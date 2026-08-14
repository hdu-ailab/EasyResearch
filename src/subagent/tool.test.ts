import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { AgentConfig } from "./agents";
import {
  buildPiArgs,
  createSubagentTool,
  describeModel,
  filterAgentsByAllowlist,
  handleChildLine,
  progressFromMessage,
  resolveInheritedSession,
  resolveSessionPath,
  SubagentExecutionError,
  subagentTool,
} from "./tool";
import { sessionNameFor, SUBAGENT_SESSION_LINK_ENTRY, SUBAGENT_SESSION_PREFIX } from "./session-links";
import { releaseSubagentLock, tryAcquireSubagentLock } from "./serial";
import { stageExtensionPaths } from "./tool";

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
  PAPER_ASSISTANT_AGENT: "paper-assistant",
  discoverAgents: vi.fn(),
}));

vi.mock("./model-resolution", () => ({
  resolveModelForSpawn: vi.fn(),
}));

vi.mock("./thinking-resolution", () => ({
  resolveThinkingForSpawn: vi.fn(),
}));

vi.mock("../runtime/pi-import", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime/pi-import")>();
  return {
    ...actual,
    importPi: vi.fn(actual.importPi),
    getAgentDir: vi.fn(actual.getAgentDir),
  };
});

beforeEach(async () => {
  releaseSubagentLock();
  const { discoverAgents } = await import("./agents");
  const { resolveModelForSpawn } = await import("./model-resolution");
  const { resolveThinkingForSpawn } = await import("./thinking-resolution");
  vi.mocked(discoverAgents).mockReset();
  vi.mocked(resolveModelForSpawn).mockReset();
  vi.mocked(resolveThinkingForSpawn).mockReset();
  spawnMock.mockReset();
  loggerMock.debug.mockClear();
});

