import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionFactory, JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentDefinitionExtension } from "../extensions/agent-definition";
import type { AgentRuntimeBinding } from "../runtime/agent-runtime-binding";
import { excludedLocalShellTools } from "../runtime/platform-tools";
import type { AgentConfig } from "./agents";
import {
  SubagentCoordinator,
  type CoordinatorSessionManager,
  type ReservedDispatch,
} from "./coordinator";
import {
  createStageSessionLauncher,
  RetryableStageSessionCreationError,
  type StageAgentSession,
  type StageLaunchOptions,
  type StageSessionDependencies,
} from "./stage-session";
import { SubagentSupervisor, type SupervisableAgentSession } from "./supervisor";

function agentRow(name: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name,
    description: name,
    enabled: true,
    builtin: name !== "reviewer",
    source: name === "reviewer" ? "global" : "bundled",
    filePath: `/agents/${name}.md`,
    systemPrompt: `${name} prompt`,
    tools: ["read", "web-search"],
    effectiveTools: ["read", "web-search"],
    skills: ["paper-search"],
    effectiveSkills: ["paper-search"],
    effectiveSkillPaths: ["/skills/paper-search"],
    missingSkills: [],
    subagents: [],
    model: "openai/gpt-test",
    thinking: "high",
    ...overrides,
  };
}

const stageAgent = agentRow("search", { systemPrompt: "Search carefully." });

function assistant(text: string): Extract<AgentMessage, { role: "assistant" }> {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "openai",
    model: "test-model",
    usage: {
      input: 2,
      output: 3,
      cacheRead: 4,
      cacheWrite: 5,
      totalTokens: 14,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
    },
    stopReason: "stop",
    timestamp: 1,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  return settled;
}

class MemoryCoordinatorSessionManager implements CoordinatorSessionManager {
  readonly entries: unknown[] = [];

  getSessionId(): string {
    return "root-session";
  }
  getSessionFile(): string {
    return "/sessions/root.jsonl";
  }
  getEntries(): unknown[] {
    return this.entries;
  }
  appendCustomEntry(customType: string, data?: unknown): string {
    const id = `entry-${this.entries.length}`;
    this.entries.push({ type: "custom", id, customType, data });
    return id;
  }
}

class FakeLiveConfiguration {
  generation = 1;
  compactionPolicy = { triggerPercent: 70, globalEnabled: true, globalKeepRecentTokens: 20_000 };
  onResolve: (() => void) | undefined;
  resolveCalls = 0;
  readonly synchronizeOptions: Array<{ projectCwds?: readonly string[] } | undefined> = [];
  readonly acquiredProjects: string[] = [];
  projectReleaseCalls = 0;
  projectReleaseImpl: () => Promise<void> = async () => {};
  private readonly listeners = new Set<(event: any) => void>();

  constructor(private rows: AgentConfig[]) {}

  async synchronize(options?: { projectCwds?: readonly string[] }): Promise<void> {
    this.synchronizeOptions.push(options);
  }
  async acquireProject(cwd: string): Promise<{ cwd: string; release(): Promise<void> }> {
    this.acquiredProjects.push(cwd);
    return {
      cwd,
      release: async () => {
        this.projectReleaseCalls += 1;
        await this.projectReleaseImpl();
      },
    };
  }
  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }
  async resolveAgents(): Promise<AgentConfig[]> {
    const rows = this.rows;
    this.resolveCalls += 1;
    this.onResolve?.();
    return rows;
  }
  subscribe(listener: (event: any) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  publish(
    rows: AgentConfig[],
    compactionPolicy = this.compactionPolicy,
  ): void {
    this.rows = rows;
    this.compactionPolicy = { ...compactionPolicy };
    this.generation += 1;
    for (const listener of [...this.listeners]) {
      listener({
        type: "config.updated",
        generation: this.generation,
        agentsChanged: true,
        modelsChanged: true,
        skillsChanged: false,
        runtimeChanged: true,
      });
    }
  }

  publishSkills(rows: AgentConfig[]): void {
    this.rows = rows;
    this.generation += 1;
    for (const listener of [...this.listeners]) {
      listener({
        type: "config.updated",
        generation: this.generation,
        agentsChanged: false,
        modelsChanged: false,
        skillsChanged: true,
        runtimeChanged: true,
      });
    }
  }
}

function liveFor(agent: AgentConfig = stageAgent): FakeLiveConfiguration {
  return new FakeLiveConfiguration([
    agentRow("research-assistant", { subagents: [agent.name] }),
    agent,
  ]);
}

class FakeStageSession implements StageAgentSession {
  agent = {
    steeringMode: "one-at-a-time" as "all" | "one-at-a-time",
    state: { model: undefined as Model<any> | undefined },
  };
  thinkingLevel: ThinkingLevel = "high";
  model = { provider: "openai", id: "gpt-test" } as Model<any>;
  isStreaming = false;
  isIdle = true;
  readonly promptCalls: string[] = [];
  readonly activeTools: string[][] = [];
  readonly names: string[] = [];
  readonly bindingCalls: unknown[] = [];
  readonly modelCalls: Model<any>[] = [];
  readonly thinkingCalls: ThinkingLevel[] = [];
  readonly listeners = new Set<(event: unknown) => void>();
  readonly entries: unknown[] = [];
  readonly sessionManager = { getEntries: () => this.entries };
  abortCalls = 0;
  disposeCalls = 0;
  unsubscribeCalls = 0;
  reloadCalls = 0;
  waitForIdleCalls = 0;
  bindError?: Error;
  promptStart?: () => void;
  abortImpl: () => Promise<void> = async () => {};
  disposeImpl: () => void = () => {};
  unsubscribeImpl: () => void = () => {};
  waitForIdleImpl: () => Promise<void> = async () => {};

