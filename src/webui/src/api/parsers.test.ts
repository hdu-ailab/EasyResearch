import { describe, expect, it } from "vitest";
import {
  parseActiveSession,
  parseAgents,
  parseChildSnapshot,
  parseConfigEntries,
  parseConfigFile,
  parseConfigProjects,
  parseConfigurationEvent,
  parseDirectories,
  parseEntries,
  parseFileContent,
  parseModels,
  parseSessionSnapshot,
  parseSessionTree,
  parseSkillCommands,
  parseStatus,
  parseSubagentSupervisorEvent,
  parseUpdateCheck,
} from "./parsers";

describe("API response parsers", () => {
  it("rejects a status payload with a missing homeDir", () => {
    expect(() => parseStatus({ agentDir: "/a", sessions: [], activeSessions: [] })).toThrow();
  });

  it("preserves the DTO values needed by the Home page", () => {
    expect(
      parseStatus({
        agentDir: "/a",
        homeDir: "/home/user",
        sessions: [],
        activeSessions: [],
      }).homeDir,
    ).toBe("/home/user");
  });

  it("accepts only a string or null update version", () => {
    expect(parseUpdateCheck({ latestVersion: "0.0.62" })).toEqual({ latestVersion: "0.0.62" });
    expect(parseUpdateCheck({ latestVersion: null })).toEqual({ latestVersion: null });
    expect(() => parseUpdateCheck({})).toThrow();
    expect(() => parseUpdateCheck({ latestVersion: 62 })).toThrow();
  });

  it("parses agent and model catalog rows with optional metadata", () => {
    expect(
      parseAgents([
        {
          name: "search",
          description: "Finds papers",
          enabled: true,
          builtin: true,
          source: "global",
          filePath: "/agent/agents/search.md",
          model: "openai/gpt-4o",
          effectiveModel: "openai/gpt-4o",
          thinking: "high",
          tools: ["web"],
          subagents: [],
          skills: ["arxiv"],
          missingSkills: [],
        },
      ]),
    ).toEqual([
      {
        name: "search",
        description: "Finds papers",
        tools: ["web"],
        subagents: [],
        skills: ["arxiv"],
        enabled: true,
        builtin: true,
        source: "global",
        filePath: "/agent/agents/search.md",
        model: "openai/gpt-4o",
        effectiveModel: "openai/gpt-4o",
        thinking: "high",
        effectiveTools: ["web"],
        effectiveSkills: ["arxiv"],
        missingSkills: [],
      },
    ]);
    expect(
      parseModels({ models: [{ provider: "openai", id: "gpt-4o", reasoning: true, thinkingLevelMap: {} }] }),
    ).toEqual([{ provider: "openai", id: "gpt-4o", reasoning: true, thinkingLevelMap: {} }]);
  });

  it("rejects malformed model rows and project Agent sources", () => {
    expect(() => parseModels({ models: [{ provider: "openai" }] })).toThrow();
    expect(() => parseModels({ models: [{ provider: "openai", id: "gpt-4o", reasoning: "yes" }] })).toThrow();
    expect(() => parseAgents([{ name: "search", description: 42 }])).toThrow();
    expect(() =>
      parseAgents([
        {
          name: "search",
          description: "Finds papers",
          source: "global",
          effectiveModel: 42,
          effectiveTools: [],
          effectiveSkills: [],
          missingSkills: [],
        },
      ]),
    ).toThrow();
    expect(() =>
      parseAgents([
        {
          name: "search",
          description: "Finds papers",
          enabled: true,
          builtin: true,
          source: "project",
          filePath: "/project/.easyresearch/agents/search.md",
          effectiveTools: [],
          effectiveSkills: [],
          missingSkills: [],
        },
      ]),
    ).toThrow();
  });

  it("parses both configuration event variants and rejects incomplete payloads", () => {
    expect(
      parseConfigurationEvent({ type: "config.updated", generation: 3, agentsChanged: true, modelsChanged: false }),
    ).toEqual({ type: "config.updated", generation: 3, agentsChanged: true, modelsChanged: false });
    expect(parseConfigurationEvent({ type: "config.error", generation: 3, message: "Invalid configuration" })).toEqual({
      type: "config.error",
      generation: 3,
      message: "Invalid configuration",
    });
    expect(() => parseConfigurationEvent({ type: "config.updated", generation: 3, agentsChanged: true })).toThrow();
    expect(() => parseConfigurationEvent({ type: "config.error", generation: -1, message: "bad" })).toThrow();
  });

  it("parses directory, file, and text-content responses", () => {
    expect(parseDirectories({ entries: [{ name: "papers", path: "/p/papers" }] })).toEqual([
      { name: "papers", path: "/p/papers" },
    ]);
    expect(parseEntries({ entries: [{ kind: "file", name: "notes.md", path: "/p/notes.md" }] })).toEqual([
      { kind: "file", name: "notes.md", path: "/p/notes.md" },
    ]);
    expect(
      parseFileContent({ path: "/p/notes.md", content: "# Notes", byteCount: 7, truncated: false, binary: false }),
    ).toEqual({
      path: "/p/notes.md",
      content: "# Notes",
      byteCount: 7,
      truncated: false,
      binary: false,
    });
    expect(() => parseEntries({ entries: [{ kind: "socket", name: "x", path: "/p/x" }] })).toThrow();
  });

  it("parses active and snapshot responses while rejecting invalid session fields", () => {
    const session = { id: "s1", cwd: "/p", isStreaming: false, status: "ready" };
    expect(parseActiveSession(session)).toEqual(session);
    expect(
      parseSessionSnapshot({
        session,
        messages: [{ role: "assistant", content: [] }],
        subagents: [
          {
            ownerSessionId: "s1",
            toolCallId: "tool-1",
            childSessionId: "child-1",
            agent: "search",
            status: "working",
          },
        ],
      }),
    ).toMatchObject({ session, messages: [{ role: "assistant" }] });
    expect(
      parseChildSnapshot({
        session: { id: "child-1", cwd: "/p", sessionName: "easyresearch:search" },
        messages: [],
        subagents: [],
      }).session,
    ).toEqual({ id: "child-1", cwd: "/p", sessionName: "easyresearch:search" });
    expect(() => parseActiveSession({ ...session, status: "unknown" })).toThrow();
    expect(() => parseSessionSnapshot({ session, messages: {}, subagents: [] })).toThrow();
    expect(() => parseChildSnapshot({ session: { id: "child-1", cwd: "/p" }, messages: [] })).toThrow();
  });

  describe("subagent supervisor payloads", () => {
    const liveEvent = {
      type: "subagent_supervisor",
      launchId: "launch-0",
      ownerSessionId: "root",
      toolCallId: "tool-0",
      agent: "custom/search",
      agentId: "opaque agent id",
      childSessionId: "child-0",
      status: "working",
    } as const;

    it.each(["working", "complete", "error"] as const)("accepts the %s status", (status) => {
      expect(parseSubagentSupervisorEvent({ ...liveEvent, status })).toEqual({ ...liveEvent, status });
    });

    it("accepts optional terminal text and a delta-only child event", () => {
      const event = {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "next token" },
      };
      expect(parseSubagentSupervisorEvent({ ...liveEvent, latestMessage: "complete handoff", event })).toEqual({
        ...liveEvent,
        latestMessage: "complete handoff",
        event,
      });
    });

    it.each(["launchId", "ownerSessionId", "toolCallId", "agent", "agentId", "childSessionId"] as const)(
      "rejects a missing or empty %s",
      (field) => {
        const missing = { ...liveEvent } as Record<string, unknown>;
        delete missing[field];
        expect(() => parseSubagentSupervisorEvent(missing)).toThrow();
        expect(() => parseSubagentSupervisorEvent({ ...liveEvent, [field]: "  " })).toThrow();
      },
    );

    it("rejects unknown statuses and wrong field types", () => {
      expect(() => parseSubagentSupervisorEvent({ ...liveEvent, status: "queued" })).toThrow();
      expect(() => parseSubagentSupervisorEvent({ ...liveEvent, latestMessage: 42 })).toThrow();
      expect(() => parseSubagentSupervisorEvent({ ...liveEvent, event: "message_update" })).toThrow();
      expect(() => parseSubagentSupervisorEvent({ ...liveEvent, toolCallId: 42 })).toThrow();
    });

    it.each(["sessionPath", "session_path"])("rejects a live %s leak", (field) => {
      expect(() => parseSubagentSupervisorEvent({ ...liveEvent, [field]: "/private/child.jsonl" })).toThrow();
    });

    it.each(["sessionPath", "session_path"])("rejects a nested child %s leak", (field) => {
      expect(() =>
        parseSubagentSupervisorEvent({
          ...liveEvent,
          event: {
            type: "message_start",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "visible" }],
              [field]: "/private/child.jsonl",
            },
          },
        }),
      ).toThrow("session path");
    });

    it("rejects a nested hidden supervisor custom message", () => {
      expect(() =>
        parseSubagentSupervisorEvent({
          ...liveEvent,
          event: {
            type: "message_end",
            message: {
              role: "custom",
              customType: "easyresearch:agent_status",
              content: "private handoff",
            },
          },
        }),
      ).toThrow("hidden supervisor status");
    });

    it("rejects cumulative assistant partials in nested child events", () => {
      expect(() =>
        parseSubagentSupervisorEvent({
          ...liveEvent,
          event: {
            type: "message_update",
            assistantMessageEvent: {
              type: "text_delta",
              contentIndex: 0,
              delta: "next token",
              partial: { role: "assistant", content: [{ type: "text", text: "all tokens" }] },
            },
          },
        }),
      ).toThrow();
    });

    it("parses current and legacy summaries while rejecting path-bearing summaries", () => {
      const session = { id: "root", cwd: "/p", isStreaming: false, status: "ready" };
      const summary = {
        ownerSessionId: "root",
        toolCallId: "tool-0",
        childSessionId: "child-0",
        agent: "custom/search",
        status: "complete",
        launchId: "launch-0",
        agentId: "opaque agent id",
        step: 2,
        latestMessage: "done",
      };
      expect(parseSessionSnapshot({ session, messages: [], subagents: [summary] }).subagents).toEqual([summary]);
      const legacy = {
        ownerSessionId: "root",
        toolCallId: "legacy-tool",
        childSessionId: "legacy-child",
        agent: "search",
        status: "complete",
      };
      expect(parseSessionSnapshot({ session, messages: [], subagents: [legacy] }).subagents).toEqual([legacy]);
      expect(() =>
        parseSessionSnapshot({ session, messages: [], subagents: [{ ...summary, sessionPath: "/private/a.jsonl" }] }),
      ).toThrow();
      expect(() =>
        parseSessionSnapshot({ session, messages: [], subagents: [{ ...summary, session_path: "/private/a.jsonl" }] }),
      ).toThrow();
      expect(() =>
        parseSessionSnapshot({ session, messages: [], subagents: [{ ...summary, ownerSessionId: undefined }] }),
      ).toThrow();
      expect(() =>
        parseSessionSnapshot({ session, messages: [], subagents: [{ ...summary, status: "queued" }] }),
      ).toThrow();
    });

    it("parses direct subagents from child snapshots", () => {
      const subagent = {
        ownerSessionId: "child-0",
        toolCallId: "nested-tool",
        childSessionId: "grandchild-0",
        agent: "search",
        status: "working",
      };
      expect(
        parseChildSnapshot({
          session: { id: "child-0", cwd: "/p" },
          messages: [],
          subagents: [subagent],
        }).subagents,
      ).toEqual([subagent]);
    });
  });

  it("parses config browser responses and rejects invalid entry types", () => {
    expect(parseConfigEntries([{ name: "settings.json", path: "settings.json", type: "file" }])).toEqual([
      { name: "settings.json", path: "settings.json", type: "file" },
    ]);
    expect(parseConfigProjects({ home: "/home/user", projects: [{ cwd: "/p" }] })).toEqual({
      home: "/home/user",
      projects: [{ cwd: "/p" }],
    });
    expect(parseConfigFile({ path: "settings.json", content: "{}" })).toEqual({ path: "settings.json", content: "{}" });
    expect(() => parseConfigEntries([{ name: "x", path: "x", type: "socket" }])).toThrow();
  });

  it("parseSkillCommands extracts name, source and optional description", () => {
    expect(
      parseSkillCommands({
        commands: [
          { name: "arxiv", description: "arXiv", source: "skill" },
          { name: "name", source: "extension" },
        ],
      }),
    ).toEqual([
      { name: "arxiv", description: "arXiv", source: "skill" },
      { name: "name", source: "extension" },
    ]);
    expect(parseSkillCommands({ commands: [{ name: "legacy" }] })).toEqual([{ name: "legacy", source: "skill" }]);
    expect(parseSkillCommands({ commands: "nope" })).toEqual([]);
    expect(parseSkillCommands({ commands: [{ description: 3 }] })).toEqual([]);
    expect(() => parseSkillCommands(null)).toThrow();
  });

  it("parseSessionTree parses entries and leaf id", () => {
    expect(
      parseSessionTree({
        leafId: "m2",
        tree: [
          { id: "m1", parentId: null, role: "user", text: "hi" },
          { id: "m2", parentId: "m1", role: "assistant", text: "yo" },
        ],
      }),
    ).toEqual({
      leafId: "m2",
      tree: [
        { id: "m1", parentId: null, role: "user", text: "hi" },
        { id: "m2", parentId: "m1", role: "assistant", text: "yo" },
      ],
    });
  });

  it("parseSessionTree drops malformed entries and non-string leaf ids", () => {
    expect(
      parseSessionTree({
        leafId: null,
        tree: [{ id: 1 }, { id: "ok", parentId: null, role: "user", text: "" }],
      }),
    ).toEqual({ leafId: null, tree: [{ id: "ok", parentId: null, role: "user", text: "" }] });
  });
});
