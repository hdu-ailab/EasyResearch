import { describe, expect, it } from "vitest";
import type { TranscriptPageDto } from "../../web/contracts";
import { fromSnapshot, reduceSessionEvent } from "./session-reducer";
import { prependTranscriptPage, shouldAdjustTranscriptRow } from "./transcript-history";

describe("older history publication", () => {
  it("compensates a prepended estimate shrinking above the original row, including the header inset", () => {
    const geometry = {
      introduced: true,
      index: 20,
      firstVisible: 20,
      end: 1064,
      offset: 1000,
      adjustments: 0,
      header: 64,
    };
    const delta = -48;
    const scroll = geometry.offset + (shouldAdjustTranscriptRow(geometry) ? delta : 0);
    expect(geometry.end + delta - scroll).toBe(64);
    expect(shouldAdjustTranscriptRow({ ...geometry, end: 1065 })).toBe(false);
    expect(shouldAdjustTranscriptRow({ ...geometry, introduced: false })).toBe(false);
    expect(shouldAdjustTranscriptRow({ ...geometry, introduced: false, index: 19 })).toBe(true);
  });
  it("prepends by entry identity without replacing live rows or reviving finished tools", () => {
    let state = fromSnapshot({
      session: { id: "s", cwd: "/project", status: "running", isStreaming: true },
      runtimeConfigurationGeneration: 2,
      subagents: [],
      history: { cursor: "before-result" },
      timeline: [
        {
          kind: "message",
          entryId: "result",
          message: {
            role: "toolResult",
            toolCallId: "call",
            toolName: "read",
            isError: false,
            content: [{ type: "text", text: "actual result" }],
            timestamp: 2,
          },
        },
      ],
    });
    state = reduceSessionEvent(state, {
      type: "message_start",
      message: { role: "assistant", timestamp: 3, content: [] },
    } as never);
    state = reduceSessionEvent(state, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "still live" },
    } as never);
    const live = state.messages.at(-1)!;
    const page: TranscriptPageDto = {
      timeline: [
        { kind: "message", entryId: "user", message: { role: "user", content: "older question", timestamp: 1 } },
        {
          kind: "message",
          entryId: "caller",
          message: {
            role: "assistant",
            timestamp: 2,
            content: [{ type: "toolCall", id: "call", name: "read", arguments: { path: "paper.md" } }],
          } as never,
        },
      ],
      history: { cursor: "even-older" },
    };
    const next = prependTranscriptPage(state, page, "s");
    expect(next.messages.map((row) => row.text)).toEqual(["older question", "still live"]);
    expect(next.messages.at(-1)).toBe(live);
    expect(next.activeMessageKey).toBe(live.key);
    expect(next.tools).toHaveLength(1);
    expect(next.tools[0]).toMatchObject({
      args: "paper.md",
      output: "actual result",
      running: false,
      error: false,
      callEntryId: "caller",
      resultEntryId: "result",
    });
    expect(next.tools[0]!.order).toBeLessThan(live.order);
    expect(next.hydrationRevision).toBe(state.hydrationRevision);
    expect(next.historyCursor).toBe("even-older");
    const again = prependTranscriptPage(next, page, "s");
    expect(again.messages.map((row) => row.text)).toEqual(["older question", "still live"]);
    expect(again.tools).toHaveLength(1);
  });
});
