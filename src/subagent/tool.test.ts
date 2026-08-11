import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  buildPiArgs,
  describeModel,
  filterAgentsByAllowlist,
  handleChildLine,
  progressFromMessage,
  resolveInheritedSession,
  subagentTool,
} from "./tool";
import { sessionNameFor, SUBAGENT_SESSION_LINK_ENTRY, SUBAGENT_SESSION_PREFIX } from "./session-links";
import { releaseSubagentLock, tryAcquireSubagentLock } from "./serial";

const [loggerMock, createLoggerMock, spawnMock] = vi.hoisted(() => {
  const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return [mockLogger, vi.fn(() => mockLogger), vi.fn()] as const;
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

vi.mock("../runtime/logger", () => ({
  createLogger: createLoggerMock,
}));

vi.mock("./agents", () => ({
  discoverAgents: vi.fn(),
}));

vi.mock("./model-resolution", () => ({
  resolveModelForSpawn: vi.fn(),
}));

vi.mock("../runtime/pi-import", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime/pi-import")>();
  return {
    ...actual,
    importPi: vi.fn(actual.importPi),
    getAgentDir: vi.fn(actual.getAgentDir),
  };
});

describe("buildPiArgs", () => {
  it("uses json + prompt-only mode, mounts the subagent extension, names the session line, and never uses --no-session", () => {
    const agent = maker("search");
    const args = buildPiArgs(agent, undefined, "task");
    expect(args.slice(0, 3)).toEqual(["--mode", "json", "-p"]);
    expect(args).toContain("--extension");
    expect(args).toContain("--name");
    expect(args[args.indexOf("--name") + 1]).toBe(`${SUBAGENT_SESSION_PREFIX}search`);
    expect(args).not.toContain("--no-session");
  });

  it("adds --session when inheriting a session line (ADR-022)", () => {
    const agent = maker("search");
    const args = buildPiArgs(agent, undefined, "task", "/tmp/lazyresearch-search.jsonl");
    expect(args).toContain("--session");
    expect(args[args.indexOf("--session") + 1]).toBe("/tmp/lazyresearch-search.jsonl");
  });

  it("does not add --session for a fresh session (ADR-022)", () => {
    const agent = maker("search");
    const args = buildPiArgs(agent, undefined, "task");
    expect(args).not.toContain("--session");
  });

  it("adds --model with the resolved model", () => {
    const agent = maker("search");
    const args = buildPiArgs(agent, "oc/mimo-v2.5-free", "task");
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("oc/mimo-v2.5-free");
  });

  it("omits --model when no model is resolved", () => {
    const agent = maker("search");
    const args = buildPiArgs(agent, undefined, "task");
    expect(args).not.toContain("--model");
  });

  it("passes the agent tools as a comma list", () => {
    const agent = maker("search", "read, bash, arxiv");
    const args = buildPiArgs(agent, undefined, "task");
    expect(args).toContain("--tools");
    expect(args[args.indexOf("--tools") + 1]).toBe("read,bash,arxiv");
  });

  it("adds --no-skills and --skill for a non-empty whitelist", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "lr-args-"));
    const skillDir = join(agentDir, "skills", "paper-search");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# paper-search");
    const agent = { ...maker("search"), skills: ["paper-search"] };
    const args = buildPiArgs(agent, undefined, "task", undefined, {
      cwd: agentDir,
      agentDir,
    });
    expect(args).toContain("--no-skills");
    expect(args[args.indexOf("--skill") + 1]!.endsWith("paper-search")).toBe(true);
    expect(args[args.indexOf("--skill") + 1]!.startsWith("/")).toBe(true);
  });

  it("emits only --no-skills for an explicit empty whitelist", () => {
    const agent = { ...maker("search"), skills: [] };
    const args = buildPiArgs(agent, undefined, "task", undefined, { cwd: "/tmp", agentDir: "/tmp" });
    expect(args).toContain("--no-skills");
    expect(args).not.toContain("--skill");
  });

  it("omits skill flags when skills is undefined", () => {
    const args = buildPiArgs(maker("search"), undefined, "task");
    expect(args).not.toContain("--no-skills");
    expect(args).not.toContain("--skill");
  });
});

