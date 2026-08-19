import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "./agents";
import { AGENT_ALIAS_ENTRY } from "./agent-alias";
import type { StageRunOptions, StageRunResult, StageSessionRunner } from "./stage-session";
import {
  createSubagentTool,
  describeModel,
  describeThinking,
  filterAgentsByAllowlist,
  formatSubagentDescription,
  progressFromMessage,
  resolveAgentTarget,
  SubagentExecutionError,
} from "./tool";

const [resolveModelMock, resolveThinkingMock, importPiMock, getAgentDirMock] = vi.hoisted(() => [
  vi.fn(),
  vi.fn(),
  vi.fn(),
  vi.fn(() => "/agent"),
]);

vi.mock("./model-resolution", () => ({ resolveModelForSpawn: resolveModelMock }));
vi.mock("./thinking-resolution", () => ({ resolveThinkingForSpawn: resolveThinkingMock }));
vi.mock("../runtime/pi-import", () => ({ importPi: importPiMock, getAgentDir: getAgentDirMock }));
vi.mock("../runtime/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

function agent(name: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name,
    description: name,
    enabled: true,
    builtin: true,
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

function result(options: StageRunOptions, text = "status: complete"): StageRunResult {
  return {
    agent: options.agent.name,
    agentSource: options.agent.source,
    task: options.task,
    exitCode: 0,
    messages: [{
      role: "assistant",
      content: [{ type: "text", text }],
      api: "openai-completions",
      provider: "openai",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1,
    }],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
    model: options.model,
    step: options.step,
    sessionId: `child-${options.step ?? 1}`,
    sessionPath: `/sessions/child-${options.step ?? 1}.jsonl`,
    stopReason: "stop",
  };
}

function context(entries: unknown[] = []) {
  return {
    cwd: "/paper",
    model: { provider: "openai", id: "gpt-test" },
    thinkingLevel: "medium",
    sessionManager: {
      getEntries: () => entries,
      getSessionFile: () => "/sessions/parent.jsonl",
      appendCustomEntry: (type: string, data?: unknown) => {
        entries.push({ type: "custom", customType: type, data });
        return "entry-1";
      },
    },
  } as never;
}

beforeEach(() => {
  resolveModelMock.mockReset().mockResolvedValue("openai/gpt-stage");
  resolveThinkingMock.mockReset().mockResolvedValue("high");
  importPiMock.mockReset().mockResolvedValue({
    SessionManager: {
      list: async () => [
        { id: "child-1", path: "/sessions/child-1.jsonl" },
        { id: "child-2", path: "/sessions/child-2.jsonl" },
      ],
    },
  });
  getAgentDirMock.mockClear();
});

describe("createSubagentTool in-process dispatch", () => {
  it("passes resolved runtime options, streams events, and persists the child UUID", async () => {
    const calls: StageRunOptions[] = [];
    const links: unknown[] = [];
    const updates: unknown[] = [];
    const runner: StageSessionRunner = async (options) => {
      calls.push(options);
      options.onSessionHeader?.({ id: "child-1", cwd: options.cwd });
      options.onEvent?.({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "working" }] },
      });
      return result(options);
    };
    const tool = createSubagentTool({
      agentProvider: async () => [agent("search")],
      stageSessionRunner: runner,
      persistSessionLink: (link) => links.push(link),
    });

    const output = await tool.execute(
      "call-1",
      { agent: "search", task: "find papers" },
      undefined,
      (update) => updates.push(update),
      context(),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      agent: { name: "search" },
      task: "find papers",
      cwd: "/paper",
      model: "openai/gpt-stage",
      thinking: "high",
    });
    expect(links).toEqual([{ toolCallId: "call-1", childSessionId: "child-1", agent: "search" }]);
    expect(updates).toContainEqual(expect.objectContaining({
      details: expect.objectContaining({
        subagent: expect.objectContaining({ agent: "search", sessionId: "child-1", latestMessage: "working" }),
      }),
    }));
    expect(output.content[0]).toMatchObject({ text: expect.stringContaining("status: complete") });
    expect(output.content[0]).toMatchObject({ text: expect.stringContaining("/sessions/child-1.jsonl") });
  });

  it("discloses the authoritative in-process session file path for a fresh child", async () => {
    const list = vi.fn(async (_cwd: string, _sessionDir?: string) => [
      { id: "child-1", path: "/sessions/list-confirmed.jsonl" },
    ]);
    importPiMock.mockResolvedValue({
      SessionManager: { list },
    });
    const tool = createSubagentTool({
      agentProvider: async () => [agent("search")],
      stageSessionRunner: async (options) => ({
        ...result(options),
        sessionPath: "/sessions/authoritative.jsonl",
      }),
    });

    const output = await tool.execute(
      "call-fresh",
      { agent: "search", task: "find" },
      undefined,
      undefined,
      context(),
    );

    expect(output.content[0]).toMatchObject({ text: expect.stringContaining("/sessions/authoritative.jsonl") });
    expect(output.content[0]).toMatchObject({ text: expect.not.stringContaining("/sessions/list-confirmed.jsonl") });
    expect(list).not.toHaveBeenCalled();
  });

  it("falls back to the list-confirmed path when the stage result has no session file", async () => {
    const list = vi.fn(async (_cwd: string, _sessionDir?: string) => [
      { id: "unrelated", path: "/sessions/unrelated.jsonl" },
      { id: "child-1", path: "/sessions/list-confirmed.jsonl" },
    ]);
    importPiMock.mockResolvedValue({
      SessionManager: { list },
    });
    const tool = createSubagentTool({
      agentProvider: async () => [agent("search")],
      stageSessionRunner: async (options) => ({ ...result(options), sessionPath: undefined }),
    });

    const output = await tool.execute(
      "call-fallback",
      { agent: "search", task: "find" },
      undefined,
      undefined,
      context(),
    );

    expect(output.content[0]).toMatchObject({ text: expect.stringContaining("/sessions/list-confirmed.jsonl") });
    expect(output.content[0]).toMatchObject({ text: expect.not.stringContaining("/sessions/unrelated.jsonl") });
    expect(output.details).toMatchObject({
      results: [{ sessionPath: "/sessions/list-confirmed.jsonl" }],
    });
    expect(list).toHaveBeenCalledTimes(1);
    expect(list.mock.calls[0]?.[0]).toBe("/paper");
    expect(list.mock.calls[0]?.[1]).toBeUndefined();
  });

  it("turns a failed stage result into a Pi tool error", async () => {
    const tool = createSubagentTool({
      agentProvider: async () => [agent("search")],
      stageSessionRunner: async (options) => ({
        ...result(options),
        exitCode: 1,
        stopReason: "error",
        errorMessage: "provider failed",
      }),
    });

    await expect(tool.execute(
      "call-failed",
      { agent: "search", task: "find" },
      undefined,
      undefined,
      context(),
    )).rejects.toMatchObject({
      name: "SubagentExecutionError",
      message: expect.stringContaining("provider failed"),
    });
  });

  it("discloses the session file path in the failure error message", async () => {
    const tool = createSubagentTool({
      agentProvider: async () => [agent("search")],
      stageSessionRunner: async (options) => ({
        ...result(options),
        exitCode: 1,
        stopReason: "error",
        errorMessage: "provider failed",
        sessionPath: "/sessions/failed-run.jsonl",
      }),
    });

    await expect(tool.execute(
      "call-failed-with-path",
      { agent: "search", task: "find" },
      undefined,
      undefined,
      context(),
    )).rejects.toMatchObject({
      name: "SubagentExecutionError",
      message: expect.stringContaining("/sessions/failed-run.jsonl"),
    });
  });

  it("serializes one runtime without blocking another runtime", async () => {
    let finishFirst: (() => void) | undefined;
    const firstDone = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const runner = vi.fn<StageSessionRunner>(async (options) => {
      await firstDone;
      return result(options);
    });
    const tool = createSubagentTool({
      agentProvider: async () => [agent("search")],
      stageSessionRunner: runner,
    });
    const otherRunner = vi.fn<StageSessionRunner>(async (options) => result(options));
    const otherTool = createSubagentTool({
      agentProvider: async () => [agent("search")],
      stageSessionRunner: otherRunner,
    });

    const first = tool.execute("call-running", { agent: "search", task: "find" }, undefined, undefined, context());
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));

    await expect(tool.execute(
      "call-locked",
      { agent: "search", task: "find" },
      undefined,
      undefined,
      context(),
    )).rejects.toBeInstanceOf(SubagentExecutionError);
    expect(runner).toHaveBeenCalledTimes(1);

    try {
      await expect(otherTool.execute(
        "call-independent",
        { agent: "search", task: "find" },
        undefined,
        undefined,
        context(),
      )).resolves.toBeDefined();
      expect(otherRunner).toHaveBeenCalledTimes(1);
    } finally {
      finishFirst?.();
      await first;
    }
  });

  it("rejects ambiguous parameters with available agents", async () => {
    const tool = createSubagentTool({
      agentProvider: async () => [agent("search")],
      stageSessionRunner: async (options) => result(options),
    });

    await expect(tool.execute("invalid", {}, undefined, undefined, context())).rejects.toMatchObject({
      message: expect.stringContaining("Available agents: search"),
    });
  });
});

