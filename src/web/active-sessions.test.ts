import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { RpcEventListener, RpcSessionState } from "@earendil-works/pi-coding-agent";
import { ActiveSessionRegistry } from "./active-sessions";
import { assertNoUserExtensions } from "../runtime/extensions-guard";
import type { RpcSessionAdapter, RpcSessionFactory, StartRpcSessionOptions } from "./rpc-session";

vi.mock("../runtime/extensions-guard", () => ({
  assertNoUserExtensions: vi.fn(),
  ExtensionGuardError: class ExtensionGuardError extends Error {},
}));

const cwd = "/test/project";
const sessionPath = "/agent/sessions/--test-project--/a.jsonl";

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
  exits: Array<{ listener: (error: Error) => void }>;
}

class FakeAdapter implements RpcSessionAdapter {
  static all: FakeAdapter[] = [];
  static nextId = 0;
  events = new Set<RpcEventListener>();
  onExitListeners = new Set<(error: Error) => void>();
  stats: FakeAdapterStats = { started: 0, stopped: 0, prompts: [], aborts: 0, exits: [] };

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
  async getState(): Promise<RpcSessionState> {
    return { ...fakeState, sessionId: `sess-${++FakeAdapter.nextId}`, sessionFile: this.options.sessionPath ?? sessionPath };
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
    registry = new ActiveSessionRegistry(factory);
    vi.mocked(assertNoUserExtensions).mockClear();
  });

  it("creates a session with exact cwd and launches a client", async () => {
    const created = await registry.create({ cwd });
    expect(created.cwd).toBe(cwd);
    expect(factory.created[0]?.options).toEqual({ cwd });
    expect(vi.mocked(assertNoUserExtensions)).toHaveBeenCalledWith({ cwd });
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

  it("stops the child and marks the session stopped", async () => {
    const created = await registry.create({ cwd });
    await registry.stop(created.id);
    expect(factory.created[0]?.stats.stopped).toBe(1);
    expect(registry.list().find((s) => s.id === created.id)?.status).toBe("stopped");
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

  it("restarts with the same session path in a replacement adapter", async () => {
    const created = await registry.open({ cwd, sessionPath });
    await registry.restart(created.id);
    expect(factory.created).toHaveLength(2);
    expect(factory.created[1]?.options.sessionPath).toBe(sessionPath);
    expect(factory.created[1]?.stats.started).toBe(1);
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