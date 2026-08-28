import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import * as parserModule from "./parsers";
import {
  parseActiveSession,
  parseAgentResource,
  parseAgents,
  parseApiUsageChangedEvent,
  parseApiUsageRecord,
  parseApiUsageSettings,
  parseApiUsageStatistics,
  parseChildSnapshot,
  parseCompactionSettings,
  parseConfigEntries,
  parseConfigFile,
  parseConfigProjects,
  parseConfigurationEvent,
  parseDirectories,
  parseEntries,
  parseFileContent,
  parseModels,
  parseSessionSnapshot,
  parseSessionStatsChangedEvent,
  parseSessionTree,
  parseSkillCommands,
  parseStatus,
  parseSubagentSupervisorEvent,
  parseUpdateCheck,
} from "./parsers";

describe("API response parsers", () => {
  const compactionPolicy = { triggerPercent: 70, enabled: true };

  it("parses only positive safe root runtime-applied generation events", () => {
    const parseRuntimeConfigurationAppliedEvent = (
      parserModule as unknown as {
        parseRuntimeConfigurationAppliedEvent(value: unknown): unknown;
      }
    ).parseRuntimeConfigurationAppliedEvent;

    expect(
      parseRuntimeConfigurationAppliedEvent({
        type: "runtime_configuration_applied",
        generation: 4,
      }),
    ).toEqual({ type: "runtime_configuration_applied", generation: 4 });
    for (const generation of [-1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1, "4"]) {
      expect(() =>
        parseRuntimeConfigurationAppliedEvent({
          type: "runtime_configuration_applied",
          generation,
        }),
      ).toThrow();
    }
    expect(() => parseRuntimeConfigurationAppliedEvent({ type: "config.updated", generation: 4 })).toThrow();
  });

  it("parses global and session-effective compaction settings without conflating enabled state", () => {
    expect(parseCompactionSettings({ triggerPercent: 80, globalEnabled: false })).toEqual({
      triggerPercent: 80,
      globalEnabled: false,
    });
    expect(
      parseSessionStatsChangedEvent({
        type: "session_stats_changed",
        contextUsage: { tokens: 90, contextWindow: 100, percent: 90 },
        compactionPolicy: { triggerPercent: 80, enabled: true },
      }),
    ).toEqual({
      type: "session_stats_changed",
      contextUsage: { tokens: 90, contextWindow: 100, percent: 90 },
      compactionPolicy: { triggerPercent: 80, enabled: true },
    });
    expect(() => parseCompactionSettings({ triggerPercent: 70, enabled: true })).toThrow();
    expect(() => parseSessionStatsChangedEvent({ type: "session_stats_changed" })).toThrow();
  });

  it("parses complete backend-owned API usage settings, records, and replacement summaries", () => {
    const totals = {
      records: 1,
      input: 10,
      output: 3,
      cacheRead: 2,
      cacheWrite: 1,
      cacheWrite1h: 1,
      reasoning: 2,
      totalTokens: 16,
      cacheHitRate: 0.2,
      cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
    };
    const statistics = {
      rootSessionId: "root-1",
      total: totals,
      sessions: [
        {
          sessionId: "root-1",
          direct: totals,
          subtree: totals,
          models: [
            {
              key: "openai/test-model",
              provider: "openai",
              model: "test-model",
              kind: "model",
              totals,
            },
          ],
        },
      ],
      partial: true,
      warnings: [{ sessionId: "child-1", agentId: "search_0", reason: "unreadable-descendant" }],
    };
    const usageRecord = {
      id: "entry-1",
      sessionId: "root-1",
      source: "assistant",
      timestamp: "2026-08-25T00:00:00.000Z",
      anchor: { kind: "message", messageEntryId: "entry-1" },
      provider: "openai",
      model: "test-model",
      usage: {
        input: 10,
        output: 3,
        cacheRead: 2,
        cacheWrite: 1,
        cacheWrite1h: 1,
        reasoning: 2,
        totalTokens: 16,
        cacheHitRate: 0.2,
        cost: totals.cost,
      },
    };

    expect(parseApiUsageSettings({ showApiUsageDetails: true })).toEqual({ showApiUsageDetails: true });
    expect(parseApiUsageRecord(usageRecord)).toEqual(usageRecord);
    expect(parseApiUsageStatistics(statistics)).toEqual(statistics);
    expect(parseApiUsageChangedEvent({ type: "api_usage_changed", statistics })).toEqual({
      type: "api_usage_changed",
      statistics,
    });
    expect(() =>
      parseApiUsageStatistics({
        ...statistics,
        total: { ...totals, cost: { total: 0.33 } },
      }),
    ).toThrow();
    expect(() => parseApiUsageChangedEvent({ type: "api_usage_changed", statistics: {} })).toThrow();
  });
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
      parseModels({
        models: [
          {
            provider: "openai",
            id: "gpt-4o",
            reasoning: true,
            thinkingLevelMap: {},
            available: false,
            authRequired: true,
          },
        ],
      }),
    ).toEqual([
      {
        provider: "openai",
        id: "gpt-4o",
        reasoning: true,
        thinkingLevelMap: {},
        available: false,
        authRequired: true,
      },
    ]);
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

  it("parses complete configuration events with optional project-watch leases", () => {
    const updated = {
      type: "config.updated",
      generation: 3,
      availabilityEpoch: 5,
      availabilityChanged: true,
      agentsChanged: true,
      modelsChanged: false,
      skillsChanged: true,
      runtimeChanged: true,
      projectWatchLeaseId: "project-watch-1",
    } as const;
    const error = {
      type: "config.error",
      generation: 3,
      availabilityEpoch: 5,
      message: "Invalid configuration",
      projectWatchLeaseId: "project-watch-2",
    } as const;

    expect(parseConfigurationEvent(updated)).toEqual(updated);
    expect(parseConfigurationEvent(error)).toEqual(error);
  });

  it("preserves Agent model repair metadata", () => {
    expect(
      parseAgentResource({
        name: "research-assistant",
        description: "Research Assistant",
        source: "bundled",
        effectiveTools: [],
        effectiveSkills: [],
        missingSkills: [],
        modelRepair: {
          requested: "deleted/model",
          applied: "openai/fallback",
          inherited: false,
        },
      }),
    ).toMatchObject({
      modelRepair: {
        requested: "deleted/model",
        applied: "openai/fallback",
        inherited: false,
      },
    });
  });

  it("preserves only the true API-usage display marker", () => {
    const displayOnly = {
      type: "config.updated",
      generation: 4,
      agentsChanged: false,
      modelsChanged: false,
      skillsChanged: false,
      runtimeChanged: false,
      apiUsageChanged: true,
    } as const;

    expect(parseConfigurationEvent(displayOnly)).toEqual(displayOnly);
    expect(() => parseConfigurationEvent({ ...displayOnly, apiUsageChanged: false })).toThrow();
  });

  it.each(["agentsChanged", "modelsChanged", "skillsChanged", "runtimeChanged"] as const)(
    "rejects config.updated without %s",
    (field) => {
      const event: Record<string, unknown> = {
        type: "config.updated",
        generation: 3,
        agentsChanged: true,
        modelsChanged: false,
        skillsChanged: true,
        runtimeChanged: true,
      };
      delete event[field];

      expect(() => parseConfigurationEvent(event)).toThrow(`${field} must be a boolean`);
    },
  );

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "3"])(
    "rejects malformed configuration generation %s",
    (generation) => {
      expect(() =>
        parseConfigurationEvent({
          type: "config.error",
          generation,
          message: "Invalid configuration",
        }),
      ).toThrow();
    },
  );

  it.each(["config.updated", "config.error"] as const)("rejects malformed project-watch lease ids on %s", (type) => {
    const event =
      type === "config.updated"
        ? {
            type,
            generation: 3,
            agentsChanged: true,
            modelsChanged: false,
            skillsChanged: true,
            runtimeChanged: true,
          }
        : { type, generation: 3, message: "Invalid configuration" };

    for (const projectWatchLeaseId of ["", "  ", 42]) {
      expect(() => parseConfigurationEvent({ ...event, projectWatchLeaseId })).toThrow();
    }
  });

  it("parses project-watch replacement and configuration refresh results", () => {
    const parsers = parserModule as typeof parserModule & {
      parseProjectWatchReplacementResult?: (value: unknown) => unknown;
      parseConfigurationRefreshResult?: (value: unknown) => unknown;
    };
    if (!parsers.parseProjectWatchReplacementResult || !parsers.parseConfigurationRefreshResult) {
      throw new Error("Configuration resource result parsers are not implemented");
    }

    expect(parsers.parseProjectWatchReplacementResult({ applied: true, revision: 0 })).toEqual({
      applied: true,
      revision: 0,
    });
    expect(parsers.parseProjectWatchReplacementResult({ applied: false, revision: 9 })).toEqual({
      applied: false,
      revision: 9,
    });
    expect(parsers.parseConfigurationRefreshResult({ generation: 0, error: null })).toEqual({
      generation: 0,
      error: null,
    });
    expect(
      parsers.parseConfigurationRefreshResult({ generation: 7, error: "Configuration validation failed" }),
    ).toEqual({ generation: 7, error: "Configuration validation failed" });
  });

  it("rejects malformed project-watch replacement and configuration refresh results", () => {
    const parsers = parserModule as typeof parserModule & {
      parseProjectWatchReplacementResult?: (value: unknown) => unknown;
      parseConfigurationRefreshResult?: (value: unknown) => unknown;
    };
    if (!parsers.parseProjectWatchReplacementResult || !parsers.parseConfigurationRefreshResult) {
      throw new Error("Configuration resource result parsers are not implemented");
    }

    for (const value of [
      { applied: "yes", revision: 0 },
      { applied: true, revision: -1 },
      { applied: true, revision: 1.5 },
      { applied: true, revision: Number.MAX_SAFE_INTEGER + 1 },
      { applied: true, revision: "1" },
    ]) {
      expect(() => parsers.parseProjectWatchReplacementResult?.(value)).toThrow();
    }
    for (const value of [
      { generation: -1, error: null },
      { generation: 1.5, error: null },
      { generation: Number.MAX_SAFE_INTEGER + 1, error: null },
      { generation: "1", error: null },
      { generation: 1 },
      { generation: 1, error: 42 },
    ]) {
      expect(() => parsers.parseConfigurationRefreshResult?.(value)).toThrow();
    }
  });

  it("parses directory, file, and text-content responses", () => {
    expect(parseDirectories({ path: "/p", entries: [{ name: "papers", path: "/p/papers" }] })).toEqual({
      path: "/p",
      entries: [{ name: "papers", path: "/p/papers" }],
    });
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
        runtimeConfigurationGeneration: 2,
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
        contextUsage: { tokens: null, contextWindow: 128_000, percent: null },
        compactionState: "queued",
        compactionPolicy,
        fileWatchLeaseId: "lease-1",
      }),
    ).toMatchObject({
      session,
      messages: [{ role: "assistant" }],
      runtimeConfigurationGeneration: 2,
      contextUsage: { tokens: null, contextWindow: 128_000, percent: null },
      compactionState: "queued",
      compactionPolicy,
      fileWatchLeaseId: "lease-1",
    });
    expect(
      parseChildSnapshot({
        session: { id: "child-1", cwd: "/p", sessionName: "easyresearch:search" },
        messages: [],
        subagents: [],
      }).session,
    ).toEqual({ id: "child-1", cwd: "/p", sessionName: "easyresearch:search" });
    expect(() => parseActiveSession({ ...session, status: "unknown" })).toThrow();
    expect(() =>
      parseSessionSnapshot({
        session,
        runtimeConfigurationGeneration: 2,
        messages: {},
        subagents: [],
        compactionPolicy,
      }),
    ).toThrow();
    expect(() => parseSessionSnapshot({ session, messages: [], subagents: [], compactionPolicy })).toThrow();
    expect(() =>
      parseSessionSnapshot({
        session,
        runtimeConfigurationGeneration: 2,
        messages: [],
        subagents: [],
      }),
    ).toThrow();
    expect(() =>
      parseSessionSnapshot({
        session,
        runtimeConfigurationGeneration: 2,
        messages: [],
        subagents: [],
        compactionPolicy,
        fileWatchLeaseId: 1,
      }),
    ).toThrow();
    for (const runtimeConfigurationGeneration of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "2"]) {
      expect(() =>
        parseSessionSnapshot({
          session,
          runtimeConfigurationGeneration,
          messages: [],
          subagents: [],
          compactionPolicy,
        }),
      ).toThrow();
    }
    expect(() =>
      parseSessionSnapshot({
        session,
        runtimeConfigurationGeneration: 2,
        messages: [],
        subagents: [],
        compactionPolicy,
        contextUsage: { tokens: 10, contextWindow: 100, percent: "10" },
      }),
    ).toThrow();
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
        usage: {
          input: 3,
          output: 5,
          cacheRead: 7,
          cacheWrite: 11,
          totalTokens: 26,
          cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
        },
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "next token" },
      } satisfies JsonAgentSessionEvent;
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
      expect(
        parseSessionSnapshot({
          session,
          runtimeConfigurationGeneration: 2,
          messages: [],
          subagents: [summary],
          compactionPolicy,
        }).subagents,
      ).toEqual([summary]);
      const legacy = {
        ownerSessionId: "root",
        toolCallId: "legacy-tool",
        childSessionId: "legacy-child",
        agent: "search",
        status: "complete",
      };
      expect(
        parseSessionSnapshot({
          session,
          runtimeConfigurationGeneration: 2,
          messages: [],
          subagents: [legacy],
          compactionPolicy,
        }).subagents,
      ).toEqual([legacy]);
      expect(() =>
        parseSessionSnapshot({
          session,
          runtimeConfigurationGeneration: 2,
          messages: [],
          subagents: [{ ...summary, sessionPath: "/private/a.jsonl" }],
          compactionPolicy,
        }),
      ).toThrow();
      expect(() =>
        parseSessionSnapshot({
          session,
          runtimeConfigurationGeneration: 2,
          messages: [],
          subagents: [{ ...summary, session_path: "/private/a.jsonl" }],
          compactionPolicy,
        }),
      ).toThrow();
      expect(() =>
        parseSessionSnapshot({
          session,
          runtimeConfigurationGeneration: 2,
          messages: [],
          subagents: [{ ...summary, ownerSessionId: undefined }],
          compactionPolicy,
        }),
      ).toThrow();
      expect(() =>
        parseSessionSnapshot({
          session,
          runtimeConfigurationGeneration: 2,
          messages: [],
          subagents: [{ ...summary, status: "queued" }],
          compactionPolicy,
        }),
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
          { name: "arxiv", description: "arXiv", source: "skill", requiresPrefix: true },
          { name: "name", source: "extension" },
        ],
      }),
    ).toEqual([
      { name: "arxiv", description: "arXiv", source: "skill", requiresPrefix: true },
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
        filterMode: "no-tools",
        skipBranchSummaryPrompt: true,
        tree: [
          { id: "m1", parentId: null, role: "user", kind: "user", text: "hi", label: "start" },
          {
            id: "m2",
            parentId: "m1",
            role: "assistant",
            kind: "assistant",
            text: "yo",
            stopReason: "stop",
          },
        ],
      }),
    ).toEqual({
      leafId: "m2",
      filterMode: "no-tools",
      skipBranchSummaryPrompt: true,
      tree: [
        { id: "m1", parentId: null, role: "user", kind: "user", text: "hi", label: "start" },
        {
          id: "m2",
          parentId: "m1",
          role: "assistant",
          kind: "assistant",
          text: "yo",
          stopReason: "stop",
        },
      ],
    });
  });

  it("parseSessionTree drops malformed entries and non-string leaf ids", () => {
    expect(
      parseSessionTree({
        leafId: null,
        filterMode: "invalid",
        skipBranchSummaryPrompt: false,
        tree: [{ id: 1 }, { id: "ok", parentId: null, role: "user", kind: "user", text: "" }],
      }),
    ).toEqual({
      leafId: null,
      filterMode: "default",
      skipBranchSummaryPrompt: false,
      tree: [{ id: "ok", parentId: null, role: "user", kind: "user", text: "" }],
    });
  });
});