  constructor(
    readonly sessionId: string,
    readonly sessionFile: string,
    private readonly promptPromise: Promise<void>,
  ) {
    Object.defineProperty(this.agent.state, "model", {
      get: () => this.model,
      set: (value: Model<any> | undefined) => {
        this.model = value as Model<any>;
      },
    });
  }

  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.unsubscribeCalls += 1;
      this.unsubscribeImpl();
      this.listeners.delete(listener);
    };
  }
  async bindExtensions(bindings: unknown): Promise<void> {
    this.bindingCalls.push(bindings);
    if (this.bindError) throw this.bindError;
  }
  setSessionName(name: string): void {
    this.names.push(name);
  }
  getAllTools(): Array<{ name: string }> {
    return [{ name: "read" }, { name: "web-search" }, { name: "subagent" }];
  }
  setActiveToolsByName(names: string[]): void {
    this.activeTools.push(names);
  }
  async reload(): Promise<void> {
    this.reloadCalls += 1;
  }
  async setModel(model: Model<any>): Promise<void> {
    this.modelCalls.push(model);
    this.model = model;
  }
  setThinkingLevel(level: ThinkingLevel): void {
    this.thinkingCalls.push(level);
    this.thinkingLevel = level;
  }
  async waitForIdle(): Promise<void> {
    this.waitForIdleCalls += 1;
    await this.waitForIdleImpl();
  }
  async navigateTree(): Promise<{ cancelled: boolean }> {
    return { cancelled: false };
  }
  prompt(message: string): Promise<void> {
    this.promptCalls.push(message);
    this.promptStart?.();
    return this.promptPromise;
  }
  async sendCustomMessage(
    _message: { customType: string; content: string; display: boolean; details?: unknown },
    _options: { deliverAs: "steer"; triggerTurn: boolean },
  ): Promise<void> {}
  async abort(): Promise<void> {
    this.abortCalls += 1;
    await this.abortImpl();
  }
  dispose(): void {
    this.disposeCalls += 1;
    this.disposeImpl();
  }
  emit(event: unknown): void {
    for (const listener of this.listeners) listener(event);
  }
  emitAssistantEndAndPersist(text = "stage complete"): void {
    this.emit({ type: "message_end", message: assistant(text) });
    writeFileSync(this.sessionFile, `${JSON.stringify({ type: "session", id: this.sessionId })}\n`);
  }
}

class FakeDirectChildSupervisor {
  readonly attached: StageAgentSession[] = [];
  readonly turnGuards: Array<(() => Promise<void>) | undefined> = [];
  readonly abortReasons: string[] = [];
  abortImpl: () => Promise<void> = async () => {};
  waitForQuiescenceImpl: () => Promise<void> = async () => {};
  disposeImpl: () => Promise<void> = async () => {};
  disposeCalls = 0;
  runtimeCoherentCalls = 0;

  attach(session: StageAgentSession, ensureTriggeredTurnReady?: () => Promise<void>): void {
    this.attached.push(session);
    this.turnGuards.push(ensureTriggeredTurnReady);
  }
  waitForQuiescence(): Promise<void> {
    return this.waitForQuiescenceImpl();
  }
  runtimeBecameCoherent(): void {
    this.runtimeCoherentCalls += 1;
  }
  async abortAll(reason: string): Promise<void> {
    this.abortReasons.push(reason);
    await this.abortImpl();
  }
  async dispose(): Promise<void> {
    this.disposeCalls += 1;
    await this.disposeImpl();
  }
}

interface DependencyHarness {
  dependencies: StageSessionDependencies;
  calls: Array<{ name: string; value?: unknown }>;
  rawSettings: ReturnType<typeof fakeSettingsManager>;
  supervisors: FakeDirectChildSupervisor[];
  bindingDisposals: string[];
  openedManager: {
    getSessionId(): string;
    getCwd(): string;
    getSessionFile(): string;
  };
}

function model(name = "model-metadata"): Model<any> {
  return {
    provider: "openai",
    id: "gpt-test",
    name,
    api: "openai-completions",
    baseUrl: "http://localhost.invalid",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  } as Model<any>;
}

