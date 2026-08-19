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
  treeResult: { tree: SessionTreeNode[]; leafId: string | null } = { tree: [], leafId: null };
  navigateCalls: string[] = [];
  steeringResult: string[] = [];
  backgroundWork = false;
  startImpl: () => Promise<void> = async () => {};
  stopImpl: () => Promise<void> = async () => {};
  onEventCalls = 0;

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
  }
  async setModel(provider: string, modelId: string) {
    this.stats.setModels.push({ provider, modelId });
  }
  async setThinkingLevel(level: string) {
    this.stats.setThinkingLevels.push(level);
  }
  async getState(): Promise<SessionState> {
    if (this.getStateError) throw this.getStateError;
    return { ...fakeState, ...this.stateOverrides, sessionId: `sess-${++FakeAdapter.nextId}`, sessionFile: this.options.sessionPath ?? sessionPath };
  }
  async getMessages(): Promise<AgentMessage[]> {
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
  async getTree(): Promise<{ tree: SessionTreeNode[]; leafId: string | null }> {
    return this.treeResult;
  }
  async navigateTree(entryId: string): Promise<void> {
    this.navigateCalls.push(entryId);
  }
  onEvent(listener: (event: unknown) => void) {
    this.onEventCalls += 1;
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
  create(options: StartSessionOptions): SessionAdapter {
    const adapter = new FakeAdapter(options);
    adapter.startError = this.startError;
    adapter.getStateError = this.getStateError;
    adapter.backgroundWork = this.backgroundWork;
    adapter.startImpl = this.startImpl;
    adapter.stopImpl = this.stopImpl;
    this.created.push(adapter);
    return adapter;
  }
}

class FakeWatcherFactory implements FileWatcherFactory {
  created: Array<{ cwd: string; onEvent: (event: FileWatcherEvent) => void; close: ReturnType<typeof vi.fn> }> = [];

  create({ cwd, onEvent }: { cwd: string; onEvent: (event: FileWatcherEvent) => void }) {
    const close = vi.fn(async () => {});
    this.created.push({ cwd, onEvent, close });
    return { close };
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
    await expect(registry.getPaperAssistantModel("nope")).rejects.toThrow(UnknownSessionError);
    await expect(registry.getPaperAssistantThinking("nope")).rejects.toThrow(UnknownSessionError);
  });

  it("exposes the record session path and cwd", async () => {
    const created = await registry.open({ cwd, sessionPath });
    await expect(registry.getSessionPath(created.id)).resolves.toBe(sessionPath);
    await expect(registry.getCwd(created.id)).resolves.toBe(cwd);
  });

  it("reports the Paper Assistant model from session state as provider/id", async () => {
    const created = await registry.create({ cwd });
    factory.created[0]!.stateOverrides = { model: { provider: "deepseek", id: "ds-v3" } as never };
    await expect(registry.getPaperAssistantModel(created.id)).resolves.toBe("deepseek/ds-v3");
  });

  it("reports no Paper Assistant model when session state has none", async () => {
    const created = await registry.create({ cwd });
    await expect(registry.getPaperAssistantModel(created.id)).resolves.toBeUndefined();
  });

  it("forwards setThinkingLevel to the adapter", async () => {
    const created = await registry.create({ cwd });
    await registry.setThinkingLevel(created.id, "high");
    expect(factory.created[0]?.stats.setThinkingLevels).toEqual(["high"]);
  });

  it("reports the Paper Assistant thinking level from session state", async () => {
    const created = await registry.create({ cwd });
    factory.created[0]!.stateOverrides = { thinkingLevel: "high" };
    await expect(registry.getPaperAssistantThinking(created.id)).resolves.toBe("high");
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
    await opening;
    await shuttingDown;
    expect(factory.created[0]?.stats.stopped).toBe(1);
    expect(registry.list()).toEqual([]);
  });

  describe("tree and commands (ADR-066)", () => {
    it("delegates getCommands/getTree/navigateTree to the adapter", async () => {
      const created = await registry.create({ cwd });
      const adapter = FakeAdapter.all.at(-1)!;
      adapter.commandsResult = [{ name: "skill:arxiv", source: "skill" }];
      adapter.treeResult = { tree: [], leafId: "leaf-1" };

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
