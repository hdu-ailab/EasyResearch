import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { SubagentSupervisorEventDto } from "../../web/contracts";
import {
  fromSnapshot as fromSnapshotRuntime,
  mergeSnapshot as mergeSnapshotRuntime,
  parseSkillInvocation,
  reduceSessionEvent,
  reduceSubagentSupervisorEvent,
  replaceApiUsageStatistics,
  type SessionViewState,
  terminateSessionRun,
} from "./session-reducer";

function withTimeline(snapshot: Record<string, unknown>) {
  if (Array.isArray(snapshot.timeline)) return snapshot;
  const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
  const { messages: _messages, ...rest } = snapshot;
  return {
    ...rest,
    timeline: messages.map((message: Record<string, unknown>, index: number) => ({
      kind: "message",
      entryId:
        typeof message.id === "string"
          ? message.id
          : message.timestamp !== undefined
            ? `${typeof message.role === "string" ? message.role : "message"}:${String(message.timestamp)}`
            : `test:${index}`,
      message,
    })),
  };
}

function fromSnapshot(snapshot: Record<string, unknown>, hydrationRevision?: number) {
  return fromSnapshotRuntime(withTimeline(snapshot) as never, hydrationRevision);
}

function mergeSnapshot(state: SessionViewState, snapshot: Record<string, unknown>) {
  return mergeSnapshotRuntime(state, withTimeline(snapshot) as never);
}

const emptyState: SessionViewState = {
  messages: [],
  tools: [],
  summaries: [],
  hydrationRevision: 0,
  isStreaming: false,
  error: null,
  retry: null,
  nextOrder: 0,
  steers: [],
  runtimeConfigurationGeneration: 0,
  compactionPolicy: { triggerPercent: 70, enabled: true },
  compactionState: "idle",
};

function userMessage(text: string) {
  return { role: "user", content: [{ type: "text", text }] } as never;
}

function assistantMessage(text: string) {
  return { role: "assistant", content: [{ type: "text", text }] } as never;
}

function assistantEvent(type: "message_start" | "message_update" | "message_end", text: string): AgentSessionEvent {
  if (type === "message_update") {
    return {
      type,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
    } as AgentSessionEvent;
  }
  return {
    type,
    message: { role: "assistant", content: [{ type: "text", text }] },
  } as AgentSessionEvent;
}

function toolEvent(
  type: "tool_execution_start" | "tool_execution_end",
  toolCallId = "t1",
  toolName = "bash",
): AgentSessionEvent {
  return { type, toolCallId, toolName, args: {} } as AgentSessionEvent;
}

function supervisorEvent(overrides: Partial<SubagentSupervisorEventDto> = {}): SubagentSupervisorEventDto {
  return {
    type: "subagent_supervisor",
    launchId: "launch-0",
    ownerSessionId: "root",
    toolCallId: "t1",
    agent: "search",
    agentId: "search_0",
    childSessionId: "child-0",
    status: "working",
    ...overrides,
  };
}

function launchToolEnd(overrides: Partial<SubagentSupervisorEventDto> = {}, toolCallId = "t1"): AgentSessionEvent {
  const job = supervisorEvent({ toolCallId, ...overrides });
  const { type: _type, event: _event, latestMessage: _latestMessage, ...identity } = job;
  return {
    type: "tool_execution_end",
    toolCallId,
    toolName: "subagent",
    isError: false,
    result: {
      content: [{ type: "text", text: `${job.agentId} is working.` }],
      details: { mode: "single", background: true, job: { ...identity, status: "working" } },
    },
  } as AgentSessionEvent;
}

