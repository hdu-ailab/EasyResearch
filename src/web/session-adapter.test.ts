import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionTreeNode } from "@earendil-works/pi-coding-agent";
import type { AgentRuntimeBinding } from "../runtime/agent-runtime-binding";
import { excludedLocalShellTools } from "../runtime/platform-tools";
import type { AgentConfig } from "../subagent/agents";
import {
  ConfigurationUnavailableError,
  type LiveConfiguration,
} from "../runtime/live-configuration";
import {
  createPiAgentSessionCreator,
  type ManagedAgentSession,
  PiSessionFactory,
  type InProcessAgentSession,
  type StartSessionOptions,
  type SteerPromptOptions,
} from "./session-adapter";
import { ManualCompactionController } from "./manual-compaction";

const model = {
  provider: "openai",
  id: "gpt-test",
  reasoning: true,
  contextWindow: 128_000,
} as InProcessAgentSession["model"];

class FakeAgentSession implements InProcessAgentSession {
  agent: InProcessAgentSession["agent"] = { steeringMode: "one-at-a-time" };
  sessionFile = "/agent/sessions/--project--/session.jsonl";
  sessionId = "session-1";
  sessionName = "Paper";
  isStreaming = false;
  isIdle = true;
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
  compactCalls: Array<string | undefined> = [];
  compactImpl: () => Promise<void> = async () => {};
  abortCompactionCalls = 0;
  disposeCalls = 0;
  disposeImpl: () => void = () => {};
  unsubscribeCalls = 0;
  unsubscribeImpl: () => void = () => {};
  subscribeError: Error | null = null;
  clearQueueCalls = 0;
  clearQueueImpl: () => void = () => {};
  steeringMessages: string[] = [];
  thinkingCalls: string[] = [];
  modelCalls: unknown[] = [];
  navigateTreeCalls: string[] = [];
  navigateTreeOptions: Array<Record<string, unknown> | undefined> = [];
  treeFilterMode = "no-tools";
  branchSummarySkipPrompt = true;
  listeners = new Set<(event: unknown) => void>();
  bindCalls: unknown[] = [];
  baseSystemPrompt: string[] = [];
  wakeSystemPrompts: string[][] = [];
  skills = [{ name: "arxiv", description: "arXiv" }];
  contextUsage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  entries: unknown[] = [];

  modelRuntime = {
    getModel: (provider: string, id: string) =>
      provider === "anthropic" && id === "claude-test"
        ? ({ provider, id } as InProcessAgentSession["model"])
        : undefined,
  };

  resourceLoader = {
    getSkills: () => ({
      skills: this.skills,
      diagnostics: [],
    }),
  };

  extensionRunner = {
    getRegisteredCommands: () => [
      { invocationName: "clear", description: "Clear", source: "extension" as const },
      { invocationName: "web-tree", description: "Internal tree navigation", source: "extension" as const },
    ],
  };

  sessionManager = {
    getTree: () => [] as SessionTreeNode[],
    getLeafId: () => "leaf-1",
    getEntries: () => this.entries,
    getBranch: () => this.entries,
  };

  settingsManager = {
    getTreeFilterMode: () => this.treeFilterMode,
    getBranchSummarySkipPrompt: () => this.branchSummarySkipPrompt,
  };

  getSessionStats() {
    return { contextUsage: this.contextUsage };
  }