afterEach(() => {
  releaseSubagentLock();
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

  it("mounts the shared web tool extensions in stage runtimes (ADR-068)", () => {
    const agent = maker("search");
    const args = buildPiArgs(agent, undefined, "task");
    const extensionFlags = args
      .map((arg, index) => (arg === "--extension" ? args[index + 1] : undefined))
      .filter((path): path is string => typeof path === "string");
    expect(extensionFlags).toEqual(expect.arrayContaining(stageExtensionPaths));
  });

  it("adds --session when inheriting a session line (ADR-022)", () => {
    const agent = maker("search");
    const args = buildPiArgs(agent, undefined, "task", "/tmp/easyresearch-search.jsonl");
    expect(args).toContain("--session");
    expect(args[args.indexOf("--session") + 1]).toBe("/tmp/easyresearch-search.jsonl");
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

  it("adds --thinking with the resolved thinking level", () => {
    const agent = maker("search");
    const args = buildPiArgs(agent, undefined, "task", undefined, undefined, "high");
    expect(args).toContain("--thinking");
    expect(args[args.indexOf("--thinking") + 1]).toBe("high");
  });

  it("omits --thinking when no level is resolved", () => {
    const agent = maker("search");
    expect(buildPiArgs(agent, undefined, "task")).not.toContain("--thinking");
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

  it.each([
    ["missing", undefined],
    ["empty", []],
  ])("leaves %s tools to stage all-tools activation", (_label, tools) => {
    const agent = { ...maker("search"), tools };
    expect(buildPiArgs(agent, undefined, "task")).not.toContain("--tools");
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

  it("does not mount a home .agents skill unless the resolver is enabled", () => {
    const root = mkdtempSync(join(tmpdir(), "lr-home-skill-"));
    const homeSkill = join(root, ".agents", "skills", "home-only");
    mkdirSync(homeSkill, { recursive: true });
    writeFileSync(join(homeSkill, "SKILL.md"), "# home-only");
    const agent = { ...maker("search"), skills: ["home-only"] };

    const disabled = buildPiArgs(agent, undefined, "task", undefined, {
      cwd: root,
      agentDir: join(root, "agent"),
      homeDir: root,
    });
    expect(disabled).not.toContain(join(root, ".agents", "skills", "home-only"));

    const enabled = buildPiArgs(agent, undefined, "task", undefined, {
      cwd: root,
      agentDir: join(root, "agent"),
      homeDir: root,
      enableDotAgentsSkill: true,
    });
    expect(enabled).toContain(join(root, ".agents", "skills", "home-only"));
  });

  it("mounts every controlled skill root for an explicit empty selection", () => {
    const root = mkdtempSync(join(tmpdir(), "lr-empty-skills-"));
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    const projectSkills = join(cwd, ".easyresearch", "skills");
    const globalSkills = join(agentDir, "skills");
    const homeSkills = join(root, ".agents", "skills");
    for (const directory of [projectSkills, globalSkills, homeSkills]) mkdirSync(directory, { recursive: true });
    const agent = { ...maker("search"), skills: [] };
    const args = buildPiArgs(agent, undefined, "task", undefined, {
      cwd,
      agentDir,
      homeDir: root,
      enableDotAgentsSkill: true,
    });
    expect(args).toContain("--no-skills");
    expect(args).toEqual(expect.arrayContaining([
      "--skill", projectSkills,
      "--skill", globalSkills,
      "--skill", homeSkills,
    ]));
  });

  it("disables default skill discovery when skills is undefined", () => {
    const args = buildPiArgs(maker("search"), undefined, "task", undefined, { cwd: "/tmp", agentDir: "/tmp/agent" });
    expect(args).toContain("--no-skills");
  });
});

describe("sessionNameFor", () => {
  it("names session lines with the easyresearch prefix (ADR-022)", () => {
    expect(sessionNameFor("search")).toBe(`${SUBAGENT_SESSION_PREFIX}search`);
  });
});

describe("filterAgentsByAllowlist (ADR-022)", () => {
  const agents = [maker("search"), maker("experiment"), maker("writing")];

  it("keeps all agents without an allowlist (Paper Assistant runtime)", () => {
    expect(filterAgentsByAllowlist(agents, undefined).map((a) => a.name)).toEqual(["search", "experiment", "writing"]);
  });

  it("filters to the declared allowlist", () => {
    expect(filterAgentsByAllowlist(agents, "search").map((a) => a.name)).toEqual(["search"]);
    expect(filterAgentsByAllowlist(agents, "search,figures").map((a) => a.name)).toEqual(["search"]);
  });

  it("allows no agents for an empty allowlist", () => {
    expect(filterAgentsByAllowlist(agents, "")).toEqual([]);
  });

  it("omits the Paper Assistant and disabled specialists when no allowlist is configured", () => {
    const paperAssistant = maker("paper-assistant");
    const disabled = { ...maker("writing"), enabled: false };

    expect(filterAgentsByAllowlist([paperAssistant, maker("search"), disabled], undefined).map((agent) => agent.name))
      .toEqual(["search"]);
  });

  it("does not make disabled or Paper Assistant targets dispatchable through an explicit allowlist", () => {
    const disabledPaperAssistant = { ...maker("paper-assistant"), enabled: false };
    const disabled = { ...maker("writing"), enabled: false };

    expect(filterAgentsByAllowlist(
      [disabledPaperAssistant, maker("search"), disabled],
      "paper-assistant,search,writing",
    ).map((agent) => agent.name)).toEqual(["search"]);
  });

  it("excludes a stage caller when its subagents policy is omitted", () => {
    expect(filterAgentsByAllowlist(
      [maker("search"), maker("reviewer"), maker("writing")],
      undefined,
      "reviewer",
    ).map((agent) => agent.name)).toEqual(["search", "writing"]);
  });

  it("excludes a stage caller even when its explicit allowlist names itself", () => {
    expect(filterAgentsByAllowlist(
      [maker("search"), maker("reviewer"), maker("writing")],
      "reviewer,search",
      "reviewer",
    ).map((agent) => agent.name)).toEqual(["search"]);
  });
});

describe("createSubagentTool agent provider", () => {
  it("uses an injected per-cwd provider instead of the process stage allowlist", async () => {
    const previous = process.env.EASYRESEARCH_AGENTS_ALLOWLIST;
    process.env.EASYRESEARCH_AGENTS_ALLOWLIST = "writing";
    try {
      const agentProvider = vi.fn(async () => [maker("search")]);
      const tool = createSubagentTool({ agentProvider });

      const error = await tool.execute(
        "assistant-call",
        {},
        undefined,
        undefined,
        { cwd: "/paper", sessionManager: { getEntries: () => [] } } as never,
      ).catch((value) => value);

      expect(agentProvider).toHaveBeenCalledWith("/paper");
      expect(error).toBeInstanceOf(SubagentExecutionError);
      expect(error.message).toContain("search (global)");
      expect(error.message).not.toContain("writing");
      expect(process.env.EASYRESEARCH_AGENTS_ALLOWLIST).toBe("writing");
    } finally {
      if (previous === undefined) delete process.env.EASYRESEARCH_AGENTS_ALLOWLIST;
      else process.env.EASYRESEARCH_AGENTS_ALLOWLIST = previous;
    }
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
    vi.mocked(getAgentDir).mockReturnValue("/tmp/easyresearch-test-agent");
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
      { cwd: "/tmp/easyresearch-test-project" } as never,
    );

    expect(result.content).toEqual([{ type: "text", text: "first section\n\nsecond section" }]);
  });

  it("returns a successful fresh child's confirmed JSONL path", async () => {
    const { discoverAgents } = await import("./agents");
    const { resolveModelForSpawn } = await import("./model-resolution");
    const { getAgentDir, importPi } = await import("../runtime/pi-import");
    vi.mocked(discoverAgents).mockResolvedValue({ agents: [maker("search")] });
    vi.mocked(resolveModelForSpawn).mockResolvedValue(undefined);
    vi.mocked(getAgentDir).mockReturnValue("/tmp/easyresearch-test-agent");
    vi.mocked(importPi).mockResolvedValue({
      SessionManager: {
        list: vi.fn(async () => [{ id: "child-success", path: "/sessions/child-success.jsonl" }]),
      },
    } as never);
    spawnMock.mockImplementationOnce(() => {
      const stdout = new EventEmitter();
      const child = Object.assign(new EventEmitter(), {
        stdout,
        stderr: new EventEmitter(),
        killed: false,
        kill: vi.fn(),
      });
      queueMicrotask(() => {
        stdout.emit("data", Buffer.from([
          '{"type":"session","version":3,"id":"child-success","cwd":"/paper"}',
          JSON.stringify({
            type: "message_end",
            message: { role: "assistant", content: [{ type: "text", text: "status: complete" }] },
          }),
          "",
        ].join("\n")));
        child.emit("close", 0);
      });
      return child;
    });

    const result = await subagentTool.execute(
      "call-success-path",
      { agent: "search", task: "find papers" },
      undefined,
      undefined,
      { cwd: "/paper", sessionManager: { getEntries: () => [] } } as never,
    );

    expect(result.content).toEqual([{ type: "text", text: [
      "status: complete",
      "",
      "Session history JSONL: /sessions/child-success.jsonl",
      'Inspect this file from the bottom for the latest saved progress. To continue this agent in the current parent session, call subagent with session: "inherit".',
    ].join("\n") }]);
    expect((result.details as { results: Array<{ sessionId?: string; sessionPath?: string }> }).results[0]).toMatchObject({
      sessionId: "child-success",
      sessionPath: "/sessions/child-success.jsonl",
    });
  });

    it("spawns the child with the resolved thinking level as --thinking", async () => {
    const { discoverAgents } = await import("./agents");
    const { resolveModelForSpawn } = await import("./model-resolution");
    const { resolveThinkingForSpawn } = await import("./thinking-resolution");
    const { getAgentDir, importPi } = await import("../runtime/pi-import");
    vi.mocked(discoverAgents).mockResolvedValue({ agents: [maker("search")] });
    vi.mocked(resolveModelForSpawn).mockResolvedValue(undefined);
    vi.mocked(resolveThinkingForSpawn).mockResolvedValue("high");
    vi.mocked(getAgentDir).mockReturnValue("/tmp/easyresearch-test-agent");
    vi.mocked(importPi).mockResolvedValue({
      SessionManager: {
        list: vi.fn(async () => [{ id: "child-thinking", path: "/sessions/child-thinking.jsonl" }]),
      },
    } as never);
    spawnMock.mockImplementationOnce(() => {
      const stdout = new EventEmitter();
      const child = Object.assign(new EventEmitter(), {
        stdout,
        stderr: new EventEmitter(),
        killed: false,
        kill: vi.fn(),
      });
      queueMicrotask(() => {
        stdout.emit("data", Buffer.from([
          '{"type":"session","version":3,"id":"child-thinking","cwd":"/paper"}',
          JSON.stringify({
            type: "message_end",
            message: { role: "assistant", content: [{ type: "text", text: "done" }] },
          }),
          "",
        ].join("\n")));
        child.emit("close", 0);
      });
      return child;
    });

    await subagentTool.execute(
      "call-thinking",
      { agent: "search", task: "find papers" },
      undefined,
      undefined,
      { cwd: "/paper", sessionManager: { getEntries: () => [] }, thinkingLevel: "medium" } as never,
    );

    const args = spawnMock.mock.calls[0]?.[1] as string[];
    expect(args[args.indexOf("--thinking") + 1]).toBe("high");
    expect(resolveThinkingForSpawn).toHaveBeenCalledWith(
      { cwd: "/paper", sessionManager: expect.anything() },
      "search",
      "medium",
    );
  });

  it("does not report an unflushed child session as a JSONL path", async () => {
    const { discoverAgents } = await import("./agents");
    const { resolveModelForSpawn } = await import("./model-resolution");
    const { getAgentDir, importPi } = await import("../runtime/pi-import");
    vi.mocked(discoverAgents).mockResolvedValue({ agents: [maker("search")] });
    vi.mocked(resolveModelForSpawn).mockResolvedValue(undefined);
    vi.mocked(getAgentDir).mockReturnValue("/tmp/easyresearch-test-agent");
    vi.mocked(importPi).mockResolvedValue({
      SessionManager: { list: vi.fn(async () => []) },
    } as never);
    spawnMock.mockImplementationOnce(() => {
      const stdout = new EventEmitter();
      const child = Object.assign(new EventEmitter(), {
        stdout,
        stderr: new EventEmitter(),
        killed: false,
        kill: vi.fn(),
      });
      queueMicrotask(() => {
        stdout.emit("data", Buffer.from([
          '{"type":"session","version":3,"id":"child-unflushed","cwd":"/paper"}',
          JSON.stringify({
            type: "message_end",
            message: { role: "assistant", content: [{ type: "text", text: "status: complete" }] },
          }),
          "",
        ].join("\n")));
        child.emit("close", 0);
      });
      return child;
    });

    const result = await subagentTool.execute(
      "call-unflushed",
      { agent: "search", task: "find papers" },
      undefined,
      undefined,
      { cwd: "/paper", sessionManager: { getEntries: () => [] } } as never,
    );

    expect(result.content).toEqual([{ type: "text", text: "status: complete" }]);
    expect((result.details as { results: Array<{ sessionPath?: string }> }).results[0]?.sessionPath).toBeUndefined();
  });

  it("returns the same mapped JSONL path for an inherited success", async () => {
    const { resolveModelForSpawn } = await import("./model-resolution");
    const { getAgentDir, importPi } = await import("../runtime/pi-import");
    vi.mocked(resolveModelForSpawn).mockResolvedValue(undefined);
    vi.mocked(getAgentDir).mockReturnValue("/tmp/easyresearch-test-agent");
    vi.mocked(importPi).mockResolvedValue({
      SessionManager: {
        list: vi.fn(async () => [{ id: "child-inherited", path: "/sessions/inherited.jsonl" }]),
      },
    } as never);
    spawnMock.mockImplementationOnce(() => {
      const stdout = new EventEmitter();
      const child = Object.assign(new EventEmitter(), {
        stdout,
        stderr: new EventEmitter(),
        killed: false,
        kill: vi.fn(),
      });
      queueMicrotask(() => {
        stdout.emit("data", Buffer.from([
          '{"type":"session","version":3,"id":"child-inherited","cwd":"/paper"}',
          JSON.stringify({
            type: "message_end",
            message: { role: "assistant", content: [{ type: "text", text: "continued" }] },
          }),
          "",
        ].join("\n")));
        child.emit("close", 0);
      });
      return child;
    });
    const tool = createSubagentTool({ agentProvider: async () => [maker("search")] });

    const result = await tool.execute(
      "call-inherited-success",
      { agent: "search", task: "continue", session: "inherit" },
      undefined,
      undefined,
      {
        cwd: "/paper",
        sessionManager: {
          getEntries: () => [{
            type: "custom",
            customType: SUBAGENT_SESSION_LINK_ENTRY,
            data: { toolCallId: "prior-call", childSessionId: "child-inherited", agent: "search" },
          }],
        },
      } as never,
    );

    const args = spawnMock.mock.calls[0]?.[1] as string[];
    expect(args[args.indexOf("--session") + 1]).toBe("/sessions/inherited.jsonl");
    expect((result.details as { results: Array<{ sessionPath?: string }> }).results[0]?.sessionPath).toBe("/sessions/inherited.jsonl");
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("/sessions/inherited.jsonl") });
  });

  it("returns every successful chain step JSONL path in order", async () => {
    const { resolveModelForSpawn } = await import("./model-resolution");
    const { getAgentDir, importPi } = await import("../runtime/pi-import");
    vi.mocked(resolveModelForSpawn).mockResolvedValue(undefined);
    vi.mocked(getAgentDir).mockReturnValue("/tmp/easyresearch-test-agent");
    vi.mocked(importPi).mockResolvedValue({
      SessionManager: {
        list: vi.fn(async () => [
          { id: "chain-a", path: "/sessions/chain-a.jsonl" },
          { id: "chain-b", path: "/sessions/chain-b.jsonl" },
        ]),
      },
    } as never);
    for (const [sessionId, text] of [["chain-a", "searched"], ["chain-b", "written"]] as const) {
      spawnMock.mockImplementationOnce(() => {
        const stdout = new EventEmitter();
        const child = Object.assign(new EventEmitter(), {
          stdout,
          stderr: new EventEmitter(),
          killed: false,
          kill: vi.fn(),
        });
        queueMicrotask(() => {
          stdout.emit("data", Buffer.from([
            `{"type":"session","version":3,"id":"${sessionId}","cwd":"/paper"}`,
            JSON.stringify({
              type: "message_end",
              message: { role: "assistant", content: [{ type: "text", text }] },
            }),
            "",
          ].join("\n")));
          child.emit("close", 0);
        });
        return child;
      });
    }
    const tool = createSubagentTool({ agentProvider: async () => [maker("search"), maker("writing")] });

    const result = await tool.execute(
      "call-chain-success",
      { chain: [
        { agent: "search", task: "find papers" },
        { agent: "writing", task: "use {previous}" },
      ] },
      undefined,
      undefined,
      { cwd: "/paper", sessionManager: { getEntries: () => [] } } as never,
    );

    const text = (result.content[0] as { text: string }).text;
    expect(text.indexOf("step 1, search")).toBeLessThan(text.indexOf("step 2, writing"));
    expect((result.details as { results: Array<{ sessionPath?: string }> }).results.map((item) => item.sessionPath)).toEqual([
      "/sessions/chain-a.jsonl",
      "/sessions/chain-b.jsonl",
    ]);
  });
});

describe("subagent failure contract (ADR-059)", () => {
  async function prepareFailureDeps(sessionId = "child-failed", sessionPath = "/sessions/failed.jsonl") {
    const { resolveModelForSpawn } = await import("./model-resolution");
    const { getAgentDir, importPi } = await import("../runtime/pi-import");
    vi.mocked(resolveModelForSpawn).mockResolvedValue(undefined);
    vi.mocked(getAgentDir).mockReturnValue("/tmp/easyresearch-test-agent");
    vi.mocked(importPi).mockResolvedValue({
      SessionManager: {
        list: vi.fn(async () => [{ id: sessionId, path: sessionPath }]),
      },
    } as never);
  }

  it.each([
    { name: "non-zero exit", exitCode: 2, stopReason: undefined, errorMessage: undefined, stderr: "stderr failure" },
    { name: "assistant error", exitCode: 0, stopReason: "error", errorMessage: "provider failed", stderr: "" },
    { name: "assistant aborted", exitCode: 0, stopReason: "aborted", errorMessage: "request aborted", stderr: "" },
  ])("rejects $name with the recoverable JSONL path", async ({ exitCode, stopReason, errorMessage, stderr }) => {
    await prepareFailureDeps();
    spawnMock.mockImplementationOnce(() => {
      const stdout = new EventEmitter();
      const stderrStream = new EventEmitter();
      const child = Object.assign(new EventEmitter(), {
        stdout,
        stderr: stderrStream,
        killed: false,
        kill: vi.fn(),
      });
      queueMicrotask(() => {
        stdout.emit("data", Buffer.from([
          '{"type":"session","version":3,"id":"child-failed","cwd":"/paper"}',
          ...(stopReason ? [JSON.stringify({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "saved progress" }],
              stopReason,
              errorMessage,
            },
          })] : []),
          "",
        ].join("\n")));
        if (stderr) stderrStream.emit("data", Buffer.from(stderr));
        child.emit("close", exitCode);
      });
      return child;
    });
    const tool = createSubagentTool({ agentProvider: async () => [maker("search")] });

    const error = await tool.execute(
      "call-failed",
      { agent: "search", task: "find papers" },
      undefined,
      undefined,
      { cwd: "/paper", sessionManager: { getEntries: () => [] } } as never,
    ).catch((value) => value);

    expect(error).toBeInstanceOf(SubagentExecutionError);
    expect(error.message).toContain(errorMessage || stderr);
    expect(error.message).toContain("Session history JSONL: /sessions/failed.jsonl");
    expect(error.message).toContain('session: "inherit"');
  });

  it.each(["partial", "blocked"])("keeps a normal %s handoff successful", async (status) => {
    await prepareFailureDeps("child-handoff", "/sessions/handoff.jsonl");
    spawnMock.mockImplementationOnce(() => {
      const stdout = new EventEmitter();
      const child = Object.assign(new EventEmitter(), {
        stdout,
        stderr: new EventEmitter(),
        killed: false,
        kill: vi.fn(),
      });
      queueMicrotask(() => {
        stdout.emit("data", Buffer.from([
          '{"type":"session","version":3,"id":"child-handoff","cwd":"/paper"}',
          JSON.stringify({
            type: "message_end",
            message: { role: "assistant", content: [{ type: "text", text: `status: ${status}` }], stopReason: "stop" },
          }),
          "",
        ].join("\n")));
        child.emit("close", 0);
      });
      return child;
    });
    const tool = createSubagentTool({ agentProvider: async () => [maker("search")] });

    const result = await tool.execute(
      `call-${status}`,
      { agent: "search", task: "find papers" },
      undefined,
      undefined,
      { cwd: "/paper", sessionManager: { getEntries: () => [] } } as never,
    );

    expect(result.content[0]).toMatchObject({ text: expect.stringContaining(`status: ${status}`) });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("/sessions/handoff.jsonl") });
  });

  it("rejects invalid parameters instead of returning a successful tool result", async () => {
    const tool = createSubagentTool({ agentProvider: async () => [maker("search")] });

    await expect(tool.execute(
      "call-invalid",
      {},
      undefined,
      undefined,
      { cwd: "/paper", sessionManager: { getEntries: () => [] } } as never,
    )).rejects.toThrow(/Invalid parameters/);
  });

  it("rejects an unknown agent instead of returning a successful tool result", async () => {
    await prepareFailureDeps();
    const tool = createSubagentTool({ agentProvider: async () => [maker("search")] });

    await expect(tool.execute(
      "call-unknown",
      { agent: "writing", task: "draft" },
      undefined,
      undefined,
      { cwd: "/paper", sessionManager: { getEntries: () => [] } } as never,
    )).rejects.toThrow(/Unknown agent: "writing"/);
  });

  it("rejects a concurrent invocation as a real tool failure", async () => {
    releaseSubagentLock();
    expect(tryAcquireSubagentLock()).toBe(true);
    const tool = createSubagentTool({ agentProvider: async () => [maker("search")] });
    try {
      await expect(tool.execute(
        "call-concurrent",
        { agent: "search", task: "find papers" },
        undefined,
        undefined,
        { cwd: "/paper", sessionManager: { getEntries: () => [] } } as never,
      )).rejects.toThrow(/Another subagent is still running/);
    } finally {
      releaseSubagentLock();
    }
  });

  it("returns prior and failed chain paths and stops before later steps", async () => {
    const { resolveModelForSpawn } = await import("./model-resolution");
    const { getAgentDir, importPi } = await import("../runtime/pi-import");
    vi.mocked(resolveModelForSpawn).mockResolvedValue(undefined);
    vi.mocked(getAgentDir).mockReturnValue("/tmp/easyresearch-test-agent");
    vi.mocked(importPi).mockResolvedValue({
      SessionManager: {
        list: vi.fn(async () => [
          { id: "chain-ok", path: "/sessions/chain-ok.jsonl" },
          { id: "chain-failed", path: "/sessions/chain-failed.jsonl" },
        ]),
      },
    } as never);
    for (const [sessionId, text, exitCode] of [
      ["chain-ok", "searched", 0],
      ["chain-failed", "saved draft", 2],
    ] as const) {
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
            `{"type":"session","version":3,"id":"${sessionId}","cwd":"/paper"}`,
            JSON.stringify({
              type: "message_end",
              message: { role: "assistant", content: [{ type: "text", text }] },
            }),
            "",
          ].join("\n")));
          if (exitCode !== 0) stderr.emit("data", Buffer.from("compile failed"));
          child.emit("close", exitCode);
        });
        return child;
      });
    }
    const tool = createSubagentTool({
      agentProvider: async () => [maker("search"), maker("writing"), maker("figures")],
    });

    const error = await tool.execute(
      "call-chain-failure",
      { chain: [
        { agent: "search", task: "find papers" },
        { agent: "writing", task: "draft from {previous}" },
        { agent: "figures", task: "draw" },
      ] },
      undefined,
      undefined,
      { cwd: "/paper", sessionManager: { getEntries: () => [] } } as never,
    ).catch((value) => value);

    expect(error).toBeInstanceOf(SubagentExecutionError);
    expect(error.message).toMatch(/Chain stopped at step 2 \(writing\): compile failed/);
    expect(error.message).toMatch(/step 1, search[\s\S]*step 2, writing/);
    expect(error.details.results.map((item: { sessionPath?: string }) => item.sessionPath)).toEqual([
      "/sessions/chain-ok.jsonl",
      "/sessions/chain-failed.jsonl",
    ]);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("recovers the confirmed JSONL path when the user aborts", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await prepareFailureDeps("child-user-abort", "/sessions/user-abort.jsonl");
      let child: EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        killed: boolean;
        kill: ReturnType<typeof vi.fn>;
      };
      spawnMock.mockImplementationOnce(() => {
        const stdout = new EventEmitter();
        child = Object.assign(new EventEmitter(), {
          stdout,
          stderr: new EventEmitter(),
          killed: false,
          kill: vi.fn(function (this: { killed: boolean }) {
            this.killed = true;
            return true;
          }),
        });
        queueMicrotask(() => {
          stdout.emit("data", Buffer.from('{"type":"session","version":3,"id":"child-user-abort","cwd":"/paper"}\n'));
        });
        return child;
      });
      const tool = createSubagentTool({ agentProvider: async () => [maker("search")] });
      const controller = new AbortController();
      const execution = tool.execute(
        "call-user-abort",
        { agent: "search", task: "find papers" },
        controller.signal,
        undefined,
        { cwd: "/paper", sessionManager: { getEntries: () => [] } } as never,
      );
      for (let i = 0; i < 10 && !child!; i++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(child!).toBeDefined();

      controller.abort();
      await vi.advanceTimersByTimeAsync(5000);
      expect(child!.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
      expect(child!.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
      child!.emit("close", 0);

      const error = await execution.catch((value) => value);
      expect(error).toBeInstanceOf(SubagentExecutionError);
      expect(error.message).toContain("Subagent was aborted");
      expect(error.message).toContain("/sessions/user-abort.jsonl");
      expect(error.message).toContain('session: "inherit"');
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not escalate an abort after the child exits", async () => {
    let escalation: (() => void) | undefined;
    const timeout = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      ...args: unknown[]
    ) => {
      escalation = args[0] as () => void;
      return 1 as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout);
    try {
      await prepareFailureDeps("child-fast-abort", "/sessions/fast-abort.jsonl");
      let child: EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        killed: boolean;
        kill: ReturnType<typeof vi.fn>;
      };
      spawnMock.mockImplementationOnce(() => {
        const stdout = new EventEmitter();
        child = Object.assign(new EventEmitter(), {
          stdout,
          stderr: new EventEmitter(),
          killed: false,
          kill: vi.fn(),
        });
        queueMicrotask(() => {
          stdout.emit("data", Buffer.from('{"type":"session","version":3,"id":"child-fast-abort","cwd":"/paper"}\n'));
        });
        return child;
      });
      const tool = createSubagentTool({ agentProvider: async () => [maker("search")] });
      const controller = new AbortController();
      const execution = tool.execute(
        "call-fast-abort",
        { agent: "search", task: "find papers" },
        controller.signal,
        undefined,
        { cwd: "/paper", sessionManager: { getEntries: () => [] } } as never,
      );
      for (let i = 0; i < 10 && !child!; i++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(child!).toBeDefined();

      controller.abort();
      child!.emit("close", 0);
      await execution.catch(() => undefined);
      expect(escalation).toBeTypeOf("function");
      escalation!();

      expect(child!.kill).toHaveBeenCalledTimes(1);
      expect(child!.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      timeout.mockRestore();
    }
  });
});