describe("session reducer", () => {
  it("never renders agent-status custom messages or lets their boundaries move the assistant cursor", () => {
    const hidden = {
      role: "custom",
      customType: "easyresearch:agent_status",
      content: "<agent_status>\nCurrent time: t\n</agent_status>",
      display: false,
    } as never;

    const visible = reduceSessionEvent(emptyState, {
      type: "message_start",
      message: { id: "visible", role: "assistant", content: [] },
    } as never);
    const byStart = reduceSessionEvent(visible, {
      type: "message_start",
      message: hidden,
    } as never);
    const byEnd = reduceSessionEvent(byStart, {
      type: "message_end",
      message: hidden,
    } as never);
    expect(byEnd.messages).toEqual(visible.messages);
    expect(byEnd.activeMessageKey).toBe("visible");

    const bySnapshot = fromSnapshot({
      runtimeConfigurationGeneration: 0,
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "idle" },
      subagents: [],
      messages: [hidden],
    } as never);
    expect(bySnapshot.messages).toHaveLength(0);
  });

  it("hydrates from a snapshot", () => {
    const state = fromSnapshot({
      runtimeConfigurationGeneration: 3,
      session: { id: "s1", cwd: "/p", isStreaming: true, status: "running" } as never,
      subagents: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
      ] as never,
    });
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]!.role).toBe("user");
    expect(state.messages[1]!.role).toBe("assistant");
    expect(state.isStreaming).toBe(true);
    expect(state.runtimeConfigurationGeneration).toBe(3);
  });

  it("advances only on increasing live runtime generations and replaces from an authoritative snapshot", () => {
    const hydrated = fromSnapshot({
      runtimeConfigurationGeneration: 3,
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready" },
      subagents: [],
      messages: [],
    });

    const advanced = reduceSessionEvent(hydrated, {
      type: "runtime_configuration_applied",
      generation: 4,
    } as never);
    const duplicate = reduceSessionEvent(advanced, {
      type: "runtime_configuration_applied",
      generation: 4,
    } as never);
    const stale = reduceSessionEvent(duplicate, {
      type: "runtime_configuration_applied",
      generation: 2,
    } as never);

    expect(advanced.runtimeConfigurationGeneration).toBe(4);
    expect(duplicate).toBe(advanced);
    expect(stale).toBe(advanced);

    const reconnected = mergeSnapshot(stale, {
      runtimeConfigurationGeneration: 2,
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready" },
      subagents: [],
      messages: [],
    });
    expect(reconnected.runtimeConfigurationGeneration).toBe(2);
  });

  it("hydrates tool-only, nested-tool, and internal usage with the backend statistics replacement", () => {
    const usage = {
      input: 4,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 5,
      cacheHitRate: 0,
      cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.2 },
    };
    const totals = {
      records: 3,
      input: 12,
      output: 3,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite1h: 0,
      reasoning: 0,
      totalTokens: 15,
      cacheHitRate: 0,
      cost: { input: 0.3, output: 0.3, cacheRead: 0, cacheWrite: 0, total: 0.6 },
    };
    const apiUsage = {
      rootSessionId: "s1",
      total: totals,
      sessions: [{ sessionId: "s1", direct: totals, subtree: totals, models: [] }],
      partial: false,
      warnings: [],
    };
    const inlineUsage = [
      {
        id: "assistant-tool-entry",
        sessionId: "s1",
        source: "assistant",
        timestamp: "2026-08-25T00:00:01.000Z",
        anchor: { kind: "message", messageEntryId: "assistant-tool-entry" },
        provider: "openai",
        model: "test-model",
        usage,
      },
      {
        id: "tool-result-entry",
        sessionId: "s1",
        source: "tool",
        timestamp: "2026-08-25T00:00:02.000Z",
        anchor: { kind: "tool", toolCallId: "tool-1" },
        usage,
      },
      {
        id: "compaction-entry",
        sessionId: "s1",
        source: "compaction",
        timestamp: "2026-08-25T00:00:03.000Z",
        anchor: { kind: "standalone", afterEntryId: "tool-result-entry" },
        usage,
      },
    ] as const;
    const state = fromSnapshot({
      runtimeConfigurationGeneration: 0,
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready" },
      subagents: [],
      messages: [
        {
          id: "assistant-tool-entry",
          role: "assistant",
          content: [{ type: "toolCall", id: "tool-1", name: "bash", arguments: {} }],
        },
        { id: "tool-result-entry", role: "toolResult", toolCallId: "tool-1", toolName: "bash", content: [] },
      ] as never,
      inlineUsage: inlineUsage as never,
      apiUsage,
    });

    expect(state.apiUsage).toEqual(apiUsage);
    expect(state.tools).toEqual([expect.objectContaining({ key: "tool-1", apiUsage: inlineUsage[1] })]);
    expect(state.messages).toEqual([
      expect.objectContaining({ usageOnly: true, apiUsage: inlineUsage[0] }),
      expect.objectContaining({ usageOnly: true, apiUsage: inlineUsage[2] }),
    ]);
  });

  it("hydrates complete messages and compaction usage in persisted timeline order", () => {
    const usage = {
      input: 4,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 5,
      cacheHitRate: 0,
      cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.2 },
    };
    const oldMessage = {
      id: "old-assistant",
      role: "assistant",
      content: [{ type: "text", text: "old answer" }],
    };
    const laterMessage = {
      id: "later-assistant",
      role: "assistant",
      content: [{ type: "text", text: "later answer" }],
    };
    const state = fromSnapshot({
      runtimeConfigurationGeneration: 0,
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready" },
      messages: [oldMessage, laterMessage],
      timeline: [
        { kind: "message", entryId: "old-assistant", message: oldMessage },
        {
          kind: "compaction",
          entryId: "compact-1",
          timestamp: "2026-09-01T00:00:00.000Z",
          summary: "Compressed **Markdown**",
        },
        { kind: "message", entryId: "later-assistant", message: laterMessage },
      ],
      subagents: [],
      inlineUsage: [
        {
          id: "old-assistant",
          sessionId: "s1",
          source: "assistant",
          timestamp: "2026-09-01T00:00:00.000Z",
          anchor: { kind: "message", messageEntryId: "old-assistant" },
          model: "test-model",
          usage,
        },
        {
          id: "compact-1",
          sessionId: "s1",
          source: "compaction",
          timestamp: "2026-09-01T00:00:01.000Z",
          anchor: { kind: "standalone", afterEntryId: "old-assistant" },
          usage,
        },
        {
          id: "later-assistant",
          sessionId: "s1",
          source: "assistant",
          timestamp: "2026-09-01T00:00:02.000Z",
          anchor: { kind: "message", messageEntryId: "later-assistant" },
          model: "test-model",
          usage,
        },
      ],
    } as never);
    const summaries = (
      state as typeof state & {
        summaries?: Array<{ entryId: string; summary?: string; apiUsage?: unknown; order: number }>;
      }
    ).summaries;

    expect(summaries).toEqual([
      expect.objectContaining({
        entryId: "compact-1",
        summary: "Compressed **Markdown**",
        apiUsage: expect.objectContaining({ id: "compact-1" }),
      }),
    ]);
    expect(
      [
        ...state.messages.map((entry) => ({ kind: "message", id: entry.entryId, order: entry.order })),
        ...(summaries ?? []).map((entry) => ({ kind: "compaction", id: entry.entryId, order: entry.order })),
      ].sort((left, right) => left.order - right.order),
    ).toEqual([
      { kind: "message", id: "old-assistant", order: 0 },
      { kind: "compaction", id: "compact-1", order: 1 },
      { kind: "message", id: "later-assistant", order: 2 },
    ]);
    expect(state.messages).toEqual([
      expect.objectContaining({ entryId: "old-assistant", apiUsage: expect.objectContaining({ id: "old-assistant" }) }),
      expect.objectContaining({
        entryId: "later-assistant",
        apiUsage: expect.objectContaining({ id: "later-assistant" }),
      }),
    ]);
  });

  it("adds a live persisted usage record once and replaces recursive statistics", () => {
    const record = {
      id: "entry-live",
      sessionId: "s1",
      source: "assistant" as const,
      timestamp: "2026-08-25T00:00:00.000Z",
      anchor: { kind: "message" as const, messageEntryId: "entry-live" },
      provider: "openai",
      model: "test-model",
      usage: {
        input: 2,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 3,
        cacheHitRate: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    const afterRecord = reduceSessionEvent(emptyState, {
      type: "entry_appended",
      entry: {},
      apiUsageRecord: record,
    } as never);
    const duplicate = reduceSessionEvent(afterRecord, {
      type: "entry_appended",
      entry: {},
      apiUsageRecord: record,
    } as never);
    expect(duplicate.messages).toEqual([expect.objectContaining({ key: "usage:entry-live", apiUsage: record })]);

    const totals = {
      records: 1,
      input: 2,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite1h: 0,
      reasoning: 0,
      totalTokens: 3,
      cacheHitRate: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const statistics = {
      rootSessionId: "s1",
      total: totals,
      sessions: [{ sessionId: "s1", direct: totals, subtree: totals, models: [] }],
      partial: false,
      warnings: [],
    };
    expect(replaceApiUsageStatistics(duplicate, statistics).apiUsage).toBe(statistics);
  });

  it("reconciles a persisted usage id onto the existing live assistant response", () => {
    const message = { role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: 42 };
    const started = reduceSessionEvent(emptyState, { type: "message_start", message } as never);
    const ended = reduceSessionEvent(started, { type: "message_end", message } as never);
    const record = {
      id: "entry-answer",
      sessionId: "s1",
      source: "assistant" as const,
      timestamp: "2026-08-25T00:00:00.000Z",
      anchor: { kind: "message" as const, messageEntryId: "entry-answer" },
      usage: {
        input: 2,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 3,
        cacheHitRate: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };

    const persisted = reduceSessionEvent(ended, {
      type: "entry_appended",
      entry: { type: "message", id: "entry-answer", message },
      apiUsageRecord: record,
    } as never);

    expect(persisted.messages).toHaveLength(1);
    expect(persisted.messages[0]).toMatchObject({ text: "answer", entryId: "entry-answer", apiUsage: record });
    expect(persisted.messages[0]?.usageOnly).not.toBe(true);
  });

  it("adds one live compaction timeline entry and reconciles its usage by persisted id", () => {
    const record = {
      id: "compact-live",
      sessionId: "s1",
      source: "compaction" as const,
      timestamp: "2026-09-01T00:00:00.000Z",
      anchor: { kind: "standalone" as const, afterEntryId: "assistant-1" },
      usage: {
        input: 10,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 12,
        cacheHitRate: 0,
        cost: { input: 0.2, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.3 },
      },
    };
    const event = {
      type: "timeline_entry_appended",
      entry: {
        kind: "compaction",
        entryId: "compact-live",
        timestamp: "2026-09-01T00:00:00.000Z",
        summary: "Live summary",
      },
      apiUsageRecord: record,
    };

    const added = reduceSessionEvent(emptyState, event as never);
    const duplicate = reduceSessionEvent(added, event as never);

    expect(duplicate.summaries).toEqual([
      expect.objectContaining({
        entryId: "compact-live",
        summary: "Live summary",
        apiUsage: record,
      }),
    ]);
  });

  it("hydrates native context usage and queued compaction state without estimating tokens", () => {
    const state = fromSnapshot({
      runtimeConfigurationGeneration: 0,
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready" },
      subagents: [],
      messages: [],
      contextUsage: { tokens: null, contextWindow: 128_000, percent: null },
      compactionState: "queued",
    });

    expect(state.contextUsage).toEqual({ tokens: null, contextWindow: 128_000, percent: null });
    expect(state.compactionState).toBe("queued");
  });

  it("restores the assistant delta cursor from a running snapshot", () => {
    const hydrated = fromSnapshot({
      runtimeConfigurationGeneration: 0,
      session: { id: "s1", cwd: "/p", isStreaming: true, status: "running" },
      subagents: [],
      messages: [userMessage("question"), assistantMessage("partial")],
    });

    const updated = reduceSessionEvent(hydrated, assistantEvent("message_update", " answer"));

    expect(updated.messages.at(-1)?.text).toBe("partial answer");
    expect(updated.activeMessageKey).toBe(hydrated.messages.at(-1)?.key);
  });

  it("restores run and assistant cursor state when status is running but isStreaming is false", () => {
    const hydrated = fromSnapshot({
      runtimeConfigurationGeneration: 0,
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "running" },
      subagents: [],
      messages: [userMessage("question"), assistantMessage("partial")],
    });

    expect(hydrated.isStreaming).toBe(true);
    expect(hydrated.activeMessageKey).toBe(hydrated.messages.at(-1)?.key);
    expect(hydrated.messages.map((message) => message.streaming)).toEqual([false, true]);
  });

  it("does not fabricate an assistant cursor when a running snapshot ends in a user message", () => {
    const hydrated = fromSnapshot({
      runtimeConfigurationGeneration: 0,
      session: { id: "s1", cwd: "/p", isStreaming: true, status: "running" },
      subagents: [],
      messages: [assistantMessage("earlier"), userMessage("follow-up")],
    });

    expect(hydrated.isStreaming).toBe(true);
    expect(hydrated.activeMessageKey).toBeUndefined();
    expect(hydrated.messages.every((message) => !message.streaming)).toBe(true);
  });

  it("starts a new assistant row when a running snapshot ends in a tool-call-only message", () => {
    const hydrated = fromSnapshot({
      runtimeConfigurationGeneration: 0,
      session: { id: "s1", cwd: "/p", isStreaming: true, status: "running" },
      subagents: [],
      messages: [
        assistantMessage("earlier answer"),
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "pwd" } }],
        },
      ] as never,
    });

    const updated = reduceSessionEvent(hydrated, assistantEvent("message_update", "new answer"));

    expect(updated.messages.map((message) => message.text)).toEqual(["earlier answer", "new answer"]);
    expect(updated.messages.at(-1)).toEqual(expect.objectContaining({ role: "assistant", streaming: true }));
  });

  it("starts a new assistant row when a running snapshot ends in a tool result", () => {
    const hydrated = fromSnapshot({
      runtimeConfigurationGeneration: 0,
      session: { id: "s1", cwd: "/p", isStreaming: true, status: "running" },
      subagents: [],
      messages: [
        assistantMessage("earlier answer"),
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "pwd" } }],
        },
        { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "/p" }] },
      ] as never,
    });

    const updated = reduceSessionEvent(hydrated, assistantEvent("message_update", "new answer"));

    expect(updated.messages.map((message) => message.text)).toEqual(["earlier answer", "new answer"]);
    expect(updated.messages.at(-1)).toEqual(expect.objectContaining({ role: "assistant", streaming: true }));
  });

  it("creates one temporary assistant row when a running empty snapshot receives its first delta", () => {
    const hydrated = fromSnapshot({
      runtimeConfigurationGeneration: 0,
      session: { id: "s1", cwd: "/p", isStreaming: true, status: "running" },
      subagents: [],
      messages: [],
    });

    const updated = reduceSessionEvent(hydrated, assistantEvent("message_update", "first token"));

    expect(updated.messages).toEqual([
      expect.objectContaining({ role: "assistant", text: "first token", streaming: true }),
    ]);
    expect(updated.activeMessageKey).toBe(updated.messages[0]!.key);
  });

  it("keeps user and assistant rows distinct when Pi assigns the same timestamp", () => {
    const state = fromSnapshot({
      runtimeConfigurationGeneration: 0,
      session: { id: "child", cwd: "/p", isStreaming: false, status: "ready", sessionName: "easyresearch:search" },
      subagents: [],
      messages: [
        { role: "user", timestamp: 1000, content: [{ type: "text", text: "delegated task" }] },
        { role: "assistant", timestamp: 1000, content: [{ type: "text", text: "search progress" }] },
      ] as never,
    });

    expect(state.messages.map((message) => message.text)).toEqual(["delegated task", "search progress"]);
    expect(new Set(state.messages.map((message) => message.key)).size).toBe(2);
    expect(new Set(state.messages.map((message) => message.identity)).size).toBe(2);
  });

  it("reconciles a missing assistant row from the authoritative message_end", () => {
    const hydrated = fromSnapshot({
      runtimeConfigurationGeneration: 0,
      session: { id: "s1", cwd: "/p", isStreaming: true, status: "running" },
      subagents: [],
      messages: [],
    });
    const withDelta = reduceSessionEvent(hydrated, assistantEvent("message_update", "partial"));

    const ended = reduceSessionEvent(withDelta, {
      type: "message_end",
      message: { id: "final-id", role: "assistant", content: [{ type: "text", text: "authoritative final" }] },
    } as never);

    expect(ended.messages).toEqual([
      expect.objectContaining({
        identity: "final-id",
        role: "assistant",
        text: "authoritative final",
        streaming: false,
      }),
    ]);
    expect(ended.activeMessageKey).toBeUndefined();
  });

  it("creates a missing assistant row directly from message_end", () => {
    const hydrated = fromSnapshot({
      runtimeConfigurationGeneration: 0,
      session: { id: "s1", cwd: "/p", isStreaming: true, status: "running" },
      subagents: [],
      messages: [],
    });

    const ended = reduceSessionEvent(hydrated, assistantEvent("message_end", "authoritative final"));

    expect(ended.messages).toEqual([
      expect.objectContaining({ role: "assistant", text: "authoritative final", streaming: false }),
    ]);
  });

  it("does not overwrite a user row when message_end must create a missing assistant row", () => {
    const hydrated = fromSnapshot({
      runtimeConfigurationGeneration: 0,
      session: { id: "s1", cwd: "/p", isStreaming: true, status: "running" },
      subagents: [],
      messages: [userMessage("question")],
    });

    const ended = reduceSessionEvent(hydrated, assistantEvent("message_end", "authoritative final"));

    expect(ended.messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "question"],
      ["assistant", "authoritative final"],
    ]);
  });

  it("tracks agent lifecycle independently from assistant message completion", () => {
    const running = reduceSessionEvent(emptyState, { type: "agent_start" } as AgentSessionEvent);
    expect(running.isStreaming).toBe(true);

    const withAssistant = reduceSessionEvent(running, assistantEvent("message_start", "partial"));
    const afterAssistantMessageEnd = reduceSessionEvent(withAssistant, assistantEvent("message_end", "complete"));
    expect(afterAssistantMessageEnd.isStreaming).toBe(true);

    const afterAgentSettled = reduceSessionEvent(afterAssistantMessageEnd, {
      type: "agent_settled",
    } as AgentSessionEvent);
    expect(afterAgentSettled.isStreaming).toBe(false);
  });

  it("does not add direct bash execution output to the snapshot transcript", () => {
    const state = fromSnapshot({
      runtimeConfigurationGeneration: 0,
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready" } as never,
      subagents: [],
      messages: [
        {
          role: "bashExecution",
          command: "ls",
          output: "secretly duplicated output",
          exitCode: 0,
          cancelled: false,
          truncated: false,
        },
      ] as never,
    });

    expect(state.messages).toEqual([]);
    expect(state.tools).toEqual([]);
  });

  it("appends a message on message_start", () => {
    const running = reduceSessionEvent(emptyState, { type: "agent_start" } as AgentSessionEvent);
    const state = reduceSessionEvent(running, assistantEvent("message_start", ""));
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]!.role).toBe("assistant");
    expect(state.messages[0]!.streaming).toBe(true);
    expect(state.isStreaming).toBe(true);
  });

  it("ignores live bash execution messages", () => {
    const state = reduceSessionEvent(emptyState, {
      type: "message_start",
      message: {
        role: "bashExecution",
        command: "ls",
        output: "secretly duplicated output",
        exitCode: 0,
        cancelled: false,
        truncated: false,
      },
    } as never);

    expect(state.messages).toEqual([]);
    expect(state.isStreaming).toBe(false);
  });

  it("ignores live toolResult message_start instead of rendering a system bubble", () => {
    const state = reduceSessionEvent(emptyState, {
      type: "message_start",
      message: {
        role: "toolResult",
        toolCallId: "t1",
        toolName: "bash",
        content: [{ type: "text", text: "secretly duplicated output" }],
        isError: false,
        timestamp: 123,
      },
    } as never);

    expect(state.messages).toEqual([]);
    expect(state.tools).toEqual([]);
    expect(state.isStreaming).toBe(false);
  });

  it("updates the streaming message in place per token delta", () => {
    const started = reduceSessionEvent(emptyState, assistantEvent("message_start", ""));
    const first = reduceSessionEvent(started, assistantEvent("message_update", "two "));
    const second = reduceSessionEvent(first, assistantEvent("message_update", "deltas"));
    expect(second.messages).toHaveLength(1);
    expect(second.messages[0]!.text).toBe("two deltas");
  });

  it("tracks live thinking until thinking ends and keeps text deltas on the same assistant row", () => {
    let state = reduceSessionEvent(emptyState, assistantEvent("message_start", ""));
    state = reduceSessionEvent(state, {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
    } as never);
    expect(state.messages[0]!.isThinking).toBe(true);
    state = reduceSessionEvent(state, {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "first " },
    } as never);
    state = reduceSessionEvent(state, {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "second" },
    } as never);
    state = reduceSessionEvent(state, {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "first second" },
    } as never);

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]!.reasoning).toBe("first second");
    expect(state.messages[0]!.isThinking).toBe(false);

    state = reduceSessionEvent(state, assistantEvent("message_update", "answer"));
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]!.text).toBe("answer");
    expect(state.messages[0]!.reasoning).toBe("first second");
    expect(state.messages[0]!.isThinking).toBe(false);
  });

  it("reconciles a thinking and tool-call message without retaining the live placeholder body", () => {
    let state = reduceSessionEvent(emptyState, {
      type: "message_start",
      message: { id: "m1", role: "assistant", content: [] },
    } as never);
    state = reduceSessionEvent(state, {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
    } as never);
    state = reduceSessionEvent(state, {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "inspect first" },
    } as never);
    state = reduceSessionEvent(state, {
      type: "message_end",
      message: {
        id: "m1",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "inspect first" },
          { type: "toolCall", id: "t1", name: "bash", arguments: { command: "pwd" } },
        ],
      },
    } as never);
    state = reduceSessionEvent(state, {
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "bash",
      args: { command: "pwd" },
    } as never);

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ text: "", reasoning: "inspect first", streaming: false });
    expect(state.tools).toHaveLength(1);
    expect(state.messages[0]!.order).toBeLessThan(state.tools[0]!.order);
  });

  it("removes the temporary assistant row when the final message contains only a tool call", () => {
    let state = reduceSessionEvent(emptyState, {
      type: "message_start",
      message: { id: "m1", role: "assistant", content: [] },
    } as never);
    state = reduceSessionEvent(state, {
      type: "message_end",
      message: {
        id: "m1",
        role: "assistant",
        content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "pwd" } }],
      },
    } as never);

    expect(state.messages).toEqual([]);
  });

  it("clears active thinking when text output starts or the agent settles", () => {
    let state = reduceSessionEvent(emptyState, assistantEvent("message_start", ""));
    state = reduceSessionEvent(state, {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "working" },
    } as never);
    expect(state.messages[0]!.isThinking).toBe(true);

    state = reduceSessionEvent(state, assistantEvent("message_update", "answer"));
    expect(state.messages[0]!.isThinking).toBe(false);

    state = reduceSessionEvent(state, {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "more" },
    } as never);
    expect(state.messages[0]!.isThinking).toBe(true);

    state = reduceSessionEvent(state, { type: "agent_settled" } as AgentSessionEvent);
    expect(state.messages[0]!.isThinking).toBe(false);
  });

  it("clears active thinking when the text block starts before its first token", () => {
    let state = reduceSessionEvent(emptyState, assistantEvent("message_start", ""));
    state = reduceSessionEvent(state, {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "working" },
    } as never);

    state = reduceSessionEvent(state, {
      type: "message_update",
      assistantMessageEvent: { type: "text_start", contentIndex: 1 },
    } as never);

    expect(state.messages[0]!.isThinking).toBe(false);
    expect(state.messages[0]!.text).toBe("");
  });

  it("keeps the text-only placeholder through text start and replaces it with the first delta", () => {
    let state = reduceSessionEvent(emptyState, assistantEvent("message_start", ""));
    const key = state.messages[0]!.key;
    expect(state.messages[0]!.text).toBe("...");

    state = reduceSessionEvent(state, {
      type: "message_update",
      assistantMessageEvent: { type: "text_start", contentIndex: 0 },
    } as never);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ key, text: "...", streaming: true, isThinking: false });

    state = reduceSessionEvent(state, assistantEvent("message_update", "answer"));
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ key, text: "answer", streaming: true, isThinking: false });
  });

  it("ignores empty text deltas without ending active thinking", () => {
    let state = reduceSessionEvent(emptyState, assistantEvent("message_start", ""));
    state = reduceSessionEvent(state, {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "working" },
    } as never);

    state = reduceSessionEvent(state, assistantEvent("message_update", ""));

    expect(state.messages[0]!.isThinking).toBe(true);
    expect(state.messages[0]!.text).toBe("");
  });

  it("clears active thinking when the assistant message ends", () => {
    let state = reduceSessionEvent(emptyState, assistantEvent("message_start", ""));
    state = reduceSessionEvent(state, {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "working" },
    } as never);

    state = reduceSessionEvent(state, assistantEvent("message_end", ""));

    expect(state.messages[0]!.isThinking).toBe(false);
  });

  it("handles agent_settled by clearing streaming state", () => {
    const started = reduceSessionEvent(emptyState, assistantEvent("message_start", ""));
    const settled = reduceSessionEvent(started, { type: "agent_settled" } as AgentSessionEvent);
    expect(settled.isStreaming).toBe(false);
    expect(settled.messages[0]!.streaming).toBe(false);
  });

  it.each([
    ["agent_settled", (state: SessionViewState) => reduceSessionEvent(state, { type: "agent_settled" } as never)],
    ["terminal helper", (state: SessionViewState) => terminateSessionRun(state)],
  ])("settles root tools but preserves supervised work through %s", (_name, terminate) => {
    let state = reduceSessionEvent(emptyState, { type: "agent_start" } as AgentSessionEvent);
    state = reduceSessionEvent(state, assistantEvent("message_start", "partial"));
    state = reduceSessionEvent(state, {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "working" },
    } as never);
    state = reduceSessionEvent(state, toolEvent("tool_execution_start", "generic", "bash"));
    state = reduceSessionEvent(state, {
      type: "tool_execution_update",
      toolCallId: "generic",
      partialResult: { content: [{ type: "text", text: "partial output" }] },
    } as never);
    state = reduceSessionEvent(state, toolEvent("tool_execution_start", "child", "subagent"));
    state = reduceSessionEvent(state, launchToolEnd({ toolCallId: "child" }, "child"));

    const terminated = terminate(state);

    expect(terminated).toMatchObject({ isStreaming: false, activeMessageKey: undefined });
    expect(terminated.messages[0]).toMatchObject({ streaming: false, isThinking: false });
    expect(terminated.tools).toEqual([
      expect.objectContaining({
        key: "generic",
        running: false,
        done: false,
        error: false,
        output: "partial output",
      }),
      expect.objectContaining({
        key: "child",
        supervised: true,
        running: true,
        done: false,
        error: false,
      }),
    ]);
  });

  it("adds a tool block on start and marks it done on end", () => {
    const active = reduceSessionEvent(emptyState, toolEvent("tool_execution_start", "t1", "bash"));
    expect(active.tools).toHaveLength(1);
    expect(active.tools[0]).toMatchObject({ key: "t1", name: "bash", running: true, done: false });
    const done = reduceSessionEvent(active, toolEvent("tool_execution_end", "t1", "bash"));
    expect(done.tools[0]).toMatchObject({ running: false, done: true, error: false });
  });

  it("marks a failing tool with its error flag and keeps other tools intact", () => {
    const first = reduceSessionEvent(emptyState, toolEvent("tool_execution_start", "t1", "bash"));
    const second = reduceSessionEvent(first, toolEvent("tool_execution_start", "t2", "grep"));
    const failed = reduceSessionEvent(second, {
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "bash",
      result: "nope",
      isError: true,
    } as never);
    expect(failed.tools).toHaveLength(2);
    expect(failed.tools[0]).toMatchObject({ error: true, done: true });
    expect(failed.tools[1]).toMatchObject({ name: "grep", running: true });
  });

  describe("supervised background lifecycle", () => {
    function launchedState(toolCallId = "t1", overrides: Partial<SubagentSupervisorEventDto> = {}) {
      const started = reduceSessionEvent(emptyState, {
        type: "tool_execution_start",
        toolCallId,
        toolName: "subagent",
        args: { agent: "search", task: "collect" },
      } as never);
      return reduceSessionEvent(started, launchToolEnd(overrides, toolCallId));
    }

    it("keeps a successful subagent launch acknowledgement background-working", () => {
      const ended = launchedState();

      expect(ended.tools[0]).toMatchObject({
        supervised: true,
        running: true,
        done: false,
        error: false,
        ownerSessionId: "root",
        launchId: "launch-0",
        agentId: "search_0",
        sessionId: "child-0",
      });
      expect(ended.tools[0]?.latestMessage).toBeUndefined();
    });

    it("keeps a pre-launch subagent tool error terminal", () => {
      const started = reduceSessionEvent(emptyState, toolEvent("tool_execution_start", "t1", "subagent"));
      const failed = reduceSessionEvent(started, {
        type: "tool_execution_end",
        toolCallId: "t1",
        toolName: "subagent",
        isError: true,
        result: { content: [{ type: "text", text: "launch failed" }] },
      } as never);

      expect(failed.tools[0]).toMatchObject({ running: false, done: true, error: true });
      expect(failed.tools[0]?.supervised).toBeUndefined();
      expect(failed.tools[0]?.latestMessage).toBe("launch failed");
    });

    it("scopes same-role jobs by owner and tool call", () => {
      let state = launchedState("t0", {
        launchId: "launch-0",
        agentId: "search_0",
        childSessionId: "child-0",
      });
      state = reduceSessionEvent(state, {
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: "subagent",
        args: { agent: "search", task: "collect more" },
      } as never);
      state = reduceSessionEvent(
        state,
        launchToolEnd({ launchId: "launch-1", agentId: "search_1", childSessionId: "child-1" }, "t1"),
      );

      const wrongOwner = reduceSubagentSupervisorEvent(
        state,
        supervisorEvent({ ownerSessionId: "nested-owner", toolCallId: "t0", status: "complete" }),
      );
      expect(wrongOwner).toBe(state);

      const complete = reduceSubagentSupervisorEvent(
        state,
        supervisorEvent({ toolCallId: "t0", status: "complete", latestMessage: "first done" }),
      );
      expect(complete.tools.find((tool) => tool.toolCallId === "t0")).toMatchObject({
        running: false,
        done: true,
        error: false,
        latestMessage: "first done",
      });
      expect(complete.tools.find((tool) => tool.toolCallId === "t1")).toMatchObject({
        running: true,
        done: false,
        agentId: "search_1",
      });
    });

    it("absorbs stale Working after a terminal event", () => {
      const complete = reduceSubagentSupervisorEvent(
        launchedState(),
        supervisorEvent({ status: "complete", latestMessage: "authoritative handoff" }),
      );
      const stale = reduceSubagentSupervisorEvent(
        complete,
        supervisorEvent({ status: "working", latestMessage: "stale progress" }),
      );

      expect(stale).toBe(complete);
      expect(stale.tools[0]).toMatchObject({
        running: false,
        done: true,
        error: false,
        latestMessage: "authoritative handoff",
      });
    });

    it("absorbs a launch acknowledgement that arrives after the terminal supervisor frame", () => {
      const started = reduceSessionEvent(emptyState, {
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: "subagent",
        args: { agent: "search", task: "collect" },
      } as never);
      const completed = reduceSubagentSupervisorEvent(
        started,
        supervisorEvent({ status: "complete", latestMessage: "fast result" }),
      );

      expect(completed.tools[0]).toMatchObject({
        supervised: true,
        running: false,
        done: true,
        latestMessage: "fast result",
      });

      const acknowledged = reduceSessionEvent(completed, launchToolEnd());
      expect(acknowledged.tools[0]).toMatchObject({
        supervised: true,
        running: false,
        done: true,
        latestMessage: "fast result",
      });
    });

    it("marks Error terminal and prefers terminal text over stale activity", () => {
      const launched = launchedState();
      const withActivity: SessionViewState = {
        ...launched,
        tools: launched.tools.map((tool) => ({
          ...tool,
          latestMessage: "stale progress",
          latestActivity: { kind: "tool" as const, name: "bash", state: "running" as const },
        })),
      };
      const failed = reduceSubagentSupervisorEvent(
        withActivity,
        supervisorEvent({ status: "error", latestMessage: "full terminal error" }),
      );

      expect(failed.tools[0]).toMatchObject({
        running: false,
        done: true,
        error: true,
        latestMessage: "full terminal error",
      });
      expect(failed.tools[0]?.latestActivity).toBeUndefined();
    });

    it("preserves unfinished supervised work when the parent settles", () => {
      const launched = { ...launchedState(), isStreaming: true };
      const settled = reduceSessionEvent(launched, { type: "agent_settled" } as never);

      expect(settled.isStreaming).toBe(false);
      expect(settled.tools[0]).toMatchObject({ supervised: true, running: true, done: false });
    });

    it("restores a Working card from a ready reconnect summary", () => {
      const state = fromSnapshot({
        runtimeConfigurationGeneration: 0,
        session: { id: "root", cwd: "/p", isStreaming: false, status: "ready" },
        messages: [
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "t1", name: "subagent", arguments: { agent: "search" } }],
          },
          {
            role: "toolResult",
            toolCallId: "t1",
            toolName: "subagent",
            content: [{ type: "text", text: "search_0 is working." }],
            isError: false,
          },
        ] as never,
        subagents: [
          {
            launchId: "launch-0",
            ownerSessionId: "root",
            toolCallId: "t1",
            agent: "search",
            agentId: "search_0",
            childSessionId: "child-0",
            status: "working",
            latestMessage: "collecting papers",
          },
        ],
      });

      expect(state.isStreaming).toBe(false);
      expect(state.tools[0]).toMatchObject({
        supervised: true,
        running: true,
        done: false,
        ownerSessionId: "root",
        launchId: "launch-0",
        agentId: "search_0",
        sessionId: "child-0",
        latestMessage: "collecting papers",
      });
    });

    it("does not reduce a nested child event into the owner transcript", () => {
      const state = launchedState();
      const updated = reduceSubagentSupervisorEvent(
        state,
        supervisorEvent({
          event: {
            type: "message_start",
            message: { role: "assistant", content: [{ type: "text", text: "child text" }] },
          } as never,
        }),
      );

      expect(updated.messages).toEqual([]);
      expect(updated.tools[0]).toMatchObject({ running: true, done: false });
      expect(updated.tools[0]?.latestActivity).toEqual({ kind: "text", text: "child text" });
    });
  });

  it("surfaces an assistant error message", () => {
    const started = reduceSessionEvent(emptyState, {
      type: "message_start",
      message: { role: "assistant", content: [], errorMessage: "provider down" },
    } as unknown as AgentSessionEvent);
    expect(started.messages[0]!.error).toBe(true);
    expect(started.messages[0]!.text).toContain("provider down");
  });

  it("keeps the error body when an assistant failure also contains reasoning", () => {
    const message = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "diagnosing request" }],
      errorMessage: "provider down",
    };
    const live = reduceSessionEvent(emptyState, {
      type: "message_start",
      message,
    } as unknown as AgentSessionEvent);
    const persisted = fromSnapshot({
      runtimeConfigurationGeneration: 0,
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "error" },
      subagents: [],
      messages: [message],
    } as never);

    for (const state of [live, persisted]) {
      expect(state.messages[0]).toMatchObject({
        text: "⚠ provider down",
        reasoning: "diagnosing request",
        error: true,
      });
    }
  });

  it("flags the run error on the session state and clears it on settle", () => {
    const started = reduceSessionEvent(emptyState, {
      type: "message_start",
      message: { role: "assistant", content: [], errorMessage: "provider down" },
    } as unknown as AgentSessionEvent);
    expect(started.error).toBe("provider down");
    const settled = reduceSessionEvent(started, { type: "agent_settled" } as unknown as AgentSessionEvent);
    expect(settled.error).toBeNull();
    const ok = reduceSessionEvent(emptyState, assistantEvent("message_start", ""));
    expect(ok.error).toBeNull();
  });

  it("appends consecutive identical token deltas without dropping text", () => {
    const started = reduceSessionEvent(emptyState, assistantEvent("message_start", ""));
    const once = reduceSessionEvent(started, assistantEvent("message_update", "same"));
    const twice = reduceSessionEvent(once, assistantEvent("message_update", "same"));
    expect(twice.messages).toHaveLength(1);
    expect(twice.messages[0]!.text).toBe("samesame");
  });

  it("keeps user messages distinct from assistant streaming", () => {
    const withUser = reduceSessionEvent(emptyState, {
      type: "message_start",
      message: userMessage("question"),
    } as AgentSessionEvent);
    const streaming = reduceSessionEvent(withUser, assistantEvent("message_start", ""));
    expect(streaming.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(streaming.messages[0]!.streaming).toBe(false);
  });

  it("splits thinking blocks into reasoning, keeping the body text", () => {
    const state = fromSnapshot({
      runtimeConfigurationGeneration: 0,
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "done" } as never,
      subagents: [],
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "let me think hard", thinkingSignature: "reasoning" },
            { type: "text", text: "here is the answer" },
          ],
        },
      ] as never,
    });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]!.reasoning).toBe("let me think hard");
    expect(state.messages[0]!.text).toBe("here is the answer");
    expect(state.messages[0]!.isThinking).toBe(false);
  });

  it("captures tool args on start and output on end", () => {
    const active = reduceSessionEvent(emptyState, {
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "bash",
      args: { command: "ls -la" },
    } as never);
    expect(active.tools[0]).toMatchObject({ args: "ls -la" });
    const done = reduceSessionEvent(active, {
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "bash",
      result: { output: "total 8" },
    } as never);
    expect(done.tools[0]).toMatchObject({ output: "total 8", done: true });
  });

  it("derives a skill name when a read tool loads a SKILL.md file", () => {
    const active = reduceSessionEvent(emptyState, {
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "read",
      args: { path: "/home/me/.config/opencode/skills/arxiv/SKILL.md" },
    } as never);
    expect(active.tools[0]).toMatchObject({
      name: "read",
      args: "/home/me/.config/opencode/skills/arxiv/SKILL.md",
      skillName: "arxiv",
    });

    const relative = reduceSessionEvent(emptyState, {
      type: "tool_execution_start",
      toolCallId: "t2",
      toolName: "read",
      args: { path: "skills/latex-pdf/SKILL.md" },
    } as never);
    expect(relative.tools[0]!.skillName).toBe("latex-pdf");

    const plain = reduceSessionEvent(emptyState, {
      type: "tool_execution_start",
      toolCallId: "t3",
      toolName: "read",
      args: { path: "src/webui/App.tsx" },
    } as never);
    expect(plain.tools[0]!.skillName).toBeUndefined();
  });

  it("derives a skill name from a Windows SKILL.md path", () => {
    const active = reduceSessionEvent(emptyState, {
      type: "tool_execution_start",
      toolCallId: "t-win",
      toolName: "read",
      args: { path: String.raw`D:\project\.easyresearch\skills\arxiv\SKILL.md` },
    } as never);

    expect(active.tools[0]!.skillName).toBe("arxiv");
  });

  it("restores a skill name from a snapshot read tool call", () => {
    const state = fromSnapshot({
      runtimeConfigurationGeneration: 0,
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "done" } as never,
      subagents: [],
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "skills/drawio/SKILL.md" } }],
        },
      ] as never,
    });
    expect(state.tools[0]).toMatchObject({ name: "read", skillName: "drawio" });
  });

  it("shows textual partial content from generic tool updates", () => {
    const active = reduceSessionEvent(emptyState, toolEvent("tool_execution_start", "t1", "bash"));
    const updated = reduceSessionEvent(active, {
      type: "tool_execution_update",
      toolCallId: "t1",
      toolName: "bash",
      partialResult: { content: [{ type: "text", text: "partial" }] },
    } as never);

    expect(updated.tools[0]!.output).toBe("partial");
  });

  it("ignores retired subagent tool-update details", () => {
    const active = reduceSessionEvent(emptyState, {
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "subagent",
      args: { agent: "search" },
    } as never);
    const updated = reduceSessionEvent(active, {
      type: "tool_execution_update",
      toolCallId: "t1",
      partialResult: {
        details: {
          subagent: {
            agent: "writing",
            sessionId: "retired-child",
            latestMessage: "retired transport",
          },
        },
      },
    } as never);

    expect(updated).toBe(active);
  });

  it("unwraps Pi content from a completed generic tool result", () => {
    const active = reduceSessionEvent(emptyState, toolEvent("tool_execution_start", "t1", "bash"));
    const done = reduceSessionEvent(active, {
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "final" }], details: { opaque: true } },
    } as never);

    expect(done.tools[0]!.output).toBe("final");
  });

  it("caps generic completed output at its presentation limit", () => {
    const longOutput = "g".repeat(2_500);
    const active = reduceSessionEvent(emptyState, toolEvent("tool_execution_start", "t1", "bash"));
    const done = reduceSessionEvent(active, {
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "bash",
      result: { content: [{ type: "text", text: longOutput }] },
    } as never);

    expect(done.tools[0]!.output).toMatch(/^g+/);
    expect(done.tools[0]!.output!.length).toBeLessThanOrEqual(2_000);
    expect(done.tools[0]!.output).toMatch(/…$/);
  });

  it("keeps a completed subagent latest message unbounded", () => {
    const latestMessage = "s".repeat(2_500);
    const active = reduceSessionEvent(emptyState, toolEvent("tool_execution_start", "t1", "subagent"));
    const done = reduceSessionEvent(active, {
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "subagent",
      result: { content: [{ type: "text", text: latestMessage }], details: { opaque: true } },
    } as never);

    expect(done.tools[0]!.latestMessage).toBe(latestMessage);
  });

  it("pairs snapshot toolCall blocks with toolResult messages", () => {
    const state = fromSnapshot({
      runtimeConfigurationGeneration: 0,
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "done" } as never,
      subagents: [],
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "tc-1", name: "bash", arguments: '{"command":"ls"}' }],
        },
        {
          role: "toolResult",
          toolCallId: "tc-1",
          toolName: "bash",
          content: [{ type: "text", text: "file.txt" }],
          isError: false,
        },
      ] as never,
    });
    expect(state.messages).toHaveLength(0);
    expect(state.tools).toHaveLength(1);
    expect(state.tools[0]).toMatchObject({ key: "tc-1", name: "bash", done: true, error: false });
    expect(state.tools[0]!.output).toBe("file.txt");
  });

  it("unwraps text-block arrays from toolResult content", () => {
    const state = fromSnapshot({
      runtimeConfigurationGeneration: 0,
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "done" } as never,
      subagents: [],
      messages: [
        {
          role: "toolResult",
          toolCallId: "tc-9",
          toolName: "bash",
          content: [{ type: "text", text: "总计 4\nnotes" }],
          isError: false,
        },
      ] as never,
    });
    expect(state.tools[0]).toMatchObject({ key: "tc-9", output: "总计 4\nnotes" });
  });

  it("keeps snapshot subagent latest messages unbounded while capping generic output", () => {
    const latestMessage = "s".repeat(2_500);
    const genericOutput = "g".repeat(2_500);
    const state = fromSnapshot({
      runtimeConfigurationGeneration: 0,
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "done" } as never,
      subagents: [],
      messages: [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "sub-1", name: "subagent", arguments: '{"agent":"writing"}' },
            { type: "toolCall", id: "bash-1", name: "bash", arguments: '{"command":"run"}' },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "sub-1",
          toolName: "subagent",
          content: [{ type: "text", text: latestMessage }],
          isError: false,
        },
        {
          role: "toolResult",
          toolCallId: "bash-1",
          toolName: "bash",
          content: [{ type: "text", text: genericOutput }],
          isError: false,
        },
      ] as never,
    });

    expect(state.tools.find((tool) => tool.key === "sub-1")!.latestMessage).toBe(latestMessage);
    expect(state.tools.find((tool) => tool.key === "bash-1")!.output!.length).toBeLessThanOrEqual(2_000);
    expect(state.tools.find((tool) => tool.key === "bash-1")!.output).toMatch(/…$/);
  });

  it("does not treat whitespace-only snapshot subagent output as a latest message", () => {
    const state = fromSnapshot({
      runtimeConfigurationGeneration: 0,
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "done" } as never,
      subagents: [],
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "sub-space", name: "subagent", arguments: '{"agent":"search"}' }],
        },
        {
          role: "toolResult",
          toolCallId: "sub-space",
          toolName: "subagent",
          content: [{ type: "text", text: " \n\t " }],
          isError: true,
        },
      ] as never,
    });

    expect(state.tools[0]).toMatchObject({ running: false, done: true, error: true });
    expect(state.tools[0]!.latestMessage).toBeUndefined();
  });

  it("orders tools at their stream position, interleaving with messages", () => {
    const state = fromSnapshot({
      runtimeConfigurationGeneration: 0,
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "done" } as never,
      subagents: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "go" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "about to run" },
            { type: "toolCall", id: "tc-1", name: "bash", arguments: '{"command":"ls"}' },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "tc-1",
          toolName: "bash",
          content: [{ type: "text", text: "file.txt" }],
          isError: false,
        },
        { role: "assistant", content: [{ type: "text", text: "done" }] },
      ] as never,
    });
    const order = (m: { order: number }) => m.order;
    const merged = [...state.messages, ...state.tools].sort((a, b) => a.order - b.order);
    expect(merged.map((e) => ("role" in e ? e.role : "tool"))).toEqual(["user", "assistant", "tool", "assistant"]);
    const messageOrders = state.messages.map(order);
    const toolOrders = state.tools.map(order);
    expect(new Set(messageOrders).size).toBe(messageOrders.length);
    expect(new Set(toolOrders).size).toBe(toolOrders.length);
    expect(messageOrders.every((o, i) => i === 0 || o > messageOrders[i - 1]!)).toBe(true);
  });

  it("labels a subagent-line dispatch as assistant, not the user", () => {
    const state = fromSnapshot({
      runtimeConfigurationGeneration: 0,
      session: { id: "s2", cwd: "/p", sessionName: "easyresearch:search", isStreaming: false, status: "done" } as never,
      subagents: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "Task: search papers" }] },
        { role: "assistant", content: [{ type: "text", text: "found 3 papers" }] },
      ] as never,
    });
    expect(state.subagentName).toBe("search");
    expect(state.messages[0]).toMatchObject({ role: "user", label: "research-assistant" });
    expect(state.messages[1]).toMatchObject({ role: "assistant", label: "search" });
  });

  it("keeps plain sessions user-labeled and unlabeled assistants", () => {
    const state = fromSnapshot({
      runtimeConfigurationGeneration: 0,
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "done" } as never,
      subagents: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
      ] as never,
    });
    expect(state.subagentName).toBeUndefined();
    expect(state.messages[0]!.label).toBeUndefined();
    expect(state.messages[1]!.label).toBeUndefined();
  });

  it("assigns stream positions to live tools between messages", () => {
    let state = reduceSessionEvent(emptyState, {
      type: "message_start",
      message: userMessage("go"),
    } as AgentSessionEvent);
    state = reduceSessionEvent(state, assistantEvent("message_start", "running"));
    state = reduceSessionEvent(state, toolEvent("tool_execution_start", "t1", "bash"));
    const final = reduceSessionEvent(state, assistantEvent("message_start", "done"));
    expect(final.messages.map((m) => m.order)).toEqual([0, 1, 3]);
    expect(final.tools.map((t) => t.order)).toEqual([2]);
  });

  it("captures the agent name from single-mode subagent args", () => {
    const state = reduceSessionEvent(emptyState, {
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "subagent",
      args: { agent: "search", task: "find papers" },
    } as never);
    expect(state.tools[0]).toMatchObject({ agentName: "search" });
  });

  it("captures the first agent name from chain-mode subagent args", () => {
    const state = reduceSessionEvent(emptyState, {
      type: "tool_execution_start",
      toolCallId: "t2",
      toolName: "subagent",
      args: {
        chain: [
          { agent: "search", task: "first" },
          { agent: "writing", task: "then" },
        ],
      },
    } as never);
    expect(state.tools[0]).toMatchObject({ agentName: "search" });
  });

  it("captures the agent name from snapshot subagent toolCall blocks (JSON-string args)", () => {
    const state = fromSnapshot({
      runtimeConfigurationGeneration: 0,
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "done" } as never,
      subagents: [],
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "tc-1", name: "subagent", arguments: '{"agent":"figures","task":"draw"}' }],
        },
      ] as never,
    });
    expect(state.tools[0]).toMatchObject({ name: "subagent", agentName: "figures" });
  });

  it("applies persisted child summaries to the exact parent tool invocation", () => {
    const state = fromSnapshot({
      runtimeConfigurationGeneration: 0,
      session: { id: "parent", cwd: "/p", isStreaming: false, status: "ready" } as never,
      subagents: [
        {
          ownerSessionId: "parent",
          toolCallId: "sub-linked",
          childSessionId: "child-uuid",
          agent: "writing",
          status: "complete",
          step: 2,
          latestMessage: "historical progress",
        },
      ],
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "sub-linked", name: "subagent", arguments: '{"agent":"search"}' }],
        },
      ] as never,
    });

    expect(state.tools[0]).toMatchObject({
      key: "sub-linked",
      agentName: "writing",
      step: 2,
      sessionId: "child-uuid",
      latestMessage: "historical progress",
    });
  });

  it("preserves every historical chain-step mapping on one parent tool row", () => {
    const state = fromSnapshot({
      runtimeConfigurationGeneration: 0,
      session: { id: "parent", cwd: "/p", isStreaming: false, status: "ready" } as never,
      subagents: [
        {
          ownerSessionId: "parent",
          toolCallId: "chain-linked",
          childSessionId: "child-search",
          agent: "search",
          status: "complete",
          step: 1,
        },
        {
          ownerSessionId: "parent",
          toolCallId: "chain-linked",
          childSessionId: "child-writing",
          agent: "writing",
          status: "complete",
          step: 2,
        },
      ],
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "chain-linked", name: "subagent", arguments: '{"chain":[]}' }],
        },
      ] as never,
    });

    expect(state.tools[0]).toMatchObject({
      agentName: "writing",
      step: 2,
      sessionId: "child-writing",
      sessionLinks: [
        { toolCallId: "chain-linked", childSessionId: "child-search", agent: "search", step: 1 },
        { toolCallId: "chain-linked", childSessionId: "child-writing", agent: "writing", step: 2 },
      ],
    });
  });

  it("lets an authoritative snapshot summary replace prior live chain agent and step", () => {
    const prior: SessionViewState = {
      ...emptyState,
      tools: [
        {
          key: "chain-call",
          toolCallId: "chain-call",
          name: "subagent",
          running: true,
          done: false,
          error: false,
          agentName: "search",
          step: 1,
          latestMessage: "live progress",
          order: 0,
        },
      ],
      nextOrder: 1,
    };
    const snapshot = {
      runtimeConfigurationGeneration: 0,
      session: { id: "parent", cwd: "/p", isStreaming: true, status: "running" },
      subagents: [
        {
          ownerSessionId: "parent",
          toolCallId: "chain-call",
          childSessionId: "child-writing",
          agent: "writing",
          status: "complete",
          step: 2,
        },
      ],
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "chain-call", name: "subagent", arguments: '{"agent":"search"}' }],
        },
      ],
    } as never;

    expect(mergeSnapshot(prior, snapshot).tools[0]).toMatchObject({
      agentName: "writing",
      step: 2,
      sessionId: "child-writing",
    });
    expect(mergeSnapshot(prior, snapshot).tools[0]!.latestMessage).toBeUndefined();
  });

  it("does not carry child metadata across incompatible chain steps", () => {
    const prior: SessionViewState = {
      ...emptyState,
      tools: [
        {
          key: "chain-call",
          toolCallId: "chain-call",
          name: "subagent",
          running: true,
          done: false,
          error: false,
          agentName: "search",
          step: 1,
          sessionId: "child-search",
          latestMessage: "search output",
          sessionLinks: [
            {
              ownerSessionId: "parent",
              toolCallId: "chain-call",
              childSessionId: "child-search",
              agent: "search",
              status: "complete",
              step: 1,
            },
          ],
          order: 0,
        },
      ],
      nextOrder: 1,
    };
    const snapshot = {
      runtimeConfigurationGeneration: 0,
      session: { id: "parent", cwd: "/p", isStreaming: true, status: "running" },
      subagents: [
        {
          ownerSessionId: "parent",
          toolCallId: "chain-call",
          childSessionId: "child-writing",
          agent: "writing",
          status: "complete",
          step: 2,
        },
      ],
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "chain-call", name: "subagent", arguments: '{"chain":[]}' }],
        },
      ],
    } as never;

    const merged = mergeSnapshot(prior, snapshot).tools[0]!;

    expect(merged).toMatchObject({ step: 2, sessionId: "child-writing", agentName: "writing" });
    expect(merged.latestMessage).toBeUndefined();
  });

  it("preserves prior live chain agent and step when the snapshot has no summary", () => {
    const prior: SessionViewState = {
      ...emptyState,
      tools: [
        {
          key: "chain-call",
          toolCallId: "chain-call",
          name: "subagent",
          running: true,
          done: false,
          error: false,
          agentName: "writing",
          step: 2,
          order: 0,
        },
      ],
      nextOrder: 1,
    };
    const snapshot = {
      runtimeConfigurationGeneration: 0,
      session: { id: "parent", cwd: "/p", isStreaming: true, status: "running" },
      subagents: [],
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "chain-call", name: "subagent", arguments: '{"agent":"search"}' }],
        },
      ],
    } as never;

    expect(mergeSnapshot(prior, snapshot).tools[0]).toMatchObject({ agentName: "writing", step: 2 });
  });

  it("preserves live supervised progress when a reconnect snapshot has no supervisor summary", () => {
    const prior: SessionViewState = {
      ...emptyState,
      tools: [
        {
          key: "sub-live",
          toolCallId: "sub-live",
          name: "subagent",
          ownerSessionId: "parent",
          launchId: "launch-live",
          agentId: "writing_0",
          supervised: true,
          running: true,
          done: false,
          error: false,
          agentName: "writing",
          sessionId: "child-live",
          latestMessage: "usable live progress",
          latestActivity: { kind: "text", text: "newest child delta" },
          order: 0,
        },
      ],
      nextOrder: 1,
    };
    const snapshot = {
      runtimeConfigurationGeneration: 0,
      session: { id: "parent", cwd: "/p", isStreaming: false, status: "ready" },
      subagents: [],
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "sub-live", name: "subagent", arguments: '{"agent":"writing"}' }],
        },
        {
          role: "toolResult",
          toolCallId: "sub-live",
          toolName: "subagent",
          content: [{ type: "text", text: " \n\t " }],
          isError: true,
        },
      ],
    } as never;

    expect(mergeSnapshot(prior, snapshot).tools[0]).toMatchObject({
      supervised: true,
      running: true,
      done: false,
      error: false,
      latestMessage: "usable live progress",
      latestActivity: { kind: "text", text: "newest child delta" },
    });
  });

  it("does not enrich an id-less snapshot subagent tool from a colliding fallback key", () => {
    const prior: SessionViewState = {
      ...emptyState,
      tools: [
        {
          key: "subagent",
          toolCallId: "subagent",
          name: "subagent",
          running: true,
          done: false,
          error: false,
          agentName: "writing",
          step: 2,
          sessionId: "child-writing",
          latestMessage: "prior metadata",
          order: 0,
        },
      ],
      nextOrder: 1,
    };
    const snapshot = {
      runtimeConfigurationGeneration: 0,
      session: { id: "parent", cwd: "/p", isStreaming: true, status: "running" },
      subagents: [
        {
          ownerSessionId: "parent",
          toolCallId: "subagent",
          childSessionId: "child-summary",
          agent: "figures",
          status: "complete",
          step: 3,
          latestMessage: "persisted metadata",
        },
      ],
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", name: "subagent", arguments: '{"agent":"search"}' }],
        },
      ],
    } as never;

    const merged = mergeSnapshot(prior, snapshot).tools[0]!;

    expect(merged).toMatchObject({ key: "subagent", agentName: "search" });
    expect(merged.toolCallId).toBeUndefined();
    expect(merged.step).toBeUndefined();
    expect(merged.sessionId).toBeUndefined();
    expect(merged.latestMessage).toBeUndefined();
  });

  it("discards prior ordinary messages and generic tools absent from the reconnect snapshot", () => {
    let prior = reduceSessionEvent(emptyState, {
      type: "message_start",
      message: userMessage("repeat"),
    } as AgentSessionEvent);
    prior = reduceSessionEvent(prior, {
      type: "message_start",
      message: userMessage("repeat"),
    } as AgentSessionEvent);
    prior = reduceSessionEvent(prior, assistantEvent("message_start", "Plan A"));
    prior = reduceSessionEvent(prior, toolEvent("tool_execution_start", "live-tool", "bash"));
    const snapshot = {
      runtimeConfigurationGeneration: 0,
      session: { id: "parent", cwd: "/p", isStreaming: false, status: "ready" },
      subagents: [],
      messages: [userMessage("repeat"), assistantMessage("Plan")],
    } as never;

    const merged = mergeSnapshot(prior, snapshot);

    expect(merged.messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "repeat"],
      ["assistant", "Plan"],
    ]);
    expect(merged.tools).toEqual([]);
    expect(merged.activeMessageKey).toBeUndefined();
  });

  it("uses the running snapshot final assistant as the sole cursor for the next delta", () => {
    const snapshot = {
      runtimeConfigurationGeneration: 0,
      session: { id: "parent", cwd: "/p", isStreaming: true, status: "running" },
      subagents: [],
      messages: [assistantMessage("partial")],
    } as never;
    let prior = fromSnapshot(snapshot);
    prior = reduceSessionEvent(prior, assistantEvent("message_update", " answer"));

    const merged = mergeSnapshot(prior, snapshot);

    expect(merged.messages).toEqual([expect.objectContaining({ role: "assistant", text: "partial", streaming: true })]);
    expect(merged.activeMessageKey).toBe(merged.messages[0]!.key);
    expect(merged.messages.filter((message) => message.streaming)).toEqual([merged.messages[0]]);

    const updated = reduceSessionEvent(merged, assistantEvent("message_update", " continued"));
    expect(updated.messages).toEqual([expect.objectContaining({ text: "partial continued", streaming: true })]);
  });

  it("rehydrates unresolved tools as running only from a streaming snapshot", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc-1", name: "subagent", arguments: '{"agent":"writing"}' }],
      },
    ] as never;
    const streaming = fromSnapshot({
      runtimeConfigurationGeneration: 0,
      session: { id: "s1", cwd: "/p", isStreaming: true, status: "running" } as never,
      subagents: [],
      messages,
    });
    const settled = fromSnapshot({
      runtimeConfigurationGeneration: 0,
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "done" } as never,
      subagents: [],
      messages,
    });

    expect(streaming.tools[0]).toMatchObject({ running: true, done: false });
    expect(settled.tools[0]).toMatchObject({ running: false, done: false });
  });

  it("resolves message_update deltas by the message_start key, even without ids", () => {
    let state = reduceSessionEvent(emptyState, assistantEvent("message_start", ""));
    expect(state.activeMessageKey).toBe("0");
    state = reduceSessionEvent(state, assistantEvent("message_update", "one "));
    state = reduceSessionEvent(state, assistantEvent("message_update", "two"));
    expect(state.messages[0]!.text).toBe("one two");
    state = reduceSessionEvent(state, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "one two" }] },
    } as never);
    expect(state.activeMessageKey).toBeUndefined();
    expect(state.messages[0]!.streaming).toBe(false);
  });

  function retryStartEvent(overrides: Record<string, unknown> = {}): AgentSessionEvent {
    return {
      type: "auto_retry_start",
      attempt: 2,
      maxAttempts: 3,
      delayMs: 4000,
      errorMessage: "rate limit exceeded",
      ...overrides,
    } as AgentSessionEvent;
  }

  it("keeps the session name from a snapshot and updates it on session_info_changed", () => {
    const base = fromSnapshot({
      runtimeConfigurationGeneration: 0,
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready", sessionName: "Old name" },
      messages: [],
      subagents: [],
    } as never);
    expect(base.sessionName).toBe("Old name");

    const named = reduceSessionEvent(base, { type: "session_info_changed", name: "New name" } as never);
    expect(named.sessionName).toBe("New name");

    const cleared = reduceSessionEvent(named, { type: "session_info_changed", name: undefined } as never);
    expect(cleared.sessionName).toBeUndefined();
  });

  it("leaves the session name unset for unnamed snapshots", () => {
    const state = fromSnapshot({
      runtimeConfigurationGeneration: 0,
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready" },
      messages: [],
      subagents: [],
    } as never);
    expect(state.sessionName).toBeUndefined();
  });

  it("sets retry state on auto_retry_start", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const state = reduceSessionEvent(emptyState, retryStartEvent());
    expect(state.retry).toEqual({
      attempt: 2,
      maxAttempts: 3,
      errorMessage: "rate limit exceeded",
      endsAt: new Date("2026-01-01T00:00:00Z").getTime() + 4000,
    });
    vi.useRealTimers();
  });

  it("overwrites retry state on a consecutive auto_retry_start", () => {
    const first = reduceSessionEvent(emptyState, retryStartEvent());
    const second = reduceSessionEvent(first, retryStartEvent({ attempt: 3, delayMs: 8000 }));
    expect(second.retry).toMatchObject({ attempt: 3, maxAttempts: 3 });
    expect(second.retry?.endsAt).toBeGreaterThan(first.retry?.endsAt ?? 0);
  });

  it("normalizes malformed auto_retry_start payloads", () => {
    const state = reduceSessionEvent(emptyState, { type: "auto_retry_start" } as AgentSessionEvent);
    expect(state.retry).toEqual({ attempt: 1, maxAttempts: 1, errorMessage: "", endsAt: expect.any(Number) });
  });

  it("clears retry state on auto_retry_end", () => {
    const started = reduceSessionEvent(emptyState, retryStartEvent());
    const ended = reduceSessionEvent(started, {
      type: "auto_retry_end",
      success: true,
      attempt: 2,
    } as AgentSessionEvent);
    expect(ended.retry).toBeNull();
  });

  it("clears retry state on terminateSessionRun", () => {
    const started = reduceSessionEvent(emptyState, retryStartEvent());
    expect(terminateSessionRun(started).retry).toBeNull();
  });

  it("hydrates retry as null from a snapshot", () => {
    const hydrated = fromSnapshot({
      runtimeConfigurationGeneration: 0,
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready" },
      subagents: [],
      messages: [assistantMessage("hello")],
    });
    expect(hydrated.retry).toBeNull();
  });

  describe("parseSkillInvocation (ADR-066)", () => {
    const expanded = `<skill name="arxiv" location="/x/SKILL.md">\nReferences are relative to /x.\n\nbody\n</skill>`;

    it("parses name and trailing args", () => {
      expect(parseSkillInvocation(`${expanded}\n\n1706.03762`)).toEqual({ name: "arxiv", args: "1706.03762" });
    });

    it("parses a bare skill block without args", () => {
      expect(parseSkillInvocation(expanded)).toEqual({ name: "arxiv" });
    });

    it("returns undefined for plain messages and malformed blocks", () => {
      expect(parseSkillInvocation("hello")).toBeUndefined();
      expect(parseSkillInvocation(`<skill name="arxiv">unclosed`)).toBeUndefined();
    });
  });

  it("marks skill-invoked user messages with a compact view (fromSnapshot)", () => {
    const state = fromSnapshot({
      runtimeConfigurationGeneration: 0,
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready" },
      subagents: [],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `<skill name="arxiv" location="/x/SKILL.md">\n\nbody\n</skill>\n\n1706.03762`,
            },
          ],
        },
      ] as never,
    });
    expect(state.messages[0]?.skillInvocation).toEqual({ name: "arxiv", args: "1706.03762" });
  });

  it("marks skill-invoked user messages arriving live (message_start/message_end)", () => {
    let state = reduceSessionEvent(emptyState, {
      type: "message_start",
      message: { role: "user", content: `<skill name="arxiv" location="/x">\n\nbody\n</skill>` },
    } as AgentSessionEvent);
    expect(state.messages[0]?.skillInvocation).toEqual({ name: "arxiv" });

    state = reduceSessionEvent(state, {
      type: "message_end",
      message: { role: "user", content: `<skill name="arxiv" location="/x">\n\nbody\n</skill>` },
    } as AgentSessionEvent);
    expect(state.messages[0]?.skillInvocation).toEqual({ name: "arxiv" });
  });

  it("does not mark ordinary messages", () => {
    const state = fromSnapshot({
      runtimeConfigurationGeneration: 0,
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready" },
      subagents: [],
      messages: [userMessage("plain text")],
    });
    expect(state.messages[0]?.skillInvocation).toBeUndefined();
  });
});