  subscribe(listener: (event: unknown) => void): () => void {
    if (this.subscribeError) throw this.subscribeError;
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

  async compact(customInstructions?: string): Promise<void> {
    this.compactCalls.push(customInstructions);
    await this.abort();
    this.isCompacting = true;
    try {
      await this.compactImpl();
    } finally {
      this.isCompacting = false;
    }
  }

  abortCompaction(): void {
    this.abortCompactionCalls += 1;
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

  async navigateTree(entryId: string, options?: Record<string, unknown>): Promise<{ cancelled: boolean; editorText?: string }> {
    this.navigateTreeCalls.push(entryId);
    this.navigateTreeOptions.push(options);
    return { cancelled: false, editorText: "restored prompt" };
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
  binding: AgentRuntimeBinding;
  compaction: ManualCompactionController;
  coordinator: {
    label: string;
    beginCancellation(): void;
    finishCancellation(): void;
    beginClosing(): void;
    subscribe(listener: (event: unknown) => void): () => void;
    emit(event: unknown): void;
  };
  supervisor: {
    label: string;
    cancelAll(reason: string): Promise<void>;
    abortAll(reason: string): Promise<void>;
    flushNotifications(options?: { triggerTurn?: boolean }): Promise<void>;
    waitForQuiescence(): Promise<void>;
    isQuiescent(): boolean;
    dispose(): Promise<void>;
  };
}

interface ManagedOverrides {
  coordinator?: {
    beginCancellation?: () => void;
    finishCancellation?: () => void;
    beginClosing?: () => void;
  };
  supervisor?: {
    cancelAll?: (reason: string) => Promise<void>;
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
  binding = new FakeRuntimeBinding(),
): ManagedHarness & ManagedAgentSession {
  const coordinatorListeners = new Set<(event: unknown) => void>();
  const compaction = new ManualCompactionController();
  compaction.attach(session);
  const harness: ManagedHarness = {
    session,
    compaction,
    coordinator: {
      label,
      beginCancellation: overrides.coordinator?.beginCancellation ?? (() => {}),
      finishCancellation: overrides.coordinator?.finishCancellation ?? (() => {}),
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
      cancelAll: overrides.supervisor?.cancelAll ?? (async () => {}),
      abortAll: overrides.supervisor?.abortAll ?? (async () => {}),
      flushNotifications: overrides.supervisor?.flushNotifications ?? (async () => {}),
      waitForQuiescence: overrides.supervisor?.waitForQuiescence ?? (async () => {}),
      isQuiescent: overrides.supervisor?.isQuiescent ?? (() => true),
      dispose: overrides.supervisor?.dispose ?? (async () => {}),
    },
    binding: binding as unknown as AgentRuntimeBinding,
  };
  return harness as unknown as ManagedHarness & ManagedAgentSession;
}

class FakeRuntimeBinding {
  ensureCalls = 0;
  disposeCalls = 0;
  ensureImpl: (() => Promise<void>) | undefined;
  disposeImpl: (() => Promise<void>) | undefined;
  policy = { triggerPercent: 70, enabled: true };

  compactionPolicy() {
    return { ...this.policy };
  }

  async ensureCurrent(): Promise<void> {
    this.ensureCalls += 1;
    await this.ensureImpl?.();
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
    await this.disposeImpl?.();
  }
}

function created(session: InProcessAgentSession, binding = new FakeRuntimeBinding()) {
  return managed(session as FakeAgentSession, session.sessionId, {}, binding);
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
    const factory = new PiSessionFactory(async () => created(session));
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
    await expect(adapter.getTree()).resolves.toEqual({
      tree: [],
      leafId: "leaf-1",
      filterMode: "no-tools",
      skipBranchSummaryPrompt: true,
    });
    await expect(adapter.getCommands()).resolves.toEqual([
      { name: "name", description: "Rename the current session", source: "extension" },
      { name: "history", description: "Browse the current session tree", source: "extension" },
      { name: "compact", description: "Compact the current session context", source: "extension" },
      { name: "statistics", description: "Show API usage statistics", source: "extension" },
      { name: "clear", description: "Clear", source: "extension" },
      { name: "review", description: "Review", source: "prompt" },
      { name: "skill:arxiv", description: "arXiv", source: "skill" },
    ]);
  });

  it("forwards native context usage when the runtime stats signal changes", async () => {
    const session = new FakeAgentSession();
    session.contextUsage = { tokens: null, contextWindow: 128_000, percent: null };
    const runtime = created(session);
    const adapter = new PiSessionFactory(async () => runtime).create({ cwd: "/project" });
    const events: unknown[] = [];
    adapter.onEvent((event) => events.push(event));
    await adapter.start();

    runtime.compaction.notifyStatsChanged();

    expect(events).toContainEqual({
      type: "session_stats_changed",
      contextUsage: { tokens: null, contextWindow: 128_000, percent: null },
      compactionPolicy: { triggerPercent: 70, enabled: true },
    });
  });

  it("tracks native compaction events as background work and visible state", async () => {
    const session = new FakeAgentSession();
    const adapter = new PiSessionFactory(async () => created(session)).create({ cwd: "/project" });
    const events: unknown[] = [];
    adapter.onEvent((event) => events.push(event));
    await adapter.start();

    session.isCompacting = true;
    session.listeners.forEach((listener) => listener({ type: "compaction_start", reason: "threshold" }));
    expect(adapter.hasBackgroundWork()).toBe(true);
    expect(events).toContainEqual({ type: "compaction_state_changed", state: "running" });

    session.isCompacting = false;
    session.listeners.forEach((listener) => listener({ type: "compaction_end", reason: "threshold", aborted: false }));
    expect(adapter.hasBackgroundWork()).toBe(false);
    expect(events).toContainEqual({ type: "compaction_state_changed", state: "idle" });
  });

  it("reserves built-in action names and keeps colliding Skills explicitly addressable", async () => {
    const session = new FakeAgentSession();
    session.skills = [
      { name: "name", description: "Name Skill" },
      { name: "history", description: "History Skill" },
      { name: "compact", description: "Compact Skill" },
    ];
    const adapter = new PiSessionFactory(async () => created(session)).create({ cwd: "/project" });
    await adapter.start();

    const commands = await adapter.getCommands();

    expect(commands.filter((command) => command.source !== "skill").slice(0, 3).map((command) => command.name))
      .toEqual(["name", "history", "compact"]);
    expect(commands.filter((command) => command.source === "skill"))
      .toEqual([
        { name: "skill:name", description: "Name Skill", source: "skill", requiresPrefix: true },
        { name: "skill:history", description: "History Skill", source: "skill", requiresPrefix: true },
        { name: "skill:compact", description: "Compact Skill", source: "skill", requiresPrefix: true },
      ]);
  });

  it("normalizes a loaded Skill's friendly slash command before prompting Pi", async () => {
    const session = new FakeAgentSession();
    session.skills = [{ name: "customize-easyresearch", description: "Customize EasyResearch" }];
    const adapter = new PiSessionFactory(async () => created(session)).create({ cwd: "/project" });
    await adapter.start();

    await adapter.prompt("/customize-easyresearch add a medical-review agent");

    expect(session.promptCalls).toEqual([
      "/skill:customize-easyresearch add a medical-review agent (steer)",
    ]);
  });

  it("resolves friendly Skill commands after applying the latest runtime binding", async () => {
    const session = new FakeAgentSession();
    session.skills = [];
    const binding = new FakeRuntimeBinding();
    binding.ensureImpl = async () => {
      session.skills = [{ name: "autoresearch", description: "Autonomous experiments" }];
    };
    const adapter = new PiSessionFactory(async () => created(session, binding)).create({ cwd: "/project" });
    await adapter.start();

    await adapter.prompt("/autoresearch improve validation F1");

    expect(session.promptCalls).toEqual([
      "/skill:autoresearch improve validation F1 (steer)",
    ]);
  });

  it("preserves native, extension, template, and unknown slash commands", async () => {
    const session = new FakeAgentSession();
    session.skills = [
      { name: "arxiv", description: "arXiv" },
      { name: "clear", description: "Skill colliding with an extension" },
      { name: "review", description: "Skill colliding with a prompt template" },
    ];
    const adapter = new PiSessionFactory(async () => created(session)).create({ cwd: "/project" });
    await adapter.start();

    await adapter.prompt("/skill:arxiv 1706.03762");
    await adapter.prompt("/skill:clear use the colliding Skill");
    await adapter.prompt("/clear all");
    await adapter.prompt("/review draft");
    await adapter.prompt("/unknown request");

    expect(session.promptCalls).toEqual([
      "/skill:arxiv 1706.03762 (steer)",
      "/skill:clear use the colliding Skill (steer)",
      "/clear all (steer)",
      "/review draft (steer)",
      "/unknown request (steer)",
    ]);
    await expect(adapter.getCommands()).resolves.toContainEqual({
      name: "skill:clear",
      description: "Skill colliding with an extension",
      source: "skill",
      requiresPrefix: true,
    });
  });

  it("removes the internal web-tree command from chat while preserving typed tree navigation", async () => {
    const session = new FakeAgentSession();
    session.skills = [{ name: "web-tree", description: "A Skill using the reserved name" }];
    const adapter = new PiSessionFactory(async () => created(session)).create({ cwd: "/project" });
    await adapter.start();

    await expect(adapter.prompt("/web-tree navigate entry-7")).rejects.toThrow(/not available/i);
    const result = await (adapter.navigateTree as unknown as (
      entryId: string,
      options: Record<string, unknown>,
    ) => Promise<unknown>)("entry-7", { summarize: true, customInstructions: "focus on evidence" });

    expect(session.promptCalls).toEqual([]);
    expect(session.navigateTreeCalls).toEqual(["entry-7"]);
    expect(session.navigateTreeOptions).toEqual([{ summarize: true, customInstructions: "focus on evidence" }]);
    expect(result).toEqual({ cancelled: false, editorText: "restored prompt", leafId: "leaf-1" });
    await expect(adapter.getCommands()).resolves.not.toContainEqual(
      expect.objectContaining({ name: "web-tree" }),
    );
    await expect(adapter.getCommands()).resolves.toContainEqual({
      name: "skill:web-tree",
      description: "A Skill using the reserved name",
      source: "skill",
      requiresPrefix: true,
    });
  });

  it("refuses tree navigation while the supervisor owns background work", async () => {
    const session = new FakeAgentSession();
    const runtime = managed(session, session.sessionId, {
      supervisor: { isQuiescent: () => false },
    });
    const adapter = new PiSessionFactory(async () => runtime).create({ cwd: "/project" });
    await adapter.start();

    await expect(adapter.navigateTree("entry-7")).rejects.toThrow(/active work/i);
    expect(session.navigateTreeCalls).toEqual([]);
  });

  it("ensures the binding is current before prompting and disposes its ownership", async () => {
    const order: string[] = [];
    const session = new FakeAgentSession();
    const binding = new FakeRuntimeBinding();
    binding.ensureImpl = async () => {
      order.push("ensure");
    };
    session.promptImpl = async (_message, options) => {
      order.push("prompt");
      options?.preflightResult?.(true);
    };
    const factory = new PiSessionFactory(async () => created(session, binding));
    const adapter = factory.create({ cwd: "/project" });
    await adapter.start();

    await adapter.prompt("hello");
    await adapter.stop();

    expect(order).toEqual(["ensure", "prompt"]);
    expect(binding.ensureCalls).toBe(1);
    expect(binding.disposeCalls).toBe(1);
    expect(session.disposeCalls).toBe(1);
  });

  it("disposes the session before the binding runtime on normal stop", async () => {
    const order: string[] = [];
    const session = new FakeAgentSession();
    const binding = new FakeRuntimeBinding();
    session.dispose = () => {
      order.push("session");
      session.disposeCalls += 1;
    };
    binding.disposeImpl = async () => {
      order.push("binding");
    };
    const adapter = new PiSessionFactory(async () => created(session, binding)).create({ cwd: "/project" });
    await adapter.start();

    await adapter.stop();

    expect(order).toEqual(["session", "binding"]);
  });

  it("stops a prompt waiting on configuration before it reaches Pi and waits before disposal", async () => {
    let releaseEnsure!: () => void;
    const ensureGate = new Promise<void>((resolve) => {
      releaseEnsure = resolve;
    });
    const session = new FakeAgentSession();
    const binding = new FakeRuntimeBinding();
    binding.ensureImpl = async () => ensureGate;
    const adapter = new PiSessionFactory(async () => created(session, binding)).create({ cwd: "/project" });
    await adapter.start();

    const promptOutcome = adapter.prompt("hello").then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    await vi.waitFor(() => expect(binding.ensureCalls).toBe(1));
    let stopSettled = false;
    const stopping = adapter.stop().then(() => {
      stopSettled = true;
    });
    await Promise.resolve();

    expect(stopSettled).toBe(false);
    expect(session.disposeCalls).toBe(0);
    releaseEnsure();
    await stopping;

    expect(await promptOutcome).toMatchObject({
      status: "rejected",
      error: expect.objectContaining({ message: "Session has stopped" }),
    });
    expect(session.promptCalls).toEqual([]);
    expect(session.disposeCalls).toBe(1);
  });

  it("reapplies stop after agent start when preflight accepted before Pi became active", async () => {
    let releaseAgentStart!: () => void;
    const agentStartGate = new Promise<void>((resolve) => {
      releaseAgentStart = resolve;
    });
    let releaseRun!: () => void;
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const session = new FakeAgentSession();
    session.promptImpl = async (_message, options) => {
      options?.preflightResult?.(true);
      await agentStartGate;
      session.isStreaming = true;
      session.listeners.forEach((listener) => listener({ type: "agent_start" }));
      await runGate;
      session.isStreaming = false;
      session.listeners.forEach((listener) => listener({ type: "agent_settled" }));
    };
    session.abort = async () => {
      session.abortCalls += 1;
      if (session.isStreaming) releaseRun();
    };
    const adapter = new PiSessionFactory(async () => created(session)).create({ cwd: "/project" });
    await adapter.start();
    await adapter.prompt("hello");

    let stopSettled = false;
    const stopping = adapter.stop().then(() => {
      stopSettled = true;
    });
    await vi.waitFor(() => expect(session.abortCalls).toBe(1));

    expect(stopSettled).toBe(false);
    expect(session.disposeCalls).toBe(0);

    releaseAgentStart();
    await vi.waitFor(() => expect(session.abortCalls).toBe(2));
    await stopping;

    expect(session.disposeCalls).toBe(1);
  });

  it("releases the creator handoff when event subscription fails", async () => {
    const order: string[] = [];
    const session = new FakeAgentSession();
    session.subscribeError = new Error("subscription failed");
    const binding = new FakeRuntimeBinding();
    session.dispose = () => {
      order.push("session");
      session.disposeCalls += 1;
    };
    binding.disposeImpl = async () => {
      order.push("binding");
    };
    const adapter = new PiSessionFactory(async () => created(session, binding)).create({ cwd: "/project" });

    await expect(adapter.start()).rejects.toThrow("subscription failed");

    expect(binding.disposeCalls).toBe(1);
    expect(session.disposeCalls).toBe(1);
    expect(order).toEqual(["session", "binding"]);
  });

  it("drains retained start cleanup before owning a second failed creation", async () => {
    const firstDispose = vi.fn()
      .mockRejectedValueOnce(new Error("first cleanup failed"))
      .mockResolvedValueOnce(undefined);
    const secondDispose = vi.fn()
      .mockRejectedValueOnce(new Error("second cleanup failed"))
      .mockResolvedValueOnce(undefined);
    const state = retryableStartHarness([firstDispose, secondDispose], new Set([1, 2]));
    const adapter = new PiSessionFactory(state.creator).create({ cwd: "/project" });

    await expect(adapter.start()).rejects.toThrow("resource reload 1 failed");
    await expect(adapter.start()).rejects.toThrow("resource reload 2 failed");
    await adapter.stop();

    expect(state.runtimeAttempts()).toBe(2);
    expect(firstDispose).toHaveBeenCalledTimes(2);
    expect(secondDispose).toHaveBeenCalledTimes(2);
  });

  it("does not create or overwrite another start owner while retained cleanup still fails", async () => {
    const firstDispose = vi.fn()
      .mockRejectedValueOnce(new Error("first cleanup failed"))
      .mockRejectedValueOnce(new Error("first cleanup still failed"))
      .mockResolvedValueOnce(undefined);
    const secondDispose = vi.fn();
    const state = retryableStartHarness([firstDispose, secondDispose], new Set([1]));
    const adapter = new PiSessionFactory(state.creator).create({ cwd: "/project" });

    await expect(adapter.start()).rejects.toThrow("resource reload 1 failed");
    await expect(adapter.start()).rejects.toThrow("first cleanup still failed");
    expect(state.runtimeAttempts()).toBe(1);

    await adapter.start();

    expect(state.runtimeAttempts()).toBe(2);
    expect(firstDispose).toHaveBeenCalledTimes(3);
    await adapter.stop();
    expect(secondDispose).toHaveBeenCalledTimes(1);
  });

  it("retries binding disposal after a failed stop while keeping successful cleanup one-shot", async () => {
    const session = new FakeAgentSession();
    const binding = new FakeRuntimeBinding();
    binding.disposeImpl = vi.fn()
      .mockRejectedValueOnce(new Error("binding disposal failed"))
      .mockResolvedValueOnce(undefined);
    const adapter = new PiSessionFactory(async () => created(session, binding)).create({ cwd: "/project" });
    await adapter.start();

    await expect(adapter.stop()).rejects.toThrow("binding disposal failed");
    await adapter.stop();

    expect(binding.disposeCalls).toBe(2);
    expect(session.disposeCalls).toBe(1);
    expect(session.listeners.size).toBe(0);
  });

  it("retries adapter unsubscription without repeating session or binding disposal", async () => {
    const session = new FakeAgentSession();
    const binding = new FakeRuntimeBinding();
    let unsubscribeCalls = 0;
    session.subscribe = () => () => {
      unsubscribeCalls += 1;
      if (unsubscribeCalls === 1) throw new Error("event unsubscribe failed");
    };
    const adapter = new PiSessionFactory(async () => created(session, binding)).create({ cwd: "/project" });
    await adapter.start();

    await expect(adapter.stop()).rejects.toThrow("event unsubscribe failed");
    await adapter.stop();

    expect(unsubscribeCalls).toBe(2);
    expect(session.disposeCalls).toBe(1);
    expect(binding.disposeCalls).toBe(1);
  });

  it("forwards delta-only message updates to Web listeners", async () => {
    const session = new FakeAgentSession();
    const factory = new PiSessionFactory(async () => created(session));
    const adapter = factory.create({ cwd: "/project" });
    const events: unknown[] = [];
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text: "all tokens so far" }],
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
    } satisfies Extract<AgentMessage, { role: "assistant" }>;
    adapter.onEvent((event) => events.push(event));
    await adapter.start();

    session.listeners.forEach((listener) =>
      listener({
        type: "message_update",
        message: assistant,
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "token",
          partial: assistant,
        },
      }),
    );

