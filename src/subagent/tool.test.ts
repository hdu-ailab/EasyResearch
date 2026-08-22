import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentSessionEvent, ExtensionContext, JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { AGENT_ALIAS_ENTRY, readAgentAliases } from "./agent-alias";
import type { AgentConfig } from "./agents";
import { type AgentCatalog, SubagentCoordinator, type CoordinatorSessionManager } from "./coordinator";
import { createSessionMaterializationBarrier } from "./materialization";
import type { StageLaunchHandle, StageLaunchOptions, StageRunResult } from "./stage-session";
import { SubagentSupervisor, type SupervisableAgentSession } from "./supervisor";
import { createSubagentTool, formatSubagentDescription } from "./tool";

vi.mock("../runtime/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

function deferred<T>() {
  let settled = false;
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    get settled() {
      return settled;
    },
    resolve(value: T | PromiseLike<T>) {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    },
    reject(reason?: unknown) {
      if (settled) return;
      settled = true;
      rejectPromise(reason);
    },
  };
}

function agent(name: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name,
    description: name,
    enabled: true,
    builtin: false,
    source: "bundled",
    filePath: `/agents/${name}.md`,
    systemPrompt: `${name} prompt`,
    tools: ["read"],
    effectiveTools: ["read"],
    skills: [],
    effectiveSkills: [],
    missingSkills: [],
    ...overrides,
  };
}

function assistant(text: string): Extract<AgentMessage, { role: "assistant" }> {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "openai",
    model: "test-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  };
}

function stageResult(options: StageLaunchOptions, overrides: Partial<StageRunResult> = {}): StageRunResult {
  return {
    agent: options.agent.name,
    agentSource: options.agent.source,
    task: options.task,
    exitCode: 0,
    messages: [assistant("status: complete") as Message],
    stderr: "",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 2, turns: 1 },
    stopReason: "stop",
    agentId: options.reservation.agentId,
    ...overrides,
  };
}

class MemorySessionManager implements CoordinatorSessionManager {
  readonly entries: unknown[] = [];
  private sequence = 0;
  getEntriesImpl?: () => void;

  constructor(
    private readonly id: string,
    private readonly path = `/sessions/${id}.jsonl`,
  ) {}

  getSessionId(): string {
    return this.id;
  }

  getSessionFile(): string {
    return this.path;
  }

  getEntries(): unknown[] {
    this.getEntriesImpl?.();
    return this.entries;
  }

  appendCustomEntry(customType: string, data?: unknown): string {
    const id = `entry-${this.sequence++}`;
    this.entries.push({ type: "custom", id, customType, data });
    return id;
  }
}

class FakeParentSession implements SupervisableAgentSession {
  readonly sessionFile: string;
  readonly persistedEntries: unknown[] = [];
  readonly sessionManager = { getEntries: () => this.persistedEntries };
  readonly listeners = new Set<(event: AgentSessionEvent) => void>();
  isStreaming = false;

  constructor(readonly sessionId: string) {
    this.sessionFile = `/sessions/${sessionId}.jsonl`;
  }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async sendCustomMessage(
    message: { customType: string; content: string; display: boolean; details?: unknown },
    _options: { deliverAs: "steer"; triggerTurn: boolean },
  ): Promise<void> {
    this.persistedEntries.push({
      type: "custom_message",
      customType: message.customType,
      content: message.content,
      display: message.display,
      details: message.details,
    });
    this.emit({ type: "message_end", message: { role: "custom", ...message, timestamp: 1 } } as AgentSessionEvent);
  }

  async abort(): Promise<void> {}

  dispose(): void {}

  acknowledgeLaunch(toolCallId: string): void {
    this.emit({ type: "tool_execution_end", toolCallId, toolName: "subagent", isError: false } as AgentSessionEvent);
  }

