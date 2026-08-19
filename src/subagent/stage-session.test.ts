import { describe, expect, it } from "vitest";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentConfig } from "./agents";
import {
  createStageSessionRunner,
  type StageAgentSession,
  type StageSessionDependencies,
} from "./stage-session";

const agent: AgentConfig = {
  name: "search",
  description: "Search",
  enabled: true,
  builtin: true,
  source: "bundled",
  filePath: "/agents/search.md",
  systemPrompt: "Search carefully.",
  tools: ["read", "web-search"],
  effectiveTools: ["read", "web-search"],
  skills: ["paper-search"],
  effectiveSkills: ["paper-search"],
  missingSkills: [],
  subagents: [],
};

function assistant(text: string): AgentMessage {
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

class FakeStageSession implements StageAgentSession {
  sessionId = "child-1";
  sessionFile = "/sessions/child-1.jsonl";
  thinkingLevel: ThinkingLevel = "high";
  model = { provider: "openai", id: "gpt-test" } as Model<any>;
  isStreaming = false;
  promptCalls: string[] = [];
  activeTools: string[][] = [];
  names: string[] = [];
  abortCalls = 0;
  disposeCalls = 0;
  listeners = new Set<(event: unknown) => void>();

  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async bindExtensions(): Promise<void> {}
  setSessionName(name: string): void {
    this.names.push(name);
  }
  getAllTools(): Array<{ name: string }> {
    return [{ name: "read" }, { name: "web-search" }, { name: "subagent" }];
  }
  setActiveToolsByName(names: string[]): void {
    this.activeTools.push(names);
  }
  async prompt(message: string): Promise<void> {
    this.promptCalls.push(message);
    const update = {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "stage token",
        partial: { role: "assistant", content: [{ type: "text", text: "all stage tokens" }] },
      },
    };
    this.listeners.forEach((listener) => listener(update));
    const event = { type: "message_end", message: assistant("stage complete") };
    this.listeners.forEach((listener) => listener(event));
  }
  async abort(): Promise<void> {
    this.abortCalls += 1;
  }
  dispose(): void {
    this.disposeCalls += 1;
  }
}

function dependencies(session: FakeStageSession, calls: Array<{ name: string; value?: unknown }>): StageSessionDependencies {
  return {
    agentDir: "/agent",
    createSessionManager: (cwd) => {
      calls.push({ name: "createManager", value: cwd });
      return { kind: "new" };
    },
    openSessionManager: (path) => {
      calls.push({ name: "openManager", value: path });
      return { kind: "open", path };
    },
    createSettingsManager: () => ({ getGlobalSettings: () => ({}) }),
    createModelRuntime: async () => ({
      getModel: (provider: string, id: string) => ({ provider, id } as Model<any>),
    }),
    createResourceLoader: (options) => {
      calls.push({ name: "loader", value: options });
      return { reload: async () => {} };
    },
    createAgentSession: async (options) => {
      calls.push({ name: "createSession", value: options });
      return { session };
    },
    createExtensionFactories: (stageAgent) => [
      { name: "stage", caller: stageAgent.name },
      { name: "web-search" },
    ],
    resolveSkillPaths: () => ["/skills/paper-search"],
  };
}

