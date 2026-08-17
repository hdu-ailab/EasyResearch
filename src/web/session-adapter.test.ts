import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionTreeNode } from "@earendil-works/pi-coding-agent";
import {
  createPiAgentSessionCreator,
  PiSessionFactory,
  type InProcessAgentSession,
  type StartSessionOptions,
} from "./session-adapter";

const model = {
  provider: "openai",
  id: "gpt-test",
} as InProcessAgentSession["model"];

class FakeAgentSession implements InProcessAgentSession {
  sessionFile = "/agent/sessions/--project--/session.jsonl";
  sessionId = "session-1";
  sessionName = "Paper";
  isStreaming = false;
  isCompacting = false;
  thinkingLevel: InProcessAgentSession["thinkingLevel"] = "medium";
  model = model;
  messages: AgentMessage[] = [];
  promptTemplates = [{ name: "review", description: "Review", source: "prompt" as const }];
  promptCalls: string[] = [];
  abortCalls = 0;
  disposeCalls = 0;
  thinkingCalls: string[] = [];
  modelCalls: unknown[] = [];
  nameCalls: string[] = [];
  listeners = new Set<(event: unknown) => void>();

  modelRuntime = {
    getModel: (provider: string, id: string) =>
      provider === "anthropic" && id === "claude-test"
        ? ({ provider, id } as InProcessAgentSession["model"])
        : undefined,
  };

  resourceLoader = {
    getSkills: () => ({
      skills: [{ name: "arxiv", description: "arXiv" }],
      diagnostics: [],
    }),
  };

  extensionRunner = {
    getRegisteredCommands: () => [
      { invocationName: "clear", description: "Clear", source: "extension" as const },
    ],
  };

  sessionManager = {
    getTree: () => [] as SessionTreeNode[],
    getLeafId: () => "leaf-1",
  };

  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(message: string): Promise<void> {
    this.promptCalls.push(message);
  }

  async abort(): Promise<void> {
    this.abortCalls += 1;
    this.isStreaming = false;
  }

  async setModel(next: NonNullable<InProcessAgentSession["model"]>): Promise<void> {
    this.modelCalls.push(next);
    this.model = next;
  }

  setThinkingLevel(level: InProcessAgentSession["thinkingLevel"]): void {
    this.thinkingCalls.push(level);
    this.thinkingLevel = level;
  }

  setSessionName(name: string): void {
    this.nameCalls.push(name);
    this.sessionName = name;
  }

  async navigateTree(): Promise<{ cancelled: boolean }> {
    return { cancelled: false };
  }

  dispose(): void {
    this.disposeCalls += 1;
  }
}