  private emit(event: AgentSessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

class FakeStage {
  readonly materialization = deferred<void>();
  readonly completion = deferred<StageRunResult>();
  readonly listeners = new Set<(event: JsonAgentSessionEvent) => void>();
  readonly handle: StageLaunchHandle;

  constructor(readonly options: StageLaunchOptions) {
    const childSessionId = options.reservation.childSessionId ?? `child-${options.reservation.agentId}`;
    const sessionPath = options.reservation.sessionPath ?? `/sessions/${childSessionId}.jsonl`;
    this.handle = {
      agentId: options.reservation.agentId,
      childSessionId,
      sessionPath,
      materialized: this.materialization.promise,
      completion: this.completion.promise,
      subscribe: (listener) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      },
      abort: async (reason) => {
        this.completion.resolve(stageResult(options, {
          exitCode: 1,
          stopReason: "aborted",
          wasAborted: true,
          errorMessage: reason ?? "aborted",
        }));
      },
      dispose: async () => {},
    };
  }
}

interface ToolHarnessOptions {
  names?: string[];
  availableNames?: string[];
  ownerSessionId?: string;
  cwd?: string;
}

function toolHarness(options: ToolHarnessOptions = {}) {
  const rootManager = new MemorySessionManager("root");
  const ownerManager = options.ownerSessionId && options.ownerSessionId !== "root"
    ? new MemorySessionManager(options.ownerSessionId)
    : rootManager;
  const coordinator = new SubagentCoordinator(rootManager);
  const parent = new FakeParentSession(ownerManager.getSessionId());
  const all = (options.names ?? ["search"]).map((name) => agent(name));
  const availableNames = new Set(options.availableNames ?? all.map(({ name }) => name));
  const catalog: AgentCatalog = {
    all,
    available: all.filter(({ name }) => availableNames.has(name)),
  };
  const live = new FakeLiveConfiguration([
    assistantWithPolicy([...availableNames], "openai/paper"),
    ...all,
  ]);
  const stages: FakeStage[] = [];
  const pendingMaterializations = new Set<string>();
  const pendingMaterializationErrors = new Map<string, Error>();
  const setupFailures: Error[] = [];
  let materializeEveryStage = false;
  const supervisor = new SubagentSupervisor({
    coordinator,
    launchStage: async (launchOptions) => {
      const setupFailure = setupFailures.shift();
      if (setupFailure) throw setupFailure;
      const stage = new FakeStage(launchOptions);
      stages.push(stage);
      const agentId = launchOptions.reservation.agentId;
      const materializationError = pendingMaterializationErrors.get(agentId);
      if (materializationError) {
        pendingMaterializationErrors.delete(agentId);
        stage.materialization.reject(materializationError);
      } else if (materializeEveryStage || pendingMaterializations.delete(agentId)) {
        stage.materialization.resolve(undefined);
      }
      return stage.handle;
    },
  });
  supervisor.attach(parent);
  const tool = createSubagentTool({
    coordinator,
    supervisor,
    liveConfiguration: live,
    callerAgent: "research-assistant",
  });
  const cwd = options.cwd ?? "/exact/project";
  const context = {
    cwd,
    model: { provider: "stage-provider", id: "stage-model" },
    thinkingLevel: "minimal",
    sessionManager: ownerManager,
  } as unknown as ExtensionContext;

  return {
    tool,
    catalog,
    live,
    coordinator,
    supervisor,
    rootManager,
    ownerManager,
    parent,
    stages,
    context,
    materialize(agentId: string) {
      const stage = stages.find((candidate) => candidate.options.reservation.agentId === agentId);
      if (stage) stage.materialization.resolve(undefined);
      else pendingMaterializations.add(agentId);
    },
    materializeAll() {
      materializeEveryStage = true;
      for (const stage of stages) stage.materialization.resolve(undefined);
    },
    rejectMaterialization(agentId: string, error: Error) {
      const stage = stages.find((candidate) => candidate.options.reservation.agentId === agentId);
      if (stage) stage.materialization.reject(error);
      else pendingMaterializationErrors.set(agentId, error);
    },
    failNextSetup(error: Error) {
      setupFailures.push(error);
    },
  };
}

class FakeLiveConfiguration {
  generation = 1;
  authoritative = true;
  onResolve: (() => void) | undefined;
  onCurrentCheck: (() => void) | undefined;
  private agents: AgentConfig[];

  constructor(agents: AgentConfig[]) {
    this.agents = agents;
  }

  async synchronize(): Promise<void> {}

  isCurrent(generation: number): boolean {
    const current = this.authoritative && generation === this.generation;
    this.onCurrentCheck?.();
    return current;
  }