describe("steer queue reducer (ADR-083)", () => {
  it("hydrates pending steers from a running snapshot", () => {
    const state = fromSnapshot({
      runtimeConfigurationGeneration: 0,
      session: { id: "s1", cwd: "/p", isStreaming: true, status: "running" },
      subagents: [],
      messages: [],
      steering: ["note one", "note two"],
    });
    expect(state.steers.map((steer) => steer.text)).toEqual(["note one", "note two"]);
  });

  it("treats an empty or missing steering array as no queued steers", () => {
    expect(
      fromSnapshot({
        runtimeConfigurationGeneration: 0,
        session: { id: "s1", cwd: "/p", isStreaming: true, status: "running" },
        subagents: [],
        messages: [],
        steering: [],
      }).steers,
    ).toEqual([]);
    expect(
      fromSnapshot({
        runtimeConfigurationGeneration: 0,
        session: { id: "s1", cwd: "/p", isStreaming: true, status: "running" },
        subagents: [],
        messages: [],
      }).steers,
    ).toEqual([]);
  });

  it("replaces the steer rows on queue_update in queue order", () => {
    const state = reduceSessionEvent(emptyState, {
      type: "queue_update",
      steering: ["first", "second"],
      followUp: [],
    } as never);
    expect(state.steers.map((steer) => steer.text)).toEqual(["first", "second"]);
  });

  it("keeps stable keys for remaining steers after one is delivered", () => {
    let state = reduceSessionEvent(emptyState, {
      type: "queue_update",
      steering: ["alpha", "beta"],
      followUp: [],
    } as never);
    const betaKey = state.steers[1]!.key;
    state = reduceSessionEvent(state, {
      type: "queue_update",
      steering: ["beta"],
      followUp: [],
    } as never);
    expect(state.steers.map((steer) => steer.text)).toEqual(["beta"]);
    expect(state.steers[0]!.key).toBe(betaKey);
  });

  it.each([
    ["expanded", '<skill name="paper-search" location="/private/SKILL.md">private expanded instructions</skill> query'],
    ["literal", "/skill:paper-search query"],
  ])("compacts a queued %s Skill invocation without retaining its expanded body", (_kind, text) => {
    const snapshot = fromSnapshot({
      runtimeConfigurationGeneration: 0,
      session: { id: "s1", cwd: "/p", isStreaming: true, status: "running" },
      subagents: [],
      messages: [],
      steering: [text],
    });
    const live = reduceSessionEvent(emptyState, {
      type: "queue_update",
      steering: [text],
      followUp: [],
    } as never);

    for (const steer of [snapshot.steers[0], live.steers[0]]) {
      expect(steer?.skillInvocation).toEqual({ name: "paper-search", args: "query" });
      expect(JSON.stringify(steer)).not.toContain("private expanded instructions");
      expect(JSON.stringify(steer)).not.toContain("<skill");
    }
  });

  it("clears steers when the run terminates", () => {
    let state = reduceSessionEvent(emptyState, {
      type: "queue_update",
      steering: ["alpha"],
      followUp: [],
    } as never);
    state = terminateSessionRun(state, true);
    expect(state.steers).toEqual([]);
  });
});
