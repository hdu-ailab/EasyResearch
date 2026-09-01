import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionTreeNode } from "@earendil-works/pi-coding-agent";
import type { RouteServices } from "./routes";
import { createRouteHandler } from "./routes";
import { PiSessionFactory, type SessionAdapter, type SessionFactory, type SessionState, type StartSessionOptions, type SteerPromptOptions, type WebSlashCommand } from "./session-adapter";
import { ActiveSessionRegistry, UnknownSessionError } from "./active-sessions";
import { DirectoryService } from "./directories";
import { ConfigFileService, ConfigServiceError } from "./config-files";
import type {
  AgentDto,
  ConfigurationEvent,
  ModelOptionDto,
  SessionSummaryDto,
  SubagentSessionSummaryDto,
} from "./contracts";
import {
  agentToDto,
  discoverAgentsForWeb,
  startServer,
  toUserSessionSummaries,
} from "./server";
import type { Logger } from "../runtime/logger";
import type { AuthModelRuntime } from "./auth-gateway";
import type {
  DaemonAuthRuntime,
  DaemonAuthRuntimeOptions,
  RuntimeApiKeyModelRuntime,
} from "./auth-runtime";
import { SubagentSessionNotFoundError } from "./subagent-sessions";
import type { FileWatcherEvent, FileWatcherFactory } from "./file-watcher";
import { createAgentPatchService, patchGlobalAgent } from "./agent-configuration";
import * as piImportModule from "../runtime/pi-import";
import {
  ConfigurationUnavailableError,
  type ConfigurationWatchImplementation,
  createLiveConfiguration,
  type ModelCatalogEntry,
  type PreparedModelCatalog,
  type LiveConfiguration,
} from "../runtime/live-configuration";
import { ModelRequestError, type ModelRequestErrorCode } from "../runtime/model-request-error";
import * as liveConfigurationModule from "../runtime/live-configuration";
import {
  createConfigurationProjectWatches,
  type ConfigurationProjectWatches,
} from "./configuration-project-watches";
import * as configurationProjectWatchesModule from "./configuration-project-watches";

const [loggerMock, createLoggerMock] = vi.hoisted(() => {
  const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return [mockLogger, vi.fn(() => mockLogger)] as const;
});

vi.mock("../runtime/logger", () => ({
  createLogger: createLoggerMock,
}));

vi.mock("../runtime/extensions-guard", () => ({
  assertSafeExtensionSources: vi.fn(),
  ExtensionGuardError: class ExtensionGuardError extends Error {},
}));

const [authGatewayMock, createDaemonAuthRuntimeMock, modelValidatorMock, disposeModelsMock] = vi.hoisted(() => {
  const gateway = { listModels: vi.fn(async () => [] as any[]), shutdown: vi.fn() };
  const modelValidator = {
    prepareModelCatalog: vi.fn<() => Promise<PreparedModelCatalog>>(async () => ({
      registeredModels: [],
      availableModels: [],
      commit() {},
      rollback() {},
    })),
    currentAvailableModels: vi.fn<() => ModelCatalogEntry[]>(() => []),
  };
  const disposeModels = vi.fn(async () => {});
  const createDaemon = vi.fn<
    (options: DaemonAuthRuntimeOptions<AuthModelRuntime & RuntimeApiKeyModelRuntime>) => Promise<DaemonAuthRuntime>
  >(async () => ({
    auth: gateway,
    modelValidator,
    dispose: disposeModels,
  } as unknown as DaemonAuthRuntime));
  return [
    gateway,
    createDaemon,
    modelValidator,
    disposeModels,
  ] as const;
});

vi.mock("./auth-runtime", () => ({
  createDaemonAuthRuntime: createDaemonAuthRuntimeMock,
}));

const noopLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function fakeLogger(): Logger & { calls: Array<[level: string, msg: string, fields?: Record<string, unknown>]> } {
  const calls: Array<[string, string, Record<string, unknown> | undefined]> = [];
  const make = (level: string) => (msg: string, fields?: Record<string, unknown>) => calls.push([level, msg, fields]);
  return { debug: make("debug"), info: make("info"), warn: make("warn"), error: make("error"), calls };
}

function userMessage(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: 1 };
}

function assistant(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "openai",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  };
}

class FakeAdapter implements SessionAdapter {
  static all: FakeAdapter[] = [];
  static nextId = 0;
  events = new Set<(event: unknown) => void>();
  prompts: string[] = [];
  aborts = 0;
  stopped = 0;
  setModels: Array<{ provider: string; modelId: string }> = [];
  setThinkingLevels: string[] = [];
  messages: AgentMessage[] = [];
  timelinePromise: Promise<Awaited<ReturnType<SessionAdapter["getTranscriptSnapshot"]>>["timeline"]> | null = null;
  constructor(public options: StartSessionOptions) {
    FakeAdapter.all.push(this);
  }
  async start() {}
  async stop() {
    this.stopped++;
  }
  async prompt(message: string, options?: SteerPromptOptions) {
    this.prompts.push(`${message}${options?.streamingBehavior === "steer" ? " (steer)" : ""}`);
  }
  async abort() {
    this.aborts++;
  }
  async setModel(provider: string, modelId: string) {
    this.setModels.push({ provider, modelId });
  }
  async setThinkingLevel(level: string) {
    this.setThinkingLevels.push(level);
  }
  async getState(): Promise<SessionState> {
    return {
      thinkingLevel: "medium",
      isStreaming: false,
      isCompacting: false,
      sessionFile: this.options.sessionPath ?? "/agent/sessions/default.jsonl",
      sessionId: `sess-${++FakeAdapter.nextId}`,
      messageCount: 0,
    };
  }
  async getTranscriptSnapshot() {
    const timeline = this.timelinePromise
      ? await this.timelinePromise
      : this.messages.map((message, index) => ({
      kind: "message" as const,
      entryId: `entry-${index}`,
      message,
        }));
    return { timeline, inlineUsage: this.inlineUsageResult };
  }
  inlineUsageResult: Awaited<ReturnType<SessionAdapter["getTranscriptSnapshot"]>>["inlineUsage"] = [];
  steeringResult: string[] = [];
  getSteeringMessages(): readonly string[] {
    return this.steeringResult;
  }
  backgroundWork = false;
  isSupervisorActive(): boolean {
    return false;
  }
  hasBackgroundWork(): boolean {
    return this.backgroundWork;
  }
  commandsResult: WebSlashCommand[] = [];
  treeResult: Awaited<ReturnType<SessionAdapter["getTree"]>> = {
    tree: [] as SessionTreeNode[],
    leafId: null as string | null,
    filterMode: "default",
    skipBranchSummaryPrompt: false,
  };
  navigateCalls: Array<{ entryId: string; options?: { summarize?: boolean; customInstructions?: string } }> = [];
  navigateResult = { cancelled: false, editorText: "restored prompt", leafId: "leaf-after" as string | null };
  compactCalls: Array<string | undefined> = [];
  compactState: "queued" | "running" = "running";
  contextUsage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  compactionPolicy = { triggerPercent: 70, enabled: true };
  runtimeConfigurationGeneration = 0;
  async getCommands(): Promise<WebSlashCommand[]> {
    return this.commandsResult;
  }
  async getTree() {
    return this.treeResult;
  }
  async navigateTree(entryId: string, options?: { summarize?: boolean; customInstructions?: string }) {
    this.navigateCalls.push({ entryId, ...(options ? { options } : {}) });
    return this.navigateResult;
  }
  async compact(customInstructions?: string) {
    this.compactCalls.push(customInstructions);
    return { state: this.compactState };
  }
  getCompactionState() {
    return this.compactState;
  }
  getCompactionPolicy() {
    return { ...this.compactionPolicy };
  }
  getContextUsage() {
    return this.contextUsage;
  }
  getRuntimeConfigurationGeneration() {
    return this.runtimeConfigurationGeneration;
  }
  onEvent(listener: (event: unknown) => void) {
    this.events.add(listener);
    return () => this.events.delete(listener);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeConfiguration(
  initial: { generation: number; error: string | null } = { generation: 1, error: null },
) {
  let generation = initial.generation;
  let error = initial.error;
  const listeners = new Set<(event: ConfigurationEvent) => void>();
  const accessOrder: string[] = [];
  const notifications: Array<{
    agentsChanged?: boolean;
    modelsChanged?: boolean;
    skillsChanged?: boolean;
    projectCwds?: readonly string[];
    availabilityChanged?: boolean;
    force?: boolean;
  }> = [];
  const live: LiveConfiguration = {
    get generation() {
      accessOrder.push("generation");
      return generation;
    },
    availabilityEpoch: initial.generation > 0 ? 1 : 0,
    get error() {
      accessOrder.push("error");
      return error;
    },
    compactionPolicy: { triggerPercent: 70, globalEnabled: true, globalKeepRecentTokens: 20_000 },
    apiUsageSettings: { showApiUsageDetails: false },
    skillPolicy: { enableDotAgentsSkill: false },
    start: async () => {},
    synchronize: async () => ({ status: "unchanged", generation, availabilityEpoch: 1, error }),
    acquireProject: async (cwd) => ({ cwd, release: async () => {} }),
    isCurrent: (candidate) => error === null && candidate === generation,
    notify: async (change) => {
      notifications.push(change);
      return { status: "unchanged", generation, availabilityEpoch: 1, error };
    },
    resolveAgents: async () => [],
    subscribe(listener) {
      accessOrder.push("subscribe");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: async () => {
      listeners.clear();
    },
  };
  return {
    live,
    accessOrder,
    notifications,
    activeSubscribers: () => listeners.size,
    emit(event: ConfigurationEvent) {
      generation = event.generation;
      error = event.type === "config.error" ? event.message : null;
      for (const listener of [...listeners]) listener(event);
    },
  };
}

function droppedConfigurationWatch(): ConfigurationWatchImplementation {
  return (() => {
    const watcher = {
      on(event: string, listener: (...args: unknown[]) => void) {
        if (event === "ready") queueMicrotask(listener);
        return watcher;
      },
      add() {
        return watcher;
      },
      async close() {},
    };
    return watcher;
  }) as ConfigurationWatchImplementation;
}

async function readSseEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<Record<string, unknown>> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    reader.read(),
    new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("Timed out waiting for SSE event")), 5_000);
    }),
  ]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });
  if (result.done || !result.value) throw new Error("SSE stream ended before the next event");
  const frame = new TextDecoder().decode(result.value);
  expect(frame.endsWith("\n\n")).toBe(true);
  expect(frame.startsWith("data: ")).toBe(true);
  return JSON.parse(frame.slice("data: ".length, -2)) as Record<string, unknown>;
}

class FakeFactory implements SessionFactory {
  created: FakeAdapter[] = [];
  create(options: StartSessionOptions): SessionAdapter {
    const adapter = new FakeAdapter(options);
    this.created.push(adapter);
    return adapter;
  }
}

class FakeWatcherFactory implements FileWatcherFactory {
  private nextLease = 0;
  created: Array<{
    cwd: string;
    onEvent: (event: FileWatcherEvent) => void;
    leases: Map<string, { revision: number; directories: Set<string> }>;
    close: ReturnType<typeof vi.fn>;
  }> = [];

  create({ cwd, onEvent }: { cwd: string; onEvent: (event: FileWatcherEvent) => void }) {
    const leases = new Map<string, { revision: number; directories: Set<string> }>();
    const close = vi.fn(async () => {});
    this.created.push({ cwd, onEvent, leases, close });
    return {
      acquireLease: () => {
        const id = `watch-lease-${++this.nextLease}`;
        leases.set(id, { revision: -1, directories: new Set() });
        return id;
      },
      replaceLease: (leaseId: string, revision: number, directories: readonly string[]) => {
        const lease = leases.get(leaseId);
        if (!lease) throw new Error(`unknown lease: ${leaseId}`);
        if (revision <= lease.revision) return false;
        lease.revision = revision;
        lease.directories = new Set(directories);
        return true;
      },
      releaseLease: (leaseId: string) => {
        leases.delete(leaseId);
      },
      close,
    };
  }

  emit(event: FileWatcherEvent) {
    this.created.at(-1)?.onEvent(event);
  }

  activeDirectories(): string[] {
    const directories = new Set<string>();
    for (const lease of this.created.at(-1)?.leases.values() ?? []) {
      for (const directory of lease.directories) directories.add(directory);
    }
    return [...directories].sort();
  }
}

