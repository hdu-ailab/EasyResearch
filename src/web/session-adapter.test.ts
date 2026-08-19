import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionTreeNode } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../subagent/agents";
import {
  createPiAgentSessionCreator,
  PiSessionFactory,
  type InProcessAgentSession,
  type StartSessionOptions,
  type SteerPromptOptions,
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
  promptError: Error | null = null;
  /** Override for simulating a run that settles later than preflight. */
  promptImpl: ((message: string, options?: SteerPromptOptions) => Promise<void>) | null = null;
  abortCalls = 0;
  disposeCalls = 0;
  clearQueueCalls = 0;
  steeringMessages: string[] = [];
  thinkingCalls: string[] = [];
  modelCalls: unknown[] = [];
  listeners = new Set<(event: unknown) => void>();
  bindCalls: unknown[] = [];
  baseSystemPrompt: string[] = [];
  wakeSystemPrompts: string[][] = [];

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

  async prompt(message: string, options?: SteerPromptOptions): Promise<void> {
    if (this.promptImpl) return this.promptImpl(message, options);
    this.promptCalls.push(
      options?.streamingBehavior === "steer" ? `${message} (steer)` : message,
    );
    if (this.promptError) {
      options?.preflightResult?.(false);
      throw this.promptError;
    }
    options?.preflightResult?.(true);
  }

  async abort(): Promise<void> {
    this.abortCalls += 1;
    this.isStreaming = false;
  }

  async bindExtensions(bindings: unknown): Promise<void> {
    this.bindCalls.push(bindings);
  }

  async waitForIdle(): Promise<void> {}

  async reload(): Promise<void> {}

  async sendCustomMessage(
    _message: { customType: string; content: string; display: boolean; details?: unknown },
    options: { deliverAs: "steer"; triggerTurn: boolean },
  ): Promise<void> {
    if (options.triggerTurn) this.wakeSystemPrompts.push([...this.baseSystemPrompt]);
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
    this.sessionName = name;
  }

  async navigateTree(): Promise<{ cancelled: boolean }> {
    return { cancelled: false };
  }

  getSteeringMessages(): readonly string[] {
    return this.steeringMessages;
  }

  clearQueue(): { steering: string[]; followUp: string[] } {
    this.clearQueueCalls += 1;
    this.steeringMessages = [];
    return { steering: [], followUp: [] };
  }

  dispose(): void {
    this.disposeCalls += 1;
  }
}

function managed(
  session: FakeAgentSession,
  label = session.sessionId,
  supervisorOverrides: { dispose?: () => Promise<void> } = {},
) {
  return {
    session,
    coordinator: { label },
    supervisor: {
      label,
      abortAll: async () => {},
      dispose: async () => {},
      ...supervisorOverrides,
    },
  } as never;
}