describe("sessionNameFor", () => {
  it("names session lines with the lazyresearch prefix (ADR-022)", () => {
    expect(sessionNameFor("search")).toBe(`${SUBAGENT_SESSION_PREFIX}search`);
  });
});

describe("filterAgentsByAllowlist (ADR-022)", () => {
  const agents = [maker("search"), maker("experiment"), maker("writing")];

  it("keeps all agents without an allowlist (orchestrator runtime)", () => {
    expect(filterAgentsByAllowlist(agents, undefined).map((a) => a.name)).toEqual(["search", "experiment", "writing"]);
  });

  it("filters to the declared allowlist", () => {
    expect(filterAgentsByAllowlist(agents, "search").map((a) => a.name)).toEqual(["search"]);
    expect(filterAgentsByAllowlist(agents, "search,figures").map((a) => a.name)).toEqual(["search"]);
  });

  it("allows no agents for an empty allowlist", () => {
    expect(filterAgentsByAllowlist(agents, "")).toEqual([]);
  });
});

describe("progressFromMessage (ADR-040)", () => {
  it("returns every non-empty assistant text block without truncation", () => {
    const complete = "x".repeat(500);
    expect(progressFromMessage("search", 2, {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "think" },
        { type: "text", text: "first section" },
        { type: "text", text: "   " },
        { type: "text", text: complete },
      ],
    } as never)).toEqual({
      agent: "search",
      step: 2,
      status: "running",
      latestMessage: `first section\n\n${complete}`,
    });
  });

  it("returns undefined when the message has no text", () => {
    expect(progressFromMessage("search", 1, { role: "assistant", content: [] } as never)).toBeUndefined();
  });

  it("returns undefined for non-assistant messages", () => {
    expect(progressFromMessage("search", 1, {
      role: "user",
      content: [{ type: "text", text: "not subagent progress" }],
    } as never)).toBeUndefined();
  });

  it("handles plain-string content", () => {
    const progress = progressFromMessage("search", undefined, {
      role: "assistant",
      content: "plain text",
    } as never);
    expect(progress).toMatchObject({ step: undefined, latestMessage: "plain text" });
  });

  it.each([
    ["null content", null],
    ["object content", { type: "text", text: "not an array" }],
    ["numeric content", 42],
    ["invalid array entries", [null, 42, {}, { type: "text" }, { type: "text", text: null }]],
  ])("returns undefined for malformed %s", (_name, content) => {
    expect(progressFromMessage("search", 1, {
      role: "assistant",
      content,
    } as never)).toBeUndefined();
  });

  it("ignores malformed array entries while preserving valid text", () => {
    expect(progressFromMessage("search", 1, {
      role: "assistant",
      content: [null, "first", { type: "text", text: 7 }, { type: "text", text: "second" }],
    } as never)).toMatchObject({ latestMessage: "first\n\nsecond" });
  });
});

describe("final subagent output (ADR-040)", () => {
  it("returns all text blocks from the latest assistant message", async () => {
    const { discoverAgents } = await import("./agents");
    const { resolveModelForSpawn } = await import("./model-resolution");
    const { getAgentDir } = await import("../runtime/pi-import");
    vi.mocked(discoverAgents).mockResolvedValue({ agents: [maker("search")] });
    vi.mocked(resolveModelForSpawn).mockResolvedValue(undefined);
    vi.mocked(getAgentDir).mockReturnValue("/tmp/lazyresearch-test-agent");
    spawnMock.mockImplementationOnce(() => {
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      const child = Object.assign(new EventEmitter(), {
        stdout,
        stderr,
        killed: false,
        kill: vi.fn(),
      });
      queueMicrotask(() => {
        stdout.emit("data", Buffer.from(`${JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "first section" },
              { type: "thinking", thinking: "internal" },
              { type: "text", text: "second section" },
            ],
          },
        })}\n`));
        child.emit("close", 0);
      });
      return child;
    });

    const result = await subagentTool.execute(
      "call-multi-block",
      { agent: "search", task: "find papers", session: "new" },
      undefined,
      undefined,
      { cwd: "/tmp/lazyresearch-test-project" } as never,
    );

    expect(result.content).toEqual([{ type: "text", text: "first section\n\nsecond section" }]);
  });
});