describe("PiSessionFactory", () => {
  it("creates an in-process session with the exact launch options", async () => {
    const created: StartSessionOptions[] = [];
    const session = new FakeAgentSession();
    const factory = new PiSessionFactory(async (options) => {
      created.push(options);
      return session;
    });
    const adapter = factory.create({
      cwd: "/project",
      sessionPath: "/agent/sessions/old.jsonl",
      thinking: "high",
    });

    await adapter.start();

    expect(created).toEqual([
      {
        cwd: "/project",
        sessionPath: "/agent/sessions/old.jsonl",
        thinking: "high",
      },
    ]);
    await expect(adapter.getState()).resolves.toMatchObject({
      sessionId: "session-1",
      sessionFile: session.sessionFile,
      sessionName: "Paper",
      isStreaming: false,
      thinkingLevel: "medium",
      model,
    });
  });

  it("uses direct AgentSession methods and event subscription", async () => {
    const session = new FakeAgentSession();
    const factory = new PiSessionFactory(async () => session);
    const adapter = factory.create({ cwd: "/project" });
    const events: unknown[] = [];
    adapter.onEvent((event) => events.push(event));
    await adapter.start();

    await adapter.prompt("hello");
    await adapter.setModel("anthropic", "claude-test");
    await adapter.setThinkingLevel("high");
    session.listeners.forEach((listener) => listener({ type: "agent_start" }));

    expect(session.promptCalls).toEqual(["hello"]);
    expect(session.modelCalls).toEqual([{ provider: "anthropic", id: "claude-test" }]);
    expect(session.thinkingCalls).toEqual(["high"]);
    expect(events).toEqual([{ type: "agent_start" }]);
    await expect(adapter.getTree()).resolves.toEqual({ tree: [], leafId: "leaf-1" });
    await expect(adapter.getCommands()).resolves.toEqual([
      { name: "clear", description: "Clear", source: "extension" },
      { name: "review", description: "Review", source: "prompt" },
      { name: "skill:arxiv", description: "arXiv", source: "skill" },
    ]);
  });

  it("forwards delta-only message updates to Web listeners", async () => {
    const session = new FakeAgentSession();
    const factory = new PiSessionFactory(async () => session);
    const adapter = factory.create({ cwd: "/project" });
    const events: unknown[] = [];
    adapter.onEvent((event) => events.push(event));
    await adapter.start();

    session.listeners.forEach((listener) =>
      listener({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "token",
          partial: { role: "assistant", content: [{ type: "text", text: "all tokens so far" }] },
        },
      }),
    );

    expect(events).toEqual([
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "token" },
      },
    ]);
  });

  it("aborts active work and disposes exactly once", async () => {
    const session = new FakeAgentSession();
    session.isStreaming = true;
    const factory = new PiSessionFactory(async () => session);
    const adapter = factory.create({ cwd: "/project" });
    await adapter.start();

    await adapter.stop();
    await adapter.stop();

    expect(session.abortCalls).toBe(1);
    expect(session.disposeCalls).toBe(1);
    expect(session.listeners.size).toBe(0);
  });

  it("rejects unknown models and invalid thinking levels", async () => {
    const session = new FakeAgentSession();
    const factory = new PiSessionFactory(async () => session);
    const adapter = factory.create({ cwd: "/project" });
    await adapter.start();

    await expect(adapter.setModel("missing", "model")).rejects.toThrow("Unknown model");
    await expect(adapter.setThinkingLevel("extreme")).rejects.toThrow("Invalid thinking level");
  });

  it("forwards session name changes to the live session", async () => {
    const session = new FakeAgentSession();
    const factory = new PiSessionFactory(async () => session);
    const adapter = factory.create({ cwd: "/project" });
    await adapter.start();

    await adapter.setSessionName("Refactor auth");

    expect(session.nameCalls).toEqual(["Refactor auth"]);
    await expect(adapter.getState()).resolves.toMatchObject({ sessionName: "Refactor auth" });
  });
});

