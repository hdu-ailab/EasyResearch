import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { emptyState, reduceSessionEvent, reduceSubagentSupervisorEvent, type SessionViewState } from "../webui/src/session-reducer";
import { toJsonSessionEvent } from "./json-session-event";

const usage = {
  input: 3,
  output: 5,
  cacheRead: 7,
  cacheWrite: 11,
  cacheWrite1h: 2,
  reasoning: 4,
  totalTokens: 26,
  cost: {
    input: 0.1,
    output: 0.2,
    cacheRead: 0.3,
    cacheWrite: 0.4,
    total: 1,
  },
};

const assistant = {
  role: "assistant",
  content: [{ type: "text", text: "all tokens" }],
  api: "openai-responses",
  provider: "test-provider",
  model: "test-model",
  usage,
  stopReason: "stop",
  timestamp: 1,
};

describe("toJsonSessionEvent", () => {
  it("isolates assistant starts from provider-owned content without changing metadata or final messages", () => {
    const message = {
      ...assistant,
      content: [
        { type: "text", text: "first token" },
        { type: "thinking", thinking: "first thought" },
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "paper.md" } },
      ],
    };
    const original = structuredClone(message);
    const start = toJsonSessionEvent({ type: "message_start", message } as AgentSessionEvent);
    expect(start).toEqual({ type: "message_start", message: { ...original, content: [] } });
    expect(message).toEqual(original);
    message.content.push({ type: "text", text: "later token" });
    expect(start).toEqual({ type: "message_start", message: { ...original, content: [] } });
    const end = { type: "message_end", message } as AgentSessionEvent;
    expect(toJsonSessionEvent(end)).toBe(end);
  });

  it.each(["text", "thinking"])("streams repeated %s deltas exactly once despite an already populated start", (kind) => {
    const message = {
      ...assistant,
      content: kind === "text"
        ? [{ type: "text", text: "ha" }]
        : [{ type: "thinking", thinking: "ha" }],
    };
    const wire = (event: unknown) => JSON.parse(JSON.stringify(toJsonSessionEvent(event as AgentSessionEvent)));
    let state = reduceSessionEvent(emptyState, wire({ type: "message_start", message }));
    for (const delta of ["ha", "ha"]) {
      state = reduceSessionEvent(state, wire({
        type: "message_update",
        message,
        assistantMessageEvent: { type: `${kind}_delta`, contentIndex: 0, delta, partial: message },
      }));
    }
    expect(kind === "text" ? state.messages[0]?.text : state.messages[0]?.reasoning).toBe("haha");
    expect(state.messages[0]?.streaming).toBe(true);
  });

  it.each(["stop", "aborted"])("retains final-only %s replies when there are no content deltas", (stopReason) => {
    const message = {
      ...assistant,
      stopReason,
      ...(stopReason === "aborted" ? { errorMessage: "Request was aborted" } : {}),
    };
    let state = emptyState;
    for (const type of ["message_start", "message_end"]) {
      const wire = JSON.parse(JSON.stringify(toJsonSessionEvent({ type, message } as AgentSessionEvent)));
      state = reduceSessionEvent(state, wire);
    }
    expect(state.messages).toEqual([expect.objectContaining({
      text: "all tokens",
      streaming: false,
      error: stopReason === "aborted",
    })]);
  });

  it.each(["user", "assistant"])("starts fresh subagent-card text after a preceding %s message", (role) => {
    let state: SessionViewState = { ...emptyState, tools: [{
      key: "launch", toolCallId: "launch", name: "subagent", running: true, done: false, error: false, order: 0,
    }] };
    const message = { ...assistant, content: [{ type: "text", text: "ha" }] };
    const events = [
      { type: "message_start", message: { role, content: [{ type: "text", text: "previous text" }], timestamp: 0 } },
      { type: "message_end", message: { role, content: [{ type: "text", text: "previous text" }], timestamp: 0 } },
      { type: "message_start", message },
      ...["ha", "ha"].map((delta) => ({
        type: "message_update", message,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: message },
      })),
    ];
    for (const event of events) {
      state = reduceSubagentSupervisorEvent(state, {
        type: "subagent_supervisor", launchId: "launch", ownerSessionId: "root", toolCallId: "launch",
        agent: "search", agentId: "search_0", childSessionId: "child", status: "working",
        event: toJsonSessionEvent(event as AgentSessionEvent),
      });
    }
    expect(state.tools[0]?.latestActivity).toEqual({ kind: "text", text: "haha" });
  });

  it.each(["user", "toolResult", "custom"])("preserves %s start content", (role) => {
    const event = {
      type: "message_start",
      message: { role, content: [{ type: "text", text: "full content" }], timestamp: 1 },
    } as AgentSessionEvent;
    expect(toJsonSessionEvent(event)).toBe(event);
  });

  it("keeps only the incremental assistant update at the JSON boundary", () => {
    const event = {
      type: "message_update",
      message: assistant,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "new token",
        partial: assistant,
      },
    } as AgentSessionEvent;

    expect(toJsonSessionEvent(event)).toEqual({
      type: "message_update",
      usage,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "new token" },
    });
  });

  it("preserves tool identity without the cumulative assistant snapshot", () => {
    const event = {
      type: "message_update",
      message: assistant,
      assistantMessageEvent: {
        type: "toolcall_start",
        contentIndex: 1,
        partial: {
          ...assistant,
          content: [
            { type: "text", text: "all tokens" },
            {
              type: "toolCall",
              id: "call-7",
              name: "read",
              arguments: { path: "paper.md" },
            },
          ],
        },
      },
    } as AgentSessionEvent;

    expect(toJsonSessionEvent(event)).toEqual({
      type: "message_update",
      usage,
      assistantMessageEvent: {
        type: "toolcall_start",
        contentIndex: 1,
        id: "call-7",
        toolName: "read",
      },
    });
  });

  it("preserves non-update events", () => {
    const event = { type: "agent_start" } as AgentSessionEvent;

    expect(toJsonSessionEvent(event)).toBe(event);
  });
});