describe("subagent session link persistence", () => {
  it("starts a fresh child when session is omitted, even if a named child exists", async () => {
    const { discoverAgents } = await import("./agents");
    const { resolveModelForSpawn } = await import("./model-resolution");
    const { getAgentDir, importPi } = await import("../runtime/pi-import");
    vi.mocked(discoverAgents).mockResolvedValue({ agents: [maker("search")] });
    vi.mocked(resolveModelForSpawn).mockResolvedValue(undefined);
    vi.mocked(getAgentDir).mockReturnValue("/tmp/lazyresearch-test-agent");
    vi.mocked(importPi).mockResolvedValue({
      SessionManager: {
        list: vi.fn(async () => [{ name: sessionNameFor("search"), path: "/old-child.jsonl", modified: new Date() }]),
      },
    } as never);
    spawnMock.mockClear();
    spawnMock.mockImplementationOnce(() => {
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      const child = Object.assign(new EventEmitter(), { stdout, stderr, killed: false, kill: vi.fn() });
      queueMicrotask(() => child.emit("close", 0));
      return child;
    });

    await subagentTool.execute(
      "parent-fresh-call",
      { agent: "search", task: "fresh task" },
      undefined,
      undefined,
      { cwd: "/tmp/lazyresearch-test-project" } as never,
    );

    const args = spawnMock.mock.calls[0]?.[1] as string[];
    expect(args).not.toContain("--session");
  });

  it("persists the exact child UUID against the real parent tool call id", async () => {
    const { discoverAgents } = await import("./agents");
    const { resolveModelForSpawn } = await import("./model-resolution");
    const { getAgentDir } = await import("../runtime/pi-import");
    vi.mocked(discoverAgents).mockResolvedValue({ agents: [maker("search")] });
    vi.mocked(resolveModelForSpawn).mockResolvedValue(undefined);
    vi.mocked(getAgentDir).mockReturnValue("/tmp/lazyresearch-test-agent");
    spawnMock.mockImplementationOnce(() => {
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      const child = Object.assign(new EventEmitter(), {
        stdout,
        stderr,
        killed: false,
        kill: vi.fn(),
      });
      queueMicrotask(() => {
        stdout.emit("data", Buffer.from('{"type":"session","version":3,"id":"child-uuid","cwd":"/paper"}\n'));
        child.emit("close", 0);
      });
      return child;
    });

    const toolModule = await import("./tool") as typeof import("./tool") & {
      createSubagentTool?: (options?: { persistSessionLink?: (link: unknown) => void }) => typeof subagentTool;
    };
    expect(toolModule.createSubagentTool).toBeTypeOf("function");
    const persistSessionLink = vi.fn();
    const tool = toolModule.createSubagentTool!({ persistSessionLink });

    await tool.execute(
      "parent-call",
      { agent: "search", task: "find papers", session: "new" },
      undefined,
      undefined,
      { cwd: "/tmp/lazyresearch-test-project" } as never,
    );

    expect(persistSessionLink).toHaveBeenCalledTimes(1);
    expect(persistSessionLink).toHaveBeenCalledWith({
      toolCallId: "parent-call",
      childSessionId: "child-uuid",
      agent: "search",
    });
  });

  it("carries the captured child UUID on nested event updates after the session header", async () => {
    const { discoverAgents } = await import("./agents");
    const { resolveModelForSpawn } = await import("./model-resolution");
    const { getAgentDir } = await import("../runtime/pi-import");
    vi.mocked(discoverAgents).mockResolvedValue({ agents: [maker("search")] });
    vi.mocked(resolveModelForSpawn).mockResolvedValue(undefined);
    vi.mocked(getAgentDir).mockReturnValue("/tmp/lazyresearch-test-agent");
    spawnMock.mockImplementationOnce(() => {
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      const child = Object.assign(new EventEmitter(), {
        stdout,
        stderr,
        killed: false,
        kill: vi.fn(),
      });
      queueMicrotask(() => {
        stdout.emit("data", Buffer.from([
          '{"type":"session","version":3,"id":"child-stream-uuid","cwd":"/paper"}',
          '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"token"}}',
          "",
        ].join("\n")));
        child.emit("close", 0);
      });
      return child;
    });

    const onUpdate = vi.fn();
    await subagentTool.execute(
      "parent-stream-call",
      { agent: "search", task: "find papers", session: "new" },
      undefined,
      onUpdate,
      { cwd: "/tmp/lazyresearch-test-project" } as never,
    );

    const nestedEventUpdate = onUpdate.mock.calls
      .map(([update]) => update.details?.subagent)
      .find((update) => update?.event?.type === "message_update");
    expect(nestedEventUpdate).toMatchObject({
      agent: "search",
      sessionId: "child-stream-uuid",
      event: {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "token" },
      },
    });
  });
});