describe("web routes", () => {
  let webuiDist: string;
  let homeDir: string;
  let agentDir: string;
  let projectDir: string;
  let factory: FakeFactory;
  let watcherFactory: FakeWatcherFactory;
  let registry: ActiveSessionRegistry;
  let directoryService: DirectoryService;
  let configService: ConfigFileService;
  let historySessions: SessionSummaryDto[];
  let handler: (request: Request) => Promise<Response>;

  beforeEach(() => {
    webuiDist = mkdtempSync(join(tmpdir(), "lazy-webui-dist-"));
    homeDir = mkdtempSync(join(tmpdir(), "lazy-home-"));
    agentDir = mkdtempSync(join(tmpdir(), "lazy-agent-"));
    projectDir = mkdtempSync(join(tmpdir(), "lazy-project-"));
    writeFileSync(join(webuiDist, "index.html"), "<div id=\"root\"></div>", "utf-8");
    FakeAdapter.all = [];
    FakeAdapter.nextId = 0;
    factory = new FakeFactory();
    watcherFactory = new FakeWatcherFactory();
    registry = new ActiveSessionRegistry(factory, noopLogger, { idleTimeoutMs: -1 }, watcherFactory);
    directoryService = new DirectoryService(homeDir);
    configService = new ConfigFileService(agentDir);
    historySessions = [];
    authGatewayMock.listModels.mockReset().mockResolvedValue([]);
    authGatewayMock.shutdown.mockReset();
    modelValidatorMock.prepareModelCatalog.mockClear();
    disposeModelsMock.mockReset();
    createDaemonAuthRuntimeMock.mockReset().mockResolvedValue({
      auth: authGatewayMock,
      modelValidator: modelValidatorMock,
      modelRuntime: {},
      dispose: disposeModelsMock,
    } as unknown as DaemonAuthRuntime);
  });

  function setup(
    overrides: Partial<Omit<RouteServices, "subagentSessions">> & {
      subagentSessions?: Partial<RouteServices["subagentSessions"]>;
      configurationProjectWatches?: ConfigurationProjectWatches;
    } = {},
  ): void {
    const configuration = fakeConfiguration().live;
    const { subagentSessions: subagentOverrides, ...routeOverrides } = overrides;
    const emptyStatistics = async (rootSessionId: string) => ({
      rootSessionId,
      total: {
        records: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cacheWrite1h: 0,
        reasoning: 0,
        totalTokens: 0,
        cacheHitRate: null,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      sessions: [],
      partial: false,
      warnings: [],
    });
    const defaultSubagentSessions: RouteServices["subagentSessions"] = {
      summaries: async () => [],
      statistics: emptyStatistics,
      trackUsage: emptyStatistics,
      snapshot: async (_parentSessionId: string, childSessionId: string) => {
        throw new SubagentSessionNotFoundError(`Subagent session not found: ${childSessionId}`);
      },
    };
    const services: RouteServices = {
      webuiDist,
      listAllSessions: async () => historySessions,
      listModels: async () => [],
      checkForUpdate: async () => ({ latestVersion: null }),
      renameSession: async () => {},
      listConfigProjects: async () => ({ home: agentDir, projects: [] }),
      directories: directoryService,
      registry,
      config: configService,
      logger: noopLogger,
      configuration,
      configurationProjectWatches: createConfigurationProjectWatches({
        live: configuration,
        isKnownCwd: async () => false,
      }),
      listAgents: async () => [],
      patchAgent: async (name, patch) => patchGlobalAgent(configService, name, patch, () => true),
      getCompactionSettings: async () => ({ triggerPercent: 70, globalEnabled: true }),
      patchCompactionSettings: async ({ triggerPercent }) => ({ triggerPercent, globalEnabled: true }),
      getApiUsageSettings: async () => ({ showApiUsageDetails: false }),
      patchApiUsageSettings: async ({ showApiUsageDetails }) => ({ showApiUsageDetails }),
      subagentSessions: {
        ...defaultSubagentSessions,
        ...subagentOverrides,
        trackUsage: subagentOverrides?.trackUsage
          ?? (async (rootSessionId) => (subagentOverrides?.statistics ?? emptyStatistics)(rootSessionId)),
      },
      ...routeOverrides,
    } as RouteServices;
    handler = createRouteHandler(services);
  }

  it("reads and patches the focused global compaction setting", async () => {
    const getCompactionSettings = vi.fn(async () => ({ triggerPercent: 70, globalEnabled: false }));
    const patchCompactionSettings = vi.fn(async ({ triggerPercent }: { triggerPercent: number }) => ({
      triggerPercent,
      globalEnabled: false,
    }));
    setup({ getCompactionSettings, patchCompactionSettings });

    const read = await handler(new Request("http://localhost/api/settings/compaction"));
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toEqual({ triggerPercent: 70, globalEnabled: false });

    const patch = await handler(new Request("http://localhost/api/settings/compaction", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ triggerPercent: 80 }),
    }));
    expect(patch.status).toBe(200);
    await expect(patch.json()).resolves.toEqual({ triggerPercent: 80, globalEnabled: false });
    expect(patchCompactionSettings).toHaveBeenCalledWith({ triggerPercent: 80 });
    expect(getCompactionSettings).toHaveBeenCalledTimes(1);
  });

  it("reads and patches the focused global API-usage setting", async () => {
    const getApiUsageSettings = vi.fn(async () => ({ showApiUsageDetails: false }));
    const patchApiUsageSettings = vi.fn(async ({ showApiUsageDetails }: { showApiUsageDetails: boolean }) => ({
      showApiUsageDetails,
    }));
    setup({ getApiUsageSettings, patchApiUsageSettings });

    const read = await handler(new Request("http://localhost/api/settings/api-usage"));
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toEqual({ showApiUsageDetails: false });

    const patch = await handler(new Request("http://localhost/api/settings/api-usage", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ showApiUsageDetails: true }),
    }));
    expect(patch.status).toBe(200);
    await expect(patch.json()).resolves.toEqual({ showApiUsageDetails: true });
    expect(patchApiUsageSettings).toHaveBeenCalledWith({ showApiUsageDetails: true });
    expect(getApiUsageSettings).toHaveBeenCalledOnce();
  });

  it("returns backend-owned recursive session statistics", async () => {
    const statistics = vi.fn(async (rootSessionId: string) => ({
      rootSessionId,
      total: {
        records: 2,
        input: 8,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        cacheWrite1h: 0,
        reasoning: 0,
        totalTokens: 10,
        cacheHitRate: 0,
        cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.2 },
      },
      sessions: [],
      partial: false,
      warnings: [],
    }));
    setup({
      subagentSessions: {
        summaries: async () => [],
        statistics,
        snapshot: async (_parentSessionId: string, childSessionId: string) => {
          throw new SubagentSessionNotFoundError(`Subagent session not found: ${childSessionId}`);
        },
      },
    });

    const response = await handler(new Request("http://localhost/api/sessions/root-1/statistics"));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ rootSessionId: "root-1", total: { totalTokens: 10 } });
    expect(statistics).toHaveBeenCalledWith("root-1");
  });

  it("returns a structured code when malformed global settings block a compaction patch", async () => {
    setup({
      patchCompactionSettings: async () => {
        throw new ConfigServiceError(409, "Global settings.json is invalid", "CONFIG_INVALID");
      },
    });

    const response = await handler(new Request("http://localhost/api/settings/compaction", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ triggerPercent: 80 }),
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Global settings.json is invalid",
      code: "CONFIG_INVALID",
    });
  });

  it.each([
    ["GET", "/api/webui-settings", undefined],
    ["PUT", "/api/webui-settings", { agentModels: {} }],
    ["GET", "/api/sessions/s1/agents/effective-models", undefined],
    ["GET", "/api/sessions/s1/agents/effective-thinking", undefined],
    ["PUT", "/api/sessions/s1/agents/search/model", { model: "openai/gpt-4o" }],
    ["PUT", "/api/sessions/s1/agents/search/thinking", { thinking: "high" }],
    ["POST", "/api/sessions/s1/agent-overrides/clear", undefined],
  ])("removes the legacy %s %s Agent configuration route", async (method, path, body) => {
    setup();
    const response = await handler(
      new Request(`http://localhost${path}`, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      }),
    );

    expect(response.status).toBe(404);
  });

  it("returns status with history and active sessions", async () => {
    historySessions = [
      {
        id: "h1",
        path: "/agent/sessions/--p--/a.jsonl",
        cwd: "/p",
        created: "2026-08-01T00:00:00.000Z",
        modified: "2026-08-01T00:00:00.000Z",
        messageCount: 1,
        firstMessage: "hello",
      },
    ];
    setup();
    const res = await handler(new Request("http://localhost/api/status"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agentDir: string; homeDir: string; sessions: unknown[]; activeSessions: unknown[] };
    expect(body.agentDir).toBe(agentDir);
    expect(body.homeDir).toBe(homeDir);
    expect(body.sessions).toHaveLength(1);
    expect(body.activeSessions).toEqual([]);
  });

  it("returns the informational package update result", async () => {
    const checkForUpdate = vi.fn(async () => ({ latestVersion: "0.0.62" }));
    setup({ checkForUpdate });

    const res = await handler(new Request("http://localhost/api/update-check"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ latestVersion: "0.0.62" });
    expect(checkForUpdate).toHaveBeenCalledOnce();
  });

  it("keeps daemon control hidden behind the per-launch ownership token", async () => {
    const requestShutdown = vi.fn();
    setup({
      daemonControl: {
        token: "launch-token",
        runtimeId: "runtime-current",
        requestShutdown,
      },
      desktopAccess: { token: "renderer-token" },
    } as unknown as Partial<RouteServices>);

    const hidden = await handler(new Request("http://localhost/api/internal/daemon"));
    expect(hidden.status).toBe(404);

    const headers = { "x-easyresearch-daemon-token": "launch-token" };
    const probe = await handler(new Request("http://localhost/api/internal/daemon", { headers }));
    expect(probe.status).toBe(200);
    expect(await probe.json()).toEqual({ runtimeId: "runtime-current" });

    const stop = await handler(new Request("http://localhost/api/internal/daemon", {
      method: "POST",
      headers,
    }));
    expect(stop.status).toBe(200);
    expect(await stop.json()).toEqual({ ok: true });
    expect(requestShutdown).toHaveBeenCalledOnce();

    const rendererOnly = await handler(new Request("http://localhost/api/internal/daemon", {
      headers: { "x-easyresearch-desktop-token": "renderer-token" },
    }));
    expect(rendererOnly.status).toBe(404);
  });

  it("requires desktop renderer access across document, asset, API, SSE, and raw-file routes", async () => {
    const assetDir = join(webuiDist, "assets");
    mkdirSync(assetDir, { recursive: true });
    writeFileSync(join(assetDir, "app.js"), "export {};", "utf8");
    const rawFile = join(homeDir, "desktop-auth.bin");
    writeFileSync(rawFile, Buffer.from([0, 1, 2, 3]));
    setup({ desktopAccess: { token: "renderer-secret" } } as Partial<RouteServices>);
    const cases = [
      { path: "/", status: 200 },
      { path: "/assets/app.js", status: 200 },
      { path: "/api/status", status: 200 },
      { path: "/api/config/events", status: 200, contentType: "text/event-stream" },
      {
        path: `/api/file/raw?path=${encodeURIComponent(rawFile)}`,
        status: 206,
        headers: { Range: "bytes=1-2" },
        contentType: "application/octet-stream",
      },
    ];

    for (const fixture of cases) {
      const denied = await handler(new Request(`http://127.0.0.1${fixture.path}`, {
        headers: fixture.headers,
      }));
      expect(denied.status, fixture.path).toBe(401);

      const accepted = await handler(new Request(`http://127.0.0.1${fixture.path}`, {
        headers: {
          ...fixture.headers,
          "x-easyresearch-desktop-token": "renderer-secret",
        },
      }));
      expect(accepted.status, fixture.path).toBe(fixture.status);
      if (fixture.contentType) {
        expect(accepted.headers.get("content-type"), fixture.path).toContain(fixture.contentType);
      }
      await accepted.body?.cancel();
    }
  });

  it("keeps ordinary CLI Web mode accessible without a renderer credential", async () => {
    setup();
    const response = await handler(new Request("http://127.0.0.1/api/status"));
    expect(response.status).toBe(200);
  });

  it("lists directories for a given path", async () => {
    setup();
    const res = await handler(new Request(`http://localhost/api/directories?path=${encodeURIComponent(homeDir)}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; entries: unknown[] };
    expect(body.path).toBe(homeDir);
  });

  it("lists files and directories for the files panel", async () => {
    writeFileSync(join(homeDir, "note.txt"), "x", "utf-8");
    setup();
    const res = await handler(new Request(`http://localhost/api/entries?path=${encodeURIComponent(homeDir)}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ kind: string }> };
    expect(body.entries.length).toBeGreaterThan(0);
    expect(body.entries.every((e) => e.kind === "file" || e.kind === "directory")).toBe(true);
  });

  it("reads a file for preview", async () => {
    writeFileSync(join(homeDir, "note.txt"), "preview me", "utf-8");
    setup();
    const res = await handler(new Request(`http://localhost/api/file?path=${encodeURIComponent(join(homeDir, "note.txt"))}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string; truncated: boolean };
    expect(body.content).toBe("preview me");
    expect(body.truncated).toBe(false);
  });

  it("rejects reading a missing file", async () => {
    setup();
    const res = await handler(new Request(`http://localhost/api/file?path=${encodeURIComponent(join(homeDir, "nope.txt"))}`));
    expect(res.status).toBe(404);
  });

  it("requires a path for file reads", async () => {
    setup();
    const res = await handler(new Request("http://localhost/api/file"));
    expect(res.status).toBe(400);
  });

  it("serves raw file bytes with MIME metadata for a full read", async () => {
    const pdf = join(homeDir, "raw.pdf");
    writeFileSync(pdf, Buffer.from([0, 1, 2, 3, 4]));
    setup();
    const res = await handler(new Request(`http://localhost/api/file/raw?path=${encodeURIComponent(pdf)}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-length")).toBe("5");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([0, 1, 2, 3, 4]);
  });

  it("serves a single ranged raw file response", async () => {
    const pdf = join(homeDir, "raw.pdf");
    writeFileSync(pdf, Buffer.from([0, 1, 2, 3, 4]));
    setup();
    const res = await handler(
      new Request(`http://localhost/api/file/raw?path=${encodeURIComponent(pdf)}`, {
        headers: { Range: "bytes=1-3" },
      }),
    );
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 1-3/5");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it("rejects unsatisfiable ranges with 416 and a content-range hint", async () => {
    const pdf = join(homeDir, "raw.pdf");
    writeFileSync(pdf, Buffer.from([0, 1, 2, 3, 4]));
    setup();
    const res = await handler(
      new Request(`http://localhost/api/file/raw?path=${encodeURIComponent(pdf)}`, {
        headers: { Range: "bytes=20-30" },
      }),
    );
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */5");
  });

  it("streams full and ranged raw bodies instead of buffering the file", async () => {
    const pdf = join(homeDir, "raw.pdf");
    writeFileSync(pdf, Buffer.from([0, 1, 2, 3, 4]));
    setup();

    const full = await handler(new Request(`http://localhost/api/file/raw?path=${encodeURIComponent(pdf)}`));
    expect(full.status).toBe(200);
    expect(full.body).toBeInstanceOf(ReadableStream);
    const fullReader = full.body!.getReader();
    const fullChunks: number[] = [];
    for (;;) {
      const { done, value } = await fullReader.read();
      if (done) break;
      fullChunks.push(...value);
    }
    expect(fullChunks).toEqual([0, 1, 2, 3, 4]);

    const ranged = await handler(
      new Request(`http://localhost/api/file/raw?path=${encodeURIComponent(pdf)}`, {
        headers: { Range: "bytes=1-3" },
      }),
    );
    expect(ranged.status).toBe(206);
    expect(ranged.body).toBeInstanceOf(ReadableStream);
    const rangedReader = ranged.body!.getReader();
    const rangedChunks: number[] = [];
    for (;;) {
      const { done, value } = await rangedReader.read();
      if (done) break;
      rangedChunks.push(...value);
    }
    expect(rangedChunks).toEqual([1, 2, 3]);
  });

  it("serves a small range of a large raw file through the streaming body", async () => {
    const big = join(homeDir, "big.bin");
    const size = 8 * 1024 * 1024;
    const fd = openSync(big, "w");
    try {
      writeSync(fd, Buffer.alloc(size));
      writeSync(fd, Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]), 0, 4, size - 4);
    } finally {
      closeSync(fd);
    }
    setup();
    const res = await handler(
      new Request(`http://localhost/api/file/raw?path=${encodeURIComponent(big)}`, {
        headers: { Range: "bytes=-4" },
      }),
    );
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes ${size - 4}-${size - 1}/${size}`);
    expect(res.headers.get("content-length")).toBe("4");
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([0xaa, 0xbb, 0xcc, 0xdd]);
  });

  it("rejects raw reads of a directory with the same typed error as text reads", async () => {
    mkdirSync(join(homeDir, "subdir"), { recursive: true });
    setup();
    const res = await handler(new Request(`http://localhost/api/file/raw?path=${encodeURIComponent(join(homeDir, "subdir"))}`));
    expect(res.status).toBe(400);
  });

  it("rejects raw reads of a missing file with the same typed error as text reads", async () => {
    setup();
    const res = await handler(new Request(`http://localhost/api/file/raw?path=${encodeURIComponent(join(homeDir, "nope.pdf"))}`));
    expect(res.status).toBe(404);
  });

  it("requires a path for raw file reads", async () => {
    setup();
    const res = await handler(new Request("http://localhost/api/file/raw"));
    expect(res.status).toBe(400);
  });

  it("creates a session for an exact cwd", async () => {
    setup();
    const res = await handler(
      new Request("http://localhost/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: projectDir }),
      }),
    );
    expect(res.status).toBe(200);
    const dto = (await res.json()) as { id: string; cwd: string; status: string };
    expect(dto.cwd).toBe(projectDir);
    expect(dto.id).toBe("sess-1");
    expect(factory.created).toHaveLength(1);
    expect(factory.created[0]?.options.cwd).toBe(projectDir);
  });

  it("returns readable filesystem roots through the directory API", async () => {
    setup();
    const res = await handler(new Request("http://localhost/api/directories/roots"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { roots: Array<{ name: string; path: string }> };
    expect(body.roots.some((root) => root.path === parse(realpathSync(homeDir)).root)).toBe(true);
  });

  it("canonicalizes a selected cwd before constructing the session runtime", async () => {
    setup();
    const submitted = `${projectDir}/.`;
    const res = await handler(
      new Request("http://localhost/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: submitted }),
      }),
    );

    expect(res.status).toBe(200);
    expect(factory.created.at(-1)?.options.cwd).toBe(realpathSync(projectDir));
  });

  it("rejects a file cwd before constructing a session runtime", async () => {
    const file = join(projectDir, "paper.md");
    writeFileSync(file, "# paper");
    setup();
    const res = await handler(
      new Request("http://localhost/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: file }),
      }),
    );

    expect(res.status).toBe(400);
    expect(factory.created).toHaveLength(0);
  });

  it("returns a typed safe error and logs the cause when session construction fails", async () => {
    const cause = new Error("secret provider detail");
    const logger = fakeLogger();
    registry = new ActiveSessionRegistry({ create: () => { throw cause; } }, logger, { idleTimeoutMs: -1 }, watcherFactory);
    setup({ logger });

    const res = await handler(new Request("http://localhost/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: projectDir }),
    }));

    expect(res.status).toBe(500);
    const body = await res.json() as { error: string; code: string };
    expect(body.code).toBe("SESSION_START_FAILED");
    expect(body.error).not.toContain("secret provider detail");
    expect(logger.calls.some(([level, message, fields]) => level === "error"
      && message === "session start failed"
      && String(fields?.error).includes("secret provider detail"))).toBe(true);
  });

  it("opens a historical session using its recorded cwd", async () => {
    const sessionPath = "/agent/sessions/--p--/a.jsonl";
    historySessions = [
      {
        id: "h1",
        path: sessionPath,
        cwd: projectDir,
        created: "2026-08-01T00:00:00.000Z",
        modified: "2026-08-01T00:00:00.000Z",
        messageCount: 1,
        firstMessage: "hello",
      },
    ];
    setup();
    const res = await handler(
      new Request("http://localhost/api/sessions/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: sessionPath }),
      }),
    );
    expect(res.status).toBe(200);
    const dto = (await res.json()) as { id: string };
    expect(dto.id).toBe("sess-1");
    expect(factory.created[0]?.options.sessionPath).toBe(sessionPath);
    expect(factory.created[0]?.options.cwd).toBe(projectDir);
  });

  it("rejects a historical session whose recorded cwd is no longer a directory", async () => {
    const cwd = join(projectDir, "paper.md");
    const sessionPath = "/agent/sessions/--p--/file-cwd.jsonl";
    writeFileSync(cwd, "# paper");
    historySessions = [
      {
        id: "h-file-cwd",
        path: sessionPath,
        cwd,
        created: "2026-08-01T00:00:00.000Z",
        modified: "2026-08-01T00:00:00.000Z",
        messageCount: 1,
        firstMessage: "hello",
      },
    ];
    setup();

    const res = await handler(
      new Request("http://localhost/api/sessions/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: sessionPath }),
      }),
    );

    expect(res.status).toBe(400);
    expect(factory.created).toHaveLength(0);
  });

  it("lists active sessions", async () => {
    setup();
    await handler(
      new Request("http://localhost/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: projectDir }),
      }),
    );
    const res = await handler(new Request("http://localhost/api/active-sessions"));
    const body = (await res.json()) as { sessions: unknown[] };
    expect(body.sessions).toHaveLength(1);
  });

  it("lists only connected sessions and touches an idle session", async () => {
    setup();
    const created = (await (
      await handler(
        new Request("http://localhost/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd: projectDir }),
        }),
      )
    ).json()) as { id: string };

    const touch = await handler(new Request(`http://localhost/api/sessions/${created.id}/touch`, { method: "POST" }));
    expect(touch.status).toBe(200);
    expect(await touch.json()).toEqual({ ok: true });

    const stopped = await handler(
      new Request(`http://localhost/api/sessions/${created.id}/stop`, { method: "POST" }),
    );
    expect(stopped.status).toBe(200);
    const active = await handler(new Request("http://localhost/api/active-sessions"));
    expect((await active.json() as { sessions: unknown[] }).sessions).toEqual([]);

    const unknown = await handler(new Request("http://localhost/api/sessions/missing/touch", { method: "POST" }));
    expect(unknown.status).toBe(404);
  });

  it("returns a session snapshot", async () => {
    setup();
    const created = (await (
      await handler(
        new Request("http://localhost/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd: projectDir }),
        }),
      )
    ).json()) as { id: string };
    FakeAdapter.all.at(-1)!.runtimeConfigurationGeneration = 4;
    FakeAdapter.all.at(-1)!.inlineUsageResult = [{
      id: "usage-1",
      sessionId: created.id,
      source: "assistant",
      timestamp: "2026-08-25T00:00:00.000Z",
      anchor: { kind: "message", messageEntryId: "usage-1" },
      provider: "openai",
      model: "test-model",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cacheHitRate: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    }];
    const res = await handler(new Request(`http://localhost/api/sessions/${created.id}/snapshot`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      session: { id: string };
      timeline: unknown[];
      inlineUsage: unknown[];
      apiUsage: { rootSessionId: string };
      runtimeConfigurationGeneration: number;
    };
    expect(body.session.id).toBe(created.id);
    expect(body.timeline).toEqual([]);
    expect(body.inlineUsage).toHaveLength(1);
    expect(body.apiUsage.rootSessionId).toBe(created.id);
    expect(body.runtimeConfigurationGeneration).toBe(4);
  });

  it("includes pending steer texts in the HTTP snapshot (ADR-083)", async () => {
    setup();
    const created = await registry.create({ cwd: projectDir });
    FakeAdapter.all.at(-1)!.steeringResult = ["note one"];

    const res = await handler(new Request(`http://localhost/api/sessions/${created.id}/snapshot`));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { steering?: string[] };
    expect(body.steering).toEqual(["note one"]);
  });

  it("GET /api/sessions/:id/commands lists commands with their source", async () => {
    setup();
    const created = await registry.create({ cwd: projectDir });
    const adapter = FakeAdapter.all.at(-1)!;
    adapter.commandsResult = [
      { name: "skill:arxiv", description: "arXiv", source: "skill", requiresPrefix: true },
      { name: "skill:drawio", source: "skill" },
      { name: "clear", source: "extension" },
      { name: "name", description: "Set the session display name", source: "extension" },
    ];

    const res = await handler(new Request(`http://localhost/api/sessions/${created.id}/commands`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      commands: [
        { name: "arxiv", description: "arXiv", source: "skill", requiresPrefix: true },
        { name: "drawio", source: "skill" },
        { name: "clear", source: "extension" },
        { name: "name", description: "Set the session display name", source: "extension" },
      ],
    });
  });

  it("GET /api/sessions/:id/tree returns the flattened tree and leaf", async () => {
    setup();
    const created = await registry.create({ cwd: projectDir });
    const adapter = FakeAdapter.all.at(-1)!;
    adapter.treeResult = {
      tree: [],
      leafId: "leaf-1",
      filterMode: "user-only",
      skipBranchSummaryPrompt: true,
    };

    const res = await handler(new Request(`http://localhost/api/sessions/${created.id}/tree`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      tree: [],
      leafId: "leaf-1",
      filterMode: "user-only",
      skipBranchSummaryPrompt: true,
    });
  });

  it("POST /api/sessions/:id/tree/navigate forwards summary options and returns Pi navigation state", async () => {
    setup();
    const created = await registry.create({ cwd: projectDir });
    const adapter = FakeAdapter.all.at(-1)!;

    const res = await handler(
      new Request(`http://localhost/api/sessions/${created.id}/tree/navigate`, {
        method: "POST",
        body: JSON.stringify({
          entryId: "entry-9",
          summarize: true,
          customInstructions: "focus on evidence",
        }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(res.status).toBe(200);
    expect(adapter.navigateCalls).toEqual([
      {
        entryId: "entry-9",
        options: { summarize: true, customInstructions: "focus on evidence" },
      },
    ]);
    expect(await res.json()).toEqual({
      cancelled: false,
      editorText: "restored prompt",
      leafId: "leaf-after",
    });
  });

  it("POST /api/sessions/:id/compact accepts native custom instructions without waiting for completion", async () => {
    setup();
    const created = await registry.create({ cwd: projectDir });
    const adapter = FakeAdapter.all.at(-1)!;
    adapter.compactState = "queued";

    const res = await handler(
      new Request(`http://localhost/api/sessions/${created.id}/compact`, {
        method: "POST",
        body: JSON.stringify({ customInstructions: "Keep experiment decisions" }),
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "queued" });
    expect(adapter.compactCalls).toEqual(["Keep experiment decisions"]);
  });

  it("POST /api/sessions/:id/tree/navigate rejects a missing entry id", async () => {
    setup();
    const created = await registry.create({ cwd: projectDir });

    const res = await handler(
      new Request(`http://localhost/api/sessions/${created.id}/tree/navigate`, {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("includes subagent summaries in a parent HTTP snapshot", async () => {
    const subagents = [{
      ownerSessionId: "parent-1",
      toolCallId: "tool-1",
      childSessionId: "child-1",
      agent: "search",
      status: "complete" as const,
      latestMessage: "final child reply",
    }];
    setup({
      subagentSessions: {
        summaries: async () => subagents,
        snapshot: async () => { throw new Error("not used"); },
      },
    });
    const created = await registry.create({ cwd: projectDir });

    const res = await handler(new Request(`http://localhost/api/sessions/${created.id}/snapshot`));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ subagents });
  });

  it("returns a complete read-only child snapshot", async () => {
    const childSnapshot = {
      session: { id: "child-1", cwd: projectDir, sessionName: "easyresearch:search" },
      timeline: [
        { kind: "message" as const, entryId: "child-user", message: userMessage("dispatch") },
        { kind: "message" as const, entryId: "child-assistant", message: assistant("complete child reply") },
      ],
      subagents: [{
        ownerSessionId: "child-1",
        toolCallId: "nested-tool",
        launchId: "nested-launch",
        agent: "figures",
        agentId: "figures_0",
        childSessionId: "nested-child",
        status: "working" as const,
      }],
    };
    setup({
      subagentSessions: {
        summaries: async () => [],
        snapshot: async () => childSnapshot,
      },
    });

    const res = await handler(new Request("http://localhost/api/sessions/parent-1/subagents/child-1/snapshot"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(childSnapshot);
  });

  it("maps an unmapped child snapshot to JSON 404", async () => {
    setup();

    const res = await handler(new Request("http://localhost/api/sessions/parent-1/subagents/unmapped/snapshot"));

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "Subagent session not found: unmapped" });
  });

  it("does not add a child snapshot to the active-session registry", async () => {
    setup({
      subagentSessions: {
        summaries: async () => [],
        snapshot: async () => ({
          session: { id: "child-1", cwd: projectDir },
          timeline: [{
            kind: "message" as const,
            entryId: "child-assistant",
            message: assistant("complete child reply"),
          }],
          subagents: [],
        }),
      },
    });
    const parent = await registry.create({ cwd: projectDir });
    const activeBefore = registry.list().length;

    const res = await handler(new Request(`http://localhost/api/sessions/${parent.id}/subagents/child-1/snapshot`));

    expect(res.status).toBe(200);
    expect(registry.list()).toHaveLength(activeBefore);
  });

  it("returns a child snapshot after the parent registry entry is stopped", async () => {
    setup({
      subagentSessions: {
        summaries: async () => [],
        snapshot: async () => ({
          session: { id: "child-1", cwd: projectDir },
          timeline: [{
            kind: "message" as const,
            entryId: "child-assistant",
            message: assistant("persisted child reply"),
          }],
          subagents: [],
        }),
      },
    });
    const parent = await registry.create({ cwd: projectDir });
    await registry.stop(parent.id);
    expect(registry.list()).toEqual([]);

    const res = await handler(new Request(`http://localhost/api/sessions/${parent.id}/subagents/child-1/snapshot`));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      timeline: [{ kind: "message", message: { role: "assistant" } }],
    });
  });

  it("streams snapshot and forwarded RPC events over SSE", async () => {
    setup();
    const created = (await (
      await handler(
        new Request("http://localhost/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd: projectDir }),
        }),
      )
    ).json()) as { id: string };
    factory.created[0]!.contextUsage = { tokens: null, contextWindow: 128_000, percent: null };
    factory.created[0]!.compactState = "queued";

    const res = await handler(new Request(`http://localhost/api/sessions/${created.id}/events`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    const snapshotEvent = decoder.decode(first.value);
    expect(snapshotEvent).toContain('"type":"snapshot"');
    expect(snapshotEvent).toContain('"contextUsage":{"tokens":null,"contextWindow":128000,"percent":null}');
    expect(snapshotEvent).toContain('"compactionState":"queued"');

    const adapter = factory.created[0]!;
    adapter.events.forEach((listener) => listener({ type: "message_start" } as never));
    const second = await reader.read();
    expect(decoder.decode(second.value)).toContain('"type":"message_start"');
    reader.cancel();
  });

  it("streams a backend replacement after a persisted Pi usage record", async () => {
    let records = 0;
    const statistics = vi.fn(async (rootSessionId: string) => ({
      rootSessionId,
      total: {
        records,
        input: records * 5,
        output: records,
        cacheRead: 0,
        cacheWrite: 0,
        cacheWrite1h: 0,
        reasoning: 0,
        totalTokens: records * 6,
        cacheHitRate: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: records * 0.1 },
      },
      sessions: [],
      partial: false,
      warnings: [],
    }));
    setup({
      subagentSessions: {
        summaries: async () => [],
        statistics,
        snapshot: async (_parentSessionId: string, childSessionId: string) => {
          throw new SubagentSessionNotFoundError(`Subagent session not found: ${childSessionId}`);
        },
      },
    });
    const created = await registry.create({ cwd: projectDir });
    const response = await handler(new Request(`http://localhost/api/sessions/${created.id}/events`));
    const reader = response.body!.getReader();
    expect((await readSseEvent(reader)).type).toBe("snapshot");

    records = 1;
    const adapter = factory.created[0]!;
    adapter.events.forEach((listener) => listener({
      type: "entry_appended",
      entry: {
        type: "message",
        id: "assistant-entry",
        parentId: null,
        timestamp: "2026-08-25T00:00:00.000Z",
        message: assistant("tracked"),
      },
    }));

    expect(await readSseEvent(reader)).toMatchObject({
      type: "entry_appended",
      apiUsageRecord: {
        id: "assistant-entry",
        sessionId: created.id,
        source: "assistant",
      },
    });
    expect(await readSseEvent(reader)).toMatchObject({
      type: "api_usage_changed",
      statistics: { rootSessionId: created.id, total: { records: 1, totalTokens: 6 } },
    });
    expect(statistics).toHaveBeenCalledTimes(2);
    await reader.cancel();
  });

  it("sanitizes a persisted compaction into one public timeline entry", async () => {
    setup();
    const created = await registry.create({ cwd: projectDir });
    const response = await handler(new Request(`http://localhost/api/sessions/${created.id}/events`));
    const reader = response.body!.getReader();
    expect((await readSseEvent(reader)).type).toBe("snapshot");
    const adapter = factory.created[0]!;
    adapter.events.forEach((listener) => listener({
      type: "entry_appended",
      entry: {
        type: "compaction",
        id: "compact-live",
        parentId: "assistant-1",
        timestamp: "2026-09-01T00:00:00.000Z",
        summary: "Compressed context",
        firstKeptEntryId: "user-2",
        tokensBefore: 100,
        details: { privatePath: "/private/project/file.md" },
        usage: {
          input: 10,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 12,
          cost: { input: 0.2, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.3 },
        },
      },
    }));

    const event = await readSseEvent(reader);
    expect(event).toMatchObject({
      type: "timeline_entry_appended",
      entry: {
        kind: "compaction",
        entryId: "compact-live",
        timestamp: "2026-09-01T00:00:00.000Z",
        summary: "Compressed context",
      },
      apiUsageRecord: {
        id: "compact-live",
        sessionId: created.id,
        source: "compaction",
      },
    });
    expect(JSON.stringify(event)).not.toContain("privatePath");
    expect(JSON.stringify(event)).not.toContain("/private/project/file.md");
    await reader.cancel();
  });

  it("streams one current configuration event before ordered daemon-wide updates", async () => {
    const configuration = fakeConfiguration({ generation: 1, error: null });
    const configurationProjectWatches = createConfigurationProjectWatches({
      live: configuration.live,
      isKnownCwd: async () => false,
    });
    setup({ configuration: configuration.live, configurationProjectWatches });

    const response = await handler(new Request("http://localhost/api/config/events"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    let leaseId = "";
    try {
      const initial = await readSseEvent(reader);
      expect(initial).toEqual({
        type: "config.updated",
        generation: 1,
        availabilityEpoch: 1,
        agentsChanged: true,
        modelsChanged: true,
        skillsChanged: true,
        runtimeChanged: true,
        projectWatchLeaseId: expect.any(String),
      });
      leaseId = initial.projectWatchLeaseId as string;
      expect(configuration.accessOrder[0]).toBe("subscribe");

      configuration.emit({
        type: "config.updated",
        generation: 2,
        agentsChanged: true,
        modelsChanged: false,
        skillsChanged: false,
        runtimeChanged: true,
        projectWatchLeaseId: "must-not-be-forwarded",
      });
      configuration.emit({
        type: "config.updated",
        generation: 3,
        agentsChanged: false,
        modelsChanged: true,
        skillsChanged: false,
        runtimeChanged: true,
      });
      expect(await readSseEvent(reader)).toEqual({
        type: "config.updated",
        generation: 2,
        agentsChanged: true,
        modelsChanged: false,
        skillsChanged: false,
        runtimeChanged: true,
      });
      expect(await readSseEvent(reader)).toEqual({
        type: "config.updated",
        generation: 3,
        agentsChanged: false,
        modelsChanged: true,
        skillsChanged: false,
        runtimeChanged: true,
      });
    } finally {
      await reader.cancel();
    }
    expect(configuration.activeSubscribers()).toBe(0);
    const released = await handler(new Request(
      `http://localhost/api/config/project-watches/${encodeURIComponent(leaseId)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: 0, cwds: [] }),
      },
    ));
    expect(released.status).toBe(404);
  });

  it("lists Settings Skills with the accepted home policy instead of raw settings bytes", async () => {
    const previousHome = process.env.HOME;
    const homeSkill = join(homeDir, ".agents", "skills", "accepted-home", "SKILL.md");
    mkdirSync(parse(homeSkill).dir, { recursive: true });
    writeFileSync(homeSkill, "---\nname: accepted-home\ndescription: accepted\n---\n", "utf8");
    writeFileSync(join(agentDir, "settings.json"), "{ malformed current candidate", "utf8");
    process.env.HOME = homeDir;
    const configuration = fakeConfiguration();
    configuration.live.skillPolicy.enableDotAgentsSkill = true;
    setup({ configuration: configuration.live });

    try {
      const response = await handler(new Request("http://localhost/api/skill-resources"));
      expect(response.status).toBe(200);
      const skills = await response.json() as Array<{ name: string; source: string; skillPath: string }>;
      expect(skills).toContainEqual(expect.objectContaining({
        name: "accepted-home",
        source: "home",
        skillPath: homeSkill,
      }));
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it("keeps configuration SSE open across a redacted generation-zero error and recovery", async () => {
    const safeError = "Configuration validation failed. Fix the global Agent or model configuration and retry.";
    const configuration = fakeConfiguration({ generation: 0, error: safeError });
    const configurationProjectWatches = createConfigurationProjectWatches({
      live: configuration.live,
      isKnownCwd: async () => false,
    });
    setup({ configuration: configuration.live, configurationProjectWatches });

    const response = await handler(new Request("http://localhost/api/config/events"));
    const reader = response.body!.getReader();
    try {
      const initial = await readSseEvent(reader);
      expect(initial).toEqual({
        type: "config.error",
        generation: 0,
        availabilityEpoch: 0,
        message: safeError,
        projectWatchLeaseId: expect.any(String),
      });
      expect(initial).not.toHaveProperty("messages");
      expect(initial).not.toHaveProperty("session");
      expect(JSON.stringify(initial)).not.toContain("/private/");

      configuration.emit({
        type: "config.updated",
        generation: 1,
        agentsChanged: true,
        modelsChanged: true,
        skillsChanged: true,
        runtimeChanged: true,
      });
      expect(await readSseEvent(reader)).toEqual({
        type: "config.updated",
        generation: 1,
        agentsChanged: true,
        modelsChanged: true,
        skillsChanged: true,
        runtimeChanged: true,
      });
    } finally {
      await reader.cancel();
    }
  });

  it("serves exact project-watch replacement and manual-refresh status contracts without prompting a model", async () => {
    const configuration = fakeConfiguration({ generation: 4, error: null });
    const configurationProjectWatches = createConfigurationProjectWatches({
      live: configuration.live,
      isKnownCwd: async (cwd) => cwd === projectDir,
    });
    const prompt = vi.spyOn(registry, "prompt");
    setup({ configuration: configuration.live, configurationProjectWatches });
    const leaseId = configurationProjectWatches.acquireLease();
    const put = (candidateLeaseId: string, body: unknown) => handler(new Request(
      `http://localhost/api/config/project-watches/${encodeURIComponent(candidateLeaseId)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    ));
    const refresh = (body: unknown) => handler(new Request("http://localhost/api/config/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }));

    const accepted = await put(leaseId, { revision: 0, cwds: [projectDir] });
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toEqual({ applied: true, revision: 0 });

    const stale = await put(leaseId, { revision: 0, cwds: [] });
    expect(stale.status).toBe(200);
    await expect(stale.json()).resolves.toEqual({ applied: false, revision: 0 });

    const malformed = await put(leaseId, { revision: -1, cwds: [] });
    expect(malformed.status).toBe(400);
    const malformedJson = await handler(new Request(
      `http://localhost/api/config/project-watches/${encodeURIComponent(leaseId)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "{",
      },
    ));
    expect(malformedJson.status).toBe(400);
    expect((await put(leaseId, { revision: 1, cwds: [homeDir] })).status).toBe(400);
    expect((await put("unknown", { revision: 0, cwds: [] })).status).toBe(404);

    const globalRefresh = await refresh({});
    expect(globalRefresh.status).toBe(200);
    await expect(globalRefresh.json()).resolves.toEqual({ generation: 4, error: null });
    const projectRefresh = await refresh({ projectCwds: [projectDir] });
    expect(projectRefresh.status).toBe(200);
    await expect(projectRefresh.json()).resolves.toEqual({ generation: 4, error: null });
    expect((await refresh({ projectCwds: [homeDir] })).status).toBe(400);
    expect((await refresh({ projectCwds: "invalid" })).status).toBe(400);

    expect(prompt).not.toHaveBeenCalled();
    await configurationProjectWatches.releaseLease(leaseId);
    await configurationProjectWatches.close();
  });

  it("returns a safe 200 refresh result when synchronization fails", async () => {
    const configuration = fakeConfiguration({ generation: 7, error: null });
    configuration.live.synchronize = async () => {
      throw new Error(`/private/${projectDir}/fingerprint failed`);
    };
    const configurationProjectWatches = createConfigurationProjectWatches({
      live: configuration.live,
      isKnownCwd: async () => false,
    });
    setup({ configuration: configuration.live, configurationProjectWatches });

    const response = await handler(new Request("http://localhost/api/config/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }));

    expect(response.status).toBe(200);
    const result = await response.json() as { generation: number; error: string | null };
    expect(result.generation).toBe(7);
    expect(result.error).toMatch(/refresh|monitoring|configuration/i);
    expect(JSON.stringify(result)).not.toContain("/private/");
    await configurationProjectWatches.close();
  });

  it("repairs separately dropped external Agent and Skill events through manual Refresh in one generation", async () => {
    const agentName = "manual-refresh-reviewer";
    const skillName = "manual-refresh-skill";
    const live = createLiveConfiguration({
      agentDir,
      catalogOptions: { homeDir },
      modelValidator: {
        async prepareModelCatalog() {
          return { registeredModels: [], availableModels: [], commit() {}, rollback() {} };
        },
        currentAvailableModels: () => [],
      },
      watch: droppedConfigurationWatch(),
    });
    const events: ConfigurationEvent[] = [];
    live.subscribe((event) => events.push(event));
    await live.start();
    const baseline = live.generation;
    const configurationProjectWatches = createConfigurationProjectWatches({
      live,
      isKnownCwd: async () => false,
    });
    setup({ configuration: live, configurationProjectWatches });
    const prompt = vi.spyOn(registry, "prompt");
    try {
      const agentPath = join(agentDir, "agents", `${agentName}.md`);
      const skillPath = join(agentDir, "skills", skillName, "SKILL.md");
      mkdirSync(join(agentPath, ".."), { recursive: true });
      mkdirSync(join(skillPath, ".."), { recursive: true });
      writeFileSync(agentPath, [
        "---",
        `name: ${agentName}`,
        "description: Manual refresh reviewer",
        "enable: true",
        "tools:",
        "  - read",
        "skills:",
        `  - ${skillName}`,
        "subagents: []",
        "---",
        "",
        "MANUAL_REFRESH_ROLE",
        "",
      ].join("\n"), "utf8");
      writeFileSync(skillPath, [
        "---",
        `name: ${skillName}`,
        "description: MANUAL_REFRESH_SKILL_MARKER",
        "---",
        "",
        "# Manual refresh",
        "",
      ].join("\n"), "utf8");
      expect(live.generation).toBe(baseline);

      const response = await handler(new Request("http://localhost/api/config/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ generation: baseline + 1, error: null });
      const reviewer = (await live.resolveAgents(projectDir)).find((agent) => agent.name === agentName);
      expect(reviewer?.systemPrompt).toContain("MANUAL_REFRESH_ROLE");
      expect(reviewer?.effectiveSkillPaths).toEqual([
        expect.stringContaining("easyresearch-skill-snapshots-"),
      ]);
      expect(events.filter((event) => event.type === "config.updated")).toHaveLength(2);
      expect(events.at(-1)).toMatchObject({
        generation: baseline + 1,
        agentsChanged: true,
        skillsChanged: true,
        runtimeChanged: true,
      });
      expect(prompt).not.toHaveBeenCalled();
    } finally {
      await configurationProjectWatches.close();
      await live.close();
    }
  });

  it("notifies successful Agent/global-Skill writes and coordinates only project Skill descriptors", async () => {
    const configuration = fakeConfiguration();
    const projectLifecycle: string[] = [];
    configuration.live.acquireProject = async (cwd) => {
      projectLifecycle.push(`acquire:${cwd}`);
      return {
        cwd,
        release: async () => {
          projectLifecycle.push(`release:${cwd}`);
        },
      };
    };
    configuration.live.synchronize = async ({ projectCwds } = {}) => {
      const cwd = projectCwds?.[0] ?? "global";
      const descriptor = join(cwd, ".easyresearch", "skills", "route-skill", "SKILL.md");
      projectLifecycle.push(`synchronize:${cwd}:${readFileSync(descriptor, "utf8")}`);
      return { status: "unchanged", generation: 1, availabilityEpoch: 1, error: null };
    };
    configService = new ConfigFileService(agentDir, {
      onAuthoritativeWrite: (change) => configuration.live.notify(change),
      acquireProject: (cwd) => configuration.live.acquireProject(cwd),
      synchronizeProject: (cwd) => configuration.live.synchronize({ projectCwds: [cwd] }),
    });
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    writeFileSync(
      join(agentDir, "agents", "search.md"),
      "---\nname: search\ndescription: Search\n---\nSearch prompt\n",
    );
    setup({ configuration: configuration.live } as Partial<RouteServices>);

    const send = (path: string, method: string, body: unknown) =>
      handler(new Request(`http://localhost${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }));

    expect((await send("/api/agents/search", "PATCH", { thinking: "high" })).status).toBe(200);
    expect(configuration.notifications.at(-1)).toEqual({});

    expect((await send("/api/agent-resources/search", "PUT", {
      content: "---\nname: search\ndescription: Saved\n---\nSaved prompt\n",
    })).status).toBe(200);
    expect(configuration.notifications.at(-1)).toEqual({ agentsChanged: true });

    expect((await send("/api/agent-resources", "POST", { name: "reviewer" })).status).toBe(200);
    expect(configuration.notifications.at(-1)).toEqual({ agentsChanged: true });

    expect((await send("/api/config/file", "PUT", {
      scope: "global",
      path: "agents/external.md",
      content: "---\nname: external\ndescription: External\n---\nPrompt\n",
    })).status).toBe(200);
    expect(configuration.notifications.at(-1)).toEqual({ agentsChanged: true });

    expect((await send("/api/config/file", "PUT", {
      scope: "global",
      path: "models.json",
      content: '{"providers":{}}',
    })).status).toBe(200);
    expect(configuration.notifications.at(-1)).toEqual({ modelsChanged: true });
    expect((await send("/api/config/file", "PUT", {
      scope: "global",
      path: "settings.json",
      content: "{}",
    })).status).toBe(200);
    expect(configuration.notifications.at(-1)).toEqual({});

    const beforeSkillsCount = configuration.notifications.length;
    expect((await send("/api/config/file", "PUT", {
      scope: "global",
      path: "skills/root-route.md",
      content: "root route skill",
    })).status).toBe(200);
    expect((await send("/api/config/file", "PUT", {
      scope: "global",
      path: "skills/namespace/route-skill/SKILL.md",
      content: "nested route skill",
    })).status).toBe(200);
    expect(configuration.notifications.slice(beforeSkillsCount)).toEqual([
      { skillsChanged: true },
      { skillsChanged: true },
    ]);

    expect((await send("/api/config/file", "PUT", {
      scope: "project",
      cwd: projectDir,
      path: "skills/route-skill/SKILL.md",
      content: "project route skill",
    })).status).toBe(200);
    expect(projectLifecycle).toEqual([
      `acquire:${projectDir}`,
      `synchronize:${projectDir}:project route skill`,
      `release:${projectDir}`,
    ]);

    const afterDescriptorsCount = configuration.notifications.length;
    expect((await send("/api/config/file", "PUT", {
      scope: "project",
      cwd: projectDir,
      path: "agents/project.md",
      content: "project",
    })).status).toBe(200);
    expect((await send("/api/config/file", "PUT", {
      scope: "project",
      cwd: projectDir,
      path: "skills/route-skill/asset.bin",
      content: "asset",
    })).status).toBe(200);
    expect((await send("/api/config/directory", "POST", {
      scope: "project",
      cwd: projectDir,
      path: "skills/empty",
    })).status).toBe(200);
    expect((await send("/api/config/file", "PUT", {
      scope: "global",
      path: "models.json",
      content: "{",
    })).status).toBe(400);
    expect(configuration.notifications).toHaveLength(afterDescriptorsCount);
    expect(projectLifecycle).toHaveLength(3);
  });

  it("recovers generation-zero startup through config write and observes a later external Agent edit", async () => {
    const modelsPath = join(agentDir, "models.json");
    writeFileSync(modelsPath, "{ malformed models");
    const live = createLiveConfiguration({
      agentDir,
      modelValidator: {
        async prepareModelCatalog() {
          const parsed = JSON.parse(readFileSync(modelsPath, "utf8")) as { providers?: unknown };
          if (!parsed.providers || typeof parsed.providers !== "object" || Array.isArray(parsed.providers)) {
            throw new Error("private semantic detail");
          }
          return { registeredModels: [], availableModels: [], commit() {}, rollback() {} };
        },
        currentAvailableModels: () => [],
      },
    });
    await live.start();
    expect(live.generation).toBe(0);
    configService = new ConfigFileService(agentDir, {
      onAuthoritativeWrite: (change) => live.notify(change),
    });
    const configurationFactory: SessionFactory = {
      create(options) {
        const adapter = new FakeAdapter(options);
        adapter.start = async () => {
          await live.resolveAgents(options.cwd);
        };
        adapter.prompt = async () => {
          await live.synchronize();
          if (!live.isCurrent(live.generation)) throw new ConfigurationUnavailableError();
        };
        return adapter;
      },
    };
    registry = new ActiveSessionRegistry(configurationFactory, noopLogger, { idleTimeoutMs: -1 });
    setup({ configuration: live } as Partial<RouteServices>);

    const events = await handler(new Request("http://localhost/api/config/events"));
    const reader = events.body!.getReader();
    try {
      expect((await handler(new Request("http://localhost/api/status"))).status).toBe(200);
      expect((await handler(new Request("http://localhost/api/config?scope=global"))).status).toBe(200);
      const startupEvent = await readSseEvent(reader);
      expect(startupEvent).toMatchObject({ type: "config.error", generation: 0 });
      expect(JSON.stringify(startupEvent)).not.toContain("private semantic detail");
      expect(JSON.stringify(startupEvent)).not.toContain(agentDir);

      const blocked = await handler(new Request("http://localhost/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: projectDir }),
      }));
      expect(blocked.status).toBe(503);
      expect(await blocked.json()).toEqual({
        error: "No valid configuration is available. Fix the global Agent or model configuration and retry.",
        code: "CONFIGURATION_UNAVAILABLE",
      });

      const repaired = await handler(new Request("http://localhost/api/config/file", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "global", path: "models.json", content: '{"providers":{}}' }),
      }));
      expect(repaired.status).toBe(200);
      expect(await readSseEvent(reader)).toEqual({
        type: "config.updated",
        generation: 1,
        agentsChanged: true,
        modelsChanged: true,
        skillsChanged: true,
        runtimeChanged: true,
      });

      const created = await handler(new Request("http://localhost/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: projectDir }),
      }));
      expect(created.status).toBe(200);
      const { id } = await created.json() as { id: string };
      expect((await handler(new Request(`http://localhost/api/sessions/${id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "continue" }),
      }))).status).toBe(200);

      mkdirSync(join(agentDir, "agents"), { recursive: true });
      writeFileSync(
        join(agentDir, "agents", "reviewer.md"),
        "---\nname: reviewer\ndescription: Reviewer\n---\nReview prompt\n",
      );
      expect(await readSseEvent(reader)).toMatchObject({
        type: "config.updated",
        generation: 2,
        agentsChanged: true,
        modelsChanged: false,
        skillsChanged: false,
        runtimeChanged: true,
      });
    } finally {
      await reader.cancel();
      await registry.shutdown();
      await live.close();
    }
  });

  it("keeps recovery surfaces usable while isolating a malformed custom-model layer", async () => {
    const modelsPath = join(agentDir, "models.json");
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    writeFileSync(modelsPath, "{ malformed models");
    writeFileSync(
      join(agentDir, "agents", "guard.md"),
      "---\nname: guard\ndescription: Guard\nmodel: accepted-provider/accepted-model\n---\nGuard prompt\n",
    );
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({
        easyresearch: {
          agentDefaults: { guard: { model: "accepted-provider/accepted-model" } },
        },
      }),
    );
    writeFileSync(
      join(agentDir, "agents", "search.md"),
      "---\nname: search\ndescription: Search\n---\nSearch prompt\n",
    );
    const createdRuntimes: Array<
      AuthModelRuntime & RuntimeApiKeyModelRuntime & { dispose: ReturnType<typeof vi.fn> }
    > = [];
    const createModelRuntime = vi.fn(async () => {
      let providers: Array<{ id: string; name: string; auth: Record<string, never> }> = [];
      let models: Array<{ provider: string; id: string; reasoning: boolean }> = [];
      const runtime = {
        dispose: vi.fn(async () => {}),
        async refresh() {
          try {
            const root = JSON.parse(readFileSync(modelsPath, "utf8")) as {
              providers?: Record<string, { models?: Array<{ id: string; reasoning?: boolean }> }>;
            };
            if (!root.providers || Array.isArray(root.providers)) throw new Error("invalid providers");
            providers = Object.keys(root.providers).map((id) => ({ id, name: id, auth: {} }));
            models = Object.entries(root.providers).flatMap(([provider, config]) =>
              (config.models ?? []).map((model) => ({
                provider,
                id: model.id,
                reasoning: model.reasoning ?? false,
              }))
            );
            return { aborted: false, errors: new Map<string, Error>() };
          } catch (error) {
            return { aborted: false, errors: new Map([["models", error as Error]]) };
          }
        },
        getError: () => undefined,
        getModels: () => models,
        getAvailableSnapshot: () => models,
        getProviders: () => providers,
        getProvider: (providerId: string) => providers.find((provider) => provider.id === providerId),
        getProviderAuthStatus: () => ({ configured: false }),
        setRuntimeApiKey: async () => {},
        checkAuth: async () => undefined,
        login: async () => ({ type: "api_key" as const, key: "unused" }),
        logout: async () => {},
      } satisfies AuthModelRuntime & RuntimeApiKeyModelRuntime & { dispose: ReturnType<typeof vi.fn> };
      createdRuntimes.push(runtime);
      return runtime;
    });
    const actualAuthRuntime = await vi.importActual<typeof import("./auth-runtime")>("./auth-runtime");
    createDaemonAuthRuntimeMock.mockImplementation((options) =>
      actualAuthRuntime.createDaemonAuthRuntime(options)
    );
    const pi = await piImportModule.importPi();
    const importPi = vi.spyOn(piImportModule, "importPi").mockResolvedValue({
      ...pi,
      getAgentDir: () => agentDir,
      ModelRuntime: { create: createModelRuntime },
      SessionManager: {
        listAll: async () => [{
          id: "fixture-history",
          path: "/agent/sessions/fixture.jsonl",
          cwd: projectDir,
          created: new Date(0),
          modified: new Date(0),
          messageCount: 0,
          firstMessage: "",
        }],
        open: vi.fn(() => ({ getEntries: () => [] })),
      },
    } as never);
    let live!: LiveConfiguration;
    let permitGenerationZeroFixture = false;
    const productionFactory: SessionFactory = {
      create(options) {
        const adapter = new FakeAdapter(options);
        adapter.getState = async () => ({
          thinkingLevel: "off",
          isStreaming: false,
          isCompacting: false,
          sessionFile: options.sessionPath,
          sessionId: `production-${++FakeAdapter.nextId}`,
          messageCount: 0,
        });
        adapter.start = async () => {
          if (!permitGenerationZeroFixture) await live.resolveAgents(options.cwd);
        };
        adapter.prompt = async (message) => {
          await live.synchronize();
          await live.resolveAgents(options.cwd);
          adapter.prompts.push(message);
        };
        return adapter;
      },
    };
    const resolveFactory = vi.spyOn(PiSessionFactory, "resolve").mockImplementation(async (configuration) => {
      live = configuration!;
      return productionFactory as never;
    });
    const originalBun = (globalThis as { Bun?: unknown }).Bun;
    let productionHandler: ((request: Request) => Promise<Response>) | undefined;
    (globalThis as { Bun?: unknown }).Bun = {
      serve: ({ fetch }: { fetch: (request: Request) => Promise<Response> }) => {
        productionHandler = fetch;
        return { port: 43215, stop: vi.fn() };
      },
    };
    let server: Awaited<ReturnType<typeof startServer>> | undefined;

    try {
      server = await startServer({ host: "127.0.0.1", port: 0 });
      const request = (path: string, init?: RequestInit) =>
        productionHandler!(new Request(`http://127.0.0.1:${server!.port}${path}`, init));
      const json = (method: string, body: unknown): RequestInit => ({
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const events = await request("/api/config/events");
      const reader = events.body!.getReader();
      try {
        expect((await request("/api/status")).status).toBe(200);
        expect((await request("/api/config?scope=global")).status).toBe(200);
        expect(await readSseEvent(reader)).toMatchObject({ type: "config.error", generation: 1 });

        const degradedCreate = await request("/api/sessions", json("POST", { cwd: projectDir }));
        expect(degradedCreate.status).toBe(200);

        const acceptedModels = {
          providers: {
            "accepted-provider": { models: [{ id: "accepted-model", reasoning: false }] },
          },
        };
        expect((await request("/api/config/file", json("PUT", {
          scope: "global",
          path: "models.json",
          content: JSON.stringify(acceptedModels),
        }))).status).toBe(200);
        expect(await readSseEvent(reader)).toEqual({
          type: "config.updated",
          generation: 2,
          availabilityEpoch: 2,
          availabilityChanged: true,
          agentsChanged: false,
          modelsChanged: true,
          skillsChanged: false,
          runtimeChanged: true,
        });
        expect(await (await request("/api/models")).json()).toEqual({
          models: [{
            provider: "accepted-provider",
            id: "accepted-model",
            reasoning: false,
            available: true,
            authRequired: false,
          }],
        });
        const created = await request("/api/sessions", json("POST", { cwd: projectDir }));
        expect(created.status).toBe(200);

        const recoveredModels = {
          providers: {
            "rejected-provider": { models: [{ id: "rejected-model", reasoning: true }] },
          },
        };
        writeFileSync(modelsPath, "{ malformed later revision");
        expect(await (await request("/api/models")).json()).toEqual({ models: [] });
        expect(await readSseEvent(reader)).toMatchObject({ type: "config.updated", generation: 3 });
        expect(await readSseEvent(reader)).toMatchObject({ type: "config.error", generation: 3 });
        const providers = await (await request("/api/auth/providers")).json() as {
          providers: Array<{ id: string; modelsJson: boolean }>;
        };
        expect(providers.providers).toEqual([]);
        const rejectedPatch = await request("/api/agents/search", json("PATCH", {
          model: "accepted-provider/accepted-model",
        }));
        expect(rejectedPatch.status).toBe(200);
        const repairedPatch = await rejectedPatch.json();
        expect(repairedPatch).not.toHaveProperty("model");
        expect(repairedPatch).toMatchObject({
          modelRepair: { requested: "accepted-provider/accepted-model", inherited: true },
        });

        expect((await request("/api/config/file", json("PUT", {
          scope: "global",
          path: "models.json",
          content: JSON.stringify(recoveredModels),
        }))).status).toBe(200);
        expect(await readSseEvent(reader)).toEqual({
          type: "config.updated",
          generation: 4,
          availabilityEpoch: 4,
          availabilityChanged: true,
          agentsChanged: false,
          modelsChanged: true,
          skillsChanged: false,
          runtimeChanged: true,
        });
        expect(await (await request("/api/models")).json()).toMatchObject({
          models: [{ provider: "rejected-provider", id: "rejected-model" }],
        });
        const recoveredProviders = await (await request("/api/auth/providers")).json() as {
          providers: Array<{ id: string; modelsJson: boolean }>;
        };
        expect(recoveredProviders.providers).toMatchObject([
          { id: "rejected-provider", modelsJson: true },
        ]);
      } finally {
        await reader.cancel();
      }
      expect(createdRuntimes.filter((runtime) => runtime.dispose.mock.calls.length === 0)).toHaveLength(1);
    } finally {
      await server?.stop().catch(() => {});
      resolveFactory.mockRestore();
      importPi.mockRestore();
      if (originalBun === undefined) delete (globalThis as { Bun?: unknown }).Bun;
      else (globalThis as { Bun?: unknown }).Bun = originalBun;
    }
  });

  it("applies the acquisition barrier before enrichment and preserves only stable pre-barrier supplements", async () => {
    const timeline = deferred<Awaited<ReturnType<SessionAdapter["getTranscriptSnapshot"]>>["timeline"]>();
    const timelineRequested = deferred<void>();
    const summaries = deferred<SubagentSessionSummaryDto[]>();
    const summariesRequested = deferred<void>();
    const barrierCrossed = deferred<void>();
    setup({
      subagentSessions: {
        summaries: async () => {
          summariesRequested.resolve();
          return summaries.promise;
        },
        snapshot: async () => {
          throw new Error("not used");
        },
      },
    });
    const created = await registry.create({ cwd: projectDir });
    const adapter = factory.created[0]!;
    adapter.timelinePromise = timeline.promise;
    const getTranscriptSnapshot = adapter.getTranscriptSnapshot.bind(adapter);
    vi.spyOn(adapter, "getTranscriptSnapshot").mockImplementation(async () => {
      timelineRequested.resolve();
      return getTranscriptSnapshot();
    });
    const snapshot = registry.snapshot.bind(registry);
    vi.spyOn(registry, "snapshot").mockImplementation((id, onAcquired) =>
      snapshot(id, () => {
        onAcquired?.();
        barrierCrossed.resolve();
      }),
    );
    const res = await handler(new Request(`http://localhost/api/sessions/${created.id}/events`));
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    try {
      const firstRead = reader.read();
      await Promise.all([timelineRequested.promise, summariesRequested.promise]);
      const emit = (event: unknown) => adapter.events.forEach((listener) => listener(event as never));
      const supervisorBefore = {
        type: "subagent_supervisor",
        launchId: "launch-before",
        ownerSessionId: created.id,
        toolCallId: "tool-before",
        agent: "search",
        agentId: "search_0",
        childSessionId: "child-before",
        status: "working",
      };
      const supervisorAfterAcquisition = {
        type: "subagent_supervisor",
        launchId: "launch-after",
        ownerSessionId: created.id,
        toolCallId: "tool-after",
        agent: "writing",
        agentId: "writing_0",
        childSessionId: "child-after",
        status: "working",
        event: {
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "nested delta" },
        },
      };
      emit({ type: "message_start", message: assistant("overlapping message") });
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "overlap" } });
      emit({ type: "tool_execution_start", toolCallId: "generic-before", toolName: "bash" });
      emit({
        type: "tool_execution_update",
        toolCallId: "generic-before",
        partialResult: { content: [{ type: "text", text: "overlap" }] },
      });
      emit({
        type: "tool_execution_update",
        toolCallId: "",
        partialResult: { details: { subagent: { agent: "search" } } },
      });
      emit({
        type: "file.watcher.updated",
        properties: { file: `${projectDir}/before.md`, event: "change" },
      });
      emit({ type: "agent_start" });
      emit({ type: "agent_settled" });
      emit({ type: "session_deactivated", sessionId: created.id });
      emit({ type: "error", error: "pre-barrier lifecycle error" });
      emit(supervisorBefore);
      adapter.runtimeConfigurationGeneration = 2;
      emit({ type: "runtime_configuration_applied", generation: 2 });
      emit({
        type: "tool_execution_update",
        toolCallId: "subagent-before",
        partialResult: { details: { subagent: { agent: "search", sessionId: "child-1" } } },
      });
      emit({
        ...supervisorBefore,
        launchId: "",
      });

      timeline.resolve([{
        kind: "message",
        entryId: "entry-0",
        message: assistant("committed"),
      }]);
      await barrierCrossed.promise;
      adapter.runtimeConfigurationGeneration = 3;
      emit({ type: "runtime_configuration_applied", generation: 3 });
      emit(supervisorAfterAcquisition);
      emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "after acquisition" },
      });
      emit({ type: "tool_execution_start", toolCallId: "generic-after", toolName: "bash" });
      emit({ type: "queue_update", steering: [], followUp: [] });
      summaries.resolve([]);

      const frames: Array<Record<string, unknown> & { type: string }> = [];
      let body = "";
      while (!frames.some((frame) => frame.type === "queue_update")) {
        const { done, value } = await (frames.length === 0 ? firstRead : reader.read());
        if (done) break;
        body += decoder.decode(value, { stream: true });
        const chunks = body.split("\n\n");
        body = chunks.pop() ?? "";
        for (const chunk of chunks) {
          frames.push(JSON.parse(chunk.slice("data: ".length)) as Record<string, unknown> & { type: string });
        }
      }

      expect(frames.map((frame) => frame.type)).toEqual([
        "snapshot",
        "file.watcher.updated",
        "agent_start",
        "session_activity_changed",
        "agent_settled",
        "session_activity_changed",
        "session_deactivated",
        "error",
        "subagent_supervisor",
        "runtime_configuration_applied",
        "runtime_configuration_applied",
        "subagent_supervisor",
        "message_update",
        "tool_execution_start",
        "queue_update",
      ]);
      expect(frames[0]?.timeline).toEqual([{
        kind: "message",
        entryId: "entry-0",
        message: assistant("committed"),
      }]);
      expect(frames[0]?.runtimeConfigurationGeneration).toBe(2);
      expect(frames.filter((frame) => frame.type === "runtime_configuration_applied")).toEqual([
        { type: "runtime_configuration_applied", generation: 2 },
        { type: "runtime_configuration_applied", generation: 3 },
      ]);
      expect(frames.filter((frame) => frame.type === "tool_execution_update")).toEqual([]);
      expect(frames.filter((frame) => frame.type === "subagent_supervisor").map((frame) => frame.launchId))
        .toEqual(["launch-before", "launch-after"]);
      expect(frames.filter((frame) => frame.type === "session_activity_changed")).toEqual([
        { type: "session_activity_changed", status: "running", isStreaming: true },
        { type: "session_activity_changed", status: "ready", isStreaming: false },
      ]);
      expect(frames[11]).toEqual(supervisorAfterAcquisition);
      expect(JSON.stringify(frames[11])).not.toContain("partial");

      const supervisorAfterInit = {
        ...supervisorBefore,
        launchId: "launch-live",
        toolCallId: "tool-live",
        agentId: "search_1",
        childSessionId: "child-live",
        status: "complete",
        latestMessage: "live terminal",
      };
      emit(supervisorAfterInit);
      const live = await reader.read();
      expect(JSON.parse(decoder.decode(live.value).trim().slice("data: ".length))).toEqual(supervisorAfterInit);
    } finally {
      await reader.cancel();
    }
  });

  it("cancels cleanly while SSE snapshot summaries are still pending", async () => {
    let resolveSummaries!: (summaries: SubagentSessionSummaryDto[]) => void;
    const summaries = new Promise<SubagentSessionSummaryDto[]>((resolve) => {
      resolveSummaries = resolve;
    });
    let activeListeners = 0;
    const subscribe = registry.subscribe.bind(registry);
    vi.spyOn(registry, "subscribe").mockImplementation((id, listener) => {
      const unsubscribe = subscribe(id, listener);
      activeListeners += 1;
      return () => {
        activeListeners -= 1;
        unsubscribe();
      };
    });
    setup({
      subagentSessions: {
        summaries: async () => summaries,
        snapshot: async () => {
          throw new Error("not used");
        },
      },
    });
    const created = await registry.create({ cwd: projectDir });
    const res = await handler(new Request(`http://localhost/api/sessions/${created.id}/events`));
    const reader = res.body!.getReader();

    await reader.cancel();
    resolveSummaries([]);
    await Promise.resolve();

    expect(activeListeners).toBe(0);
    expect(await reader.read()).toEqual({ done: true, value: undefined });
  });

  it("closes and unsubscribes when SSE snapshot initialization fails", async () => {
    let rejectSummaries: ((error: Error) => void) | undefined;
    let summariesRequested: (() => void) | undefined;
    const summaries = new Promise<SubagentSessionSummaryDto[]>((_resolve, reject) => {
      rejectSummaries = reject;
    });
    const requested = new Promise<void>((resolve) => {
      summariesRequested = resolve;
    });
    const logger = fakeLogger();
    const subscribe = registry.subscribe.bind(registry);
    let activeListeners = 0;
    let unsubscribeCalls = 0;
    vi.spyOn(registry, "subscribe").mockImplementation((id, listener) => {
      const unsubscribe = subscribe(id, listener);
      activeListeners++;
      return () => {
        unsubscribeCalls++;
        activeListeners--;
        unsubscribe();
      };
    });
    setup({
      logger,
      subagentSessions: {
        summaries: async () => {
          summariesRequested?.();
          return summaries;
        },
        snapshot: async () => {
          throw new Error("not used");
        },
      },
    });
    const created = await registry.create({ cwd: projectDir });
    const res = await handler(new Request(`http://localhost/api/sessions/${created.id}/events`));
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    try {
      const firstRead = reader.read();
      await requested;
      factory.created[0]!.events.forEach((listener) => listener({ type: "agent_start" } as never));
      rejectSummaries?.(new Error("summary failed"));

      const errorFrame = await firstRead;
      expect(decoder.decode(errorFrame.value)).toBe('data: {"type":"error","error":"Error: summary failed"}\n\n');
      await vi.waitFor(() => expect(activeListeners).toBe(0));
      expect(await reader.read()).toEqual({ done: true, value: undefined });

      await reader.cancel();
      expect(unsubscribeCalls).toBe(1);
      expect(logger.calls.filter(([, message]) => message === "sse disconnected")).toEqual([
        ["info", "sse disconnected", { sessionId: created.id }],
      ]);
    } finally {
      await reader.cancel();
    }
  });

  it("streams file watcher events over the existing SSE connection", async () => {
    setup();
    const created = await registry.create({ cwd: projectDir });
    const res = await handler(new Request(`http://localhost/api/sessions/${created.id}/events`));
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    try {
      await reader.read();
      watcherFactory.emit({
        type: "file.watcher.updated",
        properties: { file: `${projectDir}/new.md`, event: "add" },
      });
      const next = await reader.read();
      expect(decoder.decode(next.value)).toContain(
        JSON.stringify({
          type: "file.watcher.updated",
          properties: { file: `${projectDir}/new.md`, event: "add" },
        }),
      );
    } finally {
      await reader.cancel();
    }
  });

  it("leases demand-driven directories through the SSE snapshot and releases them on disconnect", async () => {
    const expanded = join(projectDir, "expanded");
    mkdirSync(expanded);
    setup();
    const created = await registry.create({ cwd: projectDir });
    const events = await handler(new Request(`http://localhost/api/sessions/${created.id}/events`));
    const reader = events.body!.getReader();
    try {
      const snapshot = await readSseEvent(reader);
      const leaseId = snapshot.fileWatchLeaseId;
      expect(typeof leaseId).toBe("string");

      const replace = await handler(new Request(
        `http://localhost/api/sessions/${created.id}/file-watches/${leaseId}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ revision: 2, directories: [projectDir, expanded] }),
        },
      ));
      expect(replace.status).toBe(200);
      expect(watcherFactory.activeDirectories()).toEqual([expanded, projectDir].sort());

      const stale = await handler(new Request(
        `http://localhost/api/sessions/${created.id}/file-watches/${leaseId}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ revision: 1, directories: [projectDir] }),
        },
      ));
      expect(stale.status).toBe(200);
      expect(watcherFactory.activeDirectories()).toEqual([expanded, projectDir].sort());
    } finally {
      await reader.cancel();
    }
    expect(watcherFactory.activeDirectories()).toEqual([]);
  });

  it("keeps the union for concurrent Work streams when one lease collapses or disconnects", async () => {
    const firstDirectory = join(projectDir, "first");
    const secondDirectory = join(projectDir, "second");
    mkdirSync(firstDirectory);
    mkdirSync(secondDirectory);
    setup();
    const created = await registry.create({ cwd: projectDir });
    const firstEvents = await handler(new Request(`http://localhost/api/sessions/${created.id}/events`));
    const secondEvents = await handler(new Request(`http://localhost/api/sessions/${created.id}/events`));
    const firstReader = firstEvents.body!.getReader();
    const secondReader = secondEvents.body!.getReader();
    try {
      const firstLease = (await readSseEvent(firstReader)).fileWatchLeaseId as string;
      const secondLease = (await readSseEvent(secondReader)).fileWatchLeaseId as string;
      expect(firstLease).not.toBe(secondLease);

      const replace = (lease: string, revision: number, directories: string[]) => handler(new Request(
        `http://localhost/api/sessions/${created.id}/file-watches/${lease}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ revision, directories }),
        },
      ));
      expect((await replace(firstLease, 1, [projectDir, firstDirectory])).status).toBe(200);
      expect((await replace(secondLease, 1, [projectDir, secondDirectory])).status).toBe(200);
      expect(watcherFactory.activeDirectories()).toEqual([firstDirectory, projectDir, secondDirectory].sort());

      expect((await replace(firstLease, 2, [projectDir])).status).toBe(200);
      expect(watcherFactory.activeDirectories()).toEqual([projectDir, secondDirectory].sort());

      await firstReader.cancel();
      expect(watcherFactory.activeDirectories()).toEqual([projectDir, secondDirectory].sort());
      await secondReader.cancel();
      expect(watcherFactory.activeDirectories()).toEqual([]);
    } finally {
      await firstReader.cancel();
      await secondReader.cancel();
    }
  });

  it("includes the same subagent summaries in the first SSE snapshot", async () => {
    const subagents = [{
      ownerSessionId: "parent-1",
      toolCallId: "tool-1",
      childSessionId: "child-1",
      agent: "search",
      status: "complete" as const,
      latestMessage: "final child reply",
    }];
    setup({
      subagentSessions: {
        summaries: async () => subagents,
        snapshot: async () => { throw new Error("not used"); },
      },
    });
    const parent = await registry.create({ cwd: projectDir });

    const res = await handler(new Request(`http://localhost/api/sessions/${parent.id}/events`));
    const reader = res.body!.getReader();
    const first = await reader.read();
    await reader.cancel();
    const payload = new TextDecoder().decode(first.value);

    expect(payload).toContain(`"subagents":${JSON.stringify(subagents)}`);
  });

  it("logs SSE connect on subscribe and disconnect on cancel", async () => {
    const logger = fakeLogger();
    setup({ logger });
    const created = (await (
      await handler(
        new Request("http://localhost/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd: projectDir }),
        }),
      )
    ).json()) as { id: string };

    const res = await handler(new Request(`http://localhost/api/sessions/${created.id}/events`));
    expect(res.status).toBe(200);
    expect(logger.calls).toContainEqual(["info", "sse connected", { sessionId: created.id }]);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    expect(decoder.decode(first.value)).toContain('"type":"snapshot"');
    await reader.cancel();
    await vi.waitFor(() =>
      expect(logger.calls).toContainEqual(["info", "sse disconnected", { sessionId: created.id }]),
    );
  });

  it("emits session_deactivated over SSE after an explicit stop and then 404s", async () => {
    setup();
    const created = await registry.create({ cwd: "/test/proj" });
    const adapter = factory.created[0]!;
    const res = await handler(new Request(`http://localhost/api/sessions/${created.id}/events`));
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    expect(decoder.decode(first.value)).toContain('"type":"snapshot"');
    let body = "";
    try {
      adapter.events.forEach((listener) => listener({ type: "agent_start" } as never));
      adapter.events.forEach((listener) => listener({ type: "agent_settled" } as never));
      expect((await registry.snapshot(created.id)).session.status).toBe("ready");
      await registry.stop(created.id);
      while (!body.includes("session_deactivated")) {
        const { done, value } = await reader.read();
        if (done) break;
        body += decoder.decode(value);
      }
      expect(body).toContain(JSON.stringify({ type: "session_deactivated", sessionId: created.id }));
    } finally {
      await reader.cancel();
    }
    const snap = await handler(new Request(`http://localhost/api/sessions/${created.id}/snapshot`));
    expect(snap.status).toBe(404);
  });

  it("posts a prompt to the active session", async () => {
    setup();
    const created = (await (
      await handler(
        new Request("http://localhost/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd: projectDir }),
        }),
      )
    ).json()) as { id: string };
    const res = await handler(
      new Request(`http://localhost/api/sessions/${created.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Write a paper" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(factory.created[0]?.prompts).toEqual(["Write a paper"]);
  });

  it("returns the fixed safe configuration error when prompt preflight is unavailable", async () => {
    setup();
    const created = await registry.create({ cwd: projectDir });
    vi.spyOn(registry, "prompt").mockRejectedValue(new ConfigurationUnavailableError());

    const response = await handler(new Request(`http://localhost/api/sessions/${created.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "continue" }),
    }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "No valid configuration is available. Fix the global Agent or model configuration and retry.",
      code: "CONFIGURATION_UNAVAILABLE",
    });
  });

  it.each<ModelRequestErrorCode>([
    "MODEL_REQUIRED",
    "MODEL_UNAVAILABLE",
    "PROVIDER_AUTH_REQUIRED",
  ])("returns typed safe model preflight failure %s", async (code) => {
    setup();
    const created = await registry.create({ cwd: projectDir });
    vi.spyOn(registry, "prompt").mockRejectedValue(new ModelRequestError(code));

    const response = await handler(new Request(`http://localhost/api/sessions/${created.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "continue" }),
    }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code });
  });

  it("aborts, stops, and 404s restarting a stopped session", async () => {
    setup();
    const created = (await (
      await handler(
        new Request("http://localhost/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd: projectDir }),
        }),
      )
    ).json()) as { id: string };

    expect((await handler(new Request(`http://localhost/api/sessions/${created.id}/abort`, { method: "POST" }))).status).toBe(200);
    expect(factory.created[0]?.aborts).toBe(1);

    expect((await handler(new Request(`http://localhost/api/sessions/${created.id}/stop`, { method: "POST" }))).status).toBe(200);
    expect(factory.created[0]?.stopped).toBe(1);

    const restarted = await handler(new Request(`http://localhost/api/sessions/${created.id}/restart`, { method: "POST" }));
    expect(restarted.status).toBe(404);
    expect(factory.created).toHaveLength(1);
  });

  it("restarts a live session in place", async () => {
    setup();
    const created = (await (
      await handler(
        new Request("http://localhost/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd: projectDir }),
        }),
      )
    ).json()) as { id: string };

    const restarted = await handler(new Request(`http://localhost/api/sessions/${created.id}/restart`, { method: "POST" }));
    expect(restarted.status).toBe(200);
    expect(factory.created).toHaveLength(2);
    const dto = (await restarted.json()) as { id: string };
    expect(dto.id).not.toBe(created.id);
  });

  it("lists, reads, writes, and creates config entries", async () => {
    setup();
    const list = await handler(new Request(`http://localhost/api/config?scope=global`));
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([]);

    const write = await handler(
      new Request("http://localhost/api/config/file", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "global", path: "settings.json", content: '{"defaultModel":"a"}' }),
      }),
    );
    expect(write.status).toBe(200);

    const read = await handler(new Request(`http://localhost/api/config/file?scope=global&path=settings.json`));
    expect(read.status).toBe(200);
    expect(await read.text()).toContain("defaultModel");

    const dir = await handler(
      new Request("http://localhost/api/config/directory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "global", path: "agents" }),
      }),
    );
    expect(dir.status).toBe(200);
    const after = (await (await handler(new Request(`http://localhost/api/config?scope=global`))).json()) as { name: string }[];
    expect(after.map((e) => e.name)).toEqual(["agents", "settings.json"]);
  });

  it("returns 400 for malformed JSON bodies", async () => {
    setup();
    const res = await handler(
      new Request("http://localhost/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown active session ids", async () => {
    setup();
    const res = await handler(new Request("http://localhost/api/sessions/nope/snapshot"));
    expect(res.status).toBe(404);
  });

  it("returns 403 for config path escapes", async () => {
    setup();
    const res = await handler(
      new Request("http://localhost/api/config/file", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "global", path: "../evil.json", content: "{}" }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 404 when reading a missing config file", async () => {
    setup();
    const res = await handler(new Request(`http://localhost/api/config/file?scope=global&path=settings.json`));
    expect(res.status).toBe(404);
  });

  it("returns 500 without secret content on internal errors", async () => {
    setup({ listAllSessions: async () => Promise.reject(new Error("boom")) });
    const res = await handler(new Request("http://localhost/api/status"));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("boom");
  });

  it("serves static assets and 404s unknown paths", async () => {
    setup();
    const index = await handler(new Request("http://localhost/"));
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("<div id=\"root\">");
    expect((await handler(new Request("http://localhost/nope"))).status).toBe(404);
  });

  it("serves .mjs modules with a JavaScript MIME type so PDF workers can load", async () => {
    writeFileSync(join(webuiDist, "pdf.worker.min.mjs"), "self.streamSink", "utf-8");
    setup();
    const worker = await handler(new Request("http://localhost/pdf.worker.min.mjs"));
    expect(worker.status).toBe(200);
    expect(worker.headers.get("content-type")).toMatch(/text\/javascript/);
    expect(await worker.text()).toBe("self.streamSink");
  });

  it("lists the agent roster for the exact cwd with missing-skill diagnostics", async () => {
    const listAgents = vi.fn(async () => [
      { name: "research-assistant", description: "Runs the pipeline", enabled: true, builtin: true, source: "bundled" as const, filePath: "research-assistant.md", thinking: "high" as const, tools: ["subagent"], effectiveTools: ["subagent"], skills: ["research-project-workflow", "missing-skill"], effectiveSkills: ["research-project-workflow"], missingSkills: ["missing-skill"] },
      { name: "search", description: "Finds papers", enabled: true, builtin: true, source: "bundled" as const, filePath: "search.md", effectiveTools: [], subagents: [], skills: [], effectiveSkills: [], missingSkills: [] },
    ]);
    setup({
      listAgents,
    });
    const res = await handler(new Request("http://localhost/api/agents?cwd=%2Fexact%2Fproject"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      name: string;
      description: string;
      tools?: string[];
      subagents?: string[];
      skills?: string[];
      effectiveSkills: string[];
      missingSkills: string[];
      systemPrompt?: string;
      model?: string;
      thinking?: string;
    }>;
    expect(listAgents).toHaveBeenCalledWith("/exact/project");
    expect(body.map((a) => a.name)).toEqual(["research-assistant", "search"]);
    expect(body[0]?.tools).toEqual(["subagent"]);
    expect(body[0]?.skills).toEqual(["research-project-workflow", "missing-skill"]);
    expect(body[0]?.effectiveSkills).toEqual(["research-project-workflow"]);
    expect(body[0]?.missingSkills).toEqual(["missing-skill"]);
    expect(body[1]?.skills).toEqual([]);
    expect(body[0]?.systemPrompt).toBeUndefined();
    expect(body[0]?.model).toBeUndefined();
    expect(body[0]?.thinking).toBe("high");
  });

  it("PATCH /api/agents/:name persists one global Agent configuration", async () => {
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    const target = join(agentDir, "agents", "search.md");
    writeFileSync(target, "---\nname: search\ndescription: Search\n---\nSearch prompt\n");
    const listModels = vi.fn(async () => [
      { provider: "openai", id: "gpt-4o", reasoning: false, available: false, authRequired: true },
    ]);
    setup({
      listModels,
      patchAgent: createAgentPatchService(configService, listModels),
    });

    const response = await handler(
      new Request("http://localhost/api/agents/search", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-4o", thinking: "high" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ name: "search", model: "openai/gpt-4o", thinking: "high" });
    expect(readFileSync(target, "utf8")).toBe(
      "---\nname: search\ndescription: Search\n---\nSearch prompt\n",
    );
    expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))).toEqual({
      easyresearch: {
        agentDefaults: { search: { model: "openai/gpt-4o", thinking: "high" } },
      },
    });
    expect(listModels).toHaveBeenCalledTimes(1);
  });

  it("PATCH /api/agents/:name rejects a model missing from the injected current catalog", async () => {
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    const target = join(agentDir, "agents", "search.md");
    writeFileSync(target, "---\nname: search\ndescription: Search\n---\nSearch prompt\n");
    const before = readFileSync(target);
    const listModels = vi.fn(async () => [
      { provider: "anthropic", id: "claude", reasoning: true, available: true, authRequired: false },
    ]);
    setup({
      listModels,
      patchAgent: createAgentPatchService(configService, listModels),
    });

    const response = await handler(
      new Request("http://localhost/api/agents/search", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-4o" }),
      }),
    );

    expect(response.status).toBe(400);
    expect(readFileSync(target)).toEqual(before);
    expect(listModels).toHaveBeenCalledTimes(1);
  });

  it("PATCH /api/agents/:name rejects unknown keys without changing persisted bytes", async () => {
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    const target = join(agentDir, "agents", "search.md");
    writeFileSync(target, "---\nname: search\ndescription: Search\n---\nSearch prompt\n");
    const before = readFileSync(target);
    setup();

    const response = await handler(
      new Request("http://localhost/api/agents/search", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-4o", unexpected: true }),
      }),
    );

    expect(response.status).toBe(400);
    expect(readFileSync(target)).toEqual(before);
  });

  it("maps a discovered AgentConfig into the roster DTO without private fields", () => {
    expect(
      agentToDto({
        name: "search",
        description: "Finds papers",
        enabled: true,
        builtin: true,
        tools: ["bash"],
        effectiveTools: ["bash"],
        subagents: ["experiment"],
        skills: ["paper-search", "missing-skill"],
        effectiveSkills: ["paper-search"],
        effectiveSkillPaths: ["/private/skills/paper-search"],
        missingSkills: ["missing-skill"],
        model: "deepseek/ds-v3",
        thinking: "medium",
        systemPrompt: "SECRET PROMPT",
        source: "global",
        filePath: "/agent/agents/search.md",
      }),
    ).toEqual({
      name: "search",
      description: "Finds papers",
      enabled: true,
      builtin: true,
      source: "global",
      filePath: "/agent/agents/search.md",
      model: "deepseek/ds-v3",
      effectiveModel: "deepseek/ds-v3",
      thinking: "medium",
      tools: ["bash"],
      effectiveTools: ["bash"],
      subagents: ["experiment"],
      skills: ["paper-search", "missing-skill"],
      effectiveSkills: ["paper-search"],
      missingSkills: ["missing-skill"],
    });
  });

  it("keeps an unset model sparse while exposing Pi's resolved default as the effective model", async () => {
    const discover = discoverAgentsForWeb as unknown as (
      cwd: string | undefined,
      root: string,
      resolveDefaultModel: (cwd: string) => Promise<string | undefined>,
    ) => Promise<AgentDto[]>;

    const agents = await discover(undefined, agentDir, async () => "openai/pi-default");

    expect(agents.find((agent) => agent.name === "research-assistant")).toMatchObject({
      model: undefined,
      effectiveModel: "openai/pi-default",
    });
    expect(agents.find((agent) => agent.name === "search")).toMatchObject({
      model: undefined,
      effectiveModel: "openai/pi-default",
    });
  });

  it("uses an explicit Research Assistant model without asking Pi for a fallback", async () => {
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({
        easyresearch: {
          agentDefaults: {
            "research-assistant": { model: "anthropic/configured" },
          },
        },
      }),
    );
    const discover = discoverAgentsForWeb as unknown as (
      cwd: string | undefined,
      root: string,
      resolveDefaultModel: (cwd: string) => Promise<string | undefined>,
    ) => Promise<AgentDto[]>;

    const agents = await discover(undefined, agentDir, async () => {
      throw new Error("Pi fallback must not run for an explicit model");
    });

    expect(agents.find((agent) => agent.name === "research-assistant")).toMatchObject({
      model: "anthropic/configured",
      effectiveModel: "anthropic/configured",
    });
    expect(agents.find((agent) => agent.name === "search")).toMatchObject({
      model: undefined,
      effectiveModel: "anthropic/configured",
    });
  });

  it("lists missing skills from global agent resources without leaking system prompts", async () => {
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    writeFileSync(
      join(agentDir, "agents", "diagnostic.md"),
      "---\nname: diagnostic\ndescription: Checks configured skills\nskills:\n  - paper-search\n  - missing-skill\n---\nSECRET PROMPT",
      "utf-8",
    );
    setup();

    const res = await handler(new Request("http://localhost/api/agent-resources"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    const agent = body.find((item) => item.name === "diagnostic");
    expect(agent?.skills).toEqual(["paper-search", "missing-skill"]);
    expect(agent?.effectiveSkills).toEqual(["paper-search"]);
    expect(agent?.missingSkills).toEqual(["missing-skill"]);
    expect(agent).not.toHaveProperty("systemPrompt");
  });

  it("keeps Global Agent diagnostics isolated when Web starts inside a project cwd", async () => {
    const originalCwd = process.cwd();
    mkdirSync(join(projectDir, ".easyresearch", "agents"), { recursive: true });
    mkdirSync(join(projectDir, ".easyresearch", "skills", "project-only"), { recursive: true });
    writeFileSync(
      join(projectDir, ".easyresearch", "agents", "project-custom.md"),
      "---\nname: project-custom\ndescription: Project only\n---\nProject prompt\n",
      "utf-8",
    );
    writeFileSync(join(projectDir, ".easyresearch", "skills", "project-only", "SKILL.md"), "# Project only\n", "utf-8");
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    writeFileSync(
      join(agentDir, "agents", "diagnostic.md"),
      "---\nname: diagnostic\ndescription: Global diagnostic\nskills: [project-only]\n---\nGlobal prompt\n",
      "utf-8",
    );
    setup();

    try {
      process.chdir(projectDir);
      const res = await handler(new Request("http://localhost/api/agent-resources"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<Record<string, unknown>>;
      expect(body.find((item) => item.name === "project-custom")).toBeUndefined();
      expect(body.find((item) => item.name === "diagnostic")).toMatchObject({
        effectiveSkills: [],
        missingSkills: ["project-only"],
      });
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("uses the optional Web cwd only for Skill resolution, not Agent discovery", async () => {
    const originalCwd = process.cwd();
    mkdirSync(join(projectDir, ".easyresearch", "agents"), { recursive: true });
    mkdirSync(join(projectDir, ".easyresearch", "skills", "project-only"), { recursive: true });
    writeFileSync(
      join(projectDir, ".easyresearch", "agents", "project-custom.md"),
      "---\nname: project-custom\ndescription: Project only\n---\nProject prompt\n",
      "utf-8",
    );
    writeFileSync(join(projectDir, ".easyresearch", "skills", "project-only", "SKILL.md"), "# Project only\n", "utf-8");
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    writeFileSync(
      join(agentDir, "agents", "diagnostic.md"),
      "---\nname: diagnostic\ndescription: Global diagnostic\nskills: [project-only]\n---\nGlobal prompt\n",
      "utf-8",
    );

    try {
      process.chdir(projectDir);
      const global = await discoverAgentsForWeb(undefined, agentDir);
      const project = await discoverAgentsForWeb(projectDir, agentDir);
      expect(global.map((agent) => agent.name)).not.toContain("project-custom");
      expect(project.map((agent) => agent.name)).not.toContain("project-custom");
      expect(global.find((agent) => agent.name === "diagnostic")).toMatchObject({
        effectiveSkills: [],
        missingSkills: ["project-only"],
      });
      expect(project.find((agent) => agent.name === "diagnostic")).toMatchObject({
        effectiveSkills: ["project-only"],
        missingSkills: [],
      });
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("lists registered models with availability, reasoning, and thinking metadata", async () => {
    setup({
      listModels: async () =>
        ([
          { provider: "openai", id: "gpt-4o", reasoning: false, available: true, authRequired: false, thinkingLevelMap: { xhigh: null, max: null } },
          { provider: "deepseek", id: "ds-v3", reasoning: true, available: false, authRequired: true, thinkingLevelMap: { low: null, xhigh: null, max: null } },
          { provider: "anthropic", id: "claude", reasoning: true, available: true, authRequired: false, thinkingLevelMap: { xhigh: "xhigh", high: "high" } },
        ] as ModelOptionDto[]),
    });
    const res = await handler(new Request("http://localhost/api/models"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: ModelOptionDto[] };
    expect(body.models).toEqual([
      { provider: "openai", id: "gpt-4o", reasoning: false, available: true, authRequired: false, thinkingLevelMap: { xhigh: null, max: null } },
      { provider: "deepseek", id: "ds-v3", reasoning: true, available: false, authRequired: true, thinkingLevelMap: { low: null, xhigh: null, max: null } },
      { provider: "anthropic", id: "claude", reasoning: true, available: true, authRequired: false, thinkingLevelMap: { xhigh: "xhigh", high: "high" } },
    ]);
  });

  it("composes GET models and Agent PATCH over the shared auth gateway catalog", async () => {
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    const target = join(agentDir, "agents", "search.md");
    writeFileSync(target, "---\nname: search\ndescription: Search\n---\nSearch prompt\n", "utf8");
    const pi = await piImportModule.importPi();
    let gatewayModels = [{ provider: "openai", id: "gpt-4o", reasoning: false }];
    authGatewayMock.listModels.mockImplementation(async () => gatewayModels);
    modelValidatorMock.prepareModelCatalog.mockImplementation(async () => ({
      registeredModels: gatewayModels.map(({ provider, id }) => ({ provider, id })),
      availableModels: gatewayModels.map(({ provider, id }) => ({ provider, id })),
      commit() {},
      rollback() {},
    }));
    modelValidatorMock.currentAvailableModels.mockImplementation(
      () => gatewayModels.map(({ provider, id }) => ({ provider, id })),
    );
    const createRuntime = vi.fn(async () => ({
      getAvailable: async () => [{ provider: "decoy", id: "separate-runtime", reasoning: false }],
    }));
    const importPi = vi.spyOn(piImportModule, "importPi").mockResolvedValue({
      ...pi,
      getAgentDir: () => agentDir,
      ModelRuntime: { create: createRuntime },
      SessionManager: { listAll: async () => [], open: vi.fn() },
    } as never);
    const resolveFactory = vi.spyOn(PiSessionFactory, "resolve").mockResolvedValue(new FakeFactory() as never);
    const originalBun = (globalThis as { Bun?: unknown }).Bun;
    let productionHandler: ((request: Request) => Promise<Response>) | undefined;
    (globalThis as { Bun?: unknown }).Bun = {
      serve: ({ fetch }: { fetch: (request: Request) => Promise<Response> }) => {
        productionHandler = fetch;
        return { port: 43210, stop: vi.fn() };
      },
    };
    let server: Awaited<ReturnType<typeof startServer>> | undefined;

    try {
      server = await startServer({ host: "127.0.0.1", port: 0 });
      const request = (path: string, init?: RequestInit) =>
        productionHandler!(new Request(`http://127.0.0.1:${server!.port}${path}`, init));
      const firstModels = await request("/api/models");
      expect(firstModels.status).toBe(200);
      expect(await firstModels.json()).toEqual({
        models: [{ provider: "openai", id: "gpt-4o", reasoning: false }],
      });
      const firstPatch = await request("/api/agents/search", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-4o" }),
      });
      expect(firstPatch.status).toBe(200);

      gatewayModels = [{ provider: "anthropic", id: "claude", reasoning: true }];
      const changedModels = await request("/api/models");
      expect(changedModels.status).toBe(200);
      expect(await changedModels.json()).toEqual({
        models: [{ provider: "anthropic", id: "claude", reasoning: true }],
      });
      const changedPatch = await request("/api/agents/search", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "anthropic/claude" }),
      });
      expect(changedPatch.status).toBe(200);
      expect(readFileSync(target, "utf8")).not.toContain("model:");
      expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))).toMatchObject({
        easyresearch: { agentDefaults: { search: { model: "anthropic/claude" } } },
      });
    } finally {
      await server?.stop();
      resolveFactory.mockRestore();
      importPi.mockRestore();
      if (originalBun === undefined) delete (globalThis as { Bun?: unknown }).Bun;
      else (globalThis as { Bun?: unknown }).Bun = originalBun;
      authGatewayMock.shutdown.mockClear();
      modelValidatorMock.prepareModelCatalog.mockImplementation(async () => ({
        registeredModels: [],
        availableModels: [],
        commit() {},
        rollback() {},
      }));
      modelValidatorMock.currentAvailableModels.mockReturnValue([]);
    }
  });

  it("resolves an unset Research Assistant model through Pi for the production Agent roster", async () => {
    const configuration = fakeConfiguration().live;
    configuration.resolveAgents = async () => [
      {
        name: "research-assistant",
        description: "Research Assistant",
        enabled: true,
        builtin: true,
        systemPrompt: "Coordinate",
        source: "bundled",
        filePath: "/bundled/research-assistant.md",
        effectiveTools: [],
        effectiveSkills: [],
        effectiveSkillPaths: [],
        missingSkills: [],
      },
      {
        name: "search",
        description: "Search",
        enabled: true,
        builtin: true,
        systemPrompt: "Search",
        source: "bundled",
        filePath: "/bundled/search.md",
        effectiveTools: [],
        effectiveSkills: [],
        effectiveSkillPaths: [],
        missingSkills: [],
      },
    ];
    const createLive = vi.spyOn(liveConfigurationModule, "createLiveConfiguration").mockReturnValue(configuration);
    const resolvedModel = { provider: "openai", id: "pi-default", reasoning: true };
    const probeDispose = vi.fn();
    const probeReload = vi.fn(async () => {});
    createDaemonAuthRuntimeMock.mockResolvedValueOnce({
      auth: authGatewayMock,
      modelValidator: modelValidatorMock,
      modelRuntime: {},
      dispose: disposeModelsMock,
    } as unknown as DaemonAuthRuntime);
    const pi = await piImportModule.importPi();
    const importPi = vi.spyOn(piImportModule, "importPi").mockResolvedValue({
      ...pi,
      getAgentDir: () => agentDir,
      DefaultResourceLoader: class {
        reload = probeReload;
      },
      SettingsManager: { create: () => ({}) },
      SessionManager: { listAll: async () => [], open: vi.fn(), inMemory: () => ({}) },
      createAgentSession: async () => ({ session: { model: resolvedModel, dispose: probeDispose } }),
    } as never);
    const resolveFactory = vi.spyOn(PiSessionFactory, "resolve").mockResolvedValue(new FakeFactory() as never);
    const originalBun = (globalThis as { Bun?: unknown }).Bun;
    let productionHandler: ((request: Request) => Promise<Response>) | undefined;
    (globalThis as { Bun?: unknown }).Bun = {
      serve: ({ fetch }: { fetch: (request: Request) => Promise<Response> }) => {
        productionHandler = fetch;
        return { port: 43219, stop: vi.fn() };
      },
    };
    let server: Awaited<ReturnType<typeof startServer>> | undefined;

    try {
      server = await startServer({ host: "127.0.0.1", port: 0 });
      const response = await productionHandler!(new Request(`http://127.0.0.1:${server.port}/api/agents`));
      expect(response.status).toBe(200);
      const agents = (await response.json()) as AgentDto[];
      const researchAssistant = agents.find((agent) => agent.name === "research-assistant");
      const search = agents.find((agent) => agent.name === "search");
      expect(researchAssistant).toMatchObject({ effectiveModel: "openai/pi-default" });
      expect(researchAssistant).not.toHaveProperty("model");
      expect(search).toMatchObject({ effectiveModel: "openai/pi-default" });
      expect(search).not.toHaveProperty("model");
      expect(probeReload).toHaveBeenCalledTimes(1);
      expect(probeDispose).toHaveBeenCalledTimes(1);
      expect(() => readFileSync(join(agentDir, "settings.json"), "utf8")).toThrow();
    } finally {
      await server?.stop();
      createLive.mockRestore();
      resolveFactory.mockRestore();
      importPi.mockRestore();
      if (originalBun === undefined) delete (globalThis as { Bun?: unknown }).Bun;
      else (globalThis as { Bun?: unknown }).Bun = originalBun;
    }
  });

  it("wires successful global and project Skill descriptor writes to the daemon LiveConfiguration", async () => {
    const configuration = fakeConfiguration();
    const projectLifecycle: string[] = [];
    const projectDescriptor = join(projectDir, ".easyresearch", "skills", "server-skill", "SKILL.md");
    configuration.live.acquireProject = async (cwd) => {
      projectLifecycle.push(`acquire:${cwd}:${existsSync(projectDescriptor)}`);
      return {
        cwd,
        release: async () => {
          projectLifecycle.push(`release:${cwd}`);
        },
      };
    };
    configuration.live.synchronize = async ({ projectCwds } = {}) => {
      projectLifecycle.push(`synchronize:${projectCwds?.[0]}:${readFileSync(projectDescriptor, "utf8")}`);
      return { status: "unchanged", generation: 1, availabilityEpoch: 1, error: null };
    };
    const createLive = vi.spyOn(liveConfigurationModule, "createLiveConfiguration").mockReturnValue(configuration.live);
    const pi = await piImportModule.importPi();
    const importPi = vi.spyOn(piImportModule, "importPi").mockResolvedValue({
      ...pi,
      getAgentDir: () => agentDir,
      SessionManager: { listAll: async () => [], open: vi.fn() },
    } as never);
    const resolveFactory = vi.spyOn(PiSessionFactory, "resolve").mockResolvedValue(new FakeFactory() as never);
    const originalBun = (globalThis as { Bun?: unknown }).Bun;
    let productionHandler: ((request: Request) => Promise<Response>) | undefined;
    (globalThis as { Bun?: unknown }).Bun = {
      serve: ({ fetch }: { fetch: (request: Request) => Promise<Response> }) => {
        productionHandler = fetch;
        return { port: 43221, stop: vi.fn() };
      },
    };
    let server: Awaited<ReturnType<typeof startServer>> | undefined;

    try {
      server = await startServer({ host: "127.0.0.1", port: 0 });
      const writeConfig = (body: unknown) => productionHandler!(new Request(
        `http://127.0.0.1:${server!.port}/api/config/file`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      ));

      expect((await writeConfig({
        scope: "global",
        path: "skills/server-root.md",
        content: "global descriptor",
      })).status).toBe(200);
      expect(configuration.notifications).toEqual([{ skillsChanged: true }]);

      expect((await writeConfig({
        scope: "project",
        cwd: projectDir,
        path: "skills/server-skill/SKILL.md",
        content: "project descriptor",
      })).status).toBe(200);
      expect(projectLifecycle).toEqual([
        `acquire:${projectDir}:false`,
        `synchronize:${projectDir}:project descriptor`,
        `release:${projectDir}`,
      ]);
    } finally {
      await server?.stop();
      createLive.mockRestore();
      resolveFactory.mockRestore();
      importPi.mockRestore();
      if (originalBun === undefined) delete (globalThis as { Bun?: unknown }).Bun;
      else (globalThis as { Bun?: unknown }).Bun = originalBun;
    }
  });

  it("constructs one daemon LiveConfiguration and injects it into every session factory", async () => {
    const pi = await piImportModule.importPi();
    const createModelRuntime = vi.fn(async () => ({}));
    const importPi = vi.spyOn(piImportModule, "importPi").mockResolvedValue({
      ...pi,
      getAgentDir: () => agentDir,
      ModelRuntime: { create: createModelRuntime },
      SessionManager: { listAll: async () => [], open: vi.fn() },
    } as never);
    let injected: LiveConfiguration | undefined;
    const resolveFactory = vi.spyOn(PiSessionFactory, "resolve").mockImplementation(async (live) => {
      injected = live;
      return new FakeFactory() as never;
    });
    const originalBun = (globalThis as { Bun?: unknown }).Bun;
    const bunStop = vi.fn();
    (globalThis as { Bun?: unknown }).Bun = {
      serve: () => ({ port: 43211, stop: bunStop }),
    };
    let server: Awaited<ReturnType<typeof startServer>> | undefined;

    try {
      server = await startServer({ host: "127.0.0.1", port: 0 });
      expect(createDaemonAuthRuntimeMock).toHaveBeenCalledTimes(1);
      expect(injected).toBeDefined();
      expect(injected?.generation).toBe(1);
      expect(resolveFactory).toHaveBeenCalledWith(injected);
      const daemonOptions = createDaemonAuthRuntimeMock.mock.calls[0]![0];
      await daemonOptions.createModelRuntime();
      expect(createModelRuntime).toHaveBeenCalledWith({
        authPath: join(agentDir, "auth.json"),
        modelsPath: join(agentDir, "models.json"),
        refreshOnCreate: false,
      });

      const events: ConfigurationEvent[] = [];
      const unsubscribe = injected!.subscribe((event) => events.push(event));
      await daemonOptions.onModelsChanged();
      unsubscribe();
      expect(events.at(-1)).toMatchObject({
        type: "config.updated",
        generation: 1,
        availabilityEpoch: 2,
        availabilityChanged: true,
        modelsChanged: false,
        skillsChanged: false,
        runtimeChanged: false,
      });
    } finally {
      await server?.stop();
      resolveFactory.mockRestore();
      importPi.mockRestore();
      if (originalBun === undefined) delete (globalThis as { Bun?: unknown }).Bun;
      else (globalThis as { Bun?: unknown }).Bun = originalBun;
    }
  });

  it("shuts down sessions, configuration, auth, models, and server in dependency order", async () => {
    const order: string[] = [];
    let releaseAuth!: () => void;
    const authCleanup = new Promise<void>((resolve) => {
      releaseAuth = resolve;
    });
    const configuration = fakeConfiguration().live;
    configuration.start = vi.fn(async () => {});
    configuration.close = vi.fn(async () => {
      order.push("configuration");
    });
    const createLive = vi.spyOn(liveConfigurationModule, "createLiveConfiguration").mockReturnValue(configuration);
    const projectWatches: ConfigurationProjectWatches = {
      acquireLease: () => "unused",
      replace: async (_leaseId, request) => ({ applied: true, revision: request.revision }),
      releaseLease: async () => {},
      refresh: async () => ({ generation: configuration.generation, error: configuration.error }),
      close: async () => {
        order.push("project-watches");
      },
    };
    const createProjectWatches = vi.spyOn(
      configurationProjectWatchesModule,
      "createConfigurationProjectWatches",
    ).mockReturnValue(projectWatches);
    authGatewayMock.shutdown.mockImplementation(async () => {
      order.push("auth-start");
      await authCleanup;
      order.push("auth-done");
    });
    disposeModelsMock.mockImplementation(async () => {
      order.push("models");
    });
    const shutdown = vi.spyOn(ActiveSessionRegistry.prototype, "shutdown").mockImplementation(async () => {
      order.push("sessions");
    });
    const pi = await piImportModule.importPi();
    const importPi = vi.spyOn(piImportModule, "importPi").mockResolvedValue({
      ...pi,
      getAgentDir: () => agentDir,
      SessionManager: { listAll: async () => [], open: vi.fn() },
    } as never);
    const resolveFactory = vi.spyOn(PiSessionFactory, "resolve").mockResolvedValue(new FakeFactory() as never);
    const originalBun = (globalThis as { Bun?: unknown }).Bun;
    (globalThis as { Bun?: unknown }).Bun = {
      serve: () => ({
        port: 43212,
        stop: () => {
          order.push("server");
        },
      }),
    };
    let server: Awaited<ReturnType<typeof startServer>> | undefined;

    try {
      server = await startServer({ host: "127.0.0.1", port: 0 });
      const stopping = server.stop();
      await vi.waitFor(() => {
        expect(order).toEqual(["sessions", "project-watches", "configuration", "auth-start"]);
      });
      releaseAuth();
      await stopping;
      expect(order).toEqual([
        "sessions",
        "project-watches",
        "configuration",
        "auth-start",
        "auth-done",
        "models",
        "server",
      ]);
    } finally {
      createLive.mockRestore();
      createProjectWatches.mockRestore();
      shutdown.mockRestore();
      resolveFactory.mockRestore();
      importPi.mockRestore();
      if (originalBun === undefined) delete (globalThis as { Bun?: unknown }).Bun;
      else (globalThis as { Bun?: unknown }).Bun = originalBun;
    }
  });

  it("releases auth and model ownership when LiveConfiguration construction fails", async () => {
    const constructionError = new Error("configuration constructor failed");
    const createLive = vi.spyOn(liveConfigurationModule, "createLiveConfiguration")
      .mockImplementation(() => {
        throw constructionError;
      });
    const pi = await piImportModule.importPi();
    const importPi = vi.spyOn(piImportModule, "importPi").mockResolvedValue({
      ...pi,
      getAgentDir: () => agentDir,
      SessionManager: { listAll: async () => [], open: vi.fn() },
    } as never);

    try {
      await expect(startServer({ host: "127.0.0.1", port: 0 })).rejects.toBe(constructionError);
      expect(authGatewayMock.shutdown).toHaveBeenCalledTimes(1);
      expect(disposeModelsMock).toHaveBeenCalledTimes(1);
    } finally {
      createLive.mockRestore();
      importPi.mockRestore();
    }
  });

  it("retries failed session shutdown before releasing dependent daemon resources", async () => {
    const order: string[] = [];
    const configuration = fakeConfiguration().live;
    configuration.start = vi.fn(async () => {});
    configuration.close = vi.fn(async () => {
      order.push("configuration");
    });
    const createLive = vi.spyOn(liveConfigurationModule, "createLiveConfiguration").mockReturnValue(configuration);
    authGatewayMock.shutdown.mockImplementation(() => {
      order.push("auth");
    });
    disposeModelsMock.mockImplementation(async () => {
      order.push("models");
    });
    const shutdown = vi.spyOn(ActiveSessionRegistry.prototype, "shutdown")
      .mockImplementationOnce(async () => {
        order.push("sessions-failed");
        throw new Error("session cleanup failed");
      })
      .mockImplementationOnce(async () => {
        order.push("sessions-retried");
      });
    const pi = await piImportModule.importPi();
    const importPi = vi.spyOn(piImportModule, "importPi").mockResolvedValue({
      ...pi,
      getAgentDir: () => agentDir,
      SessionManager: { listAll: async () => [], open: vi.fn() },
    } as never);
    const resolveFactory = vi.spyOn(PiSessionFactory, "resolve").mockResolvedValue(new FakeFactory() as never);
    const originalBun = (globalThis as { Bun?: unknown }).Bun;
    (globalThis as { Bun?: unknown }).Bun = {
      serve: () => ({
        port: 43213,
        stop: () => {
          order.push("server");
        },
      }),
    };
    let server: Awaited<ReturnType<typeof startServer>> | undefined;

    try {
      server = await startServer({ host: "127.0.0.1", port: 0 });
      await expect(server.stop()).rejects.toThrow("session cleanup failed");
      expect(order).toEqual(["sessions-failed"]);
      await server.stop();
      expect(order).toEqual([
        "sessions-failed",
        "sessions-retried",
        "configuration",
        "auth",
        "models",
        "server",
      ]);
    } finally {
      createLive.mockRestore();
      shutdown.mockRestore();
      resolveFactory.mockRestore();
      importPi.mockRestore();
      if (originalBun === undefined) delete (globalThis as { Bun?: unknown }).Bun;
      else (globalThis as { Bun?: unknown }).Bun = originalBun;
    }
  });

  it("retries failed configuration close before releasing auth, models, and the Bun server", async () => {
    const order: string[] = [];
    const configuration = fakeConfiguration().live;
    configuration.start = vi.fn(async () => {});
    configuration.close = vi.fn()
      .mockImplementationOnce(async () => {
        order.push("configuration-failed");
        throw new Error("configuration close failed");
      })
      .mockImplementationOnce(async () => {
        order.push("configuration-retried");
      });
    const createLive = vi.spyOn(liveConfigurationModule, "createLiveConfiguration").mockReturnValue(configuration);
    authGatewayMock.shutdown.mockImplementation(async () => {
      order.push("auth");
    });
    disposeModelsMock.mockImplementation(async () => {
      order.push("models");
    });
    const pi = await piImportModule.importPi();
    const importPi = vi.spyOn(piImportModule, "importPi").mockResolvedValue({
      ...pi,
      getAgentDir: () => agentDir,
      SessionManager: { listAll: async () => [], open: vi.fn() },
    } as never);
    const resolveFactory = vi.spyOn(PiSessionFactory, "resolve").mockResolvedValue(new FakeFactory() as never);
    const originalBun = (globalThis as { Bun?: unknown }).Bun;
    (globalThis as { Bun?: unknown }).Bun = {
      serve: () => ({
        port: 43214,
        stop: () => {
          order.push("server");
        },
      }),
    };
    let server: Awaited<ReturnType<typeof startServer>> | undefined;

    try {
      server = await startServer({ host: "127.0.0.1", port: 0 });
      await expect(server.stop()).rejects.toThrow("configuration close failed");
      expect(order).toEqual(["configuration-failed"]);

      await server.stop();
      expect(order).toEqual([
        "configuration-failed",
        "configuration-retried",
        "auth",
        "models",
        "server",
      ]);
    } finally {
      createLive.mockRestore();
      resolveFactory.mockRestore();
      importPi.mockRestore();
      if (originalBun === undefined) delete (globalThis as { Bun?: unknown }).Bun;
      else (globalThis as { Bun?: unknown }).Bun = originalBun;
    }
  });

  it("retries transient configuration cleanup during failed startup before releasing dependencies", async () => {
    const startupError = new Error("configuration startup failed");
    const configuration = fakeConfiguration().live;
    configuration.start = vi.fn(async () => {
      throw startupError;
    });
    configuration.close = vi.fn()
      .mockRejectedValueOnce(new Error("configuration close failed"))
      .mockResolvedValueOnce(undefined);
    const createLive = vi.spyOn(liveConfigurationModule, "createLiveConfiguration").mockReturnValue(configuration);
    const pi = await piImportModule.importPi();
    const importPi = vi.spyOn(piImportModule, "importPi").mockResolvedValue({
      ...pi,
      getAgentDir: () => agentDir,
      SessionManager: { listAll: async () => [], open: vi.fn() },
    } as never);

    try {
      await expect(startServer({ host: "127.0.0.1", port: 0 })).rejects.toBe(startupError);
      expect(configuration.close).toHaveBeenCalledTimes(2);
      expect(authGatewayMock.shutdown).toHaveBeenCalledTimes(1);
      expect(disposeModelsMock).toHaveBeenCalledTimes(1);
    } finally {
      createLive.mockRestore();
      importPi.mockRestore();
    }
  });

  it("waits for a production pending launch and retries real configuration close before daemon teardown", async () => {
    writeFileSync(join(agentDir, "models.json"), '{"providers":{}}');
    const order: string[] = [];
    const startGate = deferred<void>();
    const watcherCallbacks = new Map<string, Array<(...args: unknown[]) => void>>();
    const watcherClose = vi.fn()
      .mockImplementationOnce(async () => {
        order.push("configuration-failed");
        throw new Error("watcher close failed");
      })
      .mockImplementationOnce(async () => {
        order.push("configuration-retried");
      });
    const watch = () => {
      const watcher = {
        on(event: string, listener: (...args: unknown[]) => void) {
          const listeners = watcherCallbacks.get(event) ?? [];
          listeners.push(listener);
          watcherCallbacks.set(event, listeners);
          return watcher;
        },
        close: watcherClose,
      };
      queueMicrotask(() => {
        for (const listener of watcherCallbacks.get("ready") ?? []) listener();
      });
      return watcher;
    };
    const actualCreateLive = liveConfigurationModule.createLiveConfiguration;
    const createLive = vi.spyOn(liveConfigurationModule, "createLiveConfiguration")
      .mockImplementation((options) => actualCreateLive({ ...options, watch: watch as never }));
    const runtimeDispose = vi.fn(async () => {});
    const createModelRuntime = vi.fn(async () => ({
      dispose: runtimeDispose,
      refresh: async () => ({ aborted: false, errors: new Map<string, Error>() }),
      getError: () => undefined,
      getModels: () => [],
      getAvailableSnapshot: () => [],
      getProviders: () => [],
      getProvider: () => undefined,
      getProviderAuthStatus: () => ({ configured: false }),
      setRuntimeApiKey: async () => {},
      checkAuth: async () => undefined,
      login: async () => ({ type: "api_key" as const, key: "unused" }),
      logout: async () => {},
    }));
    const actualAuthRuntime = await vi.importActual<typeof import("./auth-runtime")>("./auth-runtime");
    createDaemonAuthRuntimeMock.mockImplementation(async (options) => {
      const daemon = await actualAuthRuntime.createDaemonAuthRuntime(options);
      return {
        auth: {
          ...daemon.auth,
          shutdown: async () => {
            await daemon.auth.shutdown();
            order.push("auth");
          },
        },
        modelValidator: daemon.modelValidator,
        modelRuntime: daemon.modelRuntime,
        noAuthProviderIds: daemon.noAuthProviderIds,
        dispose: async () => {
          order.push("models");
          await daemon.dispose();
        },
      };
    });
    const pi = await piImportModule.importPi();
    const importPi = vi.spyOn(piImportModule, "importPi").mockResolvedValue({
      ...pi,
      getAgentDir: () => agentDir,
      ModelRuntime: { create: createModelRuntime },
      SessionManager: { listAll: async () => [], open: vi.fn() },
    } as never);
    const pendingFactory: SessionFactory = {
      create(options) {
        const adapter = new FakeAdapter(options);
        adapter.start = async () => {
          await startGate.promise;
        };
        adapter.stop = async () => {
          adapter.stopped++;
          order.push("sessions");
        };
        return adapter;
      },
    };
    const resolveFactory = vi.spyOn(PiSessionFactory, "resolve").mockResolvedValue(pendingFactory as never);
    const originalBun = (globalThis as { Bun?: unknown }).Bun;
    let productionHandler: ((request: Request) => Promise<Response>) | undefined;
    (globalThis as { Bun?: unknown }).Bun = {
      serve: ({ fetch }: { fetch: (request: Request) => Promise<Response> }) => {
        productionHandler = fetch;
        return {
          port: 43216,
          stop: () => {
            order.push("server");
          },
        };
      },
    };
    let server: Awaited<ReturnType<typeof startServer>> | undefined;

    try {
      server = await startServer({ host: "127.0.0.1", port: 0 });
      const launch = productionHandler!(new Request(`http://127.0.0.1:${server.port}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: projectDir }),
      }));
      await vi.waitFor(() => expect(FakeAdapter.all.at(-1)).toBeDefined());

      const firstStop = server.stop();
      await Promise.resolve();
      const closeCallsBeforeLaunchSettled = watcherClose.mock.calls.length;
      startGate.resolve();

      expect((await launch).status).toBe(500);
      await expect(firstStop).rejects.toThrow("Configuration monitoring could not close safely.");
      expect(closeCallsBeforeLaunchSettled).toBe(0);
      expect(order).toEqual(["sessions", "configuration-failed"]);

      await server.stop();
      expect(order).toEqual([
        "sessions",
        "configuration-failed",
        "configuration-retried",
        "auth",
        "models",
        "server",
      ]);
      expect(runtimeDispose).toHaveBeenCalledTimes(2);
    } finally {
      await server?.stop().catch(() => {});
      createLive.mockRestore();
      resolveFactory.mockRestore();
      importPi.mockRestore();
      if (originalBun === undefined) delete (globalThis as { Bun?: unknown }).Bun;
      else (globalThis as { Bun?: unknown }).Bun = originalBun;
    }
  });

  it("renames a connected session by dispatching the /name command", async () => {
    setup({ renameSession: async (id, name) => void registry.prompt(id, `/name ${name}`) });
    const created = await registry.create({ cwd: projectDir });
    const adapter = FakeAdapter.all.at(-1)!;

    const res = await handler(
      new Request(`http://localhost/api/sessions/${created.id}/name`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Paper v2" }),
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(adapter.prompts).toEqual(["/name Paper v2"]);
  });

  it("renames a historical session through the rename service", async () => {
    const renameSession = vi.fn(async () => {});
    setup({ renameSession });
    historySessions = [
      {
        id: "h1",
        path: "/agent/sessions/--p--/a.jsonl",
        cwd: projectDir,
        created: "2026-08-01T00:00:00.000Z",
        modified: "2026-08-01T00:00:00.000Z",
        messageCount: 1,
        firstMessage: "hello",
      },
    ];

    const res = await handler(
      new Request(`http://localhost/api/sessions/h1/name`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Renamed" }),
      }),
    );

    expect(res.status).toBe(200);
    expect(renameSession).toHaveBeenCalledWith("h1", "Renamed");
  });

  it("clears the name with an empty string body value", async () => {
    const renameSession = vi.fn(async () => {});
    setup({ renameSession });

    const res = await handler(
      new Request(`http://localhost/api/sessions/h1/name`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "" }),
      }),
    );

    expect(res.status).toBe(200);
    expect(renameSession).toHaveBeenCalledWith("h1", "");
  });

  it("rejects non-string session names with 400", async () => {
    setup();
    const res = await handler(
      new Request(`http://localhost/api/sessions/h1/name`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: 42 }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown session id", async () => {
    setup({ renameSession: async () => { throw new UnknownSessionError("Unknown session: nope"); } });
    const res = await handler(
      new Request(`http://localhost/api/sessions/nope/name`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "x" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("lists config projects from session cwds", async () => {
    setup({
      listConfigProjects: async () => ({ home: agentDir, projects: [{ cwd: projectDir }] }),
    });
    const res = await handler(new Request("http://localhost/api/config/projects"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ home: agentDir, projects: [{ cwd: projectDir }] });
  });
});

interface SessionInfoLike {
  id: string;
  path: string;
  cwd: string;
  name?: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
}

function sessionInfo(patch: Partial<SessionInfoLike>): SessionInfoLike {
  return {
    id: "sess",
    path: "/agent/sessions/sess.jsonl",
    cwd: "/proj",
    created: new Date("2026-08-10T00:00:00.000Z"),
    modified: new Date("2026-08-10T00:00:00.000Z"),
    messageCount: 1,
    firstMessage: "write a paper",
    ...patch,
  };
}

describe("toUserSessionSummaries", () => {
  it("excludes internal easyresearch child session lines from the user home list", () => {
    expect(toUserSessionSummaries([
      sessionInfo({ id: "main", name: undefined, firstMessage: "write a paper" }),
      sessionInfo({ id: "child", name: "easyresearch:search", firstMessage: "Task: search" }),
    ])).toEqual([
      expect.objectContaining({ id: "main", firstMessage: "write a paper" }),
    ]);
  });

  it("uses literal startsWith filtering, including the exact internal prefix", () => {
    const results = toUserSessionSummaries([
      sessionInfo({ id: "s1", name: "easyresearch:search", firstMessage: "child" }),
      sessionInfo({ id: "s2", name: "my easyresearch:search notes", firstMessage: "user" }),
      sessionInfo({ id: "s3", name: "easyresearch:", firstMessage: "user" }),
      sessionInfo({ id: "s4", name: "lazyresearch:search", firstMessage: "legacy child" }),
    ]);
    expect(results.map((session) => session.id)).toEqual(["s2"]);
  });
});