describe("PiSessionFactory", () => {
  it("creates an in-process session with the exact launch options", async () => {
    const created: StartSessionOptions[] = [];
    const session = new FakeAgentSession();
    const factory = new PiSessionFactory(async (options) => {
      created.push(options);
      return managed(session);
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
    const factory = new PiSessionFactory(async () => managed(session));
    const adapter = factory.create({ cwd: "/project" });
    const events: unknown[] = [];
    adapter.onEvent((event) => events.push(event));
    await adapter.start();

    await adapter.prompt("hello");
    await adapter.setModel("anthropic", "claude-test");
    await adapter.setThinkingLevel("high");
    session.listeners.forEach((listener) => listener({ type: "agent_start" }));

    expect(session.promptCalls).toEqual(["hello (steer)"]);
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
    const factory = new PiSessionFactory(async () => managed(session));
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
    const supervisorDispose = vi.fn(async () => {});
    session.isStreaming = true;
    const factory = new PiSessionFactory(async () => managed(session, session.sessionId, { dispose: supervisorDispose }));
    const adapter = factory.create({ cwd: "/project" });
    await adapter.start();

    await adapter.stop();
    await adapter.stop();

    expect(session.abortCalls).toBe(1);
    expect(supervisorDispose).toHaveBeenCalledOnce();
    expect(session.disposeCalls).toBe(1);
    expect(session.listeners.size).toBe(0);
  });

  it("rejects unknown models and invalid thinking levels", async () => {
    const session = new FakeAgentSession();
    const factory = new PiSessionFactory(async () => managed(session));
    const adapter = factory.create({ cwd: "/project" });
    await adapter.start();

    await expect(adapter.setModel("missing", "model")).rejects.toThrow("Unknown model");
    await expect(adapter.setThinkingLevel("extreme")).rejects.toThrow("Invalid thinking level");
  });
});

describe("createPiAgentSessionCreator", () => {
  function creatorHarness() {
    const calls: Array<{ name: string; value?: unknown }> = [];
    const createdOptions: Record<string, unknown>[] = [];
    const extensionRuntimes: Array<{ coordinator: unknown; supervisor: unknown }> = [];
    const coordinators: Array<{
      manager: unknown;
      bindPaperAssistantState: ReturnType<typeof vi.fn>;
      live?: { model(): string | undefined; thinking(): string | undefined };
    }> = [];
    const supervisors: Array<{
      coordinator: unknown;
      attached: FakeAgentSession[];
      disposeCalls: number;
      attach(session: FakeAgentSession): void;
      dispose(): Promise<void>;
    }> = [];
    let sessionSequence = 0;
    const assistant: AgentConfig = {
      name: "paper-assistant",
      description: "Paper Assistant",
      enabled: true,
      builtin: true,
      source: "project",
      filePath: "/project/.easyresearch/agents/paper-assistant.md",
      systemPrompt: "Project Paper Assistant body",
      tools: [],
      effectiveTools: ["read", "subagent"],
      skills: ["research-project-workflow"],
      effectiveSkills: ["research-project-workflow"],
      missingSkills: [],
    };
    const manager = (kind: "new" | "open", value: string) => ({
      kind,
      value,
      entries: [] as unknown[],
      getSessionId: () => `${kind}-${value}`,
      getSessionFile: () => kind === "open" ? value : `/sessions/${value}.jsonl`,
      getEntries() {
        return this.entries;
      },
      appendCustomEntry(customType: string, data?: unknown) {
        this.entries.push({ type: "custom", customType, data });
        return `entry-${this.entries.length}`;
      },
    });
    const deps = {
      agentDir: "/agent",
      createSessionManager: (cwd: string) => {
        calls.push({ name: "session-manager", value: cwd });
        return manager("new", cwd);
      },
      openSessionManager: (path: string) => {
        calls.push({ name: "session-manager", value: path });
        return manager("open", path);
      },
      createCoordinator: (sessionManager: unknown) => {
        const coordinator: (typeof coordinators)[number] = {
          manager: sessionManager,
          bindPaperAssistantState: vi.fn((live: { model(): string | undefined; thinking(): string | undefined }) => {
            coordinator.live = live;
            calls.push({ name: "bind-live", value: live });
          }),
        };
        coordinators.push(coordinator);
        calls.push({ name: "coordinator", value: coordinator });
        return coordinator;
      },
      createDirectChildSupervisor: (coordinator: unknown) => {
        const supervisor = {
          coordinator,
          attached: [] as FakeAgentSession[],
          disposeCalls: 0,
          attach(session: FakeAgentSession) {
            this.attached.push(session);
            calls.push({ name: "attach", value: session });
          },
          async dispose() {
            this.disposeCalls += 1;
          },
        };
        supervisors.push(supervisor);
        calls.push({ name: "supervisor", value: supervisor });
        return supervisor;
      },
      createExtensionFactories: (runtime: { coordinator: unknown; supervisor: unknown }) => {
        extensionRuntimes.push(runtime);
        calls.push({ name: "extensions", value: runtime });
        return [{ name: "paper-assistant", runtime }];
      },
      createSettingsManager: (cwd: string, agentDir: string) => {
        calls.push({ name: "settings", value: { cwd, agentDir } });
        return { kind: "settings" };
      },
      createModelRuntime: async (agentDir: string) => {
        calls.push({ name: "models", value: agentDir });
        return { getModel: () => model };
      },
      resolveAssistant: async (cwd: string) => {
        calls.push({ name: "assistant", value: cwd });
        return assistant;
      },
      resolveModel: async () => model,
      resolveSkillPaths: async () => ["/skills/research-project-workflow"],
      createResourceLoader: (options: {
        appendSystemPrompt?: string[];
        [key: string]: unknown;
      }) => {
        calls.push({ name: "loader", value: options });
        return {
          options,
          reload: async (reloadOptions?: { resolveProjectTrust?: () => Promise<boolean> }) => {
            calls.push({ name: "reload", value: await reloadOptions?.resolveProjectTrust?.() });
          },
        };
      },
      createAgentSession: async (options: Record<string, unknown>) => {
        createdOptions.push(options);
        const session = new FakeAgentSession();
        sessionSequence += 1;
        session.sessionId = `session-${sessionSequence}`;
        const loader = options.resourceLoader as { options?: { appendSystemPrompt?: string[] } };
        session.baseSystemPrompt = [...(loader.options?.appendSystemPrompt ?? [])];
        const originalBind = session.bindExtensions.bind(session);
        session.bindExtensions = async (bindings) => {
          calls.push({ name: "bind-extensions", value: bindings });
          await originalBind(bindings);
        };
        calls.push({ name: "pi-session", value: session });
        return { session };
      },
    };
    return { deps, calls, createdOptions, extensionRuntimes, coordinators, supervisors, assistant };
  }

  it("constructs one managed root in ownership-safe order with the effective body in the base prompt", async () => {
    const harness = creatorHarness();
    const creator = createPiAgentSessionCreator(harness.deps as never);

    const managedRoot = await creator({ cwd: "/project", thinking: "high" });

    expect(managedRoot).toMatchObject({
      session: { sessionId: "session-1" },
      coordinator: harness.coordinators[0],
      supervisor: harness.supervisors[0],
    });
    expect(harness.calls.find(({ name }) => name === "assistant")?.value).toBe("/project");
    expect(harness.calls.filter(({ name }) => name === "assistant")).toHaveLength(1);
    expect(harness.calls.find(({ name }) => name === "loader")?.value).toMatchObject({
      cwd: "/project",
      agentDir: "/agent",
      noSkills: true,
      additionalSkillPaths: ["/skills/research-project-workflow"],
      appendSystemPrompt: ["Project Paper Assistant body"],
      extensionFactories: [{ name: "paper-assistant" }],
    });
    const order = harness.calls.map(({ name }) => name);
    expect(order.indexOf("session-manager")).toBeLessThan(order.indexOf("coordinator"));
    expect(order.indexOf("coordinator")).toBeLessThan(order.indexOf("supervisor"));
    expect(order.indexOf("supervisor")).toBeLessThan(order.indexOf("extensions"));
    expect(order.indexOf("extensions")).toBeLessThan(order.indexOf("pi-session"));
    expect(order.indexOf("pi-session")).toBeLessThan(order.indexOf("bind-live"));
    expect(order.indexOf("bind-live")).toBeLessThan(order.indexOf("attach"));
    expect(order.indexOf("attach")).toBeLessThan(order.indexOf("bind-extensions"));

    const live = harness.coordinators[0]!.live!;
    expect(live.model()).toBe("openai/gpt-test");
    expect(live.thinking()).toBe("medium");
    const liveSession = managedRoot.session as FakeAgentSession;
    liveSession.model = { provider: "anthropic", id: "claude-live" } as InProcessAgentSession["model"];
    liveSession.thinkingLevel = "xhigh";
    expect(live.model()).toBe("anthropic/claude-live");
    expect(live.thinking()).toBe("xhigh");

    await managedRoot.session.sendCustomMessage(
      { customType: "easyresearch:agent_status", content: "done", display: false },
      { deliverAs: "steer", triggerTurn: true },
    );
    expect((managedRoot.session as FakeAgentSession).wakeSystemPrompts).toEqual([["Project Paper Assistant body"]]);
  });

  it("opens a persisted root without replacing its thinking level", async () => {
    const harness = creatorHarness();
    const creator = createPiAgentSessionCreator(harness.deps as never);

    await creator({ cwd: "/project", sessionPath: "/sessions/old.jsonl", thinking: "high" });

    expect(harness.createdOptions[0]).toMatchObject({
      sessionManager: { kind: "open", value: "/sessions/old.jsonl" },
    });
    expect(harness.createdOptions[0]).not.toHaveProperty("thinkingLevel");
  });

  it("never shares coordinator, supervisor, or extension state between root runtimes", async () => {
    const harness = creatorHarness();
    const creator = createPiAgentSessionCreator(harness.deps as never);

    const first = await creator({ cwd: "/project-a" });
    const second = await creator({ cwd: "/project-b" });

    expect(first.coordinator).not.toBe(second.coordinator);
    expect(first.supervisor).not.toBe(second.supervisor);
    expect(harness.extensionRuntimes).toEqual([
      { coordinator: first.coordinator, supervisor: first.supervisor },
      { coordinator: second.coordinator, supervisor: second.supervisor },
    ]);
  });

  it("disposes the unbound supervisor when extension construction fails", async () => {
    const harness = creatorHarness();
    harness.deps.createExtensionFactories = () => {
      throw new Error("extension construction failed");
    };
    const creator = createPiAgentSessionCreator(harness.deps as never);

    await expect(creator({ cwd: "/project" })).rejects.toThrow("extension construction failed");
    expect(harness.supervisors[0]?.disposeCalls).toBe(1);
  });
});

describe("DirectSessionAdapter steer lifecycle (ADR-083)", () => {
  it("exposes pending steering messages from the Pi session", async () => {
    const session = new FakeAgentSession();
    session.steeringMessages = ["note one", "note two"];
    const factory = new PiSessionFactory(async () => managed(session));
    const adapter = factory.create({ cwd: "/project" });
    await adapter.start();

    expect(adapter.getSteeringMessages()).toEqual(["note one", "note two"]);
  });

  it("clears the steer queue when the run settles", async () => {
    const session = new FakeAgentSession();
    session.steeringMessages = ["undelivered note"];
    const factory = new PiSessionFactory(async () => managed(session));
    const adapter = factory.create({ cwd: "/project" });
    await adapter.start();

    session.listeners.forEach((listener) => listener({ type: "agent_settled" }));

    expect(session.clearQueueCalls).toBe(1);
    expect(adapter.getSteeringMessages()).toEqual([]);
  });

  it("does not clear the queue for unrelated events", async () => {
    const session = new FakeAgentSession();
    const factory = new PiSessionFactory(async () => managed(session));
    const adapter = factory.create({ cwd: "/project" });
    await adapter.start();

    session.listeners.forEach((listener) => listener({ type: "agent_start" }));

    expect(session.clearQueueCalls).toBe(0);
  });

  it("resolves the Web prompt at preflight acceptance, not at run settlement (ADR-083)", async () => {
    const session = new FakeAgentSession();
    let runSettled = false;
    let preflightAccepted = false;
    const runGate = (() => {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { promise, release };
    })();
    session.promptImpl = async (_message, options) => {
      options?.preflightResult?.(true);
      preflightAccepted = true;
      await runGate.promise;
      runSettled = true;
    };
    const factory = new PiSessionFactory(async () => managed(session));
    const adapter = factory.create({ cwd: "/project" });
    await adapter.start();

    const webPrompt = adapter.prompt("steer note");
    // The Web request must resolve as soon as the prompt is accepted, before
    // the underlying run settles (which would hold the composer disabled).
    await webPrompt;

    expect(preflightAccepted).toBe(true);
    expect(runSettled).toBe(false);
    runGate.release();
  });

  it("rejects the Web prompt when preflight fails (ADR-083)", async () => {
    const session = new FakeAgentSession();
    session.promptError = new Error("no model selected");
    const factory = new PiSessionFactory(async () => managed(session));
    const adapter = factory.create({ cwd: "/project" });
    await adapter.start();

    await expect(adapter.prompt("hello")).rejects.toThrow("no model selected");
  });

  it("cancels undelivered steers when the run is aborted (ADR-083)", async () => {
    const session = new FakeAgentSession();
    session.steeringMessages = ["queued note"];
    const factory = new PiSessionFactory(async () => managed(session));
    const adapter = factory.create({ cwd: "/project" });
    await adapter.start();

    await adapter.abort();

    expect(session.clearQueueCalls).toBe(1);
    expect(session.abortCalls).toBe(1);
    expect(adapter.getSteeringMessages()).toEqual([]);
  });

});