  async resolveAgents(): Promise<AgentConfig[]> {
    const resolved = this.agents.map((entry) => ({
      ...entry,
      tools: entry.tools ? [...entry.tools] : undefined,
      effectiveTools: [...entry.effectiveTools],
      subagents: entry.subagents ? [...entry.subagents] : entry.subagents,
      skills: entry.skills ? [...entry.skills] : undefined,
      effectiveSkills: [...entry.effectiveSkills],
      missingSkills: [...entry.missingSkills],
    }));
    this.onResolve?.();
    return resolved;
  }

  publish(agents: AgentConfig[]): void {
    this.agents = agents;
    this.generation += 1;
  }

  subscribe(): () => void {
    return () => {};
  }
}

function assistantWithPolicy(subagents: string[] | undefined, model = "openai/paper"): AgentConfig {
  return agent("research-assistant", { model, subagents });
}

describe("createSubagentTool asynchronous launch contract", () => {
  it("returns only the exact Working acknowledgement after materialization", async () => {
    const harness = toolHarness();
    const onUpdate = vi.fn();

    const resultPromise = harness.tool.execute(
      "t0",
      { agent: "search", task: "collect" },
      undefined,
      onUpdate,
      harness.context,
    );
    harness.materialize("search_0");
    const result = await resultPromise;

    expect(result).toEqual({
      content: [{ type: "text", text: "search_0 is working." }],
      details: {
        mode: "single",
        background: true,
        job: {
          launchId: expect.any(String),
          ownerSessionId: "root",
          toolCallId: "t0",
          agent: "search",
          agentId: "search_0",
          childSessionId: "child-search_0",
          status: "working",
        },
      },
    });
    const job = (result.details as { job: Record<string, unknown> }).job;
    expect(Object.hasOwn(job, "sessionPath")).toBe(false);
    expect(JSON.stringify(job)).not.toContain("sessionPath");
    expect(JSON.stringify(result)).not.toContain("/sessions/");
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("allows two same-role calls to overlap", async () => {
    const harness = toolHarness();
    const first = harness.tool.execute("t0", { agent: "search", task: "a" }, undefined, undefined, harness.context);
    const second = harness.tool.execute("t1", { agent: "search", task: "b" }, undefined, undefined, harness.context);
    harness.materializeAll();

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { content: [{ text: "search_0 is working." }] },
      { content: [{ text: "search_1 is working." }] },
    ]);
    expect(harness.stages).toHaveLength(2);
  });

  it("does not impose an application concurrency cap", async () => {
    const harness = toolHarness();
    const calls = Array.from({ length: 12 }, (_, index) =>
      harness.tool.execute(`t${index}`, { agent: "search", task: `task ${index}` }, undefined, undefined, harness.context));
    harness.materializeAll();

    const results = await Promise.all(calls);
    expect(results.map((result) => (result.content[0] as { text: string }).text)).toEqual(
      Array.from({ length: 12 }, (_, index) => `search_${index} is working.`),
    );
    expect(harness.stages).toHaveLength(12);
  });

  it("exposes only required agent and task parameters in parallel mode", () => {
    const harness = toolHarness();
    const schema = harness.tool.parameters as unknown as {
      properties: Record<string, unknown>;
      required?: string[];
    };

    expect(harness.tool.executionMode).toBe("parallel");
    expect(Object.keys(schema.properties)).toEqual(["agent", "task"]);
    expect(schema.required).toEqual(["agent", "task"]);
  });

  it("passes the caller's exact cwd through to the supervised stage", async () => {
    const harness = toolHarness({ cwd: "/projects/paper with spaces" });
    const result = harness.tool.execute("t0", { agent: "search", task: "collect" }, undefined, undefined, harness.context);
    harness.materializeAll();
    await result;

    expect(harness.stages[0]?.options.cwd).toBe("/projects/paper with spaces");
  });

  it("rejects a running exact alias without starting another child", async () => {
    const harness = toolHarness();
    const first = harness.tool.execute("t0", { agent: "search", task: "collect" }, undefined, undefined, harness.context);
    harness.materializeAll();
    await first;

    await expect(harness.tool.execute(
      "t1",
      { agent: "search_0", task: "continue" },
      undefined,
      undefined,
      harness.context,
    )).rejects.toThrow(/still running/i);
    expect(harness.stages).toHaveLength(1);
  });

  it("continues a completed exact alias on its mapped child", async () => {
    const harness = toolHarness();
    const first = harness.tool.execute("t0", { agent: "search", task: "collect" }, undefined, undefined, harness.context);
    harness.materializeAll();
    await first;
    harness.parent.acknowledgeLaunch("t0");
    harness.stages[0]!.completion.resolve(stageResult(harness.stages[0]!.options));
    await vi.waitFor(() => expect(harness.coordinator.summaries()[0]?.status).toBe("complete"));

    const continued = harness.tool.execute(
      "t1",
      { agent: "search_0", task: "continue" },
      undefined,
      undefined,
      harness.context,
    );
    harness.materializeAll();

    await expect(continued).resolves.toMatchObject({ content: [{ text: "search_0 is working." }] });
    expect(harness.stages[1]?.options.reservation).toMatchObject({
      continuation: true,
      childSessionId: "child-search_0",
      sessionPath: "/sessions/child-search_0.jsonl",
    });
  });

  it("rejects an exact alias/name ambiguity", async () => {
    const harness = toolHarness();
    const first = harness.tool.execute("t0", { agent: "search", task: "collect" }, undefined, undefined, harness.context);
    harness.materializeAll();
    await first;
    harness.parent.acknowledgeLaunch("t0");
    harness.stages[0]!.completion.resolve(stageResult(harness.stages[0]!.options));
    await vi.waitFor(() => expect(harness.coordinator.summaries()[0]?.status).toBe("complete"));
    const collidingAgent = agent("search_0");
    (harness.catalog.all as AgentConfig[]).push(collidingAgent);
    (harness.catalog.available as AgentConfig[]).push(collidingAgent);
    harness.live.publish([
      assistantWithPolicy(["search", "search_0"]),
      ...(harness.catalog.all as AgentConfig[]),
    ]);

    await expect(harness.tool.execute(
      "t1",
      { agent: "search_0", task: "ambiguous" },
      undefined,
      undefined,
      harness.context,
    )).rejects.toThrow(/ambiguous/i);
  });

  it.each(["审稿人", "review.agent", "review agent", "review-agent", "review_0", "review2"])(
    "keeps the exact Agent name %s opaque",
    async (name) => {
      const harness = toolHarness({ names: [name] });
      const result = harness.tool.execute("t0", { agent: name, task: "review" }, undefined, undefined, harness.context);
      harness.materializeAll();
      await expect(result).resolves.toMatchObject({ content: [{ text: `${name}_0 is working.` }] });
      expect(harness.stages[0]?.options.reservation).toMatchObject({ agent: name, continuation: false });
    },
  );

  it("throws before acknowledgement when materialization fails", async () => {
    const harness = toolHarness();
    const result = harness.tool.execute("t0", { agent: "search", task: "collect" }, undefined, undefined, harness.context);
    harness.rejectMaterialization("search_0", new Error("provider failed before first output"));

    await expect(result).rejects.toThrow("provider failed before first output");
    expect(readAgentAliases(harness.rootManager.entries)).toEqual([]);
    expect(harness.coordinator.journal().jobs.values().next().value?.status).toBe("pre_materialization_failed");
  });

  it("keeps an exact-path materialization failure private at the public tool boundary", async () => {
    const directory = mkdtempSync(join(tmpdir(), "easyresearch-private-materialization-"));
    const sessionPath = join(directory, "missing-child.jsonl");
    try {
      const barrier = createSessionMaterializationBarrier({ sessionPath, continuation: true });
      const internalFailure = await barrier.materialized.then(
        () => new Error("expected materialization to fail"),
        (error) => error as Error,
      );
      expect(internalFailure.message).toContain(sessionPath);

      const harness = toolHarness();
      const result = harness.tool.execute(
        "t0",
        { agent: "search", task: "collect" },
        undefined,
        undefined,
        harness.context,
      );
      harness.rejectMaterialization("search_0", internalFailure);
      const publicFailure = await result.then(
        () => undefined,
        (error) => error as Error & { details?: unknown },
      );

      expect(publicFailure).toBeInstanceOf(Error);
      expect(publicFailure?.name).toBe("SubagentLaunchError");
      expect(publicFailure?.message).toMatch(/ENOENT.*stat/i);
      expect(publicFailure?.message).not.toContain(sessionPath);
      expect(publicFailure?.details).toMatchObject({
        phase: "pre-materialization",
        code: "ENOENT",
        syscall: expect.stringMatching(/^stat/),
      });
      expect(JSON.stringify(publicFailure)).not.toContain(sessionPath);
      expect(JSON.stringify({
        message: publicFailure?.message,
        details: publicFailure?.details,
        error: publicFailure,
      })).not.toContain(sessionPath);

      const internalJob = [...harness.coordinator.journal().jobs.values()][0];
      expect(internalJob?.errorMessage).toContain(sessionPath);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("redacts nested session paths when reservation fails before a journal entry exists", async () => {
    const harness = toolHarness();
    const sessionPath = "/sessions/private reservation child.jsonl";
    const pathFailure = Object.assign(new Error(`stat '${sessionPath}' failed`), {
      code: "ENOENT",
      syscall: "stat",
    });
    const wrapper = new Error("reservation lookup failed", { cause: pathFailure });
    const internalFailure = new AggregateError(
      [wrapper, { operation: "read alias", cause: pathFailure }],
      `reservation failed for ${sessionPath}`,
    );
    harness.rootManager.getEntriesImpl = () => { throw internalFailure; };

    const publicFailure = await harness.tool.execute(
      "t0",
      { agent: "search", task: "collect" },
      undefined,
      undefined,
      harness.context,
    ).then(
      () => undefined,
      (error) => error as Error & { details?: unknown; cause?: unknown; errors?: unknown },
    );
    harness.rootManager.getEntriesImpl = undefined;

    expect(publicFailure).toBeInstanceOf(Error);
    expect(publicFailure?.message).toContain("reservation failed");
    expect(publicFailure?.details).toMatchObject({
      phase: "pre-materialization",
      code: "ENOENT",
      syscall: "stat",
    });
    expect(publicFailure?.cause).toBeUndefined();
    expect(publicFailure?.errors).toBeUndefined();
    expect(JSON.stringify({
      message: publicFailure?.message,
      details: publicFailure?.details,
      cause: publicFailure?.cause,
      errors: publicFailure?.errors,
      text: String(publicFailure),
    })).not.toContain(sessionPath);
    expect(harness.rootManager.entries).toEqual([]);
  });

  it("bounds generation churn before reservation and remains usable afterward", async () => {
    const harness = toolHarness();
    const rows = [assistantWithPolicy(["search"]), agent("search")];
    let resolutions = 0;
    harness.live.onResolve = () => {
      resolutions += 1;
      harness.live.publish(rows);
    };

    await expect(harness.tool.execute(
      "t0",
      { agent: "search", task: "churn" },
      undefined,
      undefined,
      harness.context,
    )).rejects.toThrow(/configuration changed/i);
    expect(resolutions).toBe(2);
    expect(harness.stages).toEqual([]);
    expect(harness.rootManager.entries).toEqual([]);

    harness.live.onResolve = undefined;
    const second = harness.tool.execute("t1", { agent: "search", task: "retry" }, undefined, undefined, harness.context);
    harness.materializeAll();
    await expect(second).resolves.toMatchObject({ content: [{ text: "search_0 is working." }] });
  });

  it("observes cancellation between bounded generation retries before reservation", async () => {
    const harness = toolHarness();
    const rows = [assistantWithPolicy(["search"]), agent("search")];
    const controller = new AbortController();
    harness.live.onResolve = () => {
      harness.live.onResolve = undefined;
      harness.live.publish(rows);
      controller.abort();
    };

    await expect(harness.tool.execute(
      "t0",
      { agent: "search", task: "cancel" },
      controller.signal,
      undefined,
      harness.context,
    )).rejects.toThrow("Agent authorization was cancelled.");
    expect(harness.stages).toEqual([]);
    expect(harness.rootManager.entries).toEqual([]);
  });

  it("resolves a newly allowed custom target and global model policy at execution", async () => {
    const harness = toolHarness({ names: ["search", "reviewer"], availableNames: ["search"] });
    const search = agent("search");
    const reviewer = agent("reviewer", { source: "global", thinking: "high" });
    harness.live.publish([
      assistantWithPolicy(["reviewer"], "openai/paper-v2"),
      search,
      reviewer,
    ]);

    const dispatched = harness.tool.execute(
      "t0", { agent: "reviewer", task: "review" }, undefined, undefined, harness.context,
    );
    harness.materializeAll();
    await expect(dispatched).resolves.toMatchObject({ content: [{ text: "reviewer_0 is working." }] });
    expect(harness.stages[0]?.options).toMatchObject({
      agent: { name: "reviewer", source: "global" },
      callerAgent: "research-assistant",
      model: "openai/paper-v2",
      thinking: "high",
      liveConfiguration: harness.live,
    });
    await expect(harness.tool.execute(
      "t1", { agent: "search", task: "no longer allowed" }, undefined, undefined, harness.context,
    )).rejects.toThrow(/disabled|unavailable/i);
  });

  it("rejects a continued child removed from the latest policy", async () => {
    const harness = toolHarness();
    const first = harness.tool.execute("t0", { agent: "search", task: "collect" }, undefined, undefined, harness.context);
    harness.materializeAll();
    await first;
    harness.parent.acknowledgeLaunch("t0");
    harness.stages[0]!.completion.resolve(stageResult(harness.stages[0]!.options));
    await vi.waitFor(() => expect(harness.coordinator.summaries()[0]?.status).toBe("complete"));
    harness.live.publish([assistantWithPolicy([]), agent("search")]);

    await expect(harness.tool.execute(
      "t1", { agent: "search_0", task: "continue" }, undefined, undefined, harness.context,
    )).rejects.toThrow(/disabled|available/i);
    expect(harness.stages).toHaveLength(1);
  });

  it("consumes a reservation when stage setup fails", async () => {
    const harness = toolHarness();
    harness.failNextSetup(new Error("stage setup failed"));

    await expect(harness.tool.execute(
      "t0",
      { agent: "search", task: "first" },
      undefined,
      undefined,
      harness.context,
    )).rejects.toThrow("stage setup failed");
    expect(readAgentAliases(harness.rootManager.entries)).toEqual([]);

    const second = harness.tool.execute("t1", { agent: "search", task: "second" }, undefined, undefined, harness.context);
    harness.materializeAll();
    await expect(second).resolves.toMatchObject({ content: [{ text: "search_1 is working." }] });
    expect(readAgentAliases(harness.rootManager.entries).map(({ id }) => id)).toEqual(["search_1"]);
  });

  it("finalizes a reservation when the supervisor rejects before owning startup", async () => {
    const harness = toolHarness();
    await harness.supervisor.dispose();

    await expect(harness.tool.execute(
      "t0",
      { agent: "search", task: "first" },
      undefined,
      undefined,
      harness.context,
    )).rejects.toThrow(/attached|disposed|closing/i);

    const failed = [...harness.coordinator.journal().jobs.values()][0];
    expect(failed).toMatchObject({ agentId: "search_0", status: "pre_materialization_failed" });
    expect(readAgentAliases(harness.rootManager.entries)).toEqual([]);
    const next = harness.coordinator.reserveDispatch({
      ownerSessionId: "root",
      toolCallId: "t1",
      requested: "search",
      catalog: harness.catalog,
    });
    expect(next.agentId).toBe("search_1");
  });

  it("uses each accepted generation's Agent model and thinking without session overrides", async () => {
    const harness = toolHarness({ ownerSessionId: "nested-stage" });
    harness.live.publish([
      assistantWithPolicy(["search"], "paper/model-a"),
      agent("search", { thinking: "high" }),
    ]);

    const first = harness.tool.execute("t0", { agent: "search", task: "one" }, undefined, undefined, harness.context);
    harness.materializeAll();
    await first;
    harness.live.publish([
      assistantWithPolicy(["search"], "paper/model-b"),
      agent("search", { thinking: "xhigh" }),
    ]);
    const second = harness.tool.execute("t1", { agent: "search", task: "two" }, undefined, undefined, harness.context);
    await second;

    expect(harness.stages.map(({ options }) => ({ model: options.model, thinking: options.thinking }))).toEqual([
      { model: "paper/model-a", thinking: "high" },
      { model: "paper/model-b", thinking: "xhigh" },
    ]);
  });
});

describe("formatSubagentDescription", () => {
  it("keeps the exact three-line caller catalog", () => {
    expect(formatSubagentDescription(["search", "experiment"])).toBe([
      "Delegate tasks to specialized subagents with isolated context.",
      "Sub agents run in the exact project directory.",
      "Available subagents: search, experiment.",
    ].join("\n"));
    expect(formatSubagentDescription([])).toBe([
      "Delegate tasks to specialized subagents with isolated context.",
      "Sub agents run in the exact project directory.",
      "Available subagents: none.",
    ].join("\n"));
  });
});