describe("createStageSessionRunner", () => {
  it("runs a stage in-process and preserves streamed result metadata", async () => {
    const calls: Array<{ name: string; value?: unknown }> = [];
    const session = new FakeStageSession();
    const headers: unknown[] = [];
    const updates: unknown[] = [];
    const run = createStageSessionRunner(dependencies(session, calls));

    const result = await run({
      agent,
      task: "find papers",
      cwd: "/project",
      model: "openai/gpt-test",
      thinking: "high",
      onSessionHeader: (header) => headers.push(header),
      onEvent: (event) => updates.push(event),
    });

    expect(calls.find((call) => call.name === "createManager")?.value).toBe("/project");
    expect(calls.some((call) => call.name === "openManager")).toBe(false);
    expect(calls.find((call) => call.name === "loader")?.value).toMatchObject({
      cwd: "/project",
      noSkills: true,
      additionalSkillPaths: ["/skills/paper-search"],
      appendSystemPrompt: ["Search carefully."],
      extensionFactories: [{ name: "stage", caller: "search" }, { name: "web-search" }],
    });
    expect(calls.find((call) => call.name === "createSession")?.value).toMatchObject({
      tools: ["read", "web-search"],
      thinkingLevel: "high",
      model: { provider: "openai", id: "gpt-test" },
      sessionManager: { kind: "new" },
    });
    expect(headers).toEqual([{ id: "child-1", cwd: "/project", sessionPath: "/sessions/child-1.jsonl" }]);
    expect(session.names).toEqual(["easyresearch:search"]);
    expect(session.promptCalls).toEqual(["Task: find papers"]);
    expect(updates).toEqual([
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "stage token" },
      },
      expect.objectContaining({ type: "message_end" }),
    ]);
    expect(result).toMatchObject({
      agent: "search",
      exitCode: 0,
      sessionId: "child-1",
      sessionPath: "/sessions/child-1.jsonl",
      stopReason: "stop",
      usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: 0.25, contextTokens: 14, turns: 1 },
    });
    expect(session.disposeCalls).toBe(1);
  });

  it("preserves session metadata when setup fails after session creation", async () => {
    const calls: Array<{ name: string; value?: unknown }> = [];
    const session = new FakeStageSession();
    const headers: unknown[] = [];
    session.bindExtensions = async () => {
      throw new Error("extension setup failed");
    };
    const run = createStageSessionRunner(dependencies(session, calls));

    const result = await run({
      agent,
      task: "find papers",
      cwd: "/project",
      onSessionHeader: (header) => headers.push(header),
    });

    expect(result).toMatchObject({
      exitCode: 1,
      errorMessage: "extension setup failed",
      sessionId: "child-1",
      sessionPath: "/sessions/child-1.jsonl",
    });
    expect(headers).toEqual([{ id: "child-1", cwd: "/project", sessionPath: "/sessions/child-1.jsonl" }]);
    expect(session.disposeCalls).toBe(1);
  });

  it("preserves fresh child identity when already aborted before assistant output", async () => {
    const calls: Array<{ name: string; value?: unknown }> = [];
    const session = new FakeStageSession();
    const headers: unknown[] = [];
    const controller = new AbortController();
    controller.abort();
    const run = createStageSessionRunner(dependencies(session, calls));

    const result = await run({
      agent,
      task: "cancel before output",
      cwd: "/project",
      signal: controller.signal,
      onSessionHeader: (header) => headers.push(header),
    });

    expect(calls.find((call) => call.name === "createManager")?.value).toBe("/project");
    expect(calls.some((call) => call.name === "openManager")).toBe(false);
    expect(session.promptCalls).toEqual([]);
    expect(session.abortCalls).toBe(1);
    expect(headers).toEqual([{ id: "child-1", cwd: "/project", sessionPath: "/sessions/child-1.jsonl" }]);
    expect(result).toMatchObject({
      exitCode: 1,
      wasAborted: true,
      messages: [],
      sessionId: "child-1",
      sessionPath: "/sessions/child-1.jsonl",
    });
    expect(session.disposeCalls).toBe(1);
  });

  it("opens the supplied existing session path and aborts through the signal", async () => {
    const calls: Array<{ name: string; value?: unknown }> = [];
    const session = new FakeStageSession();
    session.prompt = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    };
    const controller = new AbortController();
    controller.abort();
    const run = createStageSessionRunner(dependencies(session, calls));

    const result = await run({
      agent,
      task: "continue",
      cwd: "/project",
      sessionPath: "/sessions/existing.jsonl",
      signal: controller.signal,
    });

    expect(calls.some((call) => call.name === "createManager")).toBe(false);
    expect(calls.find((call) => call.name === "openManager")?.value).toBe("/sessions/existing.jsonl");
    expect(session.abortCalls).toBe(1);
    expect(result.wasAborted).toBe(true);
  });

  it("reapplies an abort that arrives before the agent run starts", async () => {
    const calls: Array<{ name: string; value?: unknown }> = [];
    const session = new FakeStageSession();
    const controller = new AbortController();
    let releasePreflight: (() => void) | undefined;
    let finishAgent: (() => void) | undefined;
    let markPromptStarted: (() => void) | undefined;
    let markAgentStarted: (() => void) | undefined;
    const preflight = new Promise<void>((resolve) => {
      releasePreflight = resolve;
    });
    const agentFinished = new Promise<void>((resolve) => {
      finishAgent = resolve;
    });
    const promptStarted = new Promise<void>((resolve) => {
      markPromptStarted = resolve;
    });
    const agentStarted = new Promise<void>((resolve) => {
      markAgentStarted = resolve;
    });
    let activeAbortCalls = 0;
    session.prompt = async (message) => {
      session.promptCalls.push(message);
      markPromptStarted?.();
      await preflight;
      session.isStreaming = true;
      session.listeners.forEach((listener) => listener({ type: "agent_start" }));
      markAgentStarted?.();
      await agentFinished;
      session.isStreaming = false;
    };
    session.abort = async () => {
      session.abortCalls += 1;
      if (session.isStreaming) {
        activeAbortCalls += 1;
        finishAgent?.();
      }
    };
    const run = createStageSessionRunner(dependencies(session, calls));
    const running = run({
      agent,
      task: "cancel during preflight",
      cwd: "/project",
      signal: controller.signal,
    });

    await promptStarted;
    controller.abort();
    releasePreflight?.();
    await agentStarted;
    await Promise.resolve();

    try {
      expect(activeAbortCalls).toBe(1);
    } finally {
      finishAgent?.();
      await running;
    }
    expect(session.promptCalls).toEqual(["Task: cancel during preflight"]);
    expect(session.abortCalls).toBeGreaterThanOrEqual(2);
  });
});
