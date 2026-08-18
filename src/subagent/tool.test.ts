import { writeFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "./agents";
import type { StageRunOptions, StageRunResult, StageSessionRunner } from "./stage-session";
import {
  createSubagentTool,
  describeModel,
  describeThinking,
  filterAgentsByAllowlist,
  progressFromMessage,
  resolveSessionArg,
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

  it("runs chains sequentially and substitutes the previous output", async () => {
    const calls: StageRunOptions[] = [];
    const runner: StageSessionRunner = async (options) => {
      calls.push(options);
      return result(options, options.step === 1 ? "papers found" : "draft complete");
    };
    const tool = createSubagentTool({
      agentProvider: async () => [agent("search"), agent("writing")],
      stageSessionRunner: runner,
    });

    const output = await tool.execute(
      "chain-1",
      { chain: [
        { agent: "search", task: "find" },
        { agent: "writing", task: "use {previous}" },
      ] },
      undefined,
      undefined,
      context(),
    );

    expect(calls.map((call) => call.task)).toEqual(["find", "use papers found"]);
    expect(calls.map((call) => call.step)).toEqual([1, 2]);
    expect(output.content[0]).toMatchObject({ text: expect.stringContaining("draft complete") });
    expect(output.content[0]).toMatchObject({ text: expect.stringContaining("/sessions/child-1.jsonl") });
    expect(output.content[0]).toMatchObject({ text: expect.stringContaining("/sessions/child-2.jsonl") });
  });

  it("resumes the child whose transcript path is passed in session", async () => {
    const suppliedPath = "/tmp/supplied-child.jsonl";
    writeFileSync(suppliedPath, "header\n");
    const calls: StageRunOptions[] = [];
    const tool = createSubagentTool({
      agentProvider: async () => [agent("search")],
      stageSessionRunner: async (options) => {
        calls.push(options);
        return { ...result(options), sessionPath: suppliedPath };
      },
    });

    const output = await tool.execute(
      "call-3",
      { agent: "search", task: "continue", session: suppliedPath },
      undefined,
      undefined,
      context(),
    );

    expect(calls[0]?.sessionPath).toBe(suppliedPath);
    expect(output.content[0]).toMatchObject({ text: expect.stringContaining(suppliedPath) });
    expect(output.details).toMatchObject({ results: [{ sessionPath: suppliedPath }] });
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

  it("retains every authoritative path when a later chain step fails", async () => {
    const tool = createSubagentTool({
      agentProvider: async () => [agent("search"), agent("writing")],
      stageSessionRunner: async (options) => {
        if (options.step === 1) {
          return {
            ...result(options, "papers found"),
            sessionPath: "/sessions/first-authoritative.jsonl",
          };
        }
        return {
          ...result(options),
          exitCode: 1,
          stopReason: "error",
          errorMessage: "later provider failed",
          sessionPath: "/sessions/later-authoritative.jsonl",
        };
      },
    });

    const thrown = await tool.execute(
      "chain-failed",
      { chain: [
        { agent: "search", task: "find" },
        { agent: "writing", task: "draft from {previous}" },
      ] },
      undefined,
      undefined,
      context(),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(SubagentExecutionError);
    const failure = thrown as SubagentExecutionError;
    expect(failure.details.results).toMatchObject([
      { step: 1, exitCode: 0, sessionPath: "/sessions/first-authoritative.jsonl" },
      {
        step: 2,
        exitCode: 1,
        errorMessage: "later provider failed",
        sessionPath: "/sessions/later-authoritative.jsonl",
      },
    ]);
    expect(failure.message).toContain("later provider failed");
    const firstPathIndex = failure.message.indexOf("/sessions/first-authoritative.jsonl");
    const laterPathIndex = failure.message.indexOf("/sessions/later-authoritative.jsonl");
    expect(firstPathIndex).toBeGreaterThanOrEqual(0);
    expect(laterPathIndex).toBeGreaterThan(firstPathIndex);
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
  it("filters disabled, Paper Assistant, caller, and non-allowlisted agents", () => {
    expect(filterAgentsByAllowlist([
      agent("paper-assistant"),
      agent("search"),
      agent("writing"),
      agent("disabled", { enabled: false }),
    ], "search,disabled", "writing").map(({ name }) => name)).toEqual(["search"]);
  });

  it("resolves a session path against the exact cwd", () => {
    expect(resolveSessionArg("/paper", "sessions/mine.jsonl", undefined, (p) => p.endsWith("mine.jsonl")))
      .toEqual({ ok: true, path: "/paper/sessions/mine.jsonl" });
    expect(resolveSessionArg("/paper", "/abs/path.jsonl", undefined, (p) => p === "/abs/path.jsonl"))
      .toEqual({ ok: true, path: "/abs/path.jsonl" });
  });

  it("returns ok for empty/whitespace session (fresh child)", () => {
    expect(resolveSessionArg("/paper", "", "/sessions/parent.jsonl")).toEqual({ ok: true });
    expect(resolveSessionArg("/paper", "   ")).toEqual({ ok: true });
  });

  it("refuses missing files and the coordinator's own session file", () => {
    const exists = (p: string) => p === "/paper/real.jsonl" || p === "/sessions/parent.jsonl";
    expect(resolveSessionArg("/paper", "real.jsonl", "/sessions/parent.jsonl", exists))
      .toEqual({ ok: true, path: "/paper/real.jsonl" });
    expect(resolveSessionArg("/paper", "nope.jsonl", "/sessions/parent.jsonl", exists)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Session file does not exist"),
    });
    expect(resolveSessionArg("/paper", "/sessions/parent.jsonl", "/sessions/parent.jsonl", exists)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("coordinator's own session file"),
    });
  });

  it("rejects a missing session path through the subagent tool", async () => {
    const tool = createSubagentTool({
      agentProvider: async () => [agent("search")],
      stageSessionRunner: async (options) => result(options),
    });
    await expect(
      tool.execute("call-4", { agent: "search", task: "x", session: "/missing.jsonl" }, undefined, undefined, context()),
    ).rejects.toMatchObject({ message: expect.stringContaining("Session file does not exist") });
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
