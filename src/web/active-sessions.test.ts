import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { RpcEventListener, RpcSessionState } from "@earendil-works/pi-coding-agent";
import { ActiveSessionRegistry, UnknownSessionError } from "./active-sessions";
import { assertSafeExtensionSources } from "../runtime/extensions-guard";
import type { RpcSessionAdapter, RpcSessionFactory, StartRpcSessionOptions } from "./rpc-session";
import type { Logger } from "../runtime/logger";

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

const fakeState: RpcSessionState = {
  thinkingLevel: "medium",
  isStreaming: false,
  isCompacting: false,
  steeringMode: "all",
  followUpMode: "one-at-a-time",
  sessionFile: sessionPath,
  sessionId: "sess-1",
  sessionName: "My Session",
  autoCompactionEnabled: true,
  messageCount: 3,
  pendingMessageCount: 0,
};

interface FakeAdapterStats {
  started: number;
  stopped: number;
  prompts: string[];
  aborts: number;
  setModels: Array<{ provider: string; modelId: string }>;
  exits: Array<{ listener: (error: Error) => void }>;
}

class FakeAdapter implements RpcSessionAdapter {
  static all: FakeAdapter[] = [];
  static nextId = 0;
  events = new Set<RpcEventListener>();
  onExitListeners = new Set<(error: Error) => void>();
  stats: FakeAdapterStats = { started: 0, stopped: 0, prompts: [], aborts: 0, setModels: [], exits: [] };
  stateOverrides: Partial<RpcSessionState> = {};

  constructor(public options: StartRpcSessionOptions) {
    FakeAdapter.all.push(this);
  }

