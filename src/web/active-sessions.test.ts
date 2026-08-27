import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionTreeNode } from "@earendil-works/pi-coding-agent";
import { ActiveSessionRegistry, UnknownSessionError } from "./active-sessions";
import { assertSafeExtensionSources } from "../runtime/extensions-guard";
import type {
  SessionAdapter,
  SessionFactory,
  SessionState,
  StartSessionOptions,
  SteerPromptOptions,
  WebSlashCommand,
} from "./session-adapter";
import type { Logger } from "../runtime/logger";
import type { FileWatcherEvent, FileWatcherFactory } from "./file-watcher";

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

const cwd = "/test/project";
const sessionPath = "/agent/sessions/--test-project--/a.jsonl";

const noopLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const fakeState: SessionState = {
  thinkingLevel: "medium",
  isStreaming: false,
  isCompacting: false,
  sessionFile: sessionPath,
  sessionId: "sess-1",
  sessionName: "My Session",
  messageCount: 3,
};

interface FakeAdapterStats {
  started: number;
  stopped: number;
  prompts: string[];
  aborts: number;
  setModels: Array<{ provider: string; modelId: string }>;
  setThinkingLevels: string[];
}

class FakeAdapter implements SessionAdapter {
  static all: FakeAdapter[] = [];
  static nextId = 0;
  events = new Set<(event: unknown) => void>();
  stats: FakeAdapterStats = { started: 0, stopped: 0, prompts: [], aborts: 0, setModels: [], setThinkingLevels: [] };
  stateOverrides: Partial<SessionState> = {};
  startError: Error | null = null;
  getStateError: Error | null = null;
  commandsResult: WebSlashCommand[] = [];
  treeResult: Awaited<ReturnType<SessionAdapter["getTree"]>> = {
    tree: [],
    leafId: null,
    filterMode: "default",
    skipBranchSummaryPrompt: false,
  };
  navigateCalls: string[] = [];
  steeringResult: string[] = [];
  contextUsage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  compactionState: "idle" | "queued" | "running" = "idle";
  compactionPolicy = { triggerPercent: 70, enabled: true };
  runtimeConfigurationGeneration = 0;
  backgroundWork = false;
  startImpl: () => Promise<void> = async () => {};
  stopImpl: () => Promise<void> = async () => {};
  abortImpl: () => Promise<void> = async () => {};
  onEventCalls = 0;
  getStateImpl: (() => Promise<SessionState>) | undefined;
  onEventHook: (() => void) | undefined;

  constructor(public options: StartSessionOptions) {
    FakeAdapter.all.push(this);
  }

  async start() {
    if (this.startError) throw this.startError;
    this.stats.started++;
    await this.startImpl();
  }
  async stop() {
    this.stats.stopped++;
    await this.stopImpl();
  }
  async prompt(message: string, options?: SteerPromptOptions) {
    this.stats.prompts.push(`${message}${options?.streamingBehavior === "steer" ? " (steer)" : ""}`);
  }
  async abort() {
    this.stats.aborts++;
    await this.abortImpl();
  }
  async setModel(provider: string, modelId: string) {
    this.stats.setModels.push({ provider, modelId });
  }
  async setThinkingLevel(level: string) {
    this.stats.setThinkingLevels.push(level);
  }
  async getState(): Promise<SessionState> {
    if (this.getStateError) throw this.getStateError;
    if (this.getStateImpl) return this.getStateImpl();
    return { ...fakeState, ...this.stateOverrides, sessionId: `sess-${++FakeAdapter.nextId}`, sessionFile: this.options.sessionPath ?? sessionPath };
  }
  async getMessages(): Promise<AgentMessage[]> {
    return [];
  }
  getInlineUsage() {
    return [];
  }
  getSteeringMessages(): readonly string[] {
    return this.steeringResult;
  }
  hasBackgroundWork(): boolean {
    return this.backgroundWork;
  }
  async getCommands(): Promise<WebSlashCommand[]> {
    return this.commandsResult;
  }
  async getTree(): Promise<Awaited<ReturnType<SessionAdapter["getTree"]>>> {
    return this.treeResult;
  }
  async navigateTree(entryId: string) {
    this.navigateCalls.push(entryId);
    return { cancelled: false, leafId: this.treeResult.leafId };
  }
  async compact() {
    return { state: "running" as const };
  }
  getCompactionState() {
    return this.compactionState;
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
    this.onEventCalls += 1;
    const hook = this.onEventHook;
    this.onEventHook = undefined;
    hook?.();
    this.events.add(listener);
    return () => this.events.delete(listener);
  }
}