    expect(events).toEqual([
      {
        type: "message_update",
        usage: assistant.usage,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "token" },
      },
    ]);
  });

  it("forwards coordinator progress but filters hidden status after supervisor observation", async () => {
    const hiddenContent = [
      "<agent_status>",
      "Current time: 2026-08-19T00:00:00.000Z",
      'Error subagent:{"name":"search_0","session_path":"/private/child.jsonl"}',
      "</agent_status>",
      "<agent_handoff>",
      "Agent: search_0",
      "Result: secret handoff",
      "</agent_handoff>",
    ].join("\n");
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

  it("projects stable root message ids and active-branch usage from persisted entries", async () => {
    const session = new FakeAgentSession();
    const message = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "tracked reply" }],
      api: "openai-completions" as const,
      provider: "openai",
      model: "test-model",
      usage: {
        input: 7,
        output: 2,
        cacheRead: 1,
        cacheWrite: 0,
        totalTokens: 10,
        cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0, total: 0.31 },
      },
      stopReason: "stop" as const,
      timestamp: 42,
    };
    session.messages = [message];
    session.entries = [{
      type: "message",
      id: "entry-assistant",
      parentId: null,
      timestamp: "2026-08-25T00:00:00.000Z",
      message,
    }];
    const adapter = new PiSessionFactory(async () => managed(session)).create({ cwd: "/project" });
    await adapter.start();

    await expect(adapter.getMessages()).resolves.toEqual([{ ...message, id: "entry-assistant" }]);
    expect(adapter.getInlineUsage()).toEqual([
      expect.objectContaining({
        id: "entry-assistant",
        sessionId: "session-1",
        source: "assistant",
        anchor: { kind: "message", messageEntryId: "entry-assistant" },
      }),
    ]);
  });

  it("performs each public Stop as reusable cancellation and reserves terminal teardown for stop", async () => {
    const session = new FakeAgentSession();
    session.isStreaming = true;
    session.steeringMessages = ["queued user steer"];
    const order: string[] = [];
    session.clearQueueImpl = () => order.push("session.clearQueue");
    session.abortImpl = async () => {
      order.push("session.abort");
    };
    session.unsubscribeImpl = () => order.push("session.unsubscribe");
    session.disposeImpl = () => order.push("session.dispose");
    const beginClosing = vi.fn(() => order.push("coordinator.beginClosing"));
    const abortAll = vi.fn(async () => {
      order.push("supervisor.abortAll");
    });
    const dispose = vi.fn(async () => {
      order.push("supervisor.dispose");
    });
    const runtime = managed(session, session.sessionId, {
      coordinator: {
        beginCancellation: () => order.push("coordinator.beginCancellation"),
        finishCancellation: () => order.push("coordinator.finishCancellation"),
        beginClosing,
      },
      supervisor: {
        cancelAll: async () => {
          order.push("supervisor.cancelAll");
        },
        abortAll,
        flushNotifications: async () => {
          order.push("supervisor.flushNoTrigger");
        },
        dispose,
      },
    });
    const factory = new PiSessionFactory(async () => runtime);
    const adapter = factory.create({ cwd: "/project" });
    await adapter.start();

    await adapter.abort();

    expect(order).toEqual([
      "coordinator.beginCancellation",
      "session.clearQueue",
      "session.abort",
      "supervisor.cancelAll",
      "coordinator.finishCancellation",
    ]);
    expect(session.steeringMessages).toEqual([]);
    expect(session.abortCalls).toBe(1);
    expect(session.disposeCalls).toBe(0);
    expect(session.listeners.size).toBeGreaterThan(0);
    await expect(adapter.getState()).resolves.toMatchObject({ sessionId: "session-1", isStreaming: false });

    await adapter.prompt("new run");
    session.isStreaming = true;
    await adapter.abort();
    expect(order.slice(5)).toEqual([
      "coordinator.beginCancellation",
      "session.clearQueue",
      "session.abort",
      "supervisor.cancelAll",
      "coordinator.finishCancellation",
    ]);
    expect(session.clearQueueCalls).toBe(2);
    expect(session.abortCalls).toBe(2);
    expect(beginClosing).not.toHaveBeenCalled();
    expect(abortAll).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();

    await adapter.stop();
    expect(order.slice(10)).toEqual([
      "coordinator.beginClosing",
      "session.clearQueue",
      "session.abort",
      "supervisor.abortAll",
      "supervisor.flushNoTrigger",
      "supervisor.dispose",
      "session.unsubscribe",
      "session.dispose",
    ]);
  });

  it("waits for reusable descendant cancellation before resolving Stop", async () => {
    const session = new FakeAgentSession();
    let releaseDescendants!: () => void;
    const descendantsSettled = new Promise<void>((resolve) => {
      releaseDescendants = resolve;
    });
    let pendingBatch = "natural-batch";
    let stopResolved = false;
    const runtime = managed(session, session.sessionId, {
      supervisor: {
        cancelAll: async () => {
          await descendantsSettled;
          pendingBatch = "cancelled-batch";
        },
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
    expect(pendingBatch).toBe("natural-batch");
    releaseDescendants();
    await stopping;
    expect(pendingBatch).toBe("cancelled-batch");
  });

  it("shares concurrent cancellation and retries after a failed cancellation without reopening early", async () => {
    const session = new FakeAgentSession();
    let releaseCancellation!: () => void;
    const cancellationGate = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    const failure = new Error("descendant cancellation failed");
    let cancelAttempt = 0;
    const beginCancellation = vi.fn();
    const finishCancellation = vi.fn();
    const cancelAll = vi.fn(async () => {
      cancelAttempt += 1;
      if (cancelAttempt === 1) {
        await cancellationGate;
        throw failure;
      }
    });
    const adapter = new PiSessionFactory(async () => managed(session, session.sessionId, {
      coordinator: { beginCancellation, finishCancellation },
      supervisor: { cancelAll },
    })).create({ cwd: "/project" });
    await adapter.start();

    const first = adapter.abort();
    const concurrent = adapter.abort();
    await vi.waitFor(() => expect(cancelAll).toHaveBeenCalledTimes(1));
    expect(session.abortCalls).toBe(1);
    releaseCancellation();
    await expect(Promise.all([first, concurrent])).rejects.toBe(failure);
    expect(finishCancellation).not.toHaveBeenCalled();

    await expect(adapter.abort()).resolves.toBeUndefined();
    expect(beginCancellation).toHaveBeenCalledTimes(2);
    expect(session.clearQueueCalls).toBe(2);
    expect(session.abortCalls).toBe(2);
    expect(cancelAll).toHaveBeenCalledTimes(2);
    expect(finishCancellation).toHaveBeenCalledTimes(1);
  });

  it("serializes terminal stop behind an active reusable cancellation", async () => {
    const session = new FakeAgentSession();
    let releaseSessionAbort!: () => void;
    const sessionAbortGate = new Promise<void>((resolve) => {
      releaseSessionAbort = resolve;
    });
    session.abortImpl = async () => {
      if (session.abortCalls === 1) await sessionAbortGate;
    };
    const order: string[] = [];
    const runtime = managed(session, session.sessionId, {
      coordinator: {
        beginCancellation: () => order.push("beginCancellation"),
        finishCancellation: () => order.push("finishCancellation"),
        beginClosing: () => order.push("beginClosing"),
      },
      supervisor: {
        cancelAll: async () => {
          order.push("cancelAll");
        },
        abortAll: async () => {
          order.push("abortAll");
        },
      },
    });
    const adapter = new PiSessionFactory(async () => runtime).create({ cwd: "/project" });
    await adapter.start();

    const cancelling = adapter.abort();
    await vi.waitFor(() => expect(session.abortCalls).toBe(1));
    const stopping = adapter.stop();
    await Promise.resolve();
    expect(session.abortCalls).toBe(1);
    expect(order).toEqual(["beginCancellation"]);

    releaseSessionAbort();
    await Promise.all([cancelling, stopping]);
    expect(session.abortCalls).toBe(2);
    expect(order).toEqual([
      "beginCancellation",
      "cancelAll",
      "finishCancellation",
      "beginClosing",
      "abortAll",
    ]);
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

      if (failedStep === "session abort") {
        await expect(adapter.stop()).rejects.toThrow("Session stop could not abort active work");
      } else {
        await expect(adapter.stop()).rejects.toBe(failure);
      }
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
    expect(cleanupError?.errors).toEqual([
      failures[0],
      failures[1],
      expect.objectContaining({ message: "Session stop could not abort active work. Retry stop." }),
      ...failures.slice(3),
    ]);
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

  it("returns a safe abort failure without waiting forever, then retries the live prompt", async () => {
    let releaseRun!: () => void;
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const session = new FakeAgentSession();
    const binding = new FakeRuntimeBinding();
    session.promptImpl = async (_message, options) => {
      options?.preflightResult?.(true);
      session.isStreaming = true;
      session.isIdle = false;
      await runGate;
      session.isStreaming = false;
      session.isIdle = true;
      session.listeners.forEach((listener) => listener({ type: "agent_settled" }));
    };
    session.abort = vi.fn()
      .mockRejectedValueOnce(new Error("SECRET abort failure at /private/session.jsonl"))
      .mockImplementationOnce(async () => {
        releaseRun();
      });
    const adapter = new PiSessionFactory(async () => created(session, binding)).create({ cwd: "/project" });
    await adapter.start();
    await adapter.prompt("hello");

    let firstStopOutcome: { error?: unknown } | undefined;
    void adapter.stop().then(
      () => {
        firstStopOutcome = {};
      },
      (error: unknown) => {
        firstStopOutcome = { error };
      },
    );
    await vi.waitFor(() => expect(firstStopOutcome).toBeDefined());

    expect(firstStopOutcome?.error).toBeInstanceOf(Error);
    expect((firstStopOutcome?.error as Error).message).toMatch(/stop|abort/i);
    expect((firstStopOutcome?.error as Error).message).not.toContain("SECRET");
    expect((firstStopOutcome?.error as Error).message).not.toContain("/private/session.jsonl");
    expect(session.disposeCalls).toBe(1);
    expect(binding.disposeCalls).toBe(1);

    await adapter.stop();

    expect(session.abort).toHaveBeenCalledTimes(2);
    expect(session.disposeCalls).toBe(1);
    expect(binding.disposeCalls).toBe(1);
  });

  it("retries a failed stop abort before one-shot session disposal", async () => {
    const session = new FakeAgentSession();
    session.isStreaming = true;
    session.abort = vi.fn()
      .mockRejectedValueOnce(new Error("abort failed"))
      .mockImplementationOnce(async () => {
        session.isStreaming = false;
      });
    const adapter = new PiSessionFactory(async () => created(session)).create({ cwd: "/project" });
    await adapter.start();

    await expect(adapter.stop()).rejects.toThrow(/stop|abort/i);
    expect(session.disposeCalls).toBe(1);

    await adapter.stop();

    expect(session.abort).toHaveBeenCalledTimes(2);
    expect(session.disposeCalls).toBe(1);
  });

  it("rejects unknown models and invalid thinking levels", async () => {
    const session = new FakeAgentSession();
    const factory = new PiSessionFactory(async () => created(session));
    const adapter = factory.create({ cwd: "/project" });
    await adapter.start();

    await expect(adapter.setModel("missing", "model")).rejects.toThrow("Unknown model");
    await expect(adapter.setThinkingLevel("extreme")).rejects.toThrow("Invalid thinking level");
  });
});

function researchAssistant(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "research-assistant",
    description: "Research Assistant",
    enabled: true,
    builtin: true,
    tools: ["read", "subagent"],
    effectiveTools: ["read", "subagent"],
    subagents: ["search"],
    skills: ["research-project-workflow"],
    effectiveSkills: ["research-project-workflow"],
    missingSkills: [],
    model: "openai/gpt-test",
    thinking: "high",
    systemPrompt: "Current Research Assistant body",
    source: "global",
    filePath: "/private/research-assistant.md",
    ...overrides,
  };
}

function fakeSettingsManager<T extends object>(base: T): T & {
  getCompactionSettings(): { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
  applyOverrides(overrides: { compaction: { enabled: boolean; reserveTokens: number; keepRecentTokens: number } }): void;
} {
  let compaction = { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 };
  return Object.assign(base, {
    getCompactionSettings: () => ({ ...compaction }),
    applyOverrides: (overrides: { compaction: typeof compaction }) => {
      compaction = { ...overrides.compaction };
    },
  });
}

function liveConfiguration(agent: AgentConfig = researchAssistant()): LiveConfiguration {
  return {
    generation: 1,
    error: null,
    compactionPolicy: { triggerPercent: 70, globalEnabled: true, globalKeepRecentTokens: 20_000 },
    apiUsageSettings: { showApiUsageDetails: false },
    start: async () => {},
    synchronize: async () => {},
    isCurrent: (generation) => generation === 1,
    notify: async () => {},
    resolveAgents: async () => [agent],
    subscribe: () => () => {},
    close: async () => {},
  };
}

function bindableSession(calls: Array<{ name: string; value?: unknown }>) {
  const session = new FakeAgentSession();
  session.bindExtensions = async (bindings) => {
    session.bindCalls.push(bindings);
    calls.push({ name: "bind-extensions", value: bindings });
  };
  session.reload = async () => {
    calls.push({ name: "sessionReload" });
  };
  return session;
}

function runtimeOwnerDeps() {
  const listeners = new Set<(event: unknown) => void>();
  return {
    createCoordinator: () => ({
      bindResearchAssistantState: () => {},
      beginCancellation: () => {},
      finishCancellation: () => {},
      beginClosing: () => {},
      subscribe(listener: (event: unknown) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as never),
    recoverSubagentTree: async () => {},
    createDirectChildSupervisor: () => ({
      attach: () => {},
      cancelAll: async () => {},
      abortAll: async () => {},
      flushNotifications: async () => {},
      isQuiescent: () => true,
      dispose: async () => {},
    } as never),
  };
}

function retryableStartHarness(
  disposals: Array<ReturnType<typeof vi.fn>>,
  failingResourceAttempts: ReadonlySet<number>,
) {
  let runtimeAttempts = 0;
  const session = bindableSession([]);
  const creator = createPiAgentSessionCreator({
    agentDir: "/agent",
    liveConfiguration: liveConfiguration(),
    ...runtimeOwnerDeps(),
    createExtensionFactories: () => [],
    createSessionManager: () => ({} as never),
    openSessionManager: () => ({} as never),
    createSettingsManager: () => fakeSettingsManager({}),
    createModelRuntime: async () => {
      const attempt = ++runtimeAttempts;
      return {
        refresh: async () => {},
        getModel: () => model,
        getError: () => undefined,
        dispose: disposals[attempt - 1],
      };
    },
    createResourceLoader: () => {
      const attempt = runtimeAttempts;
      return {
        reload: async () => {
          if (failingResourceAttempts.has(attempt)) {
            throw new Error(`resource reload ${attempt} failed`);
          }
        },
      };
    },
    createAgentSession: async () => ({ session }),
    resolveAutomaticModel: async () => undefined,
    resolveSkillPaths: () => [],
  } as never);
  return { creator, runtimeAttempts: () => runtimeAttempts };
}

describe("createPiAgentSessionCreator", () => {
  function creatorHarness() {
    const calls: Array<{ name: string; value?: unknown }> = [];
    const createdOptions: Record<string, unknown>[] = [];
    const extensionRuntimes: Array<{ coordinator: unknown; supervisor: unknown; binding: AgentRuntimeBinding }> = [];
    const coordinators: Array<{
      manager: unknown;
      bindResearchAssistantState: ReturnType<typeof vi.fn>;
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
    const assistant = researchAssistant({ systemPrompt: "Project Research Assistant body" });
    const live = liveConfiguration(assistant);
    const rawSettings = fakeSettingsManager({ kind: "settings" });
    const modelRuntime = {
      refresh: async (options: unknown) => calls.push({ name: "model-refresh", value: options }),
      getModel: (provider: string, id: string) => provider === "openai" && id === "gpt-test" ? model : undefined,
      getError: () => undefined,
      dispose: async () => {
        calls.push({ name: "model-dispose" });
      },
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
      liveConfiguration: live,
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
          bindResearchAssistantState: vi.fn((live: { model(): string | undefined; thinking(): string | undefined }) => {
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
      createExtensionFactories: (runtime: {
        coordinator: unknown;
        supervisor: unknown;
        binding: AgentRuntimeBinding;
      }) => {
        extensionRuntimes.push(runtime);
        calls.push({ name: "extensions", value: runtime });
        return [{ name: "research-assistant", runtime }];
      },
      createSettingsManager: (cwd: string, agentDir: string) => {
        calls.push({ name: "settings", value: { cwd, agentDir } });
        return rawSettings;
      },
      createModelRuntime: async (agentDir: string) => {
        calls.push({ name: "models", value: agentDir });
        return modelRuntime;
      },
      resolveAutomaticModel: async () => undefined,
      resolveSkillPaths: (agent: AgentConfig, cwd: string, agentDir: string) => {
        calls.push({ name: "skills", value: { agent: agent.name, cwd, agentDir } });
        return ["/skills/research-project-workflow"];
      },
      createResourceLoader: (options: {
        appendSystemPromptOverride?: (base: string[]) => string[];
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
        session.thinkingLevel = options.thinkingLevel as InProcessAgentSession["thinkingLevel"];
        controls.prepareSession(session);
        const loader = options.resourceLoader as {
          options?: { appendSystemPromptOverride?: (base: string[]) => string[] };
        };
        session.baseSystemPrompt = loader.options?.appendSystemPromptOverride?.([]) ?? [];
        const originalBind = session.bindExtensions.bind(session);
        session.bindExtensions = async (bindings) => {
          calls.push({ name: "bind-extensions", value: bindings });
          await originalBind(bindings);
        };
        calls.push({ name: "pi-session", value: session });
        return { session };
      },
    };
    return {
      deps,
      calls,
      createdOptions,
      extensionRuntimes,
      coordinators,
      supervisors,
      assistant,
      controls,
      rawSettings,
    };
  }

  it("constructs one managed root in ownership-safe order with the effective body in the base prompt", async () => {
    const harness = creatorHarness();
    const creator = createPiAgentSessionCreator(harness.deps as never);

    const managedRoot = await creator({ cwd: "/project", thinking: "high" });

    expect(managedRoot).toMatchObject({
      session: { sessionId: "session-1" },
      coordinator: harness.coordinators[0],
      supervisor: harness.supervisors[0],
      binding: expect.any(Object),
    });
    const loaderOptions = harness.calls.find(({ name }) => name === "loader")?.value as {
      appendSystemPromptOverride(base: string[]): string[];
      additionalSkillPaths: string[];
      extensionFactories: Array<{ name: string }>;
      settingsManager: unknown;
    };
    expect(loaderOptions).toMatchObject({
      cwd: "/project",
      agentDir: "/agent",
      noSkills: true,
      additionalSkillPaths: [],
    });
    expect(loaderOptions.appendSystemPromptOverride(["Pi base"])).toEqual([
      "Pi base",
      "Project Research Assistant body",
    ]);
    expect(loaderOptions.extensionFactories).toEqual([expect.objectContaining({ name: "research-assistant" })]);
    expect(harness.calls.find(({ name }) => name === "model-refresh")?.value).toEqual({ allowNetwork: false });
    expect(harness.calls.find(({ name }) => name === "skills")?.value).toEqual({
      agent: "research-assistant",
      cwd: "/project",
      agentDir: "/agent",
    });
    expect(harness.createdOptions[0]?.settingsManager).toBe(harness.rawSettings);
    expect(loaderOptions.settingsManager).toBe(harness.rawSettings);
    expect((harness.createdOptions[0]?.settingsManager as {
      getCompactionSettings(): { reserveTokens: number; keepRecentTokens: number };
    }).getCompactionSettings()).toMatchObject({
      reserveTokens: 38_400,
      keepRecentTokens: 20_000,
    });
    expect(harness.createdOptions[0]).toMatchObject({
      excludeTools: excludedLocalShellTools(process.platform),
    });
    expect(harness.createdOptions[0]).not.toHaveProperty("tools");
    const order = harness.calls.map(({ name }) => name);
    expect(order.indexOf("session-manager")).toBeLessThan(order.indexOf("coordinator"));
    expect(order.indexOf("coordinator")).toBeLessThan(order.indexOf("recovery"));
    expect(order.indexOf("recovery")).toBeLessThan(order.indexOf("supervisor"));
    expect(order.indexOf("supervisor")).toBeLessThan(order.indexOf("extensions"));
    expect(order.indexOf("extensions")).toBeLessThan(order.indexOf("pi-session"));
    expect(order.indexOf("pi-session")).toBeLessThan(order.indexOf("bind-live"));
    expect(order.indexOf("bind-live")).toBeLessThan(order.indexOf("attach"));
    expect(order.indexOf("attach")).toBeLessThan(order.indexOf("bind-extensions"));

    const live = harness.coordinators[0]!.live!;
    expect(live.model()).toBe("openai/gpt-test");
    expect(live.thinking()).toBe("high");
    const liveSession = managedRoot.session as FakeAgentSession;
    liveSession.model = { provider: "anthropic", id: "claude-live" } as InProcessAgentSession["model"];
    liveSession.thinkingLevel = "xhigh";
    expect(live.model()).toBe("anthropic/claude-live");
    expect(live.thinking()).toBe("xhigh");

    await managedRoot.session.sendCustomMessage(
      { customType: "easyresearch:agent_status", content: "done", display: false },
      { deliverAs: "steer", triggerTurn: true },
    );
    expect((managedRoot.session as FakeAgentSession).wakeSystemPrompts).toEqual([["Project Research Assistant body"]]);
  });

  it("uses batched Pi steering for the root runtime and restores it after reload", async () => {
    const harness = creatorHarness();
    harness.controls.prepareSession = (session) => {
      session.reload = async () => {
        session.agent.steeringMode = "one-at-a-time";
      };
    };
    const creator = createPiAgentSessionCreator(harness.deps as never);

    const managedRoot = await creator({ cwd: "/project" });
    const session = managedRoot.session as FakeAgentSession;
    const bindings = session.bindCalls[0] as {
      commandContextActions: { reload(): Promise<void> };
    };

    expect(session.agent.steeringMode).toBe("all");
    await bindings.commandContextActions.reload();
    expect(session.agent.steeringMode).toBe("all");
  });

  it("opens a persisted root with the current Agent thinking level", async () => {
    const harness = creatorHarness();
    const creator = createPiAgentSessionCreator(harness.deps as never);

    const result = await creator({ cwd: "/project", sessionPath: "/sessions/old.jsonl", thinking: "max" });

    expect(harness.createdOptions[0]).toMatchObject({
      sessionManager: { kind: "open", value: "/sessions/old.jsonl" },
      thinkingLevel: "high",
    });
    expect(result.binding).toBeDefined();
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

    expect(harness.calls.at(-1)?.name).toBe("recovery");
    expect(harness.calls.map(({ name }) => name)).not.toContain("supervisor");
    expect(harness.calls.map(({ name }) => name)).not.toContain("extensions");
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
    expect(first.compaction).not.toBe(second.compaction);
    expect(harness.extensionRuntimes).toEqual([
      {
        coordinator: first.coordinator,
        supervisor: first.supervisor,
        binding: first.binding,
        compaction: first.compaction,
      },
      {
        coordinator: second.coordinator,
        supervisor: second.supervisor,
        binding: second.binding,
        compaction: second.compaction,
      },
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

    const adapter = new PiSessionFactory(creator).create({ cwd: "/project" });
    const error = await adapter.start().then(
      () => undefined,
      (failure) => failure as AggregateError,
    );

    expect(error).toBeInstanceOf(AggregateError);
    expect(error?.errors).toEqual(failures);
    expect(order).toEqual(["binding", "supervisor", "session"]);
    expect(harness.supervisors[0]?.disposeCalls).toBe(1);
  });

  it("rejects generation zero before creating resources or a malformed AgentSession", async () => {
    const createResourceLoader = vi.fn(() => ({ reload: async () => {} }));
    const createAgentSession = vi.fn(async () => ({ session: bindableSession([]) }));
    const unavailable: LiveConfiguration = {
      ...liveConfiguration(),
      generation: 0,
      error: "safe configuration error",
      isCurrent: () => false,
      resolveAgents: async () => {
        throw new ConfigurationUnavailableError();
      },
    };
    const creator = createPiAgentSessionCreator({
      agentDir: "/agent",
      liveConfiguration: unavailable,
      ...runtimeOwnerDeps(),
      createExtensionFactories: () => [],
      createSessionManager: () => ({} as never),
      openSessionManager: () => ({} as never),
      createSettingsManager: () => fakeSettingsManager({}),
      createModelRuntime: async () => ({
        refresh: async () => {},
        getModel: () => undefined,
        getError: () => undefined,
      }),
      createResourceLoader,
      createAgentSession,
      resolveAutomaticModel: async () => undefined,
      resolveSkillPaths: () => [],
    });

    await expect(creator({ cwd: "/project" })).rejects.toThrow(/No valid configuration/i);
    expect(createResourceLoader).not.toHaveBeenCalled();
    expect(createAgentSession).not.toHaveBeenCalled();
  });

  it("disposes binding ownership when resource loading fails before session creation", async () => {
    const disposeRuntime = vi.fn();
    const createAgentSession = vi.fn(async () => ({ session: bindableSession([]) }));
    const creator = createPiAgentSessionCreator({
      agentDir: "/agent",
      liveConfiguration: liveConfiguration(),
      ...runtimeOwnerDeps(),
      createExtensionFactories: () => [],
      createSessionManager: () => ({} as never),
      openSessionManager: () => ({} as never),
      createSettingsManager: () => fakeSettingsManager({}),
      createModelRuntime: async () => ({
        refresh: async () => {},
        getModel: () => model,
        getError: () => undefined,
        dispose: disposeRuntime,
      }),
      createResourceLoader: () => ({
        reload: async () => {
          throw new Error("resource reload failed");
        },
      }),
      createAgentSession,
      resolveAutomaticModel: async () => undefined,
      resolveSkillPaths: () => [],
    });

    await expect(creator({ cwd: "/project" })).rejects.toThrow("resource reload failed");

    expect(disposeRuntime).toHaveBeenCalledTimes(1);
    expect(createAgentSession).not.toHaveBeenCalled();
  });

  it("disposes the Pi session even when binding cleanup also fails after attach rejection", async () => {
    let generation = 1;
    let currentAgent = researchAssistant({ systemPrompt: "v1" });
    const live: LiveConfiguration = {
      get generation() {
        return generation;
      },
      error: null,
      compactionPolicy: { triggerPercent: 70, globalEnabled: true, globalKeepRecentTokens: 20_000 },
      apiUsageSettings: { showApiUsageDetails: false },
      start: async () => {},
      synchronize: async () => {},
      notify: async () => {},
      isCurrent: (candidate) => candidate === generation,
      resolveAgents: async () => [currentAgent],
      subscribe: () => () => {
        throw new Error("unsubscribe failed");
      },
      close: async () => {},
    };
    const calls: Array<{ name: string; value?: unknown }> = [];
    const session = bindableSession(calls);
    session.bindExtensions = async () => {
      currentAgent = researchAssistant({ systemPrompt: "v2" });
      generation = 2;
    };
    session.reload = async () => {
      throw new Error("reload failed");
    };
    const creator = createPiAgentSessionCreator({
      agentDir: "/agent",
      liveConfiguration: live,
      ...runtimeOwnerDeps(),
      createExtensionFactories: () => [],
      createSessionManager: () => ({} as never),
      openSessionManager: () => ({} as never),
      createSettingsManager: () => fakeSettingsManager({}),
      createModelRuntime: async () => ({
        refresh: async () => {},
        getModel: () => model,
        getError: () => undefined,
      }),
      createResourceLoader: () => ({ reload: async () => {} }),
      createAgentSession: async () => ({ session }),
      resolveAutomaticModel: async () => undefined,
      resolveSkillPaths: () => [],
    });

    await expect(creator({ cwd: "/project" })).rejects.toThrow();

    expect(session.disposeCalls).toBe(1);
  });

  it("disposes a partially constructed creator session before its stable runtime binding", async () => {
    const order: string[] = [];
    const live: LiveConfiguration = {
      ...liveConfiguration(),
      subscribe: () => {
        throw new Error("attach failed");
      },
    };
    const session = bindableSession([]);
    session.dispose = () => {
      order.push("session");
    };
    const creator = createPiAgentSessionCreator({
      agentDir: "/agent",
      liveConfiguration: live,
      ...runtimeOwnerDeps(),
      createExtensionFactories: () => [],
      createSessionManager: () => ({} as never),
      openSessionManager: () => ({} as never),
      createSettingsManager: () => fakeSettingsManager({}),
      createModelRuntime: async () => ({
        refresh: async () => {},
        getModel: () => model,
        getError: () => undefined,
        dispose: () => {
          order.push("binding");
        },
      }),
      createResourceLoader: () => ({ reload: async () => {} }),
      createAgentSession: async () => ({ session }),
      resolveAutomaticModel: async () => undefined,
      resolveSkillPaths: () => [],
    });

    await expect(creator({ cwd: "/project" })).rejects.toThrow("attach failed");

    expect(order).toEqual(["session", "binding"]);
  });

  it("hands failed creator cleanup to the adapter for deterministic retry", async () => {
    let generation = 1;
    let currentAgent = researchAssistant({ systemPrompt: "v1" });
    let unsubscribeCalls = 0;
    const live: LiveConfiguration = {
      get generation() {
        return generation;
      },
      error: null,
      compactionPolicy: { triggerPercent: 70, globalEnabled: true, globalKeepRecentTokens: 20_000 },
      apiUsageSettings: { showApiUsageDetails: false },
      start: async () => {},
      synchronize: async () => {},
      notify: async () => {},
      isCurrent: (candidate) => candidate === generation,
      resolveAgents: async () => [currentAgent],
      subscribe: () => () => {
        unsubscribeCalls += 1;
        if (unsubscribeCalls === 1) throw new Error("unsubscribe failed");
      },
      close: async () => {},
    };
    const session = bindableSession([]);
    session.bindExtensions = async () => {
      currentAgent = researchAssistant({ systemPrompt: "v2" });
      generation = 2;
    };
    session.reload = async () => {
      throw new Error("reload failed");
    };
    session.dispose = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error("session disposal failed");
      })
      .mockImplementationOnce(() => {});
    const creator = createPiAgentSessionCreator({
      agentDir: "/agent",
      liveConfiguration: live,
      ...runtimeOwnerDeps(),
      createExtensionFactories: () => [],
      createSessionManager: () => ({} as never),
      openSessionManager: () => ({} as never),
      createSettingsManager: () => fakeSettingsManager({}),
      createModelRuntime: async () => ({
        refresh: async () => {},
        getModel: () => model,
        getError: () => undefined,
      }),
      createResourceLoader: () => ({ reload: async () => {} }),
      createAgentSession: async () => ({ session }),
      resolveAutomaticModel: async () => undefined,
      resolveSkillPaths: () => [],
    });
    const adapter = new PiSessionFactory(creator).create({ cwd: "/project" });

    await expect(adapter.start()).rejects.toThrow();
    expect(unsubscribeCalls).toBe(0);
    expect(session.dispose).toHaveBeenCalledTimes(1);

    await expect(adapter.stop()).rejects.toThrow("unsubscribe failed");

    expect(unsubscribeCalls).toBe(1);
    expect(session.dispose).toHaveBeenCalledTimes(2);

    await adapter.stop();

    expect(unsubscribeCalls).toBe(2);
    expect(session.dispose).toHaveBeenCalledTimes(2);
  });
});

describe("DirectSessionAdapter steer lifecycle (ADR-083)", () => {
  it("exposes pending steering messages from the Pi session", async () => {
    const session = new FakeAgentSession();
    session.steeringMessages = ["note one", "note two"];
    const factory = new PiSessionFactory(async () => created(session));
    const adapter = factory.create({ cwd: "/project" });
    await adapter.start();

    expect(adapter.getSteeringMessages()).toEqual(["note one", "note two"]);
  });

  it("keeps a user steer containing literal supervisor tag names visible", async () => {
    const literal = "Please preserve <agent_status>status</agent_status> and <agent_handoff>handoff</agent_handoff>.";
    const session = new FakeAgentSession();
    session.steeringMessages = [literal];
    const factory = new PiSessionFactory(async () => created(session));
    const adapter = factory.create({ cwd: "/project" });
    const events: unknown[] = [];
    adapter.onEvent((event) => events.push(event));
    await adapter.start();

    session.listeners.forEach((listener) => listener({
      type: "queue_update",
      steering: [literal],
      followUp: [],
    }));

    expect(adapter.getSteeringMessages()).toEqual([literal]);
    expect(events).toContainEqual({ type: "queue_update", steering: [literal], followUp: [] });
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
    const factory = new PiSessionFactory(async () => created(session));
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
    const factory = new PiSessionFactory(async () => created(session));
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
    const factory = new PiSessionFactory(async () => created(session));
    const adapter = factory.create({ cwd: "/project" });
    await adapter.start();

    await expect(adapter.prompt("hello")).rejects.toThrow("no model selected");
  });

  it("cancels undelivered steers when the run is aborted (ADR-083)", async () => {
    const session = new FakeAgentSession();
    session.steeringMessages = ["queued note"];
    const factory = new PiSessionFactory(async () => created(session));
    const adapter = factory.create({ cwd: "/project" });
    await adapter.start();

    await adapter.abort();

    expect(session.clearQueueCalls).toBe(1);
    expect(session.abortCalls).toBe(1);
    expect(adapter.getSteeringMessages()).toEqual([]);
  });

});
