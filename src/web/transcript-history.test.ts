import { describe, expect, it } from "vitest";
import type { TranscriptTimelineEntryDto } from "./contracts";
import { projectSessionUsage } from "./api-usage";
import { projectSessionTimeline } from "./session-timeline";
import { pageTranscript, readTranscriptEntry, TranscriptCursorError } from "./transcript-history";

const message = (entryId: string, text = entryId): TranscriptTimelineEntryDto => ({
  kind: "message", entryId, message: { role: "user", content: text, timestamp: 1 },
});

describe("bounded transcript history", () => {
  it("pages inline usage by its persisted entry rather than a reused render anchor", () => {
    const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const entries = ["old", "new"].map((id) => ({
      type: "message", id, timestamp: "2026-10-24T00:00:00Z", message: {
        role: "toolResult", toolCallId: "same-provider-id", toolName: "read", timestamp: 1,
        content: [{ type: "text", text: id }], isError: false, usage,
      },
    }));
    const projection = projectSessionUsage("s", entries, entries);
    const source = { timeline: projectSessionTimeline(entries), inlineUsage: projection.inlineUsage };
    const page = pageTranscript("s", source, undefined, { entries: 1 });
    expect(page.inlineUsage?.map((record) => record.id)).toEqual(["new"]);
    const older = pageTranscript("s", source, page.history!.cursor!, { entries: 1 });
    expect(older.inlineUsage?.map((record) => record.id)).toEqual(["old"]);
    expect(projection.direct.records).toBe(2);
  });
  it("pages a growing branch by persisted identity without duplicates or gaps", () => {
    const timeline = ["a", "b", "c", "d", "e"].map((id) => message(id));
    const first = pageTranscript("root", { timeline }, undefined, { entries: 2 });
    expect(first.timeline.map((e) => e.entryId)).toEqual(["d", "e"]);
    const grown = { timeline: [...timeline, message("f")] };
    const second = pageTranscript("root", grown, first.history!.cursor!, { entries: 2 });
    expect(second.timeline.map((e) => e.entryId)).toEqual(["b", "c"]);
    const third = pageTranscript("root", grown, second.history!.cursor!, { entries: 2 });
    expect(third.timeline.map((e) => e.entryId)).toEqual(["a"]);
    expect(third.history?.cursor).toBeUndefined();
    expect(() => pageTranscript("child", grown, first.history!.cursor!)).toThrow(TranscriptCursorError);
    expect(() => pageTranscript("root", { timeline: timeline.slice(0, 3) }, first.history!.cursor!)).toThrow(TranscriptCursorError);
  });

  it("bounds UTF-8 page bytes, not character count, and exposes every older entry", () => {
    const timeline = Array.from({ length: 12 }, (_, i) => message(String(i), "汉😀".repeat(500)));
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = pageTranscript("root", { timeline }, cursor, { bytes: 9000 });
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(9000);
      expect(page.timeline.length).toBeGreaterThan(0);
      seen.unshift(...page.timeline.map((e) => e.entryId));
      cursor = page.history?.cursor;
    } while (cursor);
    expect(seen).toEqual(timeline.map((e) => e.entryId));
  });

  it("opens a history larger than the event budget with a small recent window", () => {
    const timeline = Array.from({ length: 400 }, (_, i) => message(String(i), "x".repeat(100_000)));
    const page = pageTranscript("root", { timeline });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(2 * 1024 * 1024);
    expect(page.timeline.at(-1)?.entryId).toBe("399");
    expect(page.history?.cursor).toBeTruthy();
  });

  it("keeps an oversized public entry complete on disk-side reads and marks only its preview", () => {
    const entry = message("large", "begin " + "汉😀".repeat(100_000) + " end");
    const source = { timeline: [entry] };
    const page = pageTranscript("root", source);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(64 * 1024);
    expect(page.timeline[0]?.deferred).toEqual({ bytes: Buffer.byteLength(JSON.stringify(entry)) });
    expect(readTranscriptEntry(source, "large")).toBe(entry);
    expect(entry).not.toHaveProperty("deferred");
    expect(readTranscriptEntry(source, "hidden")).toBeUndefined();
  });

  it("bounds previews of parallel tool calls and JSON-escaped arguments as well as plain text", () => {
    const argumentsValue = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [String(i), Array(8).fill("\u0000".repeat(2000))]));
    const entry: TranscriptTimelineEntryDto = { kind: "message", entryId: "calls", message: {
      role: "assistant", timestamp: 1,
      content: Array.from({ length: 8 }, (_, i) => ({ type: "toolCall", id: `call-${i}`, name: "write", arguments: argumentsValue })),
    } as never };
    const page = pageTranscript("root", { timeline: [entry] }, undefined, { bytes: 16_000 });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(16_000);
    expect(page.timeline[0]?.deferred).toBeDefined();
    expect(readTranscriptEntry({ timeline: [entry] }, "calls")).toBe(entry);
  });
});