function fakeSettingsManager<T extends object>(base: T): T & {
  getCompactionSettings(): { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
  applyOverrides(overrides: { compaction: { enabled: boolean; reserveTokens: number; keepRecentTokens: number } }): void;
} {
  let compaction = { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 };
  return Object.assign(base, {
    getCompactionSettings: () => ({ ...compaction }),
    applyOverrides: (overrides: { compaction: typeof compaction }) => {
      compaction = { ...overrides.compaction };
    },
  });
}

function dependencyHarness(session: FakeStageSession): DependencyHarness {
  const calls: Array<{ name: string; value?: unknown }> = [];
  const supervisors: FakeDirectChildSupervisor[] = [];
  const bindingDisposals: string[] = [];
  const rawSettings = fakeSettingsManager({ getGlobalSettings: () => ({}) });
  const openedManager = {
    getSessionId: () => session.sessionId,
    getCwd: () => "/project",
    getSessionFile: () => session.sessionFile,
  };
  return {
    calls,
    rawSettings,
    supervisors,
    bindingDisposals,
    openedManager,
    dependencies: {
      agentDir: "/agent",
      createSessionManager: (cwd) => {
        calls.push({ name: "createManager", value: cwd });
        return { kind: "new", cwd };
      },
      openSessionManager: (path) => {
        calls.push({ name: "openManager", value: path });
        return openedManager;
      },
      createSettingsManager: (cwd, agentDir) => {
        calls.push({ name: "settings", value: { cwd, agentDir } });
        return rawSettings;
      },
      createModelRuntime: async () => ({
        refresh: async () => ({ aborted: false, errors: new Map() }),
        getError: () => undefined,
        getModel: (provider: string, id: string) => provider === "openai" && id === "gpt-test" ? model() : undefined,
        getAvailableSnapshot: () => [model()],
        getProvider: (provider: string) => provider === "openai" ? { id: provider } : undefined,
        getProviderAuthStatus: () => ({ configured: true }),
        dispose: async () => {
          bindingDisposals.push("binding");
        },
      }),
      createResourceLoader: (options) => {
        calls.push({ name: "loader", value: options });
        return { reload: async () => {} };
      },
      createAgentSession: async (options) => {
        calls.push({ name: "createSession", value: options });
        session.model = options.model as Model<any>;
        session.thinkingLevel = options.thinkingLevel as ThinkingLevel;
        return { session };
      },
      createDirectChildSupervisor: (coordinator) => {
        const supervisor = new FakeDirectChildSupervisor();
        supervisors.push(supervisor);
        calls.push({ name: "supervisor", value: { coordinator, supervisor } });
        return supervisor as unknown as SubagentSupervisor;
      },
      createExtensionFactories: ({ binding, coordinator, supervisor }) => [
        { name: "stage", caller: binding.current().name, coordinator, supervisor },
        { name: "web-search" },
      ],
      resolveAutomaticModel: async () => undefined,
    },
  };
}

function freshReservation(): ReservedDispatch {
  return {
    launchId: "launch-1",
    ownerSessionId: "owner-1",
    toolCallId: "tool-1",
    agent: "search",
    agentId: "search_0",
    continuation: false,
  };
}

function stageOptions(
  coordinator: SubagentCoordinator,
  liveConfiguration: FakeLiveConfiguration = liveFor(),
  reservation: ReservedDispatch = freshReservation(),
): StageLaunchOptions {
  return {
    reservation,
    agent: stageAgent,
    callerAgent: "research-assistant",
    task: "find papers",
    cwd: "/project",
    model: "openai/gpt-test",
    thinking: "high",
    coordinator,
    liveConfiguration,
  };
}

class ExtensionResourceHost {
  prompt: string[] = [];
  skillPaths: string[] = [];
  private readonly handlers = new Map<string, Array<(...args: any[]) => any>>();

  constructor(
    private readonly options: any,
    private readonly session: FakeStageSession,
  ) {}

  async reload(): Promise<void> {
    this.handlers.clear();
    this.prompt = this.options.appendSystemPromptOverride(["Pi base"]);
    for (const entry of this.options.extensionFactories as Array<{ factory: ExtensionFactory }>) {
      await entry.factory({
        getAllTools: () => this.session.getAllTools(),
        on: (event: string, handler: (...args: any[]) => any) => {
          const handlers = this.handlers.get(event) ?? [];
          handlers.push(handler);
          this.handlers.set(event, handlers);
        },
        setActiveTools: (names: string[]) => this.session.setActiveToolsByName(names),
      } as never);
    }
  }

  async emit(event: string, payload: unknown, context: unknown): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const handler of [...(this.handlers.get(event) ?? [])]) results.push(await handler(payload, context));
    return results;
  }

  async discover(reason: "startup" | "reload"): Promise<void> {
    const results = await this.emit(
      "resources_discover",
      { cwd: "/project", reason },
      { cwd: "/project" },
    );
    this.skillPaths = results.flatMap((result) =>
      result && typeof result === "object" && Array.isArray((result as { skillPaths?: unknown }).skillPaths)
        ? (result as { skillPaths: string[] }).skillPaths
        : []
    );
  }
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "easyresearch-stage-launch-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("createStageSessionLauncher", () => {
  it("materializes before completion and binds live runtime resources to the supervisor-owned session", async () => {
    const prompt = deferred<void>();
    const session = new FakeStageSession("child-1", join(root, "child-1.jsonl"), prompt.promise);
    const harness = dependencyHarness(session);
    const coordinator = new SubagentCoordinator(new MemoryCoordinatorSessionManager());
    const live = liveFor();
    const handle = await createStageSessionLauncher(harness.dependencies)(stageOptions(coordinator, live));

    session.emitAssistantEndAndPersist();
    await handle.materialized;
    expect(await isSettled(handle.completion)).toBe(false);
    prompt.resolve();

    await expect(handle.completion).resolves.toMatchObject({
      exitCode: 0,
      agentId: "search_0",
      sessionId: "child-1",
      sessionPath: session.sessionFile,
      stopReason: "stop",
      usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: 0.25, contextTokens: 14, turns: 1 },
    });
    expect(handle).toMatchObject({ agentId: "search_0", childSessionId: "child-1", sessionPath: session.sessionFile });
    expect(harness.calls.find((call) => call.name === "createManager")?.value).toBe("/project");
    const loader = harness.calls.find((call) => call.name === "loader")?.value as {
      additionalSkillPaths: string[];
      appendSystemPromptOverride(base: string[]): string[];
      extensionFactories: unknown[];
    };
    expect(loader.additionalSkillPaths).toEqual([]);
    expect(loader.appendSystemPromptOverride(["Pi base"])).toEqual(["Pi base", "Search carefully."]);
    expect(loader.extensionFactories).toEqual([
      { name: "stage", caller: "search", coordinator, supervisor: harness.supervisors[0] },
      { name: "web-search" },
    ]);
    const stageCreateOptions = harness.calls.find(
      (call) => call.name === "createSession",
    )?.value as Record<string, unknown>;
    const stageLoaderOptions = harness.calls.find(
      (call) => call.name === "loader",
    )?.value as Record<string, unknown>;
    expect(stageCreateOptions.settingsManager).toBe(harness.rawSettings);
    expect(stageLoaderOptions.settingsManager).toBe(harness.rawSettings);
    expect(stageCreateOptions).toMatchObject({
      cwd: "/project",
      thinkingLevel: "high",
      model: { provider: "openai", id: "gpt-test" },
      sessionManager: { kind: "new", cwd: "/project" },
      excludeTools: excludedLocalShellTools(process.platform),
    });
    expect(stageCreateOptions).not.toHaveProperty("tools");
    expect(session.names).toEqual(["easyresearch:search"]);
    expect(session.agent.steeringMode).toBe("all");
    expect(session.promptCalls).toEqual(["Task: find papers"]);
    expect(harness.supervisors[0]?.attached).toEqual([session]);
    const turnGuard = harness.supervisors[0]?.turnGuards[0];
    expect(turnGuard).toBeTypeOf("function");
    const synchronizationBaseline = live.synchronizeOptions.length;
    const waitForIdleBaseline = session.waitForIdleCalls;
    session.isIdle = false;
    session.waitForIdleImpl = async () => {
      session.isIdle = true;
    };
    await turnGuard?.();
    expect(session.waitForIdleCalls).toBe(waitForIdleBaseline + 1);
    expect(live.synchronizeOptions).toHaveLength(synchronizationBaseline + 1);
    expect(live.acquiredProjects).toEqual(["/project"]);
    expect(live.synchronizeOptions.slice(0, 2)).toEqual([
      { projectCwds: ["/project"] },
      { projectCwds: ["/project"] },
    ]);

    await handle.dispose();
    expect(harness.supervisors[0]?.disposeCalls).toBe(1);
    expect(session.disposeCalls).toBe(1);
    expect(harness.bindingDisposals).toEqual(["binding"]);
    expect(live.projectReleaseCalls).toBe(1);
  });

  it("lets the real stage wake guard recover a transient triggered batch on its bounded retry", async () => {
    const prompt = deferred<void>();
    const session = new FakeStageSession("child-1", join(root, "child-1.jsonl"), prompt.promise);
    const harness = dependencyHarness(session);
    const coordinator = new SubagentCoordinator(new MemoryCoordinatorSessionManager());
    const handle = await createStageSessionLauncher(harness.dependencies)(stageOptions(coordinator));
    const guard = harness.supervisors[0]?.turnGuards[0];
    expect(guard).toBeTypeOf("function");
    let guardAttempts = 0;
    session.isIdle = false;
    session.waitForIdleImpl = async () => {
      guardAttempts += 1;
      if (guardAttempts === 1) throw new Error("transient stage readiness failure");
      session.isIdle = true;
    };
    const notificationEntries: unknown[] = [];
    const notificationManager: CoordinatorSessionManager = {
      getSessionId: () => session.sessionId,
      getSessionFile: () => session.sessionFile,
      getEntries: () => notificationEntries,
      appendCustomEntry(customType, data) {
        const id = `entry-${notificationEntries.length}`;
        notificationEntries.push({ type: "custom", id, customType, data });
        return id;
      },
    };
    const notificationCoordinator = new SubagentCoordinator(notificationManager);
    notificationCoordinator.recordNotificationBatch({
      batchId: "stage-triggered-batch",
      ownerSessionId: session.sessionId,
      launchIds: [],
      content: "stage hidden handoff",
      triggerTurn: true,
    });
    const scheduled: Array<() => void> = [];
    const supervisor = new SubagentSupervisor({
      coordinator: notificationCoordinator,
      launchStage: async () => {
        throw new Error("not used");
      },
      schedule: (run) => scheduled.push(run),
    });
    const sent: string[] = [];
    session.sendCustomMessage = async (message) => {
      sent.push(message.content);
      const persisted = { role: "custom", ...message };
      session.entries.push(persisted);
      for (const listener of session.listeners) listener({ type: "message_end", message: persisted });
    };
    supervisor.attach(session as unknown as SupervisableAgentSession, guard);

    scheduled.shift()?.();
    await vi.waitFor(() => {
      expect(guardAttempts).toBe(1);
      expect(scheduled).toHaveLength(1);
    });

    scheduled.shift()?.();
    await vi.waitFor(() => expect(sent).toEqual(["stage hidden handoff"]));
    expect(guardAttempts).toBe(2);
    await supervisor.waitForQuiescence();
    await supervisor.dispose();

    session.emitAssistantEndAndPersist();
    await handle.materialized;
    prompt.resolve();
    await handle.completion;
    await handle.dispose();
  });

  it("waits for nested quiescence and the resulting stage turn before completion", async () => {
    const prompt = deferred<void>();
    const nestedQuiescence = deferred<void>();
    const resultingTurn = deferred<void>();
    const session = new FakeStageSession("writing-child", join(root, "writing-child.jsonl"), prompt.promise);
    session.waitForIdleImpl = () => resultingTurn.promise;
    const harness = dependencyHarness(session);
    const coordinator = new SubagentCoordinator(new MemoryCoordinatorSessionManager());
    const handle = await createStageSessionLauncher(harness.dependencies)(stageOptions(coordinator));
    harness.supervisors[0]!.waitForQuiescenceImpl = () => nestedQuiescence.promise;

    session.emitAssistantEndAndPersist();
    await handle.materialized;
    prompt.resolve();
    expect(await isSettled(handle.completion)).toBe(false);
    nestedQuiescence.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.waitForIdleCalls).toBe(1);
    expect(await isSettled(handle.completion)).toBe(false);
    resultingTurn.resolve();

    await handle.completion;
    await handle.dispose();
  });

  it("publishes only delta-shaped child events", async () => {
    const prompt = deferred<void>();
    const session = new FakeStageSession("child-1", join(root, "child-1.jsonl"), prompt.promise);
    const coordinator = new SubagentCoordinator(new MemoryCoordinatorSessionManager());
    const handle = await createStageSessionLauncher(dependencyHarness(session).dependencies)(stageOptions(coordinator));
    const events: JsonAgentSessionEvent[] = [];
    const completeAssistant = assistant("all tokens");
    handle.subscribe((event) => events.push(event));

    session.emit({
      type: "message_update",
      message: completeAssistant,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "new token",
        partial: completeAssistant,
      },
    });

    expect(events).toEqual([{
      type: "message_update",
      usage: completeAssistant.usage,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "new token" },
    }]);
    session.emitAssistantEndAndPersist();
    await handle.materialized;
    prompt.resolve();
    await handle.completion;
    await handle.dispose();
  });

  it("replays synchronous prompt-start events once to the first owner subscriber", async () => {
    const prompt = deferred<void>();
    const session = new FakeStageSession("child-1", join(root, "child-1.jsonl"), prompt.promise);
    const completeAssistant = assistant("all early tokens");
    session.promptStart = () => session.emit({
      type: "message_update",
      message: completeAssistant,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "early token",
        partial: completeAssistant,
      },
    });
    const coordinator = new SubagentCoordinator(new MemoryCoordinatorSessionManager());
    const handle = await createStageSessionLauncher(dependencyHarness(session).dependencies)(stageOptions(coordinator));
    const first: JsonAgentSessionEvent[] = [];
    const second: JsonAgentSessionEvent[] = [];

    handle.subscribe((event) => first.push(event));
    handle.subscribe((event) => second.push(event));

    expect(first).toEqual([{
      type: "message_update",
      usage: completeAssistant.usage,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "early token" },
    }]);
    expect(second).toEqual([]);
    session.emitAssistantEndAndPersist();
    await handle.materialized;
    prompt.resolve();
    await handle.completion;
    await handle.dispose();
  });

  it("remembers an early abort, reapplies it after agent_start, and aborts descendants", async () => {
    const prompt = deferred<void>();
    const session = new FakeStageSession("child-1", join(root, "child-1.jsonl"), prompt.promise);
    session.abortImpl = async () => {
      if (session.isStreaming) prompt.resolve();
    };
    const harness = dependencyHarness(session);
    const coordinator = new SubagentCoordinator(new MemoryCoordinatorSessionManager());
    const handle = await createStageSessionLauncher(harness.dependencies)(stageOptions(coordinator));
    const materializationFailure = expect(handle.materialized).rejects.toThrow(/materializ|ENOENT/i);

    const aborting = handle.abort("stopped by parent");
    expect(session.abortCalls).toBe(1);
    session.isStreaming = true;
    session.emit({ type: "agent_start" });
    await aborting;

    await expect(handle.completion).resolves.toMatchObject({
      exitCode: 1,
      wasAborted: true,
      errorMessage: "stopped by parent",
    });
    await materializationFailure;
    expect(session.abortCalls).toBe(2);
    expect(harness.supervisors[0]?.abortReasons).toEqual(["stopped by parent"]);
    await handle.dispose();
  });

  it("makes abort and disposal idempotent", async () => {
    const prompt = deferred<void>();
    const session = new FakeStageSession("child-1", join(root, "child-1.jsonl"), prompt.promise);
    const coordinator = new SubagentCoordinator(new MemoryCoordinatorSessionManager());
    const handle = await createStageSessionLauncher(dependencyHarness(session).dependencies)(stageOptions(coordinator));

    session.emitAssistantEndAndPersist();
    await handle.materialized;
    await Promise.all([handle.abort(), handle.abort()]);
    prompt.resolve();
    await handle.completion;
    await Promise.all([handle.dispose(), handle.dispose()]);

    expect(session.abortCalls).toBe(1);
    expect(session.disposeCalls).toBe(1);
    expect(session.listeners.size).toBe(0);
  });

  it("disposes the session before its binding and retries only failed ownership", async () => {
    const prompt = deferred<void>();
    const session = new FakeStageSession("child-1", join(root, "child-1.jsonl"), prompt.promise);
    const harness = dependencyHarness(session);
    const order: string[] = [];
    session.disposeImpl = () => {
      order.push("session");
      if (session.disposeCalls === 1) throw new Error("session cleanup failed");
    };
    const originalCreateRuntime = harness.dependencies.createModelRuntime;
    harness.dependencies.createModelRuntime = async (agentDir) => {
      const runtime = await originalCreateRuntime(agentDir);
      return {
        ...runtime,
        dispose: async () => {
          order.push("binding");
          await (runtime as { dispose?: () => Promise<void> }).dispose?.();
        },
      };
    };
    const coordinator = new SubagentCoordinator(new MemoryCoordinatorSessionManager());
    const handle = await createStageSessionLauncher(harness.dependencies)(stageOptions(coordinator));
    session.emitAssistantEndAndPersist();
    await handle.materialized;
    prompt.resolve();
    await handle.completion;

    await expect(handle.dispose()).rejects.toThrow("session cleanup failed");
    expect(order).toEqual(["session"]);
    await handle.dispose();
    expect(order).toEqual(["session", "session", "binding"]);
    expect(session.disposeCalls).toBe(2);
  });

  it("attempts setup cleanup and still keeps binding disposal behind session disposal", async () => {
    const prompt = deferred<void>();
    const session = new FakeStageSession("child-1", join(root, "child-1.jsonl"), prompt.promise);
    const harness = dependencyHarness(session);
    const live = liveFor();
    const order: string[] = [];
    session.bindError = new Error("extension setup failed");
    session.disposeImpl = () => order.push("session");
    const originalCreateRuntime = harness.dependencies.createModelRuntime;
    harness.dependencies.createModelRuntime = async (agentDir) => {
      const runtime = await originalCreateRuntime(agentDir);
      return {
        ...runtime,
        dispose: async () => {
          order.push("binding");
          await (runtime as { dispose?: () => Promise<void> }).dispose?.();
        },
      };
    };
    const coordinator = new SubagentCoordinator(new MemoryCoordinatorSessionManager());

    await expect(createStageSessionLauncher(harness.dependencies)(stageOptions(coordinator, live)))
      .rejects.toThrow("extension setup failed");
    expect(order).toEqual(["session", "binding"]);
    expect(harness.supervisors[0]?.disposeCalls).toBe(1);
    expect(session.unsubscribeCalls).toBe(1);
    expect(live.projectReleaseCalls).toBe(1);
  });

  it("retries setup-session disposal before releasing the binding", async () => {
    const prompt = deferred<void>();
    const session = new FakeStageSession("child-1", join(root, "child-1.jsonl"), prompt.promise);
    const harness = dependencyHarness(session);
    const live = liveFor();
    const setupFailure = new Error("extension setup failed");
    const sessionFailure = new Error("setup session disposal failed");
    const order: string[] = [];
    let failSessionDisposal = true;
    session.bindError = setupFailure;
    session.disposeImpl = () => {
      order.push("session");
      if (failSessionDisposal) {
        failSessionDisposal = false;
        throw sessionFailure;
      }
    };
    const originalCreateRuntime = harness.dependencies.createModelRuntime;
    harness.dependencies.createModelRuntime = async (agentDir) => {
      const runtime = await originalCreateRuntime(agentDir);
      return {
        ...runtime,
        dispose: async () => {
          order.push("binding");
          await (runtime as { dispose?: () => Promise<void> }).dispose?.();
        },
      };
    };
    live.projectReleaseImpl = async () => {
      order.push("release");
    };
    const coordinator = new SubagentCoordinator(new MemoryCoordinatorSessionManager());

    const failure = await createStageSessionLauncher(harness.dependencies)(stageOptions(coordinator, live))
      .catch((error) => error);

    expect(failure).toBeInstanceOf(RetryableStageSessionCreationError);
    expect((failure as AggregateError).errors).toEqual([setupFailure, sessionFailure]);
    expect(session.disposeCalls).toBe(1);
    expect(order).toEqual(["session"]);
    expect(harness.bindingDisposals).toEqual([]);
    expect(live.projectReleaseCalls).toBe(0);

    await (failure as RetryableStageSessionCreationError).retryCleanup();

    expect(session.disposeCalls).toBe(2);
    expect(order).toEqual(["session", "session", "binding", "release"]);
    expect(harness.bindingDisposals).toEqual(["binding"]);
    expect(live.projectReleaseCalls).toBe(1);
  });

  it("lets the owning supervisor retry a rejected launch's failed binding release", async () => {
    const prompt = deferred<void>();
    const session = new FakeStageSession("child-1", join(root, "child-1.jsonl"), prompt.promise);
    const harness = dependencyHarness(session);
    const live = liveFor();
    const setupFailure = new Error("extension setup failed");
    const releaseFailure = new Error("project watcher close failed");
    let remainingReleaseFailures = 2;
    live.projectReleaseImpl = async () => {
      if (remainingReleaseFailures > 0) {
        remainingReleaseFailures -= 1;
        throw releaseFailure;
      }
    };
    session.bindError = setupFailure;
    const coordinator = new SubagentCoordinator(new MemoryCoordinatorSessionManager());
    const reservation = coordinator.reserveDispatch({
      ownerSessionId: "root-session",
      toolCallId: "tool-setup",
      requested: "search",
      catalog: { all: [stageAgent], available: [stageAgent] },
    });
    const supervisor = new SubagentSupervisor({
      coordinator,
      launchStage: createStageSessionLauncher(harness.dependencies),
    });
    supervisor.attach({
      sessionId: "root-session",
      sessionFile: "/sessions/root.jsonl",
      isStreaming: false,
      sessionManager: { getEntries: () => [] },
      subscribe: () => () => {},
      sendCustomMessage: async () => {},
      abort: async () => {},
      dispose: () => {},
    });

    const failure = await supervisor.launch(reservation, {
      agent: stageAgent,
      callerAgent: "research-assistant",
      task: "find papers",
      cwd: "/project",
      liveConfiguration: live,
    }).catch((error) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([setupFailure, releaseFailure]);
    expect(live.projectReleaseCalls).toBe(2);
    expect(session.disposeCalls).toBe(1);
    expect(supervisor.hasRunningChildren()).toBe(true);
    await expect(supervisor.waitForQuiescence()).rejects.toThrow(releaseFailure);

    await supervisor.dispose();

    expect(live.projectReleaseCalls).toBe(3);
    expect(session.disposeCalls).toBe(1);
    expect(supervisor.hasRunningChildren()).toBe(false);
  });

  it("bounds post-setup generation churn and never prompts an unauthorized stage", async () => {
    const prompt = deferred<void>();
    const session = new FakeStageSession("child-1", join(root, "child-1.jsonl"), prompt.promise);
    const harness = dependencyHarness(session);
    const live = liveFor();
    let authorizationResolutions = 0;
    session.setSessionName = (name) => {
      session.names.push(name);
      live.onResolve = () => {
        authorizationResolutions += 1;
        live.generation += 1;
      };
    };
    const coordinator = new SubagentCoordinator(new MemoryCoordinatorSessionManager());

    await expect(createStageSessionLauncher(harness.dependencies)(stageOptions(coordinator, live)))
      .rejects.toThrow(/configuration changed/i);
    expect(authorizationResolutions).toBe(2);
    expect(session.promptCalls).toEqual([]);
    expect(session.disposeCalls).toBe(1);
    expect(harness.bindingDisposals).toEqual(["binding"]);
  });

  it("observes cancellation during authorization and cleans the owned stage", async () => {
    const prompt = deferred<void>();
    const session = new FakeStageSession("child-1", join(root, "child-1.jsonl"), prompt.promise);
    const harness = dependencyHarness(session);
    const live = liveFor();
    const controller = new AbortController();
    session.setSessionName = (name) => {
      session.names.push(name);
      live.onResolve = () => {
        live.onResolve = undefined;
        live.generation += 1;
        controller.abort();
      };
    };
    const coordinator = new SubagentCoordinator(new MemoryCoordinatorSessionManager());

    await expect(createStageSessionLauncher(harness.dependencies)({
      ...stageOptions(coordinator, live),
      signal: controller.signal,
    })).rejects.toThrow("Agent authorization was cancelled.");
    expect(session.promptCalls).toEqual([]);
    expect(session.abortCalls).toBe(1);
    expect(harness.supervisors[0]?.abortReasons).toHaveLength(1);
    expect(session.disposeCalls).toBe(1);
  });

  it("applies prompt, tools, Skills, model, thinking, and policy before the next stage turn", async () => {
    const stageV1 = agentRow("search", {
      model: "openai/gpt-test",
      thinking: "low",
      tools: ["read", "subagent"],
      effectiveTools: ["read", "subagent"],
      skills: ["paper-v1"],
      effectiveSkills: ["paper-v1"],
      effectiveSkillPaths: ["/project/.easyresearch/skills/paper"],
      systemPrompt: "Search generation one.",
      subagents: ["reviewer"],
    });
    const stageV2 = agentRow("search", {
      model: "openai/gpt-test",
      thinking: "high",
      tools: ["web-search", "subagent"],
      effectiveTools: ["web-search", "subagent"],
      skills: ["paper-v2"],
      effectiveSkills: ["paper-v2"],
      effectiveSkillPaths: ["/agent/skills/paper"],
      systemPrompt: "Search generation two.",
      subagents: ["reviewer"],
    });
    const paper = agentRow("research-assistant", { subagents: ["search"] });
    const reviewer = agentRow("reviewer", { subagents: [] });
    const live = new FakeLiveConfiguration([paper, stageV1, reviewer]);
    const prompt = deferred<void>();
    const session = new FakeStageSession("child-1", join(root, "child-1.jsonl"), prompt.promise);
    let resourceHost: ExtensionResourceHost | undefined;
    let runtimeBinding: AgentRuntimeBinding | undefined;
    let modelGeneration = 0;
    let reloadCallsBeforeBoundary = -1;
    let initialSkillPaths: string[] = [];
    const disposedModels: string[] = [];
    const supervisor = new FakeDirectChildSupervisor();
    const policySettings = fakeSettingsManager({ getGlobalSettings: () => ({}) });
    const dependencies: StageSessionDependencies = {
      agentDir: "/agent",
      createSessionManager: () => ({ kind: "new" }),
      openSessionManager: () => ({
        getSessionId: () => session.sessionId,
        getCwd: () => "/project",
        getSessionFile: () => session.sessionFile,
      }),
      createSettingsManager: () => policySettings,
      createModelRuntime: async () => {
        modelGeneration += 1;
        const selected = model(`metadata-v${modelGeneration}`);
        return {
          refresh: async () => ({ aborted: false, errors: new Map() }),
          getError: () => undefined,
          getModel: (provider: string, id: string) =>
            provider === selected.provider && id === selected.id ? selected : undefined,
          getAvailableSnapshot: () => [selected],
          getProvider: (provider: string) => provider === selected.provider ? { id: provider } : undefined,
          getProviderAuthStatus: () => ({ configured: true }),
          dispose: async () => {
            disposedModels.push(selected.name);
          },
        };
      },
      createResourceLoader: (options) => {
        resourceHost = new ExtensionResourceHost(options, session);
        return resourceHost;
      },
      createAgentSession: async (options) => {
        session.model = options.model as Model<any>;
        session.thinkingLevel = options.thinkingLevel as ThinkingLevel;
        return { session };
      },
      createDirectChildSupervisor: () => supervisor as unknown as SubagentSupervisor,
      createExtensionFactories: ({ binding }) => {
        runtimeBinding = binding;
        return [{ name: "agent-definition", factory: createAgentDefinitionExtension(binding) }];
      },
      resolveAutomaticModel: async () => undefined,
    };
    session.bindExtensions = async (bindings) => {
      session.bindingCalls.push(bindings);
      await resourceHost!.emit("session_start", { reason: "startup" }, { cwd: "/project" });
      await resourceHost!.discover("startup");
    };
    session.reload = async () => {
      session.reloadCalls += 1;
      await resourceHost!.reload();
      await resourceHost!.emit("session_start", { reason: "reload" }, { cwd: "/project" });
      await resourceHost!.discover("reload");
    };
    session.promptStart = () => {
      session.isIdle = false;
      if (!resourceHost) throw new Error("Stage resource host was not constructed.");
      initialSkillPaths = [...resourceHost.skillPaths];
      live.publish(
        [paper, stageV2, reviewer],
        { triggerPercent: 80, globalEnabled: true, globalKeepRecentTokens: 20_000 },
      );
      reloadCallsBeforeBoundary = session.reloadCalls;
      void resourceHost!.emit("turn_end", { turnIndex: 0 }, { cwd: "/project", abort: vi.fn() })
        .then(() => {
          session.isIdle = true;
          session.emitAssistantEndAndPersist();
          prompt.resolve();
        });
    };
    const coordinator = new SubagentCoordinator(new MemoryCoordinatorSessionManager());
    const handle = await createStageSessionLauncher(dependencies)(stageOptions(coordinator, live));
    const stageEvents: JsonAgentSessionEvent[] = [];
    handle.subscribe((event) => stageEvents.push(event));

    await handle.materialized;
    await handle.completion;

    expect(session.reloadCalls).toBe(1);
    expect(reloadCallsBeforeBoundary).toBe(0);
    expect(initialSkillPaths).toEqual(["/project/.easyresearch/skills/paper"]);
    expect(resourceHost!.prompt).toEqual(["Pi base", "Search generation two."]);
    expect(session.activeTools.at(-1)).toEqual(["web-search", "subagent"]);
    expect(resourceHost!.skillPaths).toEqual(["/agent/skills/paper"]);
    expect(runtimeBinding!.current().subagents).toEqual(["reviewer"]);
    expect(session.model?.name).toBe("metadata-v2");
    expect(session.thinkingLevel).toBe("high");
    expect(policySettings.getCompactionSettings()).toMatchObject({
      reserveTokens: 25_600,
      keepRecentTokens: 20_000,
    });
    expect(runtimeBinding!.compactionPolicy()).toEqual({ triggerPercent: 80, enabled: true });
    expect(supervisor.runtimeCoherentCalls).toBe(1);
    expect(session.agent.steeringMode).toBe("all");
    expect(disposedModels).toContain("metadata-v1");
    expect(stageEvents.some((event) => (event as { type: string }).type === "runtime_configuration_applied")).toBe(false);

    live.publishSkills([paper, stageV2, reviewer]);
    await vi.waitFor(() => expect(session.reloadCalls).toBe(2));
    expect(resourceHost?.skillPaths).toEqual(["/agent/skills/paper"]);

    const stageV3 = agentRow("search", {
      ...stageV2,
      effectiveSkillPaths: ["/project/.easyresearch/skills/paper"],
    });
    live.publishSkills([paper, stageV3, reviewer]);
    await vi.waitFor(() => expect(session.reloadCalls).toBe(3));
    expect(resourceHost?.skillPaths).toEqual(["/project/.easyresearch/skills/paper"]);

    await handle.dispose();
    expect(disposedModels).toContain("metadata-v2");
  });

  it("validates an exact continuation before opening and reuses its readable identity", async () => {
    const prompt = deferred<void>();
    const sessionPath = join(root, "continued.jsonl");
    writeFileSync(sessionPath, "{}\n");
    const session = new FakeStageSession("continued-child", sessionPath, prompt.promise);
    const harness = dependencyHarness(session);
    const coordinator = new SubagentCoordinator(new MemoryCoordinatorSessionManager());
    const reservation: ReservedDispatch = {
      ...freshReservation(),
      continuation: true,
      childSessionId: "continued-child",
      sessionPath,
    };
    const handle = await createStageSessionLauncher(harness.dependencies)(stageOptions(coordinator, liveFor(), reservation));

    await expect(handle.materialized).resolves.toBeUndefined();
    expect(harness.calls.some((call) => call.name === "createManager")).toBe(false);
    expect(harness.calls.find((call) => call.name === "openManager")?.value).toBe(sessionPath);
    prompt.resolve();
    await handle.completion;
    await handle.dispose();

    harness.openedManager.getSessionId = () => "wrong-child";
    await expect(createStageSessionLauncher(harness.dependencies)(stageOptions(coordinator, liveFor(), reservation)))
      .rejects.toThrow(/UUID|session id/i);
  });

  it("rejects an unreadable continuation before SessionManager.open", async () => {
    const prompt = deferred<void>();
    const sessionPath = join(root, "deleted.jsonl");
    const session = new FakeStageSession("continued-child", sessionPath, prompt.promise);
    const harness = dependencyHarness(session);
    const coordinator = new SubagentCoordinator(new MemoryCoordinatorSessionManager());
    const reservation: ReservedDispatch = {
      ...freshReservation(),
      continuation: true,
      childSessionId: "continued-child",
      sessionPath,
    };

    await expect(createStageSessionLauncher(harness.dependencies)(stageOptions(coordinator, liveFor(), reservation)))
      .rejects.toThrow();
    expect(harness.calls.some((call) => call.name === "openManager")).toBe(false);
    expect(session.disposeCalls).toBe(0);
  });
});