describe("handleChildLine (ADR-037)", () => {
  const line = (event: unknown) => JSON.stringify(event);

  it("captures a valid child session header before message dispatch", () => {
    const headers: Array<{ id: string; cwd: string }> = [];
    handleChildLine(
      '{"type":"session","version":3,"id":"child-uuid","cwd":"/paper"}',
      "search",
      undefined,
      {
        onSessionHeader: (header) => headers.push(header),
        onEvent: () => {},
        onMessageEnd: () => {},
        onToolResultEnd: () => {},
      },
    );
    expect(headers).toEqual([{ id: "child-uuid", cwd: "/paper" }]);
  });

  it("forwards the exact child message delta event", () => {
    const events: unknown[] = [];
    const childLine = JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "token" },
    });
    handleChildLine(childLine, "search", 1, {
      onEvent: (event) => events.push(event),
      onMessageEnd: () => {},
      onToolResultEnd: () => {},
    });
    expect(events).toEqual([JSON.parse(childLine)]);
  });

  it("dispatches message_end to onMessageEnd and streams progress to onProgress", () => {
    const onMessageEnd = vi.fn();
    const onToolResultEnd = vi.fn();
    const onProgress = vi.fn();
    handleChildLine(
      line({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "scanning arxiv" }] } }),
      "search",
      3,
      { onMessageEnd, onToolResultEnd, onProgress },
    );
    expect(onMessageEnd).toHaveBeenCalledTimes(1);
    expect(onToolResultEnd).not.toHaveBeenCalled();
    expect(onProgress).toHaveBeenCalledWith({
      agent: "search",
      step: 3,
      status: "running",
      latestMessage: "scanning arxiv",
    });
  });

  it("dispatches tool_result_end to onToolResultEnd without progress", () => {
    const onMessageEnd = vi.fn();
    const onToolResultEnd = vi.fn();
    const onProgress = vi.fn();
    handleChildLine(line({ type: "tool_result_end", message: { role: "tool", content: [{ type: "text", text: "out" }] } }), "search", 1, {
      onMessageEnd,
      onToolResultEnd,
      onProgress,
    });
    expect(onMessageEnd).not.toHaveBeenCalled();
    expect(onToolResultEnd).toHaveBeenCalledTimes(1);
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("skips progress when the message carries no text", () => {
    const onProgress = vi.fn();
    handleChildLine(line({ type: "message_end", message: { role: "assistant", content: [] } }), "search", 1, {
      onMessageEnd: vi.fn(),
      onToolResultEnd: vi.fn(),
      onProgress,
    });
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("dispatches malformed-content messages without emitting progress or throwing", () => {
    const message = { role: "assistant", content: [null, { type: "text" }] };
    const onMessageEnd = vi.fn();
    const onProgress = vi.fn();
    expect(() => handleChildLine(line({ type: "message_end", message }), "search", 1, {
      onMessageEnd,
      onToolResultEnd: vi.fn(),
      onProgress,
    })).not.toThrow();
    expect(onMessageEnd).toHaveBeenCalledWith(message);
    expect(onProgress).not.toHaveBeenCalled();
  });

  it.each([
    ["null", null],
    ["array", []],
    ["string", "message_end"],
    ["number", 42],
    ["boolean", true],
  ])("ignores a valid JSON %s event", (_name, event) => {
    const handlers = { onMessageEnd: vi.fn(), onToolResultEnd: vi.fn(), onProgress: vi.fn() };
    expect(() => handleChildLine(line(event), "search", 1, handlers)).not.toThrow();
    expect(handlers.onMessageEnd).not.toHaveBeenCalled();
    expect(handlers.onToolResultEnd).not.toHaveBeenCalled();
    expect(handlers.onProgress).not.toHaveBeenCalled();
  });

  it.each([
    ["null", null],
    ["array", []],
    ["string", "assistant"],
    ["number", 42],
    ["boolean", true],
  ])("ignores a message_end with a %s message", (_name, message) => {
    const handlers = { onMessageEnd: vi.fn(), onToolResultEnd: vi.fn(), onProgress: vi.fn() };
    expect(() => handleChildLine(line({ type: "message_end", message }), "search", 1, handlers)).not.toThrow();
    expect(handlers.onMessageEnd).not.toHaveBeenCalled();
    expect(handlers.onToolResultEnd).not.toHaveBeenCalled();
    expect(handlers.onProgress).not.toHaveBeenCalled();
  });

  it("ignores a tool_result_end with a primitive message", () => {
    const handlers = { onMessageEnd: vi.fn(), onToolResultEnd: vi.fn(), onProgress: vi.fn() };
    handleChildLine(line({ type: "tool_result_end", message: "output" }), "search", 1, handlers);
    expect(handlers.onToolResultEnd).not.toHaveBeenCalled();
  });

  it("ignores malformed lines without crashing", () => {
    const handlers = { onMessageEnd: vi.fn(), onToolResultEnd: vi.fn(), onProgress: vi.fn() };
    handleChildLine("not json", "search", 1, handlers);
    handleChildLine("", "search", 1, handlers);
    handleChildLine(line({ type: "message_start" }), "search", 1, handlers);
    expect(handlers.onMessageEnd).not.toHaveBeenCalled();
    expect(handlers.onToolResultEnd).not.toHaveBeenCalled();
    expect(handlers.onProgress).not.toHaveBeenCalled();
  });

  it("does not crash when no progress callback is wired", () => {
    expect(() =>
      handleChildLine(line({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } }), "search", 1, {
        onMessageEnd: vi.fn(),
        onToolResultEnd: vi.fn(),
      }),
    ).not.toThrow();
  });
});

describe("serial lock (ADR-022)", () => {
  it("rejects a second acquisition while one invocation is active", () => {
    releaseSubagentLock();
    expect(tryAcquireSubagentLock()).toBe(true);
    expect(tryAcquireSubagentLock()).toBe(false);
    releaseSubagentLock();
    expect(tryAcquireSubagentLock()).toBe(true);
    releaseSubagentLock();
  });
});

describe("resolveInheritedSession (ADR-044)", () => {
  let dir: string;
  const cwd = "/tmp/lazyresearch-pipeline";

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "lazy-sessions-"));
    const runtime = await vi.importActual<typeof import("../runtime/pi-import")>("../runtime/pi-import");
    const { importPi } = await import("../runtime/pi-import");
    vi.mocked(importPi).mockImplementation(runtime.importPi);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeSession(name: string | undefined, headerTimestamp: string, id = crypto.randomUUID()): string {
    const filePath = join(dir, `${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`);
    const lines = [
      JSON.stringify({ type: "session", version: 3, id, timestamp: headerTimestamp, cwd }),
    ];
    if (name !== undefined) {
      lines.push(
        JSON.stringify({
          type: "session_info",
          id: "e5f6g7h8",
          parentId: null,
          timestamp: headerTimestamp,
          name,
        }),
      );
    }
    writeFileSync(filePath, lines.join("\n"), "utf8");
    return filePath;
  }

  it("does not use an unlinked named child as an inheritance fallback", async () => {
    makeSession("lazyresearch:search", "2026-08-06T00:00:00.000Z", crypto.randomUUID());
    expect(await resolveInheritedSession(cwd, "search", dir, [])).toBeUndefined();
  });

  it("resumes the child UUID linked from the current parent, not another parent's newer child", async () => {
    const linkedId = crypto.randomUUID();
    const unrelatedId = crypto.randomUUID();
    const linked = makeSession("lazyresearch:search", "2026-08-06T01:00:00.000Z", linkedId);
    const unrelated = makeSession("lazyresearch:search", "2026-08-06T02:00:00.000Z", unrelatedId);
    expect(await resolveInheritedSession(cwd, "search", dir, [{
      type: "custom",
      customType: SUBAGENT_SESSION_LINK_ENTRY,
      data: { toolCallId: "parent-call", childSessionId: linkedId, agent: "search" },
    }])).toBe(linked);
    expect(linked).not.toBe(unrelated);
  });
});