describe("Pi tool-error integration (ADR-059)", () => {
  it("records a thrown subagent failure as a real tool error", async () => {
    const { runAgentLoop } = await import("@earendil-works/pi-agent-core");
    const { createAssistantMessageEventStream, fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai");
    const definition = createSubagentTool({ agentProvider: async () => [] });
    const tool = {
      name: definition.name,
      label: definition.label,
      description: definition.description,
      parameters: definition.parameters,
      execute: (toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: never) =>
        definition.execute(
          toolCallId,
          params as never,
          signal,
          onUpdate,
          { cwd: "/paper", sessionManager: { getEntries: () => [] } } as never,
        ),
    };
    const firstCallId = "integrated-tool-call";
    const responses = [
      fauxAssistantMessage([fauxToolCall("subagent", { agent: "search", task: "find papers" }, { id: firstCallId })]),
      fauxAssistantMessage("done"),
    ];
    let responseIndex = 0;
    const streamFn = () => {
      const stream = createAssistantMessageEventStream();
      const message = responses[responseIndex++]!;
      queueMicrotask(() => {
        stream.push({ type: "start", partial: { ...message } });
        stream.push({ type: "done", reason: message.stopReason as "stop", message });
        stream.end(message);
      });
      return stream;
    };
    const model = {
      api: "faux",
      provider: "faux",
      id: "faux-1",
      name: "Faux Model",
      baseUrl: "http://localhost:0",
    } as never;
    const events: Array<{ type: string; [key: string]: unknown }> = [];
    await runAgentLoop(
      [{ role: "user", content: [{ type: "text" as const, text: "run search" }], timestamp: Date.now() }],
      { systemPrompt: "test", messages: [], tools: [tool as never] },
      {
        model,
        convertToLlm: async (messages: unknown) => messages as never,
      },
      async (event) => {
        events.push(event as { type: string; [key: string]: unknown });
      },
      undefined,
      streamFn,
    );

    const end = events.find((event) => event.type === "tool_execution_end");
    expect(end).toMatchObject({ toolName: "subagent", toolCallId: firstCallId, isError: true });

    const toolResultEnd = events.find(
      (event) => event.type === "message_end" && (event.message as { role?: string })?.role === "toolResult",
    );
    expect(toolResultEnd?.message).toMatchObject({
      toolName: "subagent",
      toolCallId: firstCallId,
      isError: true,
    });
    expect((toolResultEnd?.message as { content?: Array<{ text?: string }> })?.content?.[0]?.text).toContain(
      "No agents are available in this runtime.",
    );
  });
});

describe("subagent session link persistence", () => {
  it("resolves a single child definition and model from its explicit cwd", async () => {
    const { discoverAgents } = await import("./agents");
    const { resolveModelForSpawn } = await import("./model-resolution");
    const { getAgentDir } = await import("../runtime/pi-import");
    vi.mocked(discoverAgents).mockImplementation(async ({ cwd } = {}) => ({
      agents: [{ ...maker("search", cwd === "/paper/child" ? "read" : "bash"), source: "project" }],
    }));
    vi.mocked(resolveModelForSpawn).mockImplementation(async (ctx) =>
      ctx.cwd === "/paper/child" ? "child/model" : "parent/model");
    vi.mocked(getAgentDir).mockReturnValue("/tmp/easyresearch-test-agent");
    spawnMock.mockImplementationOnce(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        killed: false,
        kill: vi.fn(),
      });
      queueMicrotask(() => child.emit("close", 0));
      return child;
    });

    await subagentTool.execute(
      "explicit-child-cwd",
      { agent: "search", task: "find papers", cwd: "/paper/child" },
      undefined,
      undefined,
      { cwd: "/paper/parent", sessionManager: { getEntries: () => [] } } as never,
    );

    expect(discoverAgents).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/paper/child" }));
    expect(resolveModelForSpawn).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/paper/child" }),
      "search",
      undefined,
    );
    const args = spawnMock.mock.calls[0]?.[1] as string[];
    expect(args[args.indexOf("--tools") + 1]).toBe("read");
    expect(args[args.indexOf("--model") + 1]).toBe("child/model");
  });

  it("resolves every chain step from that step's effective cwd", async () => {
    const { discoverAgents } = await import("./agents");
    const { resolveModelForSpawn } = await import("./model-resolution");
    const { getAgentDir } = await import("../runtime/pi-import");
    vi.mocked(discoverAgents).mockImplementation(async ({ cwd } = {}) => ({
      agents: [{ ...maker("search", cwd === "/paper/a" ? "read" : "grep"), source: "project" }],
    }));
    vi.mocked(resolveModelForSpawn).mockImplementation(async (ctx) => `${ctx.cwd}/model`);
    vi.mocked(getAgentDir).mockReturnValue("/tmp/easyresearch-test-agent");
    for (let i = 0; i < 2; i++) {
      spawnMock.mockImplementationOnce(() => {
        const stdout = new EventEmitter();
        const child = Object.assign(new EventEmitter(), {
          stdout,
          stderr: new EventEmitter(),
          killed: false,
          kill: vi.fn(),
        });
        queueMicrotask(() => {
          stdout.emit("data", Buffer.from(`${JSON.stringify({
            type: "message_end",
            message: { role: "assistant", content: [{ type: "text", text: `step ${i + 1}` }] },
          })}\n`));
          child.emit("close", 0);
        });
        return child;
      });
    }

    await subagentTool.execute(
      "explicit-chain-cwds",
      { chain: [
        { agent: "search", task: "first", cwd: "/paper/a" },
        { agent: "search", task: "second {previous}", cwd: "/paper/b" },
      ] },
      undefined,
      undefined,
      { cwd: "/paper/parent", sessionManager: { getEntries: () => [] } } as never,
    );

    expect(discoverAgents).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/paper/a" }));
    expect(discoverAgents).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/paper/b" }));
    expect(vi.mocked(resolveModelForSpawn).mock.calls.map(([ctx]) => ctx.cwd)).toEqual(["/paper/a", "/paper/b"]);
    const firstArgs = spawnMock.mock.calls[0]?.[1] as string[];
    const secondArgs = spawnMock.mock.calls[1]?.[1] as string[];
    expect(firstArgs[firstArgs.indexOf("--tools") + 1]).toBe("read");
    expect(secondArgs[secondArgs.indexOf("--tools") + 1]).toBe("grep");
  });

  it("marks missing tools as all while preserving an explicit leaf allowlist", async () => {
    const { discoverAgents } = await import("./agents");
    const { resolveModelForSpawn } = await import("./model-resolution");
    const { getAgentDir } = await import("../runtime/pi-import");
    vi.mocked(discoverAgents).mockResolvedValue({ agents: [{ ...maker("search"), subagents: [] }] });
    vi.mocked(resolveModelForSpawn).mockResolvedValue(undefined);
    vi.mocked(getAgentDir).mockReturnValue("/tmp/easyresearch-test-agent");
    spawnMock.mockClear();
    spawnMock.mockImplementationOnce(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        killed: false,
        kill: vi.fn(),
      });
      queueMicrotask(() => child.emit("close", 0));
      return child;
    });

    await subagentTool.execute(
      "all-tools-leaf",
      { agent: "search", task: "find papers" },
      undefined,
      undefined,
      { cwd: "/tmp/easyresearch-test-project" } as never,
    );

    const options = spawnMock.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv };
    expect(options.env?.EASYRESEARCH_AGENT_TOOLS).toBe("all");
    expect(options.env?.EASYRESEARCH_AGENTS_ALLOWLIST).toBe("");
    expect(options.env?.EASYRESEARCH_CALLER_AGENT).toBe("search");
  });

  it("does not inherit parent stage capability markers", async () => {
    const { discoverAgents } = await import("./agents");
    const { resolveModelForSpawn } = await import("./model-resolution");
    const { getAgentDir } = await import("../runtime/pi-import");
    vi.mocked(discoverAgents).mockResolvedValue({ agents: [{ ...maker("search", "read"), subagents: undefined }] });
    vi.mocked(resolveModelForSpawn).mockResolvedValue(undefined);
    vi.mocked(getAgentDir).mockReturnValue("/tmp/easyresearch-test-agent");
    spawnMock.mockClear();
    spawnMock.mockImplementationOnce(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        killed: false,
        kill: vi.fn(),
      });
      queueMicrotask(() => child.emit("close", 0));
      return child;
    });
    const previousTools = process.env.EASYRESEARCH_AGENT_TOOLS;
    const previousAllowlist = process.env.EASYRESEARCH_AGENTS_ALLOWLIST;
    process.env.EASYRESEARCH_AGENT_TOOLS = "all";
    process.env.EASYRESEARCH_AGENTS_ALLOWLIST = "search";

    try {
      await subagentTool.execute(
        "isolated-capabilities",
        { agent: "search", task: "find papers" },
        undefined,
        undefined,
        { cwd: "/tmp/easyresearch-test-project" } as never,
      );
    } finally {
      if (previousTools === undefined) delete process.env.EASYRESEARCH_AGENT_TOOLS;
      else process.env.EASYRESEARCH_AGENT_TOOLS = previousTools;
      if (previousAllowlist === undefined) delete process.env.EASYRESEARCH_AGENTS_ALLOWLIST;
      else process.env.EASYRESEARCH_AGENTS_ALLOWLIST = previousAllowlist;
    }

    const options = spawnMock.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv };
    expect(options.env).not.toHaveProperty("EASYRESEARCH_AGENT_TOOLS");
    expect(options.env).not.toHaveProperty("EASYRESEARCH_AGENTS_ALLOWLIST");
  });

  it("starts a fresh child when session is omitted, even if a named child exists", async () => {
    const { discoverAgents } = await import("./agents");
    const { resolveModelForSpawn } = await import("./model-resolution");
    const { getAgentDir, importPi } = await import("../runtime/pi-import");
    vi.mocked(discoverAgents).mockResolvedValue({ agents: [maker("search")] });
    vi.mocked(resolveModelForSpawn).mockResolvedValue(undefined);
    vi.mocked(getAgentDir).mockReturnValue("/tmp/easyresearch-test-agent");
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
      { cwd: "/tmp/easyresearch-test-project" } as never,
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
    vi.mocked(getAgentDir).mockReturnValue("/tmp/easyresearch-test-agent");
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
      { cwd: "/tmp/easyresearch-test-project" } as never,
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
    vi.mocked(getAgentDir).mockReturnValue("/tmp/easyresearch-test-agent");
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
      { cwd: "/tmp/easyresearch-test-project" } as never,
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
  const cwd = "/tmp/easyresearch-pipeline";

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
    makeSession("easyresearch:search", "2026-08-06T00:00:00.000Z", crypto.randomUUID());
    expect(await resolveInheritedSession(cwd, "search", dir, [])).toBeUndefined();
  });

  it("resumes the child UUID linked from the current parent, not another parent's newer child", async () => {
    const linkedId = crypto.randomUUID();
    const unrelatedId = crypto.randomUUID();
    const linked = makeSession("easyresearch:search", "2026-08-06T01:00:00.000Z", linkedId);
    const unrelated = makeSession("easyresearch:search", "2026-08-06T02:00:00.000Z", unrelatedId);
    expect(await resolveInheritedSession(cwd, "search", dir, [{
      type: "custom",
      customType: SUBAGENT_SESSION_LINK_ENTRY,
      data: { toolCallId: "parent-call", childSessionId: linkedId, agent: "search" },
    }])).toBe(linked);
    expect(linked).not.toBe(unrelated);
  });

  it("resolves a child JSONL only by exact UUID", async () => {
    const wantedId = crypto.randomUUID();
    const otherId = crypto.randomUUID();
    const wanted = makeSession("easyresearch:search", "2026-08-13T01:00:00.000Z", wantedId);
    makeSession("easyresearch:search", "2026-08-13T02:00:00.000Z", otherId);

    await expect(resolveSessionPath(cwd, wantedId, dir)).resolves.toBe(wanted);
    await expect(resolveSessionPath(cwd, crypto.randomUUID(), dir)).resolves.toBeUndefined();
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
    vi.mocked(discoverAgents).mockResolvedValue({ agents: [maker("search")] });
    vi.mocked(resolveModelForSpawn).mockResolvedValue("p/m");
    vi.mocked(getAgentDir).mockReturnValue("/fake/agent");
    vi.mocked(importPi).mockResolvedValue({
      SessionManager: { list: vi.fn(async () => []) },
    } as never);
    spawnMock.mockImplementationOnce(() => {
      const stdout = new EventEmitter();
      const child = Object.assign(new EventEmitter(), {
        stdout,
        stderr: new EventEmitter(),
        killed: false,
        kill: vi.fn(),
      });
      queueMicrotask(() => {
        stdout.emit("data", Buffer.from(
          JSON.stringify({
            type: "message_end",
            message: { role: "assistant", content: [{ type: "text", text: "status: complete" }] },
          }),
        ));
        child.emit("close", 0);
      });
      return child;
    });
  }

  it("logs the resolved model at dispatch", async () => {
    const previous = process.env.EASYRESEARCH_RPC_CHILD;
    delete process.env.EASYRESEARCH_RPC_CHILD;
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
        { cwd: "/tmp/easyresearch-pipeline", sessionManager: { getEntries: () => [] } } as never,
      );

      expect(loggerMock.debug).toHaveBeenCalledWith("subagent model resolved", {
        agent: "search",
        model: "p/m",
      });
    } finally {
      if (previous === undefined) delete process.env.EASYRESEARCH_RPC_CHILD;
      else process.env.EASYRESEARCH_RPC_CHILD = previous;
    }
  });

  it("creates no logger inside RPC children (EASYRESEARCH_RPC_CHILD=1)", async () => {
    const previous = process.env.EASYRESEARCH_RPC_CHILD;
    process.env.EASYRESEARCH_RPC_CHILD = "1";
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
        { cwd: "/tmp/easyresearch-pipeline", sessionManager: { getEntries: () => [] } } as never,
      );

      expect(createLoggerMock).not.toHaveBeenCalled();
      expect(loggerMock.debug).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.EASYRESEARCH_RPC_CHILD;
      else process.env.EASYRESEARCH_RPC_CHILD = previous;
    }
  });
});

function maker(name: string, tools = ""): AgentConfig {
  const configuredTools = tools ? tools.split(", ").map((t) => t.trim()).filter(Boolean) : undefined;
  return {
    name,
    description: "test agent",
    enabled: true,
    builtin: false,
    tools: configuredTools,
    effectiveTools: configuredTools ?? ["read", "bash", "edit", "write", "grep", "find", "ls"],
    skills: undefined,
    effectiveSkills: [],
    missingSkills: [],
    subagents: undefined,
    model: undefined,
    systemPrompt: "",
    source: "global",
    filePath: name,
  };
}