class FakeFactory implements SessionFactory {
  created: FakeAdapter[] = [];
  startError: Error | null = null;
  getStateError: Error | null = null;
  backgroundWork = false;
  startImpl: () => Promise<void> = async () => {};
  stopImpl: () => Promise<void> = async () => {};
  getStateImpl: (() => Promise<SessionState>) | undefined;
  onEventHook: (() => void) | undefined;
  create(options: StartSessionOptions): SessionAdapter {
    const adapter = new FakeAdapter(options);
    adapter.startError = this.startError;
    adapter.getStateError = this.getStateError;
    adapter.backgroundWork = this.backgroundWork;
    adapter.startImpl = this.startImpl;
    adapter.stopImpl = this.stopImpl;
    adapter.getStateImpl = this.getStateImpl;
    adapter.onEventHook = this.onEventHook;
    this.created.push(adapter);
    return adapter;
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

class FakeWatcherFactory implements FileWatcherFactory {
  private nextLease = 0;
  created: Array<{
    cwd: string;
    onEvent: (event: FileWatcherEvent) => void;
    close: ReturnType<typeof vi.fn>;
    leases: Map<string, { revision: number; directories: Set<string> }>;
  }> = [];

  create({ cwd, onEvent }: { cwd: string; onEvent: (event: FileWatcherEvent) => void }) {
    const close = vi.fn(async () => {});
    const leases = new Map<string, { revision: number; directories: Set<string> }>();
    this.created.push({ cwd, onEvent, close, leases });
    return {
      acquireLease: () => {
        const leaseId = `lease-${++this.nextLease}`;
        leases.set(leaseId, { revision: -1, directories: new Set() });
        return leaseId;
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
}

describe("ActiveSessionRegistry", () => {
  let factory: FakeFactory;
  let registry: ActiveSessionRegistry;
  let watcherFactory: FakeWatcherFactory;

  beforeEach(() => {
    FakeAdapter.all = [];
    FakeAdapter.nextId = 0;
    factory = new FakeFactory();
    watcherFactory = new FakeWatcherFactory();
    registry = new ActiveSessionRegistry(factory, noopLogger, { idleTimeoutMs: -1 }, watcherFactory);
    vi.mocked(assertSafeExtensionSources).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates a session with exact cwd and launches a client", async () => {
    const created = await registry.create({ cwd });
    expect(created.cwd).toBe(cwd);
    expect(factory.created[0]?.options).toEqual({ cwd });
    expect(vi.mocked(assertSafeExtensionSources)).toHaveBeenCalledWith({ cwd });
    expect(factory.created[0]?.stats.started).toBe(1);
    expect(created.status).toBe("ready");
    expect(created.id).toBe(fakeState.sessionId);
  });

  it("unsubscribing the last listener never stops the child", async () => {
    const created = await registry.create({ cwd });
    const listener = vi.fn();
    const unsubscribe = registry.subscribe(created.id, listener);
    unsubscribe();
    expect(factory.created[0]?.stats.stopped).toBe(0);
  });

  it("starts a cwd watcher and forwards its event to session subscribers", async () => {
    const created = await registry.create({ cwd });
    const listener = vi.fn();
    registry.subscribe(created.id, listener);

    watcherFactory.emit({
      type: "file.watcher.updated",
      properties: { file: `${cwd}/new.md`, event: "add" },
    });

    expect(watcherFactory.created[0]?.cwd).toBe(cwd);
    expect(listener).toHaveBeenCalledWith({
      type: "file.watcher.updated",
      properties: { file: `${cwd}/new.md`, event: "add" },
    });
  });

  it("isolates registry subscribers and snapshots listener removal during ordered fan-out", async () => {
    const created = await registry.create({ cwd });
    const adapter = factory.created[0]!;
    let throwingCalls = 0;
    registry.subscribe(created.id, () => {
      throwingCalls += 1;
      throw new Error("subscriber failed");
    });
    const received: string[] = [];
    let removeThird = () => {};
    registry.subscribe(created.id, (event) => {
      const generation = (event as { generation: number }).generation;
      received.push(`second:${generation}`);
      removeThird();
    });
    removeThird = registry.subscribe(created.id, (event) => {
      received.push(`third:${(event as { generation: number }).generation}`);
    });
    const emit = (generation: number) => {
      adapter.runtimeConfigurationGeneration = generation;
      for (const listener of [...adapter.events]) {
        listener({ type: "runtime_configuration_applied", generation });
      }
    };

    expect(() => emit(4)).not.toThrow();

    expect(received).toEqual(["second:4", "third:4"]);
    await expect(registry.snapshot(created.id)).resolves.toMatchObject({
      session: { status: "ready" },
      runtimeConfigurationGeneration: 4,
    });

    expect(() => emit(5)).not.toThrow();

    expect(throwingCalls).toBe(2);
    expect(received).toEqual(["second:4", "third:4", "second:5"]);
    await expect(registry.snapshot(created.id)).resolves.toMatchObject({
      session: { status: "ready" },
      runtimeConfigurationGeneration: 5,
    });
  });

  it("closes the watcher on stop and replaces it on restart", async () => {
    const created = await registry.create({ cwd });
    const first = watcherFactory.created[0]!;

    await registry.restart(created.id);

    expect(first.close).toHaveBeenCalledTimes(1);
    expect(watcherFactory.created).toHaveLength(2);
    expect(watcherFactory.created[1]?.cwd).toBe(cwd);
  });

  it("prompts the underlying adapter", async () => {
    const created = await registry.create({ cwd });
    await registry.prompt(created.id, "hello");
    expect(factory.created[0]?.stats.prompts).toEqual(["hello"]);
  });

  it("stop deactivates: removes the registry entry", async () => {
    const created = await registry.create({ cwd });
    await registry.stop(created.id);
    expect(factory.created[0]?.stats.stopped).toBe(1);
    expect(registry.list().find((s) => s.id === created.id)).toBeUndefined();
  });

  it("emits session_deactivated only after durable cleanup succeeds", async () => {
    const created = await registry.create({ cwd });
    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    factory.created[0]!.stopImpl = () => stopGate;
    const listener = vi.fn();
    registry.subscribe(created.id, listener);
    const stopping = registry.stop(created.id);
    await Promise.resolve();

    expect(listener).not.toHaveBeenCalled();
    expect(registry.has(created.id)).toBe(true);
    releaseStop();
    await stopping;

    expect(listener).toHaveBeenCalledWith({ type: "session_deactivated", sessionId: created.id });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("retains activation after failed cleanup and deactivates on retry", async () => {
    const created = await registry.create({ cwd });
    const failure = new Error("durable cleanup failed");
    let fail = true;
    factory.created[0]!.stopImpl = async () => {
      if (!fail) return;
      fail = false;
      throw failure;
    };
    const listener = vi.fn();
    registry.subscribe(created.id, listener);

    await expect(registry.stop(created.id)).rejects.toBe(failure);
    expect(listener).not.toHaveBeenCalledWith({ type: "session_deactivated", sessionId: created.id });
    expect(registry.has(created.id)).toBe(true);

    await registry.stop(created.id);
    expect(listener).toHaveBeenCalledWith({ type: "session_deactivated", sessionId: created.id });
    expect(registry.has(created.id)).toBe(false);
    expect(factory.created[0]?.stats.stopped).toBe(2);
  });

  it("keeps abort connected and ready while explicit stop disposes the runtime", async () => {
    const created = await registry.create({ cwd });
    const adapter = factory.created[0]!;
    adapter.events.forEach((listener) => listener({ type: "agent_start" }));

    await registry.abort(created.id);

    expect(registry.list()).toContainEqual(expect.objectContaining({ id: created.id, status: "ready" }));
    expect(adapter.stats.stopped).toBe(0);

    await registry.stop(created.id);
    expect(registry.has(created.id)).toBe(false);
    expect(adapter.stats.stopped).toBe(1);
  });

  it("reconciles abort completion with a newer active run instead of forcing ready", async () => {
    const created = await registry.create({ cwd });
    const adapter = factory.created[0]!;
    let releaseAbort!: () => void;
    adapter.abortImpl = () => new Promise<void>((resolve) => {
      releaseAbort = resolve;
    });
    adapter.events.forEach((listener) => listener({ type: "agent_start" }));

    const aborting = registry.abort(created.id);
    await vi.waitFor(() => expect(adapter.stats.aborts).toBe(1));
    adapter.events.forEach((listener) => listener({ type: "agent_settled" }));
    adapter.events.forEach((listener) => listener({ type: "agent_start" }));
    adapter.stateOverrides.isStreaming = true;
    releaseAbort();
    await aborting;

    expect(registry.list()).toContainEqual(expect.objectContaining({
      id: created.id,
      status: "running",
      isStreaming: true,
    }));
  });

  it("forwards setModel to the adapter with provider and model id", async () => {
    const created = await registry.create({ cwd });
    await registry.setModel(created.id, "openai", "gpt-4o");
    expect(factory.created[0]?.stats.setModels).toEqual([{ provider: "openai", modelId: "gpt-4o" }]);
  });

  it("throws UnknownSessionError for unknown ids in model accessors", async () => {
    await expect(registry.setModel("nope", "openai", "gpt-4o")).rejects.toThrow(UnknownSessionError);
    await expect(registry.setThinkingLevel("nope", "high")).rejects.toThrow(UnknownSessionError);
    await expect(registry.getSessionPath("nope")).rejects.toThrow(UnknownSessionError);
    await expect(registry.getCwd("nope")).rejects.toThrow(UnknownSessionError);
    await expect(registry.getResearchAssistantModel("nope")).rejects.toThrow(UnknownSessionError);
    await expect(registry.getResearchAssistantThinking("nope")).rejects.toThrow(UnknownSessionError);
  });

  it("exposes the record session path and cwd", async () => {
    const created = await registry.open({ cwd, sessionPath });
    await expect(registry.getSessionPath(created.id)).resolves.toBe(sessionPath);
    await expect(registry.getCwd(created.id)).resolves.toBe(cwd);
  });

  it("reports the Research Assistant model from session state as provider/id", async () => {
    const created = await registry.create({ cwd });
    factory.created[0]!.stateOverrides = { model: { provider: "deepseek", id: "ds-v3" } as never };
    await expect(registry.getResearchAssistantModel(created.id)).resolves.toBe("deepseek/ds-v3");
  });

  it("reports no Research Assistant model when session state has none", async () => {
    const created = await registry.create({ cwd });
    await expect(registry.getResearchAssistantModel(created.id)).resolves.toBeUndefined();
  });

  it("forwards setThinkingLevel to the adapter", async () => {
    const created = await registry.create({ cwd });
    await registry.setThinkingLevel(created.id, "high");
    expect(factory.created[0]?.stats.setThinkingLevels).toEqual(["high"]);
  });

  it("reports the Research Assistant thinking level from session state", async () => {
    const created = await registry.create({ cwd });
    factory.created[0]!.stateOverrides = { thinkingLevel: "high" };
    await expect(registry.getResearchAssistantThinking(created.id)).resolves.toBe("high");
  });

  it("follows session_info_changed events emitted by the runtime", async () => {
    const created = await registry.create({ cwd });
    const adapter = FakeAdapter.all.at(-1)!;

    adapter.events.forEach((listener) => listener({ type: "session_info_changed", name: "From Event" }));
    expect(registry.list()[0]?.sessionName).toBe("From Event");

    adapter.events.forEach((listener) => listener({ type: "session_info_changed", name: undefined }));
    expect(registry.list()[0]?.sessionName).toBeUndefined();
  });

  it("exposes has() only for connected records", async () => {
    expect(registry.has("missing")).toBe(false);
    const created = await registry.create({ cwd });
    expect(registry.has(created.id)).toBe(true);
    await registry.stop(created.id);
    expect(registry.has(created.id)).toBe(false);
  });

  it("recognizes only exact cwd spellings owned by connected sessions", async () => {
    expect(registry.hasConnectedCwd(cwd)).toBe(false);
    const created = await registry.create({ cwd });

    expect(registry.hasConnectedCwd(cwd)).toBe(true);
    expect(registry.hasConnectedCwd(`${cwd}/.`)).toBe(false);

    const adapter = factory.created[0]!;
    adapter.getStateError = new Error("state unavailable");
    await registry.snapshot(created.id);
    expect(registry.hasConnectedCwd(cwd)).toBe(false);

    await registry.stop(created.id);
    expect(registry.hasConnectedCwd(cwd)).toBe(false);
  });

  it("launches a fresh session with the resolved thinking level", async () => {
    const resolving = new ActiveSessionRegistry(
      factory,
      noopLogger,
      { idleTimeoutMs: -1, resolveLaunchThinking: async () => "medium" },
      watcherFactory,
    );
    await resolving.create({ cwd });
    expect(factory.created[0]?.options.thinking).toBe("medium");
  });

  it("never passes a resolved thinking level to resumed sessions", async () => {
    const resolving = new ActiveSessionRegistry(
      factory,
      noopLogger,
      { idleTimeoutMs: -1, resolveLaunchThinking: async () => "medium" },
      watcherFactory,
    );
    await resolving.open({ cwd, sessionPath });
    expect(factory.created[0]?.options.thinking).toBeUndefined();
  });

  it("passes no thinking level when nothing is resolved", async () => {
    await registry.create({ cwd });
    expect(factory.created[0]?.options.thinking).toBeUndefined();
  });

  it("makes two simultaneous stops call child stop once", async () => {
    const created = await registry.create({ cwd });
    await Promise.all([registry.stop(created.id), registry.stop(created.id)]);
    expect(factory.created[0]?.stats.stopped).toBe(1);
  });

  it("shares one failed stop attempt, then retries retained abort ownership exactly once", async () => {
    const created = await registry.create({ cwd });
    const adapter = factory.created[0]!;
    const listener = vi.fn();
    registry.subscribe(created.id, listener);
    let rejectFirst!: (error: Error) => void;
    const firstAttempt = new Promise<void>((_resolve, reject) => {
      rejectFirst = reject;
    });
    let resolveSecond!: () => void;
    const secondAttempt = new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });
    adapter.stopImpl = vi.fn()
      .mockImplementationOnce(() => firstAttempt)
      .mockImplementationOnce(() => secondAttempt);

    const firstStops = [registry.stop(created.id), registry.stop(created.id)];
    const firstOutcomesPromise = Promise.allSettled(firstStops);
    await vi.waitFor(() => expect(adapter.stats.stopped).toBe(1));
    rejectFirst(new Error("Session stop could not abort active work. Retry stop."));
    const firstOutcomes = await firstOutcomesPromise;

    expect(firstOutcomes.map(({ status }) => status)).toEqual(["rejected", "rejected"]);
    expect(registry.has(created.id)).toBe(true);
    expect(listener).not.toHaveBeenCalled();

    const retryStops = [registry.stop(created.id), registry.stop(created.id)];
    const retryOutcomesPromise = Promise.allSettled(retryStops);
    await vi.waitFor(() => expect(adapter.stats.stopped).toBe(2));
    resolveSecond();
    expect((await retryOutcomesPromise).map(({ status }) => status)).toEqual(["fulfilled", "fulfilled"]);

    expect(registry.has(created.id)).toBe(false);
    await registry.stop(created.id);
    expect(adapter.stats.stopped).toBe(2);
    expect(watcherFactory.created[0]?.close).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("opens a historical path and reuses the active entry on duplicate open", async () => {
    const opened = await registry.open({ cwd, sessionPath });
    expect(factory.created[0]?.options.sessionPath).toBe(sessionPath);
    const again = await registry.open({ cwd, sessionPath });
    expect(again.id).toBe(opened.id);
    expect(factory.created).toHaveLength(1);
  });

  it("singleflights simultaneous opens of the same exact session and cwd", async () => {
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    factory.startImpl = () => startGate;

    const first = registry.open({ cwd, sessionPath });
    const second = registry.open({ cwd, sessionPath });
    expect(first).toBe(second);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const createdBeforeRelease = factory.created.length;
    releaseStart();
    const [firstOpened, secondOpened] = await Promise.all([first, second]);

    expect(createdBeforeRelease).toBe(1);
    expect(factory.created).toHaveLength(1);
    expect(firstOpened).toEqual(secondOpened);
    expect(registry.list()).toEqual([firstOpened]);
    expect(factory.created[0]?.onEventCalls).toBe(2);
  });

  it("does not merge opens from distinct exact cwd and session identities", async () => {
    const first = await registry.open({ cwd, sessionPath });
    const second = await registry.open({ cwd: "/other/project", sessionPath });
    const third = await registry.open({ cwd, sessionPath: "/sessions/other.jsonl" });

    expect(new Set([first.id, second.id, third.id]).size).toBe(3);
    expect(factory.created.map(({ options }) => options)).toEqual([
      { cwd, sessionPath },
      { cwd: "/other/project", sessionPath },
      { cwd, sessionPath: "/sessions/other.jsonl" },
    ]);
  });

  it("shares concurrent open failure and permits one later retry", async () => {
    const failure = new Error("recovery failed");
    let rejectStart!: (error: Error) => void;
    const startGate = new Promise<void>((_resolve, reject) => {
      rejectStart = reject;
    });
    factory.startImpl = () => startGate;

    const first = registry.open({ cwd, sessionPath });
    const second = registry.open({ cwd, sessionPath });
    const failed = Promise.allSettled([first, second]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const createdBeforeFailure = factory.created.length;
    rejectStart(failure);
    const results = await failed;

    expect(createdBeforeFailure).toBe(1);
    expect(results).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ]);
    expect(registry.list()).toEqual([]);
    expect(factory.created).toHaveLength(1);

    factory.startImpl = async () => {};
    const retried = await registry.open({ cwd, sessionPath });
    expect(retried.status).toBe("ready");
    expect(factory.created).toHaveLength(2);
  });

  it("re-launches a stopped session on open instead of reusing the dead entry", async () => {
    const created = await registry.open({ cwd, sessionPath });
    await registry.stop(created.id);
    const reopened = await registry.open({ cwd, sessionPath });
    expect(reopened.status).toBe("ready");
    expect(factory.created).toHaveLength(2);
    expect(factory.created[1]?.options.sessionPath).toBe(sessionPath);
    expect(factory.created[1]?.stats.started).toBe(1);
  });

  it("re-launches an errored session on open instead of reusing the adapter", async () => {
    const created = await registry.open({ cwd, sessionPath });
    const adapter = factory.created[0]!;
    adapter.getStateError = new Error("state unavailable");
    await registry.snapshot(created.id);
    const reopened = await registry.open({ cwd, sessionPath });
    expect(reopened.status).toBe("ready");
    expect(factory.created).toHaveLength(2);
    expect(factory.created[1]?.stats.started).toBe(1);
  });

  it("open reuses an idle session after agent_settled", async () => {
    const created = await registry.open({ cwd, sessionPath });
    const adapter = factory.created[0]!;
    adapter.events.forEach((l) => l({ type: "agent_start" } as never));
    adapter.events.forEach((l) => l({ type: "agent_settled" } as never));
    const reopened = await registry.open({ cwd, sessionPath });
    expect(reopened.status).toBe("ready");
    expect(reopened.id).toBe(created.id);
    expect(factory.created).toHaveLength(1);
    expect(factory.created[0]?.stats.stopped).toBe(0);
  });

  it("snapshot includes pending steering messages while live (ADR-083)", async () => {
    const created = await registry.open({ cwd, sessionPath });
    factory.created[0]!.steeringResult = ["note one", "note two"];

    const snapshot = await registry.snapshot(created.id);

    expect(snapshot.steering).toEqual(["note one", "note two"]);
  });

  it("snapshot includes native context usage and the effective compaction policy/state", async () => {
    const created = await registry.open({ cwd, sessionPath });
    const adapter = factory.created[0]!;
    adapter.contextUsage = { tokens: 70_000, contextWindow: 100_000, percent: 70 };
    adapter.compactionState = "queued";
    adapter.compactionPolicy = { triggerPercent: 80, enabled: false };

    const snapshot = await registry.snapshot(created.id);

    expect(snapshot.contextUsage).toEqual({ tokens: 70_000, contextWindow: 100_000, percent: 70 });
    expect(snapshot.compactionPolicy).toEqual({ triggerPercent: 80, enabled: false });
    expect(snapshot.compactionState).toBe("queued");
  });

  it("snapshot reports the root adapter's authoritative applied generation", async () => {
    const created = await registry.open({ cwd, sessionPath });
    const adapter = factory.created[0]!;

    expect((await registry.snapshot(created.id)).runtimeConfigurationGeneration).toBe(0);

    adapter.runtimeConfigurationGeneration = 7;

    expect((await registry.snapshot(created.id)).runtimeConfigurationGeneration).toBe(7);
  });

  it("snapshot omits steering for non-live sessions (ADR-083)", async () => {
    const created = await registry.create({ cwd });
    const adapter = factory.created[0]!;
    adapter.steeringResult = ["should not leak"];
    adapter.getStateError = new Error("state unavailable");
    const spy = vi.spyOn(adapter, "getSteeringMessages");

    const snapshot = await registry.snapshot(created.id);

    expect(snapshot.session.status).toBe("error");
    expect(snapshot.steering).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("snapshot rejects after deactivation", async () => {
    const created = await registry.create({ cwd });
    await registry.stop(created.id);
    await expect(registry.snapshot(created.id)).rejects.toThrow(UnknownSessionError);
  });

  it("snapshots an errored session without reading messages after state fails", async () => {
    const created = await registry.create({ cwd });
    const adapter = factory.created[0]!;
    const broken = vi.spyOn(adapter, "getMessages");
    adapter.getStateError = new Error("state unavailable");
    const snapshot = await registry.snapshot(created.id);
    expect(broken).not.toHaveBeenCalled();
    expect(snapshot.session.status).toBe("error");
    expect(snapshot.session.error).toBe("state unavailable");
    expect(snapshot.messages).toEqual([]);
  });

  it("restarts with the same session path in a replacement adapter", async () => {
    const created = await registry.open({ cwd, sessionPath });
    await registry.restart(created.id);
    expect(factory.created).toHaveLength(2);
    expect(factory.created[1]?.options.sessionPath).toBe(sessionPath);
    expect(factory.created[1]?.stats.started).toBe(1);
  });

  it("stays ready when a prompt never starts an agent run", async () => {
    const created = await registry.create({ cwd });
    expect(created.status).toBe("ready");
    await registry.prompt(created.id, "hello");
    // Pi's RPC prompt resolves even when the run fails preflight and emits no
    // agent_settled, so the session must not be left marked running.
    const dto = registry.list().find((s) => s.id === created.id);
    expect(dto?.status).toBe("ready");
    expect(dto?.isStreaming).toBe(false);
  });

  it("retains an idle child on agent_settled", async () => {
    const created = await registry.create({ cwd });
    const adapter = factory.created[0]!;
    const listener = vi.fn();
    registry.subscribe(created.id, listener);
    adapter.events.forEach((l) => l({ type: "agent_start" } as never));
    expect(registry.list().find((s) => s.id === created.id)?.status).toBe("running");
    adapter.events.forEach((l) => l({ type: "agent_settled" } as never));
    expect(registry.list().find((s) => s.id === created.id)?.status).toBe("ready");
    expect(registry.listActive().find((s) => s.id === created.id)?.status).toBe("ready");
    expect(factory.created[0]?.stats.stopped).toBe(0);
    expect(listener).not.toHaveBeenCalledWith({ type: "session_deactivated", sessionId: created.id });
  });

  it("expires an idle child after the configured timeout", async () => {
    vi.useFakeTimers();
    registry = new ActiveSessionRegistry(factory, noopLogger, { idleTimeoutMs: 1000 });
    const created = await registry.create({ cwd });
    const adapter = factory.created[0]!;
    adapter.events.forEach((l) => l({ type: "agent_start" } as never));
    adapter.events.forEach((l) => l({ type: "agent_settled" } as never));

    await vi.advanceTimersByTimeAsync(999);
    expect(factory.created[0]?.stats.stopped).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(registry.list().find((s) => s.id === created.id)).toBeUndefined());
    expect(factory.created[0]?.stats.stopped).toBe(1);
  });

  it("holds the idle lease while a root-ready child is running", async () => {
    vi.useFakeTimers();
    factory.backgroundWork = true;
    registry = new ActiveSessionRegistry(factory, noopLogger, { idleTimeoutMs: 1000 }, watcherFactory);
    const created = await registry.create({ cwd });
    const adapter = factory.created[0]!;

    await vi.advanceTimersByTimeAsync(10_000);
    expect(registry.has(created.id)).toBe(true);
    expect(adapter.stats.stopped).toBe(0);

    adapter.backgroundWork = false;
    adapter.events.forEach((listener) => listener({ type: "subagent_supervisor", status: "complete" }));
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(registry.has(created.id)).toBe(false));
  });

  it("holds and then clears the idle lease for a pending terminal notification", async () => {
    vi.useFakeTimers();
    registry = new ActiveSessionRegistry(factory, noopLogger, { idleTimeoutMs: 1000 }, watcherFactory);
    const created = await registry.create({ cwd });
    const adapter = factory.created[0]!;
    adapter.backgroundWork = true;
    adapter.events.forEach((listener) => listener({ type: "subagent_supervisor", status: "complete" }));

    await vi.advanceTimersByTimeAsync(1000);
    expect(registry.has(created.id)).toBe(true);
    expect(adapter.stats.stopped).toBe(0);

    adapter.backgroundWork = false;
    adapter.events.forEach((listener) => listener({ type: "agent_settled" }));
    await vi.advanceTimersByTimeAsync(999);
    expect(registry.has(created.id)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(registry.has(created.id)).toBe(false));
  });

  it("rechecks background work inside an already-scheduled idle callback", async () => {
    vi.useFakeTimers();
    registry = new ActiveSessionRegistry(factory, noopLogger, { idleTimeoutMs: 1000 }, watcherFactory);
    const created = await registry.create({ cwd });
    const adapter = factory.created[0]!;

    await vi.advanceTimersByTimeAsync(999);
    adapter.backgroundWork = true;
    await vi.advanceTimersByTimeAsync(1);
    expect(registry.has(created.id)).toBe(true);
    expect(adapter.stats.stopped).toBe(0);

    adapter.backgroundWork = false;
    adapter.events.forEach((listener) => listener({ type: "subagent_supervisor", status: "complete" }));
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(registry.has(created.id)).toBe(false));
  });

  it("retains the connected record when idle cleanup fails and permits retry", async () => {
    vi.useFakeTimers();
    registry = new ActiveSessionRegistry(factory, noopLogger, { idleTimeoutMs: 0 }, watcherFactory);
    const created = await registry.create({ cwd });
    const adapter = factory.created[0]!;
    const failure = new Error("idle cleanup failed");
    let fail = true;
    adapter.stopImpl = async () => {
      if (!fail) return;
      fail = false;
      throw failure;
    };
    const listener = vi.fn();
    registry.subscribe(created.id, listener);

    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(registry.has(created.id)).toBe(true);
    expect(listener).not.toHaveBeenCalledWith({ type: "session_deactivated", sessionId: created.id });

    await registry.stop(created.id);
    expect(registry.has(created.id)).toBe(false);
    expect(adapter.stats.stopped).toBe(2);
  });

  it("resets an idle timeout when the active session is touched", async () => {
    vi.useFakeTimers();
    registry = new ActiveSessionRegistry(factory, noopLogger, { idleTimeoutMs: 1000 });
    const created = await registry.create({ cwd });
    await vi.advanceTimersByTimeAsync(900);
    await registry.touch(created.id);
    await vi.advanceTimersByTimeAsync(900);
    expect(factory.created[0]?.stats.stopped).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(factory.created[0]?.stats.stopped).toBe(1));
  });

  it("does not expire when the timeout is disabled", async () => {
    vi.useFakeTimers();
    registry = new ActiveSessionRegistry(factory, noopLogger, { idleTimeoutMs: -1 });
    const created = await registry.create({ cwd });
    await vi.advanceTimersByTimeAsync(3_600_001);
    expect(registry.list().find((s) => s.id === created.id)).toBeDefined();
    expect(factory.created[0]?.stats.stopped).toBe(0);
  });

  it("disconnects immediately when the timeout is zero", async () => {
    vi.useFakeTimers();
    factory.backgroundWork = true;
    registry = new ActiveSessionRegistry(factory, noopLogger, { idleTimeoutMs: 0 }, watcherFactory);
    const created = await registry.create({ cwd });
    await vi.advanceTimersByTimeAsync(0);
    expect(registry.list().find((s) => s.id === created.id)).toBeDefined();

    const adapter = factory.created[0]!;
    adapter.backgroundWork = false;
    adapter.events.forEach((listener) => listener({ type: "agent_settled" }));
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(registry.list().find((s) => s.id === created.id)).toBeUndefined());
  });

  it("restarts the idle deadline from a replacement runtime", async () => {
    vi.useFakeTimers();
    registry = new ActiveSessionRegistry(factory, noopLogger, { idleTimeoutMs: 1000 }, watcherFactory);
    const created = await registry.open({ cwd, sessionPath });
    await vi.advanceTimersByTimeAsync(900);

    const restarted = await registry.restart(created.id);
    expect(factory.created[0]?.stats.stopped).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(registry.has(restarted.id)).toBe(true);
    expect(factory.created[1]?.stats.stopped).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(registry.has(restarted.id)).toBe(false));
  });

  it("lists connected records but excludes adapters with unreadable state", async () => {
    const ready = await registry.create({ cwd });
    const errored = await registry.create({ cwd: "/other/project" });
    factory.created[1]!.getStateError = new Error("state unavailable");
    await registry.snapshot(errored.id);
    expect(registry.listActive().map((session) => session.id)).toEqual([ready.id]);
    expect(registry.list().find((session) => session.id === errored.id)?.status).toBe("error");
  });

  it("ignores message events when deciding run status", async () => {
    const created = await registry.create({ cwd });
    const adapter = factory.created[0]!;
    adapter.events.forEach((listener) => listener({ type: "message_start" } as never));
    expect(registry.list().find((s) => s.id === created.id)?.status).toBe("ready");
    adapter.events.forEach((listener) => listener({ type: "agent_start" } as never));
    expect(registry.list().find((s) => s.id === created.id)?.status).toBe("running");
  });

  it("surfaces an adapter state error as status error", async () => {
    const created = await registry.create({ cwd });
    const adapter = factory.created[0]!;
    adapter.getStateError = new Error("state unavailable");
    await registry.snapshot(created.id);
    expect(registry.list().find((s) => s.id === created.id)?.status).toBe("error");
    expect(registry.list().find((s) => s.id === created.id)?.error).toBe("state unavailable");
  });

  it("logs and propagates unchanged when the session runtime fails to launch", async () => {
    loggerMock.error.mockClear();
    const launchError = new Error("boom");
    factory.startError = launchError;
    const registryWithMock = new ActiveSessionRegistry(factory, loggerMock);
    await expect(registryWithMock.create({ cwd })).rejects.toBe(launchError);
    expect(factory.created[0]?.stats.stopped).toBe(1);
    expect(loggerMock.error).toHaveBeenCalledWith(
      "session runtime launch failed",
      expect.objectContaining({ cwd, sessionPath: "", error: "boom" }),
    );
  });

  it("releases startup ownership without leaving an idle timer after launch failure", async () => {
    vi.useFakeTimers();
    const launchError = new Error("startup failed");
    factory.startError = launchError;
    factory.backgroundWork = true;
    const failing = new ActiveSessionRegistry(
      factory,
      noopLogger,
      { idleTimeoutMs: 0 },
      watcherFactory,
    );

    await expect(failing.open({ cwd, sessionPath })).rejects.toBe(launchError);
    expect(failing.list()).toEqual([]);
    expect(factory.created[0]?.stats.stopped).toBe(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(factory.created[0]?.stats.stopped).toBe(1);
  });

  it("stops the incomplete adapter and logs when getState fails during launch", async () => {
    loggerMock.error.mockClear();
    const getStateError = new Error("state boom");
    factory.getStateError = getStateError;
    const registryWithMock = new ActiveSessionRegistry(factory, loggerMock);
    await expect(registryWithMock.create({ cwd })).rejects.toBe(getStateError);
    expect(registryWithMock.list()).toEqual([]);
    expect(factory.created[0]?.stats.stopped).toBe(1);
    expect(loggerMock.error).toHaveBeenCalledWith(
      "session runtime launch failed",
      expect.objectContaining({ cwd, sessionPath: "", error: "state boom" }),
    );
  });

  it("shutdown stops all clients even while their background leases are held", async () => {
    factory.backgroundWork = true;
    await registry.create({ cwd });
    await registry.open({ cwd, sessionPath });
    await registry.shutdown();
    expect(factory.created.every((a) => a.stats.stopped >= 1)).toBe(true);
  });

  it("shutdown owns an in-flight open through startup and durable stop", async () => {
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    factory.startImpl = () => startGate;
    const opening = registry.open({ cwd, sessionPath });
    await new Promise((resolve) => setTimeout(resolve, 0));

    let shutdownResolved = false;
    const shuttingDown = registry.shutdown().then(() => {
      shutdownResolved = true;
    });
    await Promise.resolve();
    expect(shutdownResolved).toBe(false);

    releaseStart();
    await expect(opening).rejects.toThrow(/shutting down/i);
    await shuttingDown;
    expect(factory.created[0]?.stats.stopped).toBe(1);
    expect(registry.list()).toEqual([]);
  });

  it("settles every active stop before reporting shutdown failures and retries retained records", async () => {
    const first = await registry.create({ cwd });
    const second = await registry.create({ cwd: "/test/other" });
    const firstAdapter = factory.created[0]!;
    const secondAdapter = factory.created[1]!;
    firstAdapter.stopImpl = async () => {
      throw new Error("first stop failed");
    };
    let resolveSecond!: () => void;
    secondAdapter.stopImpl = () => new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });
    let outcome = "pending";

    const shutdown = registry.shutdown().then(
      () => {
        outcome = "fulfilled";
      },
      () => {
        outcome = "rejected";
      },
    );
    await vi.waitFor(() => expect(firstAdapter.stats.stopped).toBe(1));
    await vi.waitFor(() => expect(secondAdapter.stats.stopped).toBe(1));
    await Promise.resolve();
    expect(outcome).toBe("pending");

    resolveSecond();
    await shutdown;
    expect(outcome).toBe("rejected");
    expect(registry.has(first.id)).toBe(true);
    expect(registry.has(second.id)).toBe(false);

    firstAdapter.stopImpl = async () => {};
    await registry.shutdown();
    expect(firstAdapter.stats.stopped).toBe(2);
    expect(registry.list()).toEqual([]);
  });

  it.each(["client start", "state acquisition"] as const)(
    "owns a create pending at %s until shutdown stops its client",
    async (boundary) => {
      const gate = deferred<void>();
      if (boundary === "client start") {
        factory.startImpl = () => gate.promise;
      } else {
        factory.getStateImpl = async () => {
          await gate.promise;
          return { ...fakeState, sessionId: "pending-state", sessionFile: sessionPath };
        };
      }
      const launch = registry.create({ cwd });
      await vi.waitFor(() => expect(factory.created).toHaveLength(1));
      if (boundary === "state acquisition") {
        await vi.waitFor(() => expect(factory.created[0]?.stats.started).toBe(1));
      }
      let shutdownSettled = false;
      const shutdown = registry.shutdown().finally(() => {
        shutdownSettled = true;
      });

      await Promise.resolve();
      const settledBeforeBoundary = shutdownSettled;
      gate.resolve();

      await expect(launch).rejects.toThrow(/shutting down/i);
      await shutdown;
      expect(settledBeforeBoundary).toBe(false);
      expect(factory.created[0]?.stats.stopped).toBe(1);
      expect(registry.list()).toEqual([]);
    },
  );

  it("owns watcher and listener setup when shutdown starts reentrantly", async () => {
    let shutdown: Promise<void> | undefined;
    factory.onEventHook = () => {
      shutdown = registry.shutdown();
    };

    const launch = registry.create({ cwd });

    await expect(launch).rejects.toThrow(/shutting down/i);
    await shutdown;
    expect(factory.created[0]?.events.size).toBe(0);
    expect(factory.created[0]?.stats.stopped).toBe(1);
    expect(watcherFactory.created[0]?.close).toHaveBeenCalledTimes(1);
    expect(registry.list()).toEqual([]);
  });

  it("retains a cancelled pending client when its first stop fails and retries only that cleanup", async () => {
    let shutdown: Promise<void> | undefined;
    factory.onEventHook = () => {
      shutdown = registry.shutdown();
    };
    factory.stopImpl = vi.fn()
      .mockRejectedValueOnce(new Error("pending stop failed"))
      .mockResolvedValueOnce(undefined);

    const launch = registry.create({ cwd });

    await expect(launch).rejects.toThrow(/shutting down/i);
    await expect(shutdown).rejects.toThrow("pending stop failed");
    expect(factory.created[0]?.stats.stopped).toBe(1);
    expect(registry.list()).toEqual([]);

    await registry.shutdown();
    expect(factory.created[0]?.stats.stopped).toBe(2);
    expect(watcherFactory.created[0]?.close).toHaveBeenCalledTimes(1);
    await registry.shutdown();
    expect(factory.created[0]?.stats.stopped).toBe(2);
  });

  it("reserves a restart before stopping the old client so shutdown cannot admit a replacement", async () => {
    const created = await registry.create({ cwd });
    const stopGate = deferred<void>();
    factory.created[0]!.stopImpl = () => stopGate.promise;

    const restarting = registry.restart(created.id);
    await vi.waitFor(() => expect(factory.created[0]?.stats.stopped).toBe(1));
    const shutdown = registry.shutdown();
    stopGate.resolve();

    await expect(restarting).rejects.toThrow(/shutting down/i);
    await shutdown;
    expect(factory.created).toHaveLength(1);
    expect(registry.list()).toEqual([]);
  });

  it("rejects new create and open launches after shutdown begins", async () => {
    await registry.shutdown();

    await expect(registry.create({ cwd })).rejects.toThrow(/shutting down/i);
    await expect(registry.open({ cwd, sessionPath })).rejects.toThrow(/shutting down/i);
    expect(factory.created).toHaveLength(0);
  });
  describe("tree and commands (ADR-066)", () => {
    it("delegates getCommands/getTree/navigateTree to the adapter", async () => {
      const created = await registry.create({ cwd });
      const adapter = FakeAdapter.all.at(-1)!;
      adapter.commandsResult = [{ name: "skill:arxiv", source: "skill" }];
      adapter.treeResult = {
        tree: [],
        leafId: "leaf-1",
        filterMode: "default",
        skipBranchSummaryPrompt: false,
      };

      await expect(registry.getCommands(created.id)).resolves.toEqual(adapter.commandsResult);
      await expect(registry.getTree(created.id)).resolves.toEqual(adapter.treeResult);
      await registry.navigateTree(created.id, "entry-7");
      expect(adapter.navigateCalls).toEqual(["entry-7"]);
    });

    it("rejects unknown sessions", async () => {
      await expect(registry.getCommands("nope")).rejects.toThrow(UnknownSessionError);
      await expect(registry.getTree("nope")).rejects.toThrow(UnknownSessionError);
      await expect(registry.navigateTree("nope", "e1")).rejects.toThrow(UnknownSessionError);
    });
  });
});
