import { beforeEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { RpcEventListener, RpcSessionState } from "@earendil-works/pi-coding-agent";
import { PiRpcSessionFactory, type StartRpcSessionOptions } from "./rpc-session";

const fakeState: RpcSessionState = {
  thinkingLevel: "medium",
  isStreaming: false,
  isCompacting: false,
  steeringMode: "all",
  followUpMode: "one-at-a-time",
  sessionFile: "/agent/sessions/--cwd--/a.jsonl",
  sessionId: "sess-1",
  autoCompactionEnabled: true,
  messageCount: 3,
  pendingMessageCount: 0,
};

interface FakeClientOptions {
  cwd: string;
  cliPath: string;
  args: string[];
  env?: Record<string, string>;
}

class FakeRpcClient {
  static instances: FakeRpcClient[] = [];
  options: FakeClientOptions;
  startCalls = 0;
  stopCalls = 0;
  promptCalls: string[] = [];
  abortCalls = 0;
  setModelCalls: Array<{ provider: string; modelId: string }> = [];
  stateCalls = 0;
  messagesCalls = 0;
  listeners = new Set<RpcEventListener>();
  failState = false;
  startError: Error | null = null;

  constructor(options: FakeClientOptions) {
    this.options = options;
    FakeRpcClient.instances.push(this);
  }

  async start() {
    this.startCalls++;
    if (this.startError) throw this.startError;
  }
  async stop() {
    this.stopCalls++;
  }
  async prompt(message: string) {
    if (this.failState) throw new Error("child gone");
    this.promptCalls.push(message);
  }
  async abort() {
    this.abortCalls++;
  }
  async setModel(provider: string, modelId: string) {
    this.setModelCalls.push({ provider, modelId });
  }
  async getState() {
    this.stateCalls++;
    if (this.failState) throw new Error("child gone");
    return fakeState;
  }
  async getMessages(): Promise<AgentMessage[]> {
    this.messagesCalls++;
    return [];
  }
  onEvent(listener: RpcEventListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

const cliPath = fileURLToPath(new URL("../runtime/pi-bootstrap.mjs", import.meta.url));
const extensionPath = fileURLToPath(new URL("../runtime/assistant-extension.ts", import.meta.url));

describe("PiRpcSessionFactory", () => {
  beforeEach(() => {
    FakeRpcClient.instances = [];
  });

  it("maps options to cwd, bundled child path, and native args", () => {
    const factory = new PiRpcSessionFactory(FakeRpcClient);
    const options: StartRpcSessionOptions = {
      cwd: "/project",
      sessionPath: "/agent/sessions/--project--/old.jsonl",
    };
    const adapter = factory.create(options);
    void adapter;

    const client = FakeRpcClient.instances[0]!;
    expect(client.options.cwd).toBe("/project");
    expect(client.options.cliPath).toBe(cliPath);
    expect(client.options.args).toContain("--extension");
    expect(client.options.args).toContain(extensionPath);
    expect(client.options.args).toContain("--session");
    expect(client.options.args).toContain("/agent/sessions/--project--/old.jsonl");
    expect(client.options.args).toContain("--approve");
    expect(client.options.args).toContain("--no-skills");
    expect(client.options.args).not.toContain("--no-approve");
    expect(client.options.env).toEqual({ EASYRESEARCH_RPC_CHILD: "1" });
  });

  it("always passes --approve even without a session (ADR-018)", () => {
    const factory = new PiRpcSessionFactory(FakeRpcClient);
    factory.create({ cwd: "/plain" });
    const client = FakeRpcClient.instances[0]!;
    expect(client.options.args).not.toContain("--session");
    expect(client.options.args).toContain("--approve");
    expect(client.options.args).not.toContain("--no-approve");
    expect(client.options.args).toContain("--no-skills");
  });

  it("keeps skill discovery disabled at the RPC bootstrap boundary", () => {
    const factory = new PiRpcSessionFactory(FakeRpcClient);
    factory.create({ cwd: "/project-with-agent-config" });
    const args = FakeRpcClient.instances[0]!.options.args;
    expect(args).toContain("--no-skills");
    expect(args).not.toContain("--skill");
  });
});

describe("RpcSessionAdapter", () => {
  beforeEach(() => {
    FakeRpcClient.instances = [];
  });

  it("delegates start, prompt, abort, getState, getMessages, and stop exactly once", async () => {
    const factory = new PiRpcSessionFactory(FakeRpcClient);
    const adapter = factory.create({ cwd: "/project" });
    const client = FakeRpcClient.instances[0]!;

    await adapter.start();
    await adapter.prompt("hello");
    await adapter.abort();
    await adapter.getState();
    await adapter.getMessages();
    await adapter.stop();

    expect(client.startCalls).toBe(1);
    expect(client.promptCalls).toEqual(["hello"]);
    expect(client.abortCalls).toBe(1);
    expect(client.stateCalls).toBeGreaterThanOrEqual(1);
    expect(client.messagesCalls).toBe(1);
    expect(client.stopCalls).toBe(1);
  });

  it("forwards setModel with provider and model id", async () => {
    const factory = new PiRpcSessionFactory(FakeRpcClient);
    const adapter = factory.create({ cwd: "/project" });
    const client = FakeRpcClient.instances[0]!;

    await adapter.setModel("openai", "gpt-4o");
    expect(client.setModelCalls).toEqual([{ provider: "openai", modelId: "gpt-4o" }]);
  });

  it("forwards events from the client to listeners", async () => {
    const factory = new PiRpcSessionFactory(FakeRpcClient);
    const adapter = factory.create({ cwd: "/project" });
    const client = FakeRpcClient.instances[0]!;
    const listener = vi.fn();
    const unsubscribe = adapter.onEvent(listener);
    await adapter.start();

    client.listeners.forEach((l) => l({ type: "agent_start" } as never));
    expect(listener).toHaveBeenCalledWith({ type: "agent_start" });
    unsubscribe();
    client.listeners.forEach((l) => l({ type: "agent_end", messages: [], willRetry: false } as never));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("fires onExit once when a heartbeat get_state fails", async () => {
    vi.useFakeTimers();
    try {
      const factory = new PiRpcSessionFactory(FakeRpcClient, { heartbeatIntervalMs: 10 });
      const adapter = factory.create({ cwd: "/project" });
      const client = FakeRpcClient.instances[0]!;
      const onExit = vi.fn();
      adapter.onExit(onExit);
      await adapter.start();

      client.failState = true;
      await vi.advanceTimersByTimeAsync(25);
      await vi.advanceTimersByTimeAsync(25);

      expect(onExit).toHaveBeenCalledTimes(1);
      expect(onExit.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fire onExit after explicit stop, and heartbeat stops", async () => {
    vi.useFakeTimers();
    try {
      const factory = new PiRpcSessionFactory(FakeRpcClient, { heartbeatIntervalMs: 10 });
      const adapter = factory.create({ cwd: "/project" });
      const client = FakeRpcClient.instances[0]!;
      const onExit = vi.fn();
      adapter.onExit(onExit);
      await adapter.start();

      await adapter.stop();
      client.failState = true;
      await vi.advanceTimersByTimeAsync(50);

      expect(onExit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fires onExit when a command rejects because the child is gone", async () => {
    const factory = new PiRpcSessionFactory(FakeRpcClient);
    const adapter = factory.create({ cwd: "/project" });
    const client = FakeRpcClient.instances[0]!;
    const onExit = vi.fn();
    adapter.onExit(onExit);
    await adapter.start();

    client.failState = true;
    await expect(adapter.prompt("boom")).rejects.toThrow();
    expect(onExit).toHaveBeenCalledTimes(1);
  });
});
