import { describe, expect, it } from "vitest";
import {
  parseActiveSession,
  parseAgents,
  parseChildSnapshot,
  parseConfigEntries,
  parseConfigFile,
  parseConfigProjects,
  parseDirectories,
  parseEffectiveModels,
  parseEntries,
  parseFileContent,
  parseModels,
  parseSessionSnapshot,
  parseSessionTree,
  parseSkillCommands,
  parseStatus,
  parseWebuiSettings,
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

  it("parses agent and model catalog rows with optional metadata", () => {
    expect(
      parseAgents([
        {
          name: "search",
          description: "Finds papers",
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
        builtin: false,
        source: "global",
        filePath: "",
        effectiveTools: ["web"],
        effectiveSkills: ["arxiv"],
        missingSkills: [],
      },
    ]);
    expect(
      parseModels({ models: [{ provider: "openai", id: "gpt-4o", reasoning: true, thinkingLevelMap: {} }] }),
    ).toEqual([{ provider: "openai", id: "gpt-4o", reasoning: true, thinkingLevelMap: {} }]);
  });

  it("rejects malformed model, agent, and effective-model payloads", () => {
    expect(() => parseModels({ models: [{ provider: "openai" }] })).toThrow();
    expect(() => parseModels({ models: [{ provider: "openai", id: "gpt-4o", reasoning: "yes" }] })).toThrow();
    expect(() => parseAgents([{ name: "search", description: 42 }])).toThrow();
    expect(() => parseEffectiveModels([{ name: "search", model: null, source: "unknown" }])).toThrow();
  });

  it("parses settings and preserves null effective model values", () => {
    expect(
      parseWebuiSettings({
        agentModels: { search: "openai/gpt-4o" },
        paperAssistantModel: null,
        effectivePaperAssistantModel: "openai/gpt-4o",
        agentThinking: { search: "high" },
        paperAssistantThinking: null,
      }),
    ).toEqual({
      agentModels: { search: "openai/gpt-4o" },
      paperAssistantModel: null,
      effectivePaperAssistantModel: "openai/gpt-4o",
      agentThinking: { search: "high" },
      paperAssistantThinking: null,
    });
    expect(() =>
      parseWebuiSettings({ agentModels: {}, paperAssistantModel: 42, effectivePaperAssistantModel: null }),
    ).toThrow();
    expect(() =>
      parseWebuiSettings({
        agentModels: {},
        agentThinking: { search: 42 },
        paperAssistantModel: null,
        effectivePaperAssistantModel: null,
      }),
    ).toThrow();
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
        subagents: [{ toolCallId: "tool-1", childSessionId: "child-1", agent: "search" }],
      }),
    ).toMatchObject({ session, messages: [{ role: "assistant" }] });
    expect(
      parseChildSnapshot({
        session: { id: "child-1", cwd: "/p", sessionName: "easyresearch:search" },
        messages: [],
      }).session,
    ).toEqual({ id: "child-1", cwd: "/p", sessionName: "easyresearch:search" });
    expect(() => parseActiveSession({ ...session, status: "unknown" })).toThrow();
    expect(() => parseSessionSnapshot({ session, messages: {}, subagents: [] })).toThrow();
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

  it("parseSkillCommands extracts name and optional description", () => {
    expect(
      parseSkillCommands({ commands: [{ name: "arxiv", description: "arXiv" }, { name: "drawio" }] }),
    ).toEqual([
      { name: "arxiv", description: "arXiv" },
      { name: "drawio" },
    ]);
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