  async start() {
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
  async getState(): Promise<RpcSessionState> {
    return { ...fakeState, ...this.stateOverrides, sessionId: `sess-${++FakeAdapter.nextId}`, sessionFile: this.options.sessionPath ?? sessionPath };
  }
  async getMessages(): Promise<AgentMessage[]> {
    return [];
  }
  onEvent(listener: RpcEventListener) {
    this.events.add(listener);
    return () => this.events.delete(listener);
  }
  onExit(listener: (error: Error) => void) {
    this.onExitListeners.add(listener);
    return () => this.onExitListeners.delete(listener);
  }
}

class FakeFactory implements RpcSessionFactory {
  created: FakeAdapter[] = [];
  create(options: StartRpcSessionOptions): RpcSessionAdapter {
    const adapter = new FakeAdapter(options);
    this.created.push(adapter);
    return adapter;
  }
}

describe("ActiveSessionRegistry", () => {
  let factory: FakeFactory;
  let registry: ActiveSessionRegistry;

  beforeEach(() => {
    factory = new FakeFactory();
    registry = new ActiveSessionRegistry(factory, noopLogger);
    vi.mocked(assertSafeExtensionSources).mockClear();
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
    await expect(registry.getSessionPath("nope")).rejects.toThrow(UnknownSessionError);
    await expect(registry.getCwd("nope")).rejects.toThrow(UnknownSessionError);
    await expect(registry.getOrchestratorModel("nope")).rejects.toThrow(UnknownSessionError);
  });

  it("exposes the record session path and cwd", async () => {
    const created = await registry.open({ cwd, sessionPath });
    await expect(registry.getSessionPath(created.id)).resolves.toBe(sessionPath);
    await expect(registry.getCwd(created.id)).resolves.toBe(cwd);
  });

  it("reports the orchestrator model from session state as provider/id", async () => {
    const created = await registry.create({ cwd });
    factory.created[0]!.stateOverrides = { model: { provider: "deepseek", id: "ds-v3" } as never };
    await expect(registry.getOrchestratorModel(created.id)).resolves.toBe("deepseek/ds-v3");
  });

  it("reports no orchestrator model when session state has none", async () => {
    const created = await registry.create({ cwd });
    await expect(registry.getOrchestratorModel(created.id)).resolves.toBeUndefined();
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

  it("re-launches an errored session on open instead of reusing the dead entry", async () => {
    const created = await registry.create({ cwd });
    const adapter = factory.created[0]!;
    adapter.onExitListeners.forEach((listener) => listener(new Error("crash")));
    const reopened = await registry.open({ cwd, sessionPath });
    expect(reopened.status).toBe("ready");
    expect(factory.created).toHaveLength(2);
    expect(factory.created[1]?.stats.started).toBe(1);
  });

  it("open re-launches a session deactivated by agent_settled", async () => {
    const created = await registry.open({ cwd, sessionPath });
    const adapter = factory.created[0]!;
    adapter.events.forEach((l) => l({ type: "agent_start" } as never));
    adapter.events.forEach((l) => l({ type: "agent_settled" } as never));
    await vi.waitFor(() => expect(registry.list().find((s) => s.id === created.id)).toBeUndefined());
    const reopened = await registry.open({ cwd, sessionPath });
    expect(reopened.status).toBe("ready");
    expect(factory.created).toHaveLength(2);
  });

  it("snapshot rejects after deactivation", async () => {
    const created = await registry.create({ cwd });
    await registry.stop(created.id);
    await expect(registry.snapshot(created.id)).rejects.toThrow(UnknownSessionError);
  });

  it("snapshots an errored session without calling into the dead client", async () => {
    const created = await registry.create({ cwd });
    const adapter = factory.created[0]!;
    const broken = vi.spyOn(adapter, "getMessages").mockRejectedValue(new Error("Client not started"));
    adapter.onExitListeners.forEach((listener) => listener(new Error("crash")));
    const snapshot = await registry.snapshot(created.id);
    expect(broken).not.toHaveBeenCalled();
    expect(snapshot.session.status).toBe("error");
    expect(snapshot.session.error).toBe("crash");
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

  it("deactivates on agent_settled: stops child, removes entry, emits event", async () => {
    const created = await registry.create({ cwd });
    const adapter = factory.created[0]!;
    const listener = vi.fn();
    registry.subscribe(created.id, listener);
    adapter.events.forEach((l) => l({ type: "agent_start" } as never));
    expect(registry.list().find((s) => s.id === created.id)?.status).toBe("running");
    adapter.events.forEach((l) => l({ type: "agent_settled" } as never));
    await vi.waitFor(() => expect(registry.list().find((s) => s.id === created.id)).toBeUndefined());
    expect(factory.created[0]?.stats.stopped).toBe(1);
    expect(listener).toHaveBeenCalledWith({ type: "session_deactivated", sessionId: created.id });
    expect(
      listener.mock.calls.filter(([event]) => (event as { type?: string }).type === "session_deactivated"),
    ).toHaveLength(1);
  });

  it("ignores message events when deciding run status", async () => {
    const created = await registry.create({ cwd });
    const adapter = factory.created[0]!;
    adapter.events.forEach((listener) => listener({ type: "message_start" } as never));
    expect(registry.list().find((s) => s.id === created.id)?.status).toBe("ready");
    adapter.events.forEach((listener) => listener({ type: "agent_start" } as never));
    expect(registry.list().find((s) => s.id === created.id)?.status).toBe("running");
  });

  it("surfaces an unexpected process error as status error", async () => {
    const created = await registry.create({ cwd });
    const adapter = factory.created[0]!;
    adapter.onExitListeners.forEach((listener) => listener(new Error("crash")));
    expect(registry.list().find((s) => s.id === created.id)?.status).toBe("error");
    expect(registry.list().find((s) => s.id === created.id)?.error).toBe("crash");
  });

  it("shutdown stops all clients", async () => {
    await registry.create({ cwd });
    await registry.open({ cwd, sessionPath });
    await registry.shutdown();
    expect(factory.created.every((a) => a.stats.stopped >= 1)).toBe(true);
  });
});