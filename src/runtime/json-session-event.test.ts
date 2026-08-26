import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
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
