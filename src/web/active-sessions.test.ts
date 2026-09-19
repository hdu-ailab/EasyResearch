import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionTreeNode } from "@earendil-works/pi-coding-agent";
import {
  ActiveSessionRegistry,
  SessionRegistryShuttingDownError,
  UnknownSessionError,
} from "./active-sessions";
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
  timelineResult: Awaited<ReturnType<SessionAdapter["getTranscriptSnapshot"]>>["timeline"] = [];
  contextUsage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  compactionState: "idle" | "queued" | "running" = "idle";
  compactionPolicy = { triggerPercent: 70, enabled: true };
  runtimeConfigurationGeneration = 0;
  backgroundWork = false;
  supervisorActive = false;
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
  async getTranscriptSnapshot() {
    return { timeline: this.timelineResult, inlineUsage: [] };
  }
  getSteeringMessages(): readonly string[] {
    return this.steeringResult;
  }
  hasBackgroundWork(): boolean {
    return this.backgroundWork;
  }
  isSupervisorActive(): boolean {
    return this.supervisorActive;
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
  supervisorActive = false;
  startImpl: () => Promise<void> = async () => {};
  stopImpl: () => Promise<void> = async () => {};
  getStateImpl: (() => Promise<SessionState>) | undefined;
  onEventHook: (() => void) | undefined;
  create(options: StartSessionOptions): SessionAdapter {
    const adapter = new FakeAdapter(options);
    adapter.startError = this.startError;
    adapter.getStateError = this.getStateError;
    adapter.backgroundWork = this.backgroundWork;
    adapter.supervisorActive = this.supervisorActive;
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

  describe("session deletion admission", () => {
    const history = (id: string, remove = vi.fn(async () => {})) => ({
      resolve: async () => ({ id, cwd, path: sessionPath }),
      remove,
    });

    it.each(["preflight", "descendants", "queued compaction", "running compaction"])(
      "rejects no-force %s without stopping writers or removing history", async (work) => {
        const created = await registry.create({ cwd });
        const adapter = factory.created[0]!;
        if (work === "preflight") adapter.backgroundWork = true;
        if (work === "descendants") adapter.supervisorActive = true;
        if (work === "queued compaction") adapter.compactionState = "queued";
        if (work === "running compaction") adapter.compactionState = "running";
        const deps = history(created.id);

        await expect(registry.deleteSession(created.id, false, deps)).rejects.toMatchObject({ code: "SESSION_BUSY" });

        expect(adapter.stats.stopped).toBe(0);
        expect(deps.remove).not.toHaveBeenCalled();
        await registry.prompt(created.id, "still usable");
        expect(adapter.stats.prompts).toEqual(["still usable"]);
      },
    );

    it("waits for terminal cleanup, excludes competing writers and keeps unrelated roots usable", async () => {
      const created = await registry.create({ cwd });
      factory.getStateImpl = async () => ({ ...fakeState, sessionId: "other", sessionFile: "/agent/sessions/other.jsonl" });
      const other = await registry.create({ cwd: "/other/project" });
      const cleanup = deferred<void>();
      factory.created[0]!.stopImpl = () => cleanup.promise;
      const deps = history(created.id);
      const deleting = registry.deleteSession(created.id, true, deps);
      await vi.waitFor(() => expect(factory.created[0]!.stats.stopped).toBe(1));
      expect(deps.remove).not.toHaveBeenCalled();
      await expect(registry.prompt(created.id, "late")).rejects.toThrow();
      await expect(registry.compact(created.id)).rejects.toThrow();
      await expect(registry.setThinkingLevel(created.id, "high")).rejects.toThrow();
      await expect(registry.navigateTree(created.id, "leaf")).rejects.toThrow();
      await expect(registry.open({ cwd, sessionPath })).rejects.toThrow();
      await expect(registry.restart(created.id)).rejects.toThrow();
      const rename = vi.fn(async () => {});
      await expect(registry.withHistoryMutation({ id: created.id, cwd, path: sessionPath }, rename)).rejects.toThrow();
      await registry.prompt(other.id, "unrelated");
      expect(factory.created[1]!.stats.prompts).toEqual(["unrelated"]);
      cleanup.resolve();
      await deleting;
      expect(deps.remove).toHaveBeenCalledOnce();
      expect(rename).not.toHaveBeenCalled();
    });

    it("retains failed writer cleanup for retry and never reports deletion before success", async () => {
      const created = await registry.create({ cwd });
      const listener = vi.fn();
      registry.subscribe(created.id, listener);
      factory.created[0]!.stopImpl = vi.fn().mockRejectedValueOnce(new Error("cleanup failed")).mockResolvedValue(undefined);
      const deps = history(created.id);
      await expect(registry.deleteSession(created.id, true, deps)).rejects.toThrow("cleanup failed");
      expect(deps.remove).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalledWith({ type: "session_deleted", sessionId: created.id });
      await expect(registry.open({ cwd, sessionPath })).rejects.toThrow();
      await registry.deleteSession(created.id, true, deps);
      expect(deps.remove).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenLastCalledWith({ type: "session_deleted", sessionId: created.id });
    });

    it("owns pending open cancellation and cleanup before forced removal", async () => {
      const start = deferred<void>();
      const cleanup = deferred<void>();
      factory.startImpl = () => start.promise;
      factory.stopImpl = () => cleanup.promise;
      const opening = registry.open({ cwd, sessionPath }).catch((error: unknown) => error);
      await vi.waitFor(() => expect(factory.created).toHaveLength(1));
      const deps = history("sess-1");
      await expect(registry.deleteSession("sess-1", false, deps)).rejects.toMatchObject({ code: "SESSION_BUSY" });
      expect(factory.created[0]!.stats.stopped).toBe(0);
      const deleting = registry.deleteSession("sess-1", true, deps);
      await Promise.resolve();
      expect(deps.remove).not.toHaveBeenCalled();
      start.resolve();
      await vi.waitFor(() => expect(factory.created[0]!.stats.stopped).toBe(1));
      expect(deps.remove).not.toHaveBeenCalled();
      cleanup.resolve();
      await deleting;
      expect(await opening).toBeInstanceOf(Error);
      expect(registry.list()).toEqual([]);
      expect(deps.remove).toHaveBeenCalledOnce();
    });

    it("stops an admitted open that finishes while deletion resolves historical identity", async () => {
      const start = deferred<void>();
      const resolving = deferred<{ id: string; cwd: string; path: string }>();
      const cleanup = deferred<void>();
      factory.startImpl = () => start.promise;
      factory.stopImpl = () => cleanup.promise;
      const opening = registry.open({ cwd, sessionPath });
      await vi.waitFor(() => expect(factory.created).toHaveLength(1));
      const deps = { resolve: () => resolving.promise, remove: vi.fn(async () => {}) };
      const deleting = registry.deleteSession("sess-1", true, deps);
      start.resolve();
      const opened = await opening;
      resolving.resolve({ id: opened.id, cwd, path: sessionPath });
      await vi.waitFor(() => expect(factory.created[0]!.stats.stopped).toBe(1));
      expect(deps.remove).not.toHaveBeenCalled();
      cleanup.resolve();
      await deleting;
      expect(registry.has(opened.id)).toBe(false);
    });

    it("rechecks no-force work after admission before terminal stop", async () => {
      const created = await registry.create({ cwd });
      const deps = history(created.id);
      const deleting = registry.deleteSession(created.id, false, deps);
      factory.created[0]!.backgroundWork = true;
      await expect(deleting).rejects.toMatchObject({ code: "SESSION_BUSY" });
      expect(factory.created[0]!.stats.stopped).toBe(0);
      expect(deps.remove).not.toHaveBeenCalled();
    });

    it("excludes deletion, open and restart while a historical rename owns the path", async () => {
      const gate = deferred<void>();
      const target = { id: "sess-1", cwd, path: sessionPath };
      const renaming = registry.withHistoryMutation(target, () => gate.promise);
      const deps = history(target.id);
      await expect(registry.deleteSession(target.id, true, deps)).rejects.toThrow();
      await expect(registry.open({ cwd, sessionPath })).rejects.toThrow();
      expect(deps.remove).not.toHaveBeenCalled();
      gate.resolve();
      await renaming;
      await registry.deleteSession(target.id, true, deps);
      expect(deps.remove).toHaveBeenCalledOnce();
    });

    it("holds already admitted live mutations through unlink even after adapter stop resolves", async () => {
      const created = await registry.create({ cwd });
      const mutation = deferred<void>();
      factory.created[0]!.setModel = () => mutation.promise;
      const changing = registry.setModel(created.id, "provider", "model");
      const deps = history(created.id);
      await expect(registry.deleteSession(created.id, false, deps)).rejects.toMatchObject({ code: "SESSION_BUSY" });
      const deleting = registry.deleteSession(created.id, true, deps);
      await vi.waitFor(() => expect(factory.created[0]!.stats.stopped).toBe(1));
      expect(deps.remove).not.toHaveBeenCalled();
      mutation.resolve();
      await changing;
      await deleting;
      expect(deps.remove).toHaveBeenCalledOnce();
    });

    it("shares a deletion attempt and holds it through registry shutdown", async () => {
      const created = await registry.create({ cwd });
      const removal = deferred<void>();
      const deps = history(created.id, vi.fn(() => removal.promise));
      const deleting = registry.deleteSession(created.id, true, deps);
      await vi.waitFor(() => expect(deps.remove).toHaveBeenCalledOnce());
      const duplicate = registry.deleteSession(created.id, true, deps);
      let shutdownDone = false;
      const shutdown = registry.shutdown().then(() => { shutdownDone = true; });
      await Promise.resolve();
      expect(shutdownDone).toBe(false);
      removal.resolve();
      await Promise.all([deleting, duplicate, shutdown]);
      expect(deps.remove).toHaveBeenCalledOnce();
    });

    it("notifies disconnected subscribers but not released subscriptions", async () => {
      const created = await registry.create({ cwd });
      const retained = vi.fn();
      const released = vi.fn();
      registry.subscribe(created.id, retained);
      const release = registry.subscribe(created.id, released);
      await registry.stop(created.id);
      release();
      const deps = history(created.id);
      await registry.deleteSession(created.id, false, deps);
      expect(retained).toHaveBeenLastCalledWith({ type: "session_deleted", sessionId: created.id });
      expect(released).not.toHaveBeenCalledWith({ type: "session_deleted", sessionId: created.id });
    });

    it("rejects reopen while a failed startup still owns cleanup", async () => {
      factory.startError = new Error("startup failed");
      factory.stopImpl = async () => { throw new Error("cleanup failed"); };
      await expect(registry.open({ cwd, sessionPath })).rejects.toThrow("startup failed");
      factory.startError = null;
      await expect(registry.open({ cwd, sessionPath })).rejects.toThrow(/conflict/i);
      expect(factory.created).toHaveLength(1);
      factory.created[0]!.stopImpl = async () => {};
      await registry.shutdown();
    });

    it("retries pending-open cleanup after failure without unlinking first", async () => {
      const start = deferred<void>();
      factory.startImpl = () => start.promise;
      factory.stopImpl = vi.fn().mockRejectedValueOnce(new Error("pending cleanup failed")).mockResolvedValue(undefined);
      const opening = registry.open({ cwd, sessionPath }).catch((error: unknown) => error);
      await vi.waitFor(() => expect(factory.created).toHaveLength(1));
      const deps = history("sess-1");
      const deleting = registry.deleteSession("sess-1", true, deps);
      // Let the deletion resolve its identity and cancel the admitted open.
      await new Promise<void>((resolve) => setImmediate(resolve));
      start.resolve();
      await expect(deleting).rejects.toThrow("pending cleanup failed");
      await opening;
      expect(deps.remove).not.toHaveBeenCalled();
      await expect(registry.open({ cwd, sessionPath })).rejects.toThrow();
      await registry.deleteSession("sess-1", true, deps);
      expect(deps.remove).toHaveBeenCalledOnce();
      expect(factory.created[0]!.stats.stopped).toBe(2);
    });

    it("retains an admitted historical rename through shutdown", async () => {
      const rename = deferred<void>();
      const renaming = registry.withHistoryMutation({ id: "historical", path: sessionPath, cwd }, () => rename.promise);
      let stopped = false;
      const shutdown = registry.shutdown().then(() => { stopped = true; });
      await Promise.resolve();
      expect(stopped).toBe(false);
      rename.resolve();
      await Promise.all([renaming, shutdown]);
      expect(stopped).toBe(true);
    });

    it("releases a disconnected view's exact watcher after a same-id reopen", async () => {
      factory.getStateImpl = async () => fakeState;
      const created = await registry.open({ cwd, sessionPath });
      const oldLease = registry.acquireFileWatchLease(created.id);
      const oldListener = vi.fn();
      const releaseOld = registry.subscribe(created.id, oldListener);
      await registry.stop(created.id);
      await registry.open({ cwd, sessionPath });
      const newLease = registry.acquireFileWatchLease(created.id);
      const newListener = vi.fn();
      registry.subscribe(created.id, newListener);
      releaseOld();
      registry.releaseFileWatchLease(created.id, oldLease);
      expect(watcherFactory.created[0]!.leases.size).toBe(0);
      expect(watcherFactory.created[1]!.leases.has(newLease)).toBe(true);
      await registry.deleteSession(created.id, true, history(created.id));
      expect(oldListener).not.toHaveBeenCalledWith({ type: "session_deleted", sessionId: created.id });
      expect(newListener).toHaveBeenLastCalledWith({ type: "session_deleted", sessionId: created.id });
      registry.releaseFileWatchLease(created.id, newLease);
      expect(watcherFactory.created[1]!.leases.size).toBe(0);
    });
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
    expect(adapter.stats.stopped).toBe(1);
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

  it("does not let a stale state read overwrite a newer root activity edge", async () => {
    const created = await registry.open({ cwd, sessionPath });
    const adapter = factory.created[0]!;
    const staleState = deferred<SessionState>();
    adapter.getStateImpl = () => staleState.promise;

    const snapshot = registry.snapshot(created.id);
    adapter.events.forEach((listener) => listener({ type: "agent_start" }));
    staleState.resolve({ ...fakeState, isStreaming: false });

    await expect(snapshot).resolves.toMatchObject({
      session: { status: "running", isStreaming: true },
    });
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

  it("snapshots an errored session without reading the timeline after state fails", async () => {
    const created = await registry.create({ cwd });
    const adapter = factory.created[0]!;
    const broken = vi.spyOn(adapter, "getTranscriptSnapshot");
    adapter.getStateError = new Error("state unavailable");
    const snapshot = await registry.snapshot(created.id);
    expect(broken).not.toHaveBeenCalled();
    expect(snapshot.session.status).toBe("error");
    expect(snapshot.session.error).toBe("state unavailable");
    expect(snapshot.timeline).toEqual([]);
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

  it("keeps aggregate status running after the root settles while descendants remain active", async () => {
    const created = await registry.create({ cwd });
    const adapter = factory.created[0]!;

    adapter.events.forEach((listener) => listener({ type: "agent_start" }));
    adapter.backgroundWork = true;
    adapter.events.forEach((listener) => listener({ type: "session_activity_changed", active: true }));
    adapter.events.forEach((listener) => listener({ type: "agent_settled" }));

    expect(registry.list().find((session) => session.id === created.id)).toMatchObject({
      status: "running",
      isStreaming: false,
    });
    expect((await registry.snapshot(created.id)).session).toMatchObject({
      status: "running",
      isStreaming: false,
    });

    adapter.backgroundWork = false;
    adapter.events.forEach((listener) => listener({ type: "session_activity_changed", active: false }));

    expect(registry.list().find((session) => session.id === created.id)).toMatchObject({
      status: "ready",
      isStreaming: false,
    });
  });

  it("publishes authoritative activity replacements after every root and supervisor boundary", async () => {
    const created = await registry.create({ cwd });
    const adapter = factory.created[0]!;
    const listener = vi.fn();
    registry.subscribe(created.id, listener);

    adapter.events.forEach((subscriber) => subscriber({ type: "agent_start" }));
    adapter.supervisorActive = true;
    adapter.backgroundWork = true;
    adapter.events.forEach((subscriber) => subscriber({ type: "session_activity_changed", active: true }));
    adapter.events.forEach((subscriber) => subscriber({ type: "agent_settled" }));
    adapter.supervisorActive = false;
    adapter.backgroundWork = false;
    adapter.events.forEach((subscriber) => subscriber({ type: "session_activity_changed", active: false }));

    expect(listener.mock.calls.map(([event]) => event)).toEqual([
      { type: "agent_start" },
      { type: "session_activity_changed", status: "running", isStreaming: true },
      { type: "session_activity_changed", status: "running", isStreaming: true },
      { type: "agent_settled" },
      { type: "session_activity_changed", status: "running", isStreaming: false },
      { type: "session_activity_changed", status: "ready", isStreaming: false },
    ]);
  });

  it("launches with aggregate running status when recovered supervisor work already exists", async () => {
    factory.supervisorActive = true;

    const created = await registry.open({ cwd, sessionPath });

    expect(created).toMatchObject({ status: "running", isStreaming: false });
  });

  it("owns root lifecycle events before sampling launch state", async () => {
    let isStreaming = false;
    factory.getStateImpl = async () => ({ ...fakeState, isStreaming });
    factory.onEventHook = () => {
      isStreaming = true;
    };

    const created = await registry.open({ cwd, sessionPath });

    expect(created).toMatchObject({ status: "running", isStreaming: true });
  });

  it("replays launch-time root activity to listeners adopted by restart", async () => {
    const created = await registry.open({ cwd, sessionPath });
    const listener = vi.fn();
    registry.subscribe(created.id, listener);
    const stateGate = deferred<SessionState>();
    factory.getStateImpl = () => stateGate.promise;

    const restarting = registry.restart(created.id);
    await vi.waitFor(() => expect(factory.created).toHaveLength(2));
    const replacement = factory.created[1]!;
    await vi.waitFor(() => expect(replacement.events.size).toBeGreaterThan(0));
    replacement.events.forEach((subscriber) => subscriber({ type: "agent_start" }));
    stateGate.resolve({ ...fakeState, isStreaming: false });
    const restarted = await restarting;

    expect(restarted).toMatchObject({ status: "running", isStreaming: true });
    expect(listener.mock.calls.map(([event]) => event)).toEqual([
      { type: "session_deactivated", sessionId: created.id },
      { type: "agent_start" },
      { type: "session_activity_changed", status: "running", isStreaming: true },
    ]);
  });

  it("publishes sampled initial activity to listeners adopted by restart", async () => {
    const created = await registry.open({ cwd, sessionPath });
    const listener = vi.fn();
    registry.subscribe(created.id, listener);
    factory.getStateImpl = async () => ({ ...fakeState, isStreaming: true });

    const restarted = await registry.restart(created.id);

    expect(restarted).toMatchObject({ status: "running", isStreaming: true });
    expect(listener.mock.calls.map(([event]) => event)).toEqual([
      { type: "session_deactivated", sessionId: created.id },
      { type: "session_activity_changed", status: "running", isStreaming: true },
    ]);
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

  it("counts a launch pending before adapter construction exactly once", async () => {
    const thinking = deferred<string | undefined>();
    const pendingRegistry = new ActiveSessionRegistry(
      factory,
      noopLogger,
      { idleTimeoutMs: -1, resolveLaunchThinking: () => thinking.promise },
      watcherFactory,
    );

    const launch = pendingRegistry.create({ cwd });
    await vi.waitFor(() => expect(pendingRegistry.activeWorkCount()).toBe(1));

    expect(factory.created).toHaveLength(0);
    thinking.resolve(undefined);
    await launch;
    expect(pendingRegistry.activeWorkCount()).toBe(0);
    await pendingRegistry.shutdown();
  });

  it("counts an adapter launch blocked in start exactly once", async () => {
    const start = deferred<void>();
    factory.startImpl = () => start.promise;

    const launch = registry.create({ cwd });
    await vi.waitFor(() => expect(factory.created).toHaveLength(1));

    expect(registry.activeWorkCount()).toBe(1);
    start.resolve();
    await launch;
    expect(registry.activeWorkCount()).toBe(0);
  });

  it("counts running root work but not an idle ready record", async () => {
    const created = await registry.create({ cwd });
    const adapter = factory.created[0]!;

    expect(registry.activeWorkCount()).toBe(0);
    adapter.events.forEach((listener) => listener({ type: "agent_start" }));
    expect(registry.activeWorkCount()).toBe(1);
    adapter.events.forEach((listener) => listener({ type: "agent_settled" }));
    expect(registry.activeWorkCount()).toBe(0);
    expect(registry.has(created.id)).toBe(true);
  });

  it("counts child-only background work even when the connected DTO is still ready", async () => {
    await registry.create({ cwd });
    const adapter = factory.created[0]!;

    adapter.backgroundWork = true;

    expect(registry.list()[0]).toMatchObject({ status: "ready", isStreaming: false });
    expect(registry.activeWorkCount()).toBe(1);
  });

  it("beginShutdown synchronously rejects prompt, create, and open admission", async () => {
    const created = await registry.create({ cwd });

    registry.beginShutdown();

    await expect(registry.prompt(created.id, "late prompt")).rejects.toBeInstanceOf(
      SessionRegistryShuttingDownError,
    );
    await expect(registry.create({ cwd: "/late/create" })).rejects.toBeInstanceOf(
      SessionRegistryShuttingDownError,
    );
    await expect(registry.open({ cwd, sessionPath })).rejects.toBeInstanceOf(
      SessionRegistryShuttingDownError,
    );
    expect(factory.created[0]?.stats.prompts).toEqual([]);
    expect(factory.created).toHaveLength(1);
    await registry.shutdown();
  });

  it("beginShutdown is idempotent and cancels an already pending launch", async () => {
    const start = deferred<void>();
    factory.startImpl = () => start.promise;
    const launch = registry.create({ cwd });
    await vi.waitFor(() => expect(factory.created).toHaveLength(1));

    registry.beginShutdown();
    registry.beginShutdown();
    start.resolve();

    await expect(launch).rejects.toBeInstanceOf(SessionRegistryShuttingDownError);
    await registry.shutdown();
    expect(factory.created[0]?.stats.stopped).toBe(1);
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
  it.each(["queued", "running"] as const)("includes %s compaction in aggregate activity without changing root streaming", async (state) => {
    const created = await registry.create({ cwd });
    const adapter = factory.created[0]!;
    const events: unknown[] = [];
    registry.subscribe(created.id, (event) => events.push(event));
    const emit = (event: unknown) => adapter.events.forEach((listener) => listener(event));

    adapter.compactionState = state;
    emit({ type: "compaction_state_changed", state });
    expect(registry.list()[0]).toMatchObject({ status: "running", isStreaming: false });
    expect(events).toContainEqual({ type: "session_activity_changed", status: "running", isStreaming: false });
    expect((await registry.snapshot(created.id)).session).toMatchObject({ status: "running", isStreaming: false });

    adapter.supervisorActive = true;
    emit({ type: "session_activity_changed", active: true });
    adapter.compactionState = "idle";
    emit({ type: "compaction_state_changed", state: "idle" });
    expect(registry.list()[0]).toMatchObject({ status: "running", isStreaming: false });
    adapter.supervisorActive = false;
    emit({ type: "session_activity_changed", active: false });
    expect(registry.list()[0]).toMatchObject({ status: "ready", isStreaming: false });
    expect(events.at(-1)).toEqual({ type: "session_activity_changed", status: "ready", isStreaming: false });
    await registry.shutdown();
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