describe("createPiAgentSessionCreator", () => {
  it("builds a fresh Pi session with inline extensions and exact cwd", async () => {
    const calls: Array<{ name: string; value?: unknown }> = [];
    const session = new FakeAgentSession() as FakeAgentSession & {
      bindExtensions(bindings: unknown): Promise<void>;
      waitForIdle(): Promise<void>;
      reload(): Promise<void>;
    };
    session.bindExtensions = async (bindings) => {
      calls.push({ name: "bind", value: bindings });
    };
    session.waitForIdle = async () => {};
    session.reload = async () => {};

    const creator = createPiAgentSessionCreator({
      agentDir: "/agent",
      extensionFactories: [{ name: "paper-assistant", factory: () => {} }],
      createSessionManager: (cwd) => {
        calls.push({ name: "createSessionManager", value: cwd });
        return { kind: "new" };
      },
      openSessionManager: (path) => {
        calls.push({ name: "openSessionManager", value: path });
        return { kind: "open" };
      },
      createSettingsManager: (cwd, agentDir) => {
        calls.push({ name: "settings", value: { cwd, agentDir } });
        return { kind: "settings" };
      },
      createModelRuntime: async (agentDir) => {
        calls.push({ name: "models", value: agentDir });
        return session.modelRuntime;
      },
      createResourceLoader: (options) => {
        calls.push({ name: "loader", value: options });
        return {
          reload: async (options?: { resolveProjectTrust?: () => Promise<boolean> }) => {
            calls.push({ name: "reload", value: await options?.resolveProjectTrust?.() });
          },
        };
      },
      createAgentSession: async (options) => {
        calls.push({ name: "createAgentSession", value: options });
        return { session };
      },
      resolveModel: async () => model,
      resolveSkillPaths: async () => [],
    });

    await creator({ cwd: "/project", thinking: "high" });

    expect(calls.find((call) => call.name === "createSessionManager")?.value).toBe("/project");
    expect(calls.some((call) => call.name === "openSessionManager")).toBe(false);
    expect(calls.find((call) => call.name === "settings")?.value).toEqual({ cwd: "/project", agentDir: "/agent" });
    expect(calls.find((call) => call.name === "reload")?.value).toBe(true);
    expect(calls.find((call) => call.name === "loader")?.value).toMatchObject({
      cwd: "/project",
      agentDir: "/agent",
      noSkills: true,
      extensionFactories: [{ name: "paper-assistant" }],
    });
    expect(calls.find((call) => call.name === "createAgentSession")?.value).toMatchObject({
      cwd: "/project",
      agentDir: "/agent",
      thinkingLevel: "high",
      model,
      sessionManager: { kind: "new" },
    });
    expect(calls.find((call) => call.name === "bind")?.value).toMatchObject({ mode: "rpc" });
  });

  it("opens a persisted session without replacing its thinking level", async () => {
    const calls: unknown[] = [];
    const session = new FakeAgentSession() as FakeAgentSession & {
      bindExtensions(): Promise<void>;
      waitForIdle(): Promise<void>;
      reload(): Promise<void>;
    };
    session.bindExtensions = async () => {};
    session.waitForIdle = async () => {};
    session.reload = async () => {};
    const creator = createPiAgentSessionCreator({
      agentDir: "/agent",
      extensionFactories: [],
      createSessionManager: () => ({ kind: "new" }),
      openSessionManager: (path) => ({ kind: "open", path }),
      createSettingsManager: () => ({}),
      createModelRuntime: async () => session.modelRuntime,
      createResourceLoader: () => ({ reload: async () => {} }),
      createAgentSession: async (options) => {
        calls.push(options);
        return { session };
      },
      resolveModel: async () => undefined,
      resolveSkillPaths: async () => [],
    });

    await creator({ cwd: "/project", sessionPath: "/sessions/old.jsonl", thinking: "high" });

    expect(calls[0]).toMatchObject({ sessionManager: { kind: "open", path: "/sessions/old.jsonl" } });
    expect(calls[0]).not.toHaveProperty("thinkingLevel");
  });

  it("loads the resolved skill paths into the session resource loader", async () => {
    const calls: Array<{ name: string; value?: unknown }> = [];
    const session = new FakeAgentSession() as FakeAgentSession & {
      bindExtensions(): Promise<void>;
      waitForIdle(): Promise<void>;
      reload(): Promise<void>;
    };
    session.bindExtensions = async () => {};
    session.waitForIdle = async () => {};
    session.reload = async () => {};
    const creator = createPiAgentSessionCreator({
      agentDir: "/agent",
      extensionFactories: [],
      createSessionManager: () => ({ kind: "new" }),
      openSessionManager: () => ({ kind: "open" }),
      createSettingsManager: () => ({}),
      createModelRuntime: async () => session.modelRuntime,
      createResourceLoader: (options) => {
        calls.push({ name: "loader", value: options });
        return { reload: async () => {} };
      },
      createAgentSession: async () => ({ session }),
      resolveModel: async () => undefined,
      resolveSkillPaths: async (cwd, agentDir) => {
        calls.push({ name: "skills", value: { cwd, agentDir } });
        return ["/skills/research-project-workflow", "/skills/find-skills"];
      },
    });

    await creator({ cwd: "/project" });

    expect(calls.find((call) => call.name === "skills")?.value).toEqual({ cwd: "/project", agentDir: "/agent" });
    expect(calls.find((call) => call.name === "loader")?.value).toMatchObject({
      noSkills: true,
      additionalSkillPaths: ["/skills/research-project-workflow", "/skills/find-skills"],
    });
  });
});