describe("subagent helpers", () => {
  it("formats the three-line description with the caller's available subagents (ADR-084)", () => {
    expect(formatSubagentDescription(["search", "experiment"])).toBe(
      [
        "Delegate tasks to specialized subagents with isolated context.",
        "Sub agents run in the exact project directory.",
        "Available subagents: search, experiment.",
      ].join("\n"),
    );
    expect(formatSubagentDescription([])).toContain("Available subagents: none.");
  });

  it("filters disabled, Paper Assistant, caller, and non-allowlisted agents", () => {
    expect(filterAgentsByAllowlist([
      agent("paper-assistant"),
      agent("search"),
      agent("writing"),
      agent("disabled", { enabled: false }),
    ], "search,disabled", "writing").map(({ name }) => name)).toEqual(["search"]);
  });

  describe("subagent agent-id aliases (ADR-084/086)", () => {
    function aliasEntries(records: Array<{ id: string; agent: string; sessionId: string; sessionPath: string }>): unknown[] {
      return records.map((data) => ({ type: "custom", customType: AGENT_ALIAS_ENTRY, data }));
    }

    const sessionManager = (entries: unknown[] = []) =>
      (context(entries) as unknown as { sessionManager: never }).sessionManager;

    it("resolves an agent id to its mapped session path and agent", () => {
      const entries = aliasEntries([
        { id: "search_1", agent: "search", sessionId: "child-2", sessionPath: "/sessions/child-2.jsonl" },
      ]);
      const target = resolveAgentTarget("search_1", sessionManager(entries));
      expect(target).toEqual({
        ok: true,
        target: { name: "search", path: "/sessions/child-2.jsonl", activeId: "search_1" },
      });
    });

    it("treats a bare agent name as a fresh dispatch", () => {
      expect(resolveAgentTarget("search", sessionManager())).toEqual({ ok: true, target: { name: "search" } });
    });

    it("errors on an unknown agent id and lists the known ids", () => {
      const entries = aliasEntries([
        { id: "search_0", agent: "search", sessionId: "child-1", sessionPath: "/sessions/child-1.jsonl" },
      ]);
      const target = resolveAgentTarget("search_9", sessionManager(entries));
      expect(target).toMatchObject({
        ok: false,
        reason: expect.stringContaining('Unknown agent id "search_9"'),
      });
      expect(target.ok === false && target.reason).toContain("search_0");
    });

    it("allocates the next agent id for a fresh dispatch and binds the alias at session creation", async () => {
      const entries: unknown[] = [];
      const runner: StageSessionRunner = async (options) => {
        options.onSessionHeader?.({ id: "child-1", cwd: options.cwd, sessionPath: "/sessions/child-1.jsonl" });
        return result(options);
      };
      const tool = createSubagentTool({
        agentProvider: async () => [agent("search")],
        stageSessionRunner: runner,
      });

      const output = await tool.execute("call-1", { agent: "search", task: "find papers" }, undefined, undefined, context(entries));

      const text = (output.content as unknown as Array<{ text?: string }>)[0]?.text ?? "";
      expect(text).toContain("Agent id: search_0");
      expect(entries).toContainEqual({
        type: "custom",
        customType: AGENT_ALIAS_ENTRY,
        data: { id: "search_0", agent: "search", sessionId: "child-1", sessionPath: "/sessions/child-1.jsonl" },
      });
    });

    it("increments the id for a second dispatch of the same agent", async () => {
      const entries: unknown[] = [];
      const runner: StageSessionRunner = async (options) => {
        options.onSessionHeader?.({ id: `child-${entries.length + 1}`, cwd: options.cwd, sessionPath: `/sessions/child-${entries.length + 1}.jsonl` });
        return result(options);
      };
      const tool = createSubagentTool({
        agentProvider: async () => [agent("search")],
        stageSessionRunner: runner,
      });

      await tool.execute("call-1", { agent: "search", task: "one" }, undefined, undefined, context(entries));
      const second = await tool.execute("call-2", { agent: "search", task: "two" }, undefined, undefined, context(entries));

      const text = (second.content as unknown as Array<{ text?: string }>)[0]?.text ?? "";
      expect(text).toContain("Agent id: search_1");
    });

    it("resumes an id-referenced child by its mapped path and echoes the id", async () => {
      const entries = aliasEntries([
        { id: "search_0", agent: "search", sessionId: "child-1", sessionPath: "/sessions/child-1.jsonl" },
      ]);
      const seenPaths: Array<string | undefined> = [];
      const runner: StageSessionRunner = async (options) => {
        seenPaths.push(options.sessionPath);
        options.onSessionHeader?.({ id: "child-1", cwd: options.cwd, sessionPath: "/sessions/child-1.jsonl" });
        return result(options);
      };
      const tool = createSubagentTool({
        agentProvider: async () => [agent("search")],
        stageSessionRunner: runner,
      });

      const output = await tool.execute(
        "call-2",
        { agent: "search_0", task: "continue" },
        undefined,
        undefined,
        context(entries),
      );

      expect(seenPaths).toEqual(["/sessions/child-1.jsonl"]);
      const text = (output.content as unknown as Array<{ text?: string }>)[0]?.text ?? "";
      expect(text).toContain("Agent id: search_0");
    });

    it("rejects an unknown id through the tool", async () => {
      const tool = createSubagentTool({
        agentProvider: async () => [agent("search")],
        stageSessionRunner: async (options) => result(options),
      });
      await expect(
        tool.execute("call-3", { agent: "nope_5", task: "x" }, undefined, undefined, context()),
      ).rejects.toMatchObject({ message: expect.stringContaining("Unknown agent id") });
    });

    it("threads the coordinator session manager into nested runners (ADR-084)", async () => {
      const entries: unknown[] = [];
      const runners: Array<unknown> = [];
      const runner: StageSessionRunner = async (options) => {
        runners.push(options.ownerSessionManager);
        return result(options);
      };
      const ctx = context(entries);
      const tool = createSubagentTool({
        agentProvider: async () => [agent("search")],
        stageSessionRunner: runner,
      });

      await tool.execute("call-1", { agent: "search", task: "x" }, undefined, undefined, ctx);

      expect(runners[0]).toBe((ctx as unknown as { sessionManager: unknown }).sessionManager);
    });
  });

  it("extracts complete assistant progress text", () => {
    expect(progressFromMessage("search", 2, {
      role: "assistant",
      content: [{ type: "text", text: "one" }, { type: "text", text: "two" }],
    } as never)).toEqual({
      agent: "search",
      step: 2,
      status: "running",
      latestMessage: "one\n\ntwo",
    });
  });

  it("describes the live parent model and thinking level", () => {
    const ctx = {
      model: { provider: "openai", id: "gpt-test" },
      thinkingLevel: "high",
    } as never;
    expect(describeModel(ctx)).toBe("openai/gpt-test");
    expect(describeThinking(ctx)).toBe("high");
  });
});
