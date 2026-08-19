import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentSessionEvent, ExtensionContext, JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_ALIAS_ENTRY, readAgentAliases } from "./agent-alias";
import type { AgentConfig } from "./agents";
import { type AgentCatalog, SubagentCoordinator, type CoordinatorSessionManager } from "./coordinator";
import { AGENT_MODEL_ENTRY } from "./model-resolution";
import { createSessionMaterializationBarrier } from "./materialization";
import type { StageLaunchHandle, StageLaunchOptions, StageRunResult } from "./stage-session";
import { SubagentSupervisor, type SupervisableAgentSession } from "./supervisor";
import { AGENT_THINKING_ENTRY } from "./thinking-resolution";
import { createSubagentTool, formatSubagentDescription } from "./tool";

const [resolveModelMock, resolveThinkingMock] = vi.hoisted(() => [vi.fn(), vi.fn()]);

vi.mock("./model-resolution", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./model-resolution")>()),
  resolveModelForSpawn: resolveModelMock,
}));
vi.mock("./thinking-resolution", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./thinking-resolution")>()),
  resolveThinkingForSpawn: resolveThinkingMock,
}));
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
    source: "project",
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
  const tool = createSubagentTool({ coordinator, supervisor, catalog });
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

function latestOverride(
  manager: { getEntries(): unknown[] },
  customType: string,
  field: "model" | "thinking",
  agentName: string,
): string | undefined {
  let result: string | undefined;
  for (const entry of manager.getEntries()) {
    if (!entry || typeof entry !== "object" || !("customType" in entry) || entry.customType !== customType) continue;
    const data = "data" in entry ? entry.data : undefined;
    if (!data || typeof data !== "object" || !("agent" in data) || data.agent !== agentName) continue;
    const record = data as Record<string, unknown>;
    const value = field in record ? record[field] : undefined;
    if (typeof value === "string") result = value;
  }
  return result;
}

beforeEach(() => {
  resolveModelMock.mockReset().mockImplementation(async (ctx, agentName, fallback) =>
    latestOverride(ctx.sessionManager, AGENT_MODEL_ENTRY, "model", agentName) ?? fallback);
  resolveThinkingMock.mockReset().mockImplementation(async (ctx, agentName, fallback) =>
    latestOverride(ctx.sessionManager, AGENT_THINKING_ENTRY, "thinking", agentName) ?? fallback ?? "off");
});

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

  it.each(["model", "thinking"] as const)(
    "redacts nested session paths from %s resolution while retaining the private journal reason",
    async (resolution) => {
      const harness = toolHarness();
      const sessionPath = `/sessions/private-${resolution}-child.jsonl`;
      const pathFailure = Object.assign(new Error(`open ${sessionPath} failed`), {
        path: sessionPath,
        code: "EACCES",
        syscall: "open",
      });
      const wrapper = new Error(`${resolution} provider lookup failed`, { cause: pathFailure });
      const internalFailure = new AggregateError(
        [wrapper, { errors: [pathFailure] }],
        `${resolution} resolution failed for ${sessionPath}`,
      );
      if (resolution === "model") resolveModelMock.mockRejectedValueOnce(internalFailure);
      else resolveThinkingMock.mockRejectedValueOnce(internalFailure);

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

      expect(publicFailure).toBeInstanceOf(Error);
      expect(publicFailure?.message).toContain(`${resolution} resolution failed`);
      expect(publicFailure?.details).toMatchObject({
        phase: "pre-materialization",
        code: "EACCES",
        syscall: "open",
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

      const internalJob = [...harness.coordinator.journal().jobs.values()][0];
      expect(internalJob).toMatchObject({ status: "pre_materialization_failed" });
      expect(internalJob?.errorMessage).toContain(sessionPath);
    },
  );

  it("consumes a reservation when root-scoped model resolution fails", async () => {
    const harness = toolHarness();
    resolveModelMock.mockRejectedValueOnce(new Error("model unavailable"));

    await expect(harness.tool.execute(
      "t0",
      { agent: "search", task: "first" },
      undefined,
      undefined,
      harness.context,
    )).rejects.toThrow("model unavailable");
    expect(readAgentAliases(harness.rootManager.entries)).toEqual([]);

    const second = harness.tool.execute("t1", { agent: "search", task: "second" }, undefined, undefined, harness.context);
    harness.materializeAll();
    await expect(second).resolves.toMatchObject({ content: [{ text: "search_1 is working." }] });
    expect(readAgentAliases(harness.rootManager.entries).map(({ id }) => id)).toEqual(["search_1"]);
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

  it("resolves nested overrides from the root coordinator session", async () => {
    const harness = toolHarness({ ownerSessionId: "nested-stage" });
    harness.rootManager.appendCustomEntry(AGENT_MODEL_ENTRY, { agent: "search", model: "root/model" });
    harness.rootManager.appendCustomEntry(AGENT_THINKING_ENTRY, { agent: "search", thinking: "high" });
    harness.ownerManager.appendCustomEntry(AGENT_MODEL_ENTRY, { agent: "search", model: "stage/model" });
    harness.ownerManager.appendCustomEntry(AGENT_THINKING_ENTRY, { agent: "search", thinking: "low" });

    const result = harness.tool.execute("t0", { agent: "search", task: "nested" }, undefined, undefined, harness.context);
    harness.materializeAll();
    await result;

    expect(harness.stages[0]?.options).toMatchObject({ model: "root/model", thinking: "high" });
  });

  it("inherits the live Paper Assistant model and thinking instead of immediate stage defaults", async () => {
    const harness = toolHarness({ ownerSessionId: "nested-stage" });
    let paperAssistantModel = "paper/model-a";
    let paperAssistantThinking = "high";
    harness.coordinator.bindPaperAssistantState({
      model: () => paperAssistantModel,
      thinking: () => paperAssistantThinking,
    });

    const first = harness.tool.execute("t0", { agent: "search", task: "one" }, undefined, undefined, harness.context);
    harness.materializeAll();
    await first;
    paperAssistantModel = "paper/model-b";
    paperAssistantThinking = "xhigh";
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
