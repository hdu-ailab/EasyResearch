import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionTreeNode } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../subagent/agents";
import {
  createPiAgentSessionCreator,
  type ManagedAgentSession,
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
  abortImpl: () => Promise<void> = async () => {};
  disposeCalls = 0;
  disposeImpl: () => void = () => {};
  unsubscribeCalls = 0;
  unsubscribeImpl: () => void = () => {};
  clearQueueCalls = 0;
  clearQueueImpl: () => void = () => {};
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
    return () => {
      this.unsubscribeCalls += 1;
      this.unsubscribeImpl();
      this.listeners.delete(listener);
    };
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
    await this.abortImpl();
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
    this.clearQueueImpl();
    this.steeringMessages = [];
    return { steering: [], followUp: [] };
  }

  dispose(): void {
    this.disposeCalls += 1;
    this.disposeImpl();
  }
}

interface ManagedHarness {
  session: FakeAgentSession;
  coordinator: {
    label: string;
    beginClosing(): void;
    subscribe(listener: (event: unknown) => void): () => void;
    emit(event: unknown): void;
  };
  supervisor: {
    label: string;
    abortAll(reason: string): Promise<void>;
    flushNotifications(options?: { triggerTurn?: boolean }): Promise<void>;
    waitForQuiescence(): Promise<void>;
    isQuiescent(): boolean;
    dispose(): Promise<void>;
  };
}

interface ManagedOverrides {
  coordinator?: {
    beginClosing?: () => void;
  };
  supervisor?: {
    abortAll?: (reason: string) => Promise<void>;
    flushNotifications?: (options?: { triggerTurn?: boolean }) => Promise<void>;
    waitForQuiescence?: () => Promise<void>;
    isQuiescent?: () => boolean;
    dispose?: () => Promise<void>;
  };
}

function managed(
  session: FakeAgentSession,
  label = session.sessionId,
  overrides: ManagedOverrides = {},
): ManagedHarness & ManagedAgentSession {
  const coordinatorListeners = new Set<(event: unknown) => void>();
  const harness: ManagedHarness = {
    session,
    coordinator: {
      label,
      beginClosing: overrides.coordinator?.beginClosing ?? (() => {}),
      subscribe(listener) {
        coordinatorListeners.add(listener);
        return () => coordinatorListeners.delete(listener);
      },
      emit(event) {
        for (const listener of coordinatorListeners) listener(event);
      },
    },
    supervisor: {
      label,
      abortAll: overrides.supervisor?.abortAll ?? (async () => {}),
      flushNotifications: overrides.supervisor?.flushNotifications ?? (async () => {}),
      waitForQuiescence: overrides.supervisor?.waitForQuiescence ?? (async () => {}),
      isQuiescent: overrides.supervisor?.isQuiescent ?? (() => true),
      dispose: overrides.supervisor?.dispose ?? (async () => {}),
    },
  };
  return harness as unknown as ManagedHarness & ManagedAgentSession;
}