describe("describeModel", () => {
  it("returns provider/id for a known model", () => {
    expect(describeModel({ model: { provider: "openrouter", id: "deepseek" } } as never)).toBe(
      "openrouter/deepseek",
    );
  });

  it("returns undefined without a model", () => {
    expect(describeModel({} as never)).toBeUndefined();
  });
});

describe("subagent model resolution logging", () => {
  async function stubFreshToolDeps(): Promise<void> {
    const { discoverAgents } = await import("./agents");
    const { resolveModelForSpawn } = await import("./model-resolution");
    const { importPi, getAgentDir } = await import("../runtime/pi-import");
    vi.mocked(discoverAgents).mockResolvedValue({ agents: [maker("other")] });
    vi.mocked(resolveModelForSpawn).mockResolvedValue("p/m");
    vi.mocked(getAgentDir).mockReturnValue("/fake/agent");
    vi.mocked(importPi).mockResolvedValue({
      SessionManager: { list: vi.fn(async () => []) },
    } as never);
  }

  it("logs the resolved model at dispatch", async () => {
    const previous = process.env.LAZYRESEARCH_RPC_CHILD;
    delete process.env.LAZYRESEARCH_RPC_CHILD;
    try {
      vi.resetModules();
      await stubFreshToolDeps();
      // Fresh import re-executes the module scope, so createLogger runs with
      // RPC_CHILD unset and the module-scope logger is live.
      const { subagentTool } = await import("./tool");

      await subagentTool.execute(
        "call-1",
        { chain: [{ agent: "search", task: "find papers" }] },
        undefined,
        undefined,
        { cwd: "/tmp/lazyresearch-pipeline", sessionManager: { getEntries: () => [] } } as never,
      );

      expect(loggerMock.debug).toHaveBeenCalledWith("subagent model resolved", {
        agent: "search",
        model: "p/m",
      });
    } finally {
      if (previous === undefined) delete process.env.LAZYRESEARCH_RPC_CHILD;
      else process.env.LAZYRESEARCH_RPC_CHILD = previous;
    }
  });

  it("creates no logger inside RPC children (LAZYRESEARCH_RPC_CHILD=1)", async () => {
    const previous = process.env.LAZYRESEARCH_RPC_CHILD;
    process.env.LAZYRESEARCH_RPC_CHILD = "1";
    try {
      createLoggerMock.mockClear();
      loggerMock.debug.mockClear();
      vi.resetModules();
      await stubFreshToolDeps();
      // Fresh import re-executes the module scope; with RPC_CHILD=1 the guard
      // must skip createLogger entirely (Constraint 4: RPC children never run
      // their own logger).
      const { subagentTool } = await import("./tool");
      expect(createLoggerMock).not.toHaveBeenCalled();

      await subagentTool.execute(
        "call-2",
        { agent: "search", task: "find papers" },
        undefined,
        undefined,
        { cwd: "/tmp/lazyresearch-pipeline", sessionManager: { getEntries: () => [] } } as never,
      );

      expect(createLoggerMock).not.toHaveBeenCalled();
      expect(loggerMock.debug).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.LAZYRESEARCH_RPC_CHILD;
      else process.env.LAZYRESEARCH_RPC_CHILD = previous;
    }
  });
});

function maker(name: string, tools = ""): {
  name: string;
  description: string;
  tools: string[] | undefined;
  subagents: string[] | undefined;
  systemPrompt: string;
  source: "global";
  filePath: string;
} {
  return {
    name,
    description: "test agent",
    tools: tools ? tools.split(", ").map((t) => t.trim()).filter(Boolean) : undefined,
    subagents: undefined,
    systemPrompt: "",
    source: "global",
    filePath: name,
  };
}
