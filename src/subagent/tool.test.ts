import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "./agents";
import type { StageRunOptions, StageRunResult, StageSessionRunner } from "./stage-session";
import {
  createSubagentTool,
  describeModel,
  describeThinking,
  filterAgentsByAllowlist,
  progressFromMessage,
  resolveInheritedSession,
  SubagentExecutionError,
} from "./tool";
import { SUBAGENT_SESSION_LINK_ENTRY } from "./session-links";

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
    sessionManager: { getEntries: () => entries },
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

  it("opens only the current parent's mapped child for explicit inheritance", async () => {
    importPiMock.mockResolvedValue({
      SessionManager: { list: async () => [{ id: "owned-child", path: "/sessions/owned.jsonl" }] },
    });
    const calls: StageRunOptions[] = [];
    const tool = createSubagentTool({
      agentProvider: async () => [agent("search")],
      stageSessionRunner: async (options) => {
        calls.push(options);
        return result(options);
      },
    });

    await tool.execute(
      "call-2",
      { agent: "search", task: "continue", session: "inherit" },
      undefined,
      undefined,
      context([{
        type: "custom",
        customType: SUBAGENT_SESSION_LINK_ENTRY,
        data: { toolCallId: "prior", childSessionId: "owned-child", agent: "search" },
      }]),
    );

    expect(calls[0]?.sessionPath).toBe("/sessions/owned.jsonl");
  });

  it("exposes only a post-settlement confirmed path for a fresh child", async () => {
    importPiMock.mockResolvedValue({
      SessionManager: { list: async () => [{ id: "child-1", path: "/sessions/confirmed.jsonl" }] },
    });
    const tool = createSubagentTool({
      agentProvider: async () => [agent("search")],
      stageSessionRunner: async (options) => ({
        ...result(options),
        sessionPath: "/sessions/unconfirmed.jsonl",
      }),
    });

    const output = await tool.execute(
      "call-confirmed",
      { agent: "search", task: "find" },
      undefined,
      undefined,
      context(),
    );

    expect(output.content[0]).toMatchObject({ text: expect.stringContaining("/sessions/confirmed.jsonl") });
    expect(output.content[0]).toMatchObject({ text: expect.not.stringContaining("/sessions/unconfirmed.jsonl") });
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

  it("resolves inheritance only through the latest parent mapping", async () => {
    importPiMock.mockResolvedValue({
      SessionManager: { list: async () => [{ id: "latest", path: "/sessions/latest.jsonl" }] },
    });
    await expect(resolveInheritedSession("/paper", "search", undefined, [
      { type: "custom", customType: SUBAGENT_SESSION_LINK_ENTRY, data: { toolCallId: "old-call", childSessionId: "old", agent: "search" } },
      { type: "custom", customType: SUBAGENT_SESSION_LINK_ENTRY, data: { toolCallId: "new-call", childSessionId: "latest", agent: "search" } },
    ])).resolves.toBe("/sessions/latest.jsonl");
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
