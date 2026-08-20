import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { toJsonSessionEvent } from "./json-session-event";

describe("toJsonSessionEvent", () => {
  it("keeps only the incremental assistant update at the JSON boundary", () => {
    const event = {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "new token",
        partial: { role: "assistant", content: [{ type: "text", text: "all tokens" }] },
      },
    } as AgentSessionEvent;

    expect(toJsonSessionEvent(event)).toEqual({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "new token" },
    });
  });

  it("preserves non-update events", () => {
    const event = { type: "agent_start" } as AgentSessionEvent;

    expect(toJsonSessionEvent(event)).toBe(event);
  });
});