describe("PiSessionFactory", () => {
  it("reports startup and recovery work until the managed runtime settles", async () => {
    const session = new FakeAgentSession();
    let releaseStart!: (runtime: ManagedHarness & ManagedAgentSession) => void;
    const startGate = new Promise<ManagedHarness & ManagedAgentSession>((resolve) => {
      releaseStart = resolve;
    });
    const factory = new PiSessionFactory(async () => startGate);
    const adapter = factory.create({ cwd: "/project" });

    expect(adapter.hasBackgroundWork()).toBe(false);
    const starting = adapter.start();
    expect(adapter.hasBackgroundWork()).toBe(true);
    releaseStart(managed(session));
    await starting;

    expect(adapter.hasBackgroundWork()).toBe(false);
  });

  it("releases startup background ownership after creation fails", async () => {
    const failure = new Error("recovery failed");
    let rejectStart!: (error: Error) => void;
    const startGate = new Promise<ManagedAgentSession>((_resolve, reject) => {
      rejectStart = reject;
    });
    const factory = new PiSessionFactory(async () => startGate);
    const adapter = factory.create({ cwd: "/project" });

    const starting = adapter.start();
    expect(adapter.hasBackgroundWork()).toBe(true);
    rejectStart(failure);
    await expect(starting).rejects.toBe(failure);

    expect(adapter.hasBackgroundWork()).toBe(false);
  });

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

  it("forwards coordinator progress but filters hidden status after supervisor observation", async () => {
    const hiddenContent = "<agent_status>Error subagent:{\"session_path\":\"/private/child.jsonl\"}</agent_status>\n<agent_handoff>secret handoff</agent_handoff>";
    const session = new FakeAgentSession();
    session.messages = [
      { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },
      {
        role: "custom",
        customType: "easyresearch:agent_status",
        content: hiddenContent,
        display: false,
        timestamp: 2,
      } as never,
    ];
    session.steeringMessages = [hiddenContent, "visible user steer"];
    const supervisorObserved: unknown[] = [];
    session.subscribe((event) => supervisorObserved.push(event));
    const runtime = managed(session);
    const factory = new PiSessionFactory(async () => runtime);
    const adapter = factory.create({ cwd: "/project" });
    const events: unknown[] = [];
    adapter.onEvent((event) => events.push(event));
    await adapter.start();

    const progress = {
      type: "subagent_supervisor",
      launchId: "launch-0",
      ownerSessionId: "session-1",
      toolCallId: "tool-0",
      agent: "search",
      agentId: "search_0",
      childSessionId: "child-0",
      status: "working",
    };
    runtime.coordinator.emit(progress);
    const hidden = {
      type: "message_end",
      message: {
        role: "custom",
        customType: "easyresearch:agent_status",
        content: hiddenContent,
        display: false,
      },
    };
    session.listeners.forEach((listener) => listener(hidden));
    session.listeners.forEach((listener) => listener({
      type: "queue_update",
      steering: [hiddenContent, "visible user steer"],
      followUp: [],
    }));
    session.listeners.forEach((listener) => listener({
      type: "agent_end",
      messages: [
        hidden.message,
        { role: "assistant", content: [{ type: "text", text: "visible" }], timestamp: 3 },
      ],
    }));

    expect(supervisorObserved).toContain(hidden);
    expect(events).toEqual([
      progress,
      {
        type: "queue_update",
        steering: ["visible user steer"],
        followUp: [],
      },
      {
        type: "agent_end",
        messages: [{ role: "assistant", content: [{ type: "text", text: "visible" }], timestamp: 3 }],
      },
    ]);
    await expect(adapter.getMessages()).resolves.toEqual([session.messages[0]]);
    expect(adapter.getSteeringMessages()).toEqual(["visible user steer"]);
    expect(JSON.stringify({ events, messages: await adapter.getMessages(), steering: adapter.getSteeringMessages() }))
      .not.toContain("/private/child.jsonl");
  });

  it("performs public Stop in tree-wide durable order and keeps the root connected", async () => {
    const session = new FakeAgentSession();
    session.isStreaming = true;
    session.steeringMessages = ["queued user steer"];
    const order: string[] = [];
    session.clearQueueImpl = () => order.push("session.clearQueue");
    session.abortImpl = async () => {
      order.push("session.abort");
    };
    const flushNotifications = vi.fn(async (options?: { triggerTurn?: boolean }) => {
      order.push("supervisor.flushNoTrigger");
      expect(options).toEqual({ triggerTurn: false });
    });
    const runtime = managed(session, session.sessionId, {
      coordinator: { beginClosing: () => order.push("coordinator.beginClosing") },
      supervisor: {
        abortAll: async () => {
          order.push("supervisor.abortAll");
        },
        flushNotifications,
      },
    });
    const factory = new PiSessionFactory(async () => runtime);
    const adapter = factory.create({ cwd: "/project" });
    await adapter.start();

    await adapter.abort();

    expect(order).toEqual([
      "coordinator.beginClosing",
      "session.clearQueue",
      "session.abort",
      "supervisor.abortAll",
      "supervisor.flushNoTrigger",
    ]);
    expect(session.steeringMessages).toEqual([]);
    expect(session.abortCalls).toBe(1);
    expect(session.disposeCalls).toBe(0);
    expect(session.listeners.size).toBeGreaterThan(0);
    await expect(adapter.getState()).resolves.toMatchObject({ sessionId: "session-1", isStreaming: false });
  });

  it("waits for descendants and pending-batch supersession before the no-trigger flush", async () => {
    const session = new FakeAgentSession();
    let releaseDescendants!: () => void;
    const descendantsSettled = new Promise<void>((resolve) => {
      releaseDescendants = resolve;
    });
    let pendingBatch = "natural-batch";
    let stopResolved = false;
    const flushNotifications = vi.fn(async () => {
      expect(pendingBatch).toBe("closing-batch");
    });
    const runtime = managed(session, session.sessionId, {
      supervisor: {
        abortAll: async () => {
          await descendantsSettled;
          pendingBatch = "closing-batch";
        },
        flushNotifications,
      },
    });
    const factory = new PiSessionFactory(async () => runtime);
    const adapter = factory.create({ cwd: "/project" });
    await adapter.start();

    const stopping = adapter.abort().then(() => {
      stopResolved = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(stopResolved).toBe(false);
    expect(flushNotifications).not.toHaveBeenCalled();
    releaseDescendants();
    await stopping;
    expect(flushNotifications).toHaveBeenCalledWith({ triggerTurn: false });
  });

  it("performs the same durable cleanup before stop unsubscribes and disposes", async () => {
    const session = new FakeAgentSession();
    const order: string[] = [];
    session.clearQueueImpl = () => order.push("session.clearQueue");
    session.abortImpl = async () => {
      order.push("session.abort");
    };
    session.unsubscribeImpl = () => order.push("session.unsubscribe");
    session.disposeImpl = () => order.push("session.dispose");
    const runtime = managed(session, session.sessionId, {
      coordinator: { beginClosing: () => order.push("coordinator.beginClosing") },
      supervisor: {
        abortAll: async () => {
          order.push("supervisor.abortAll");
        },
        flushNotifications: async () => {
          order.push("supervisor.flushNoTrigger");
        },
        dispose: async () => {
          order.push("supervisor.dispose");
        },
      },
    });
    const factory = new PiSessionFactory(async () => runtime);
    const adapter = factory.create({ cwd: "/project" });
    await adapter.start();

    await adapter.stop();
    await adapter.stop();

    expect(order).toEqual([
      "coordinator.beginClosing",
      "session.clearQueue",
      "session.abort",
      "supervisor.abortAll",
      "supervisor.flushNoTrigger",
      "supervisor.dispose",
      "session.unsubscribe",
      "session.dispose",
    ]);
    expect(session.listeners.size).toBe(0);
    await expect(adapter.getState()).rejects.toThrow("not started");
  });

  it.each([
    "coordinator closing",
    "queue clear",
    "session abort",
    "supervisor abort",
    "notification flush",
    "supervisor dispose",
    "listener removal",
    "session dispose",
  ] as const)(
    "attempts every root cleanup and retries only failed %s ownership",
    async (failedStep) => {
      const session = new FakeAgentSession();
      session.isStreaming = true;
      const failure = new Error(`${failedStep} failed`);
      let fail = true;
      const failOnce = () => {
        if (!fail) return;
        fail = false;
        throw failure;
      };
      const coordinatorClosing = vi.fn(() => {
        if (failedStep === "coordinator closing") failOnce();
      });
      if (failedStep === "queue clear") session.clearQueueImpl = failOnce;
      if (failedStep === "session abort") session.abortImpl = async () => failOnce();
      if (failedStep === "listener removal") session.unsubscribeImpl = failOnce;
      if (failedStep === "session dispose") session.disposeImpl = failOnce;
      const supervisorAbort = vi.fn(async () => {
        if (failedStep === "supervisor abort") failOnce();
      });
      const notificationFlush = vi.fn(async () => {
        if (failedStep === "notification flush") failOnce();
      });
      const supervisorDispose = vi.fn(async () => {
        if (failedStep === "supervisor dispose") failOnce();
      });
      const factory = new PiSessionFactory(async () => managed(
        session,
        session.sessionId,
        {
          coordinator: { beginClosing: coordinatorClosing },
          supervisor: {
            abortAll: supervisorAbort,
            flushNotifications: notificationFlush,
            dispose: supervisorDispose,
          },
        },
      ));
      const adapter = factory.create({ cwd: "/project" });
      await adapter.start();

      await expect(adapter.stop()).rejects.toBe(failure);
      const counts = () => ({
        coordinator: coordinatorClosing.mock.calls.length,
        clearQueue: session.clearQueueCalls,
        abort: session.abortCalls,
        supervisorAbort: supervisorAbort.mock.calls.length,
        notificationFlush: notificationFlush.mock.calls.length,
        supervisorDispose: supervisorDispose.mock.calls.length,
        unsubscribe: session.unsubscribeCalls,
        dispose: session.disposeCalls,
      });
      expect(counts()).toEqual({
        coordinator: 1,
        clearQueue: 1,
        abort: 1,
        supervisorAbort: 1,
        notificationFlush: 1,
        supervisorDispose: 1,
        unsubscribe: 1,
        dispose: 1,
      });

      await adapter.stop();
      const expected = (step: typeof failedStep) => step === failedStep ? 2 : 1;
      expect(counts()).toEqual({
        coordinator: expected("coordinator closing"),
        clearQueue: expected("queue clear"),
        abort: expected("session abort"),
        supervisorAbort: expected("supervisor abort"),
        notificationFlush: expected("notification flush"),
        supervisorDispose: expected("supervisor dispose"),
        unsubscribe: expected("listener removal"),
        dispose: expected("session dispose"),
      });

      await adapter.stop();
      expect(counts()).toEqual({
        coordinator: expected("coordinator closing"),
        clearQueue: expected("queue clear"),
        abort: expected("session abort"),
        supervisorAbort: expected("supervisor abort"),
        notificationFlush: expected("notification flush"),
        supervisorDispose: expected("supervisor dispose"),
        unsubscribe: expected("listener removal"),
        dispose: expected("session dispose"),
      });
    },
  );

  it("reports all root cleanup failures after attempting every sibling", async () => {
    const session = new FakeAgentSession();
    session.isStreaming = true;
    const failures = [
      new Error("coordinator closing failed"),
      new Error("queue clear failed"),
      new Error("session abort failed"),
      new Error("supervisor abort failed"),
      new Error("notification flush failed"),
      new Error("supervisor dispose failed"),
      new Error("listener removal failed"),
      new Error("session dispose failed"),
    ];
    session.clearQueueImpl = () => { throw failures[1]; };
    session.abortImpl = async () => { throw failures[2]; };
    session.unsubscribeImpl = () => { throw failures[6]; };
    session.disposeImpl = () => { throw failures[7]; };
    const coordinatorClosing = vi.fn(() => { throw failures[0]; });
    const supervisorAbort = vi.fn(async () => { throw failures[3]; });
    const notificationFlush = vi.fn(async () => { throw failures[4]; });
    const supervisorDispose = vi.fn(async () => { throw failures[5]; });
    const factory = new PiSessionFactory(async () => managed(
      session,
      session.sessionId,
      {
        coordinator: { beginClosing: coordinatorClosing },
        supervisor: {
          abortAll: supervisorAbort,
          flushNotifications: notificationFlush,
          dispose: supervisorDispose,
        },
      },
    ));
    const adapter = factory.create({ cwd: "/project" });
    await adapter.start();

    const cleanupError = await adapter.stop().then(
      () => undefined,
      (error) => error as AggregateError,
    );

    expect(cleanupError).toBeInstanceOf(AggregateError);
    expect(cleanupError?.errors).toEqual(failures);
    expect({
      coordinator: coordinatorClosing.mock.calls.length,
      clearQueue: session.clearQueueCalls,
      abort: session.abortCalls,
      supervisorAbort: supervisorAbort.mock.calls.length,
      notificationFlush: notificationFlush.mock.calls.length,
      supervisorDispose: supervisorDispose.mock.calls.length,
      unsubscribe: session.unsubscribeCalls,
      dispose: session.disposeCalls,
    }).toEqual({
      coordinator: 1,
      clearQueue: 1,
      abort: 1,
      supervisorAbort: 1,
      notificationFlush: 1,
      supervisorDispose: 1,
      unsubscribe: 1,
      dispose: 1,
    });
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
    const controls = {
      supervisorDispose: async (): Promise<void> => {},
      prepareSession: (_session: FakeAgentSession): void => {},
      recover: async (): Promise<void> => {},
    };
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
      recoverSubagentTree: async (options: { coordinator: unknown; expectedCwd: string }) => {
        calls.push({ name: "recovery", value: options });
        await controls.recover();
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
            await controls.supervisorDispose();
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
        controls.prepareSession(session);
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
    return { deps, calls, createdOptions, extensionRuntimes, coordinators, supervisors, assistant, controls };
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

  it("finishes recovery before a resumed root constructs extensions or accepts work", async () => {
    const harness = creatorHarness();
    let releaseRecovery!: () => void;
    const recoveryGate = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    harness.controls.recover = () => recoveryGate;
    const creator = createPiAgentSessionCreator(harness.deps as never);

    const creating = creator({ cwd: "/project", sessionPath: "/sessions/old.jsonl" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.calls.map(({ name }) => name)).toEqual([
      "session-manager",
      "coordinator",
      "recovery",
    ]);
    releaseRecovery();
    await creating;
    const order = harness.calls.map(({ name }) => name);
    expect(order.indexOf("recovery")).toBeLessThan(order.indexOf("extensions"));
    expect(order.indexOf("recovery")).toBeLessThan(order.indexOf("bind-extensions"));
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

  it("preserves construction and cleanup failures in deterministic cleanup order", async () => {
    const harness = creatorHarness();
    const failures = [
      new Error("extension binding failed"),
      new Error("supervisor disposal failed"),
      new Error("session disposal failed"),
    ];
    const order: string[] = [];
    harness.controls.supervisorDispose = async () => {
      order.push("supervisor");
      throw failures[1];
    };
    harness.controls.prepareSession = (session) => {
      session.bindExtensions = async () => {
        order.push("binding");
        throw failures[0];
      };
      session.disposeImpl = () => {
        order.push("session");
        throw failures[2];
      };
    };
    const creator = createPiAgentSessionCreator(harness.deps as never);

    const error = await creator({ cwd: "/project" }).then(
      () => undefined,
      (failure) => failure as AggregateError,
    );

    expect(error).toBeInstanceOf(AggregateError);
    expect(error?.errors).toEqual(failures);
    expect(order).toEqual(["binding", "supervisor", "session"]);
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

  it("leaves queued user and hidden supervisor steers intact when the run settles", async () => {
    const session = new FakeAgentSession();
    session.steeringMessages = ["undelivered note"];
    const runtime = managed(session, session.sessionId, {
      supervisor: { isQuiescent: () => false },
    });
    const factory = new PiSessionFactory(async () => runtime);
    const adapter = factory.create({ cwd: "/project" });
    const events: unknown[] = [];
    adapter.onEvent((event) => events.push(event));
    await adapter.start();

    runtime.coordinator.emit({
      type: "subagent_supervisor",
      agentId: "search_0",
      status: "working",
    });
    session.listeners.forEach((listener) => listener({ type: "agent_settled" }));

    expect(session.clearQueueCalls).toBe(0);
    expect(adapter.getSteeringMessages()).toEqual(["undelivered note"]);
    expect(adapter.hasBackgroundWork()).toBe(true);
    expect(events).toEqual([
      { type: "subagent_supervisor", agentId: "search_0", status: "working" },
      { type: "agent_settled" },
    ]);
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
