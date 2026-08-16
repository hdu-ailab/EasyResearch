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

  constructor(public options: StartSessionOptions) {
    FakeAdapter.all.push(this);
  }

  async start() {
    if (this.startError) throw this.startError;
    this.stats.started++;
  }
  async stop() {
    this.stats.stopped++;
  }
  async prompt(message: string) {
    this.stats.prompts.push(message);
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
    this.events.add(listener);
    return () => this.events.delete(listener);
  }
}

class FakeFactory implements SessionFactory {
  created: FakeAdapter[] = [];
  startError: Error | null = null;
  getStateError: Error | null = null;
  create(options: StartSessionOptions): SessionAdapter {
    const adapter = new FakeAdapter(options);
    adapter.startError = this.startError;
    adapter.getStateError = this.getStateError;
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

  it("stop emits session_deactivated to subscribers", async () => {
    const created = await registry.create({ cwd });
    const listener = vi.fn();
    registry.subscribe(created.id, listener);
    await registry.stop(created.id);
    expect(listener).toHaveBeenCalledWith({ type: "session_deactivated", sessionId: created.id });
    expect(listener).toHaveBeenCalledTimes(1);
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
    registry = new ActiveSessionRegistry(factory, noopLogger, { idleTimeoutMs: 0 });
    const created = await registry.create({ cwd });
    expect(registry.list().find((s) => s.id === created.id)).toBeDefined();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(registry.list().find((s) => s.id === created.id)).toBeUndefined());
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

  it("shutdown stops all clients", async () => {
    await registry.create({ cwd });
    await registry.open({ cwd, sessionPath });
    await registry.shutdown();
    expect(factory.created.every((a) => a.stats.stopped >= 1)).toBe(true);
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
