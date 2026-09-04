import { describe, expect, it } from "vitest";
import type { ApiUsageStatisticsDto } from "../../web/contracts";
import type { SessionMessageView, SessionSummaryView, ToolView } from "./session-reducer";
import { indexSubtreeUsage, mergeTranscriptEntries } from "./transcript-entries";

const message = (key: string, order: number): SessionMessageView => ({
  key,
  order,
  role: "assistant",
  text: key,
  streaming: false,
  error: false,
});
const tool = (key: string, order: number): ToolView => ({
  key,
  order,
  name: "bash",
  running: false,
  done: true,
  error: false,
});
const summary = (key: string, order: number): SessionSummaryView => ({
  key,
  order,
  entryId: key,
  kind: "compaction",
});

describe("mergeTranscriptEntries", () => {
  it("merges ordered sources while preserving entry identity", () => {
    const messages = [message("m0", 0), message("m3", 3)];
    const result = mergeTranscriptEntries(messages, [tool("t1", 1)], [summary("s2", 2)], false);
    expect(result.map((entry) => ("kind" in entry && entry.kind === "pending" ? "pending" : entry.key))).toEqual([
      "m0",
      "t1",
      "s2",
      "m3",
    ]);
    expect(result[0]).toBe(messages[0]);
  });

  it("keeps source precedence for equal orders and appends pending last", () => {
    const result = mergeTranscriptEntries([message("m", 1)], [tool("t", 1)], [summary("s", 1)], true);
    expect(result.map((entry) => ("kind" in entry && entry.kind === "pending" ? "pending" : entry.key))).toEqual([
      "m",
      "t",
      "s",
      "pending",
    ]);
  });
});

describe("indexSubtreeUsage", () => {
  it("indexes the authoritative subtree objects without arithmetic", () => {
    const subtree = { input: 1, output: 2, cacheRead: 3, cacheWrite: 0, reasoning: 0, total: 6, cost: {} };
    const value = { sessions: [{ sessionId: "child", subtree }] } as unknown as ApiUsageStatisticsDto;
    expect(indexSubtreeUsage(value).get("child")).toBe(subtree);
  });
});
