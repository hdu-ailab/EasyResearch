import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionTreeNode } from "@earendil-works/pi-coding-agent";
import { ActiveSessionRegistry } from "./active-sessions";
import type {
  SessionAdapter,
  SessionFactory,
  SessionState,
  StartSessionOptions,
  WebSlashCommand,
} from "./session-adapter";

class DirectAdapter implements SessionAdapter {
  stopped = 0;
  private readonly listeners = new Set<(event: unknown) => void>();

  async start(): Promise<void> {}
  async stop(): Promise<void> {
    this.stopped += 1;
  }
  async prompt(): Promise<void> {}
  async abort(): Promise<void> {}
  async setModel(): Promise<void> {}
  async setThinkingLevel(): Promise<void> {}
  async getState(): Promise<SessionState> {
    return {
      sessionId: "direct-1",
      sessionFile: "/sessions/direct-1.jsonl",
      thinkingLevel: "off",
      isStreaming: false,
      isCompacting: false,
      messageCount: 0,
    };
  }
  async getMessages(): Promise<AgentMessage[]> {
    return [];
  }
  async getCommands(): Promise<WebSlashCommand[]> {
    return [];
  }
  async getTree(): Promise<{ tree: SessionTreeNode[]; leafId: string | null }> {
    return { tree: [], leafId: null };
  }
  async navigateTree(): Promise<void> {}
  onEvent(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

class DirectFactory implements SessionFactory {
  readonly adapter = new DirectAdapter();
  options: StartSessionOptions | undefined;
  create(options: StartSessionOptions): SessionAdapter {
    this.options = options;
    return this.adapter;
  }
}

describe("ActiveSessionRegistry in-process lifecycle", () => {
  it("owns an adapter without requiring a child-exit channel", async () => {
    const factory = new DirectFactory();
    const registry = new ActiveSessionRegistry(factory, undefined, { idleTimeoutMs: -1 });

    const created = await registry.create({ cwd: "/project" });
    await registry.stop(created.id);

    expect(factory.options).toEqual({ cwd: "/project" });
    expect(created).toMatchObject({ id: "direct-1", status: "ready" });
    expect(factory.adapter.stopped).toBe(1);
  });
});
