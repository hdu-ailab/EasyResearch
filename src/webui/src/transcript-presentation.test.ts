import { describe, expect, it } from "vitest";
import type { ApiUsageRecordDto } from "../../web/contracts";
import type { SessionCompletionView, SessionMessageView, SessionSummaryView, ToolView } from "./session-reducer";
import { getTimelineDetail, TIMELINE_PRESETS, type TimelineDetail } from "./timeline-detail";
import { mergeTranscriptEntries } from "./transcript-entries";
import {
  type ActivityGroup,
  activityCategory,
  type PresentationEntry,
  presentationDefaultOpen,
  projectTranscript,
} from "./transcript-presentation";

const preset = (id: (typeof TIMELINE_PRESETS)[number]["id"]): TimelineDetail =>
  TIMELINE_PRESETS.find((value) => value.id === id)!.value;
const message = (key: string, order: number, overrides: Partial<SessionMessageView> = {}): SessionMessageView => ({
  key,
  order,
  role: "assistant",
  text: "answer",
  streaming: false,
  error: false,
  ...overrides,
});
const tool = (key: string, order: number, overrides: Partial<ToolView> = {}): ToolView => ({
  key,
  order,
  name: "read",
  args: "notes.md",
  done: true,
  running: false,
  error: false,
  ...overrides,
});
const summary: SessionSummaryView = {
  kind: "compaction",
  key: "summary:s",
  entryId: "s",
  summary: "stored summary",
  order: 4,
};
const completion: SessionCompletionView = {
  kind: "subagent-completion",
  key: "c",
  entryId: "c",
  timestamp: "2026-11-06T00:00:00Z",
  batchId: "b",
  launchId: "l",
  agentId: "search_0",
  status: "complete",
  text: "done",
  order: 3,
};
const key = (entry: PresentationEntry) => ("kind" in entry && entry.kind === "pending" ? "pending" : entry.key);
const flatten = (entries: PresentationEntry[]) =>
  entries.flatMap((entry) => ("kind" in entry && entry.kind === "activity-group" ? entry.entries : [entry]));

describe("transcript presentation projection", () => {
  it.each(["bash", "powershell", "ssh-bash"])("classifies %s as command execution", (name) => {
    expect(activityCategory(tool("call", 0, { name }))).toBe("shell");
  });
  it.each(["edit", "write", "patch", "apply_patch"])("classifies %s as file changes", (name) => {
    expect(activityCategory(tool("call", 0, { name }))).toBe("edit");
  });
  it("keeps Skill reads with tools and subagent completions with subagents", () => {
    expect(activityCategory(tool("skill", 0, { skillName: "arxiv" }))).toBe("tools");
    expect(activityCategory(completion)).toBe("subagents");
    expect(activityCategory(summary)).toBeUndefined();
  });

  it("splits mixed thoughts from visible answers before hiding or grouping, without mutating history", () => {
    const mixed = Object.freeze(message("mixed", 0, { reasoning: "private reasoning", streaming: true }));
    const hidden = projectTranscript([mixed], preset("text-only"));
    expect(hidden).toEqual([{ ...mixed, reasoning: undefined, isThinking: false }]);
    expect(mixed.reasoning).toBe("private reasoning");
    const grouped = projectTranscript([mixed], preset("compact"));
    expect(grouped[0]).toMatchObject({
      kind: "activity-group",
      entries: [{ kind: "thinking", key: "mixed:thinking" }],
    });
    expect(grouped[1]).toMatchObject({ key: "mixed", text: "answer", streaming: true });
    expect(presentationDefaultOpen(grouped[0]!, preset("compact"))).toBe(false);
  });

  it("groups adjacent activities across categories but never across user, answer or summary boundaries", () => {
    const source = mergeTranscriptEntries(
      [
        message("u", 0, { role: "user", text: "request" }),
        message("think", 2, { text: "", reasoning: "consider evidence" }),
        message("reply", 6),
        message("next-user", 8, { role: "user" }),
      ],
      [tool("r", 1), tool("w", 5, { name: "write" }), tool("after", 7)],
      [summary],
      false,
      [completion],
    );
    const rows = projectTranscript(source, preset("compact"));
    expect(rows.map(key)).toEqual([
      "u",
      "activity:r",
      summary.key,
      "activity:w",
      "reply",
      "activity:after",
      "next-user",
    ]);
    expect((rows[1] as ActivityGroup).entries.map(key)).toEqual(["r", "think:thinking", "c"]);
    expect(flatten(rows).map(key)).toEqual([
      "u",
      "r",
      "think:thinking",
      "c",
      "summary:s",
      "w",
      "reply",
      "after",
      "next-user",
    ]);
  });

  it("keeps failures, interruptions and current work separate and legible in compact and text-only modes", () => {
    const entries = [
      tool("done", 0),
      tool("active", 1, { running: true, done: false }),
      tool("failed", 2, { error: true }),
      tool("interrupted", 3, { interrupted: true }),
      { ...completion, key: "child-error", status: "error" as const },
      message("notice", 5, { role: "system", text: "connection failed", error: true }),
      message("answer-error", 6, { text: "partial answer", error: true }),
    ];
    for (const detail of [preset("text-only"), preset("compact")]) {
      const rows = projectTranscript(entries, detail);
      for (const id of ["active", "failed", "interrupted", "child-error", "notice", "answer-error"])
        expect(rows.some((entry) => key(entry) === id)).toBe(true);
      expect(presentationDefaultOpen(rows.find((row) => key(row) === "failed")!, detail)).toBe(
        detail.shell.placement === "hidden",
      );
    }
    expect(projectTranscript(entries, preset("text-only")).some((row) => key(row) === "done")).toBe(false);
  });

  it("conceals active reasoning content while retaining a live thinking status", () => {
    const rows = projectTranscript(
      [message("live", 0, { text: "", reasoning: "not for the compact surface", isThinking: true, streaming: true })],
      preset("text-only"),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "thinking", concealed: true });
  });

  it("retains exact distinct stored summary entries and appends only an actual queued/running state", () => {
    const sameText = { ...summary, key: "summary:other", entryId: "other", order: 5 };
    const branch = { ...summary, key: "summary:branch", entryId: "branch", kind: "branch-summary" as const, order: 6 };
    const stored = [summary, sameText, branch];
    for (const state of ["queued", "running", "idle"] as const) {
      const rows = projectTranscript(stored, preset("text-only"), { compactionState: state });
      expect(rows.slice(0, 3)).toEqual(stored);
      expect(rows.slice(0, 3).every((entry) => !presentationDefaultOpen(entry, preset("everything")))).toBe(true);
      expect(rows.slice(3)).toEqual(
        state === "idle" ? [] : [{ kind: "compaction-state", key: "compaction-state", state }],
      );
    }
  });

  it("preserves group identity over streaming replacements and history prepends without duplicate split keys", () => {
    const detail = preset("compact");
    const previous = projectTranscript([tool("b", 2), tool("c", 3)], detail);
    const next = projectTranscript([tool("a", 1), tool("b", 2), tool("c", 3, { output: "new final output" })], detail, {
      previous,
    });
    expect(key(next[0]!)).toBe(key(previous[0]!));
    expect((next[0] as ActivityGroup).entries[2]).toMatchObject({ output: "new final output" });
    const split = projectTranscript([tool("a", 1), message("answer", 1.5), tool("b", 2), tool("c", 3)], detail, {
      previous: next,
    });
    expect(split.map(key)).toEqual(["activity:a", "answer", "activity:b"]);
    expect(new Set(split.map(key)).size).toBe(split.length);
  });

  it("keeps usage a separate global display choice when ordinary content is hidden", () => {
    const record: ApiUsageRecordDto = {
      id: "usage",
      sessionId: "root",
      source: "tool",
      timestamp: "2026-11-06T00:00:00Z",
      anchor: { kind: "tool", toolCallId: "read" },
      usage: {
        input: 10,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 12,
        cacheHitRate: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    const rows = [
      tool("read", 0, { apiUsage: record }),
      message("notice", 1, { role: "system", apiUsage: record }),
      message("thought", 2, { text: "", reasoning: "reasoning", apiUsage: record }),
    ];
    expect(projectTranscript(rows, preset("text-only"))).toEqual([]);
    expect(projectTranscript(rows, preset("text-only"), { showApiUsageDetails: true })).toEqual(
      rows.map((entry) => ({ kind: "usage", key: `${entry.key}:usage`, record })),
    );
    const compact = preset("compact");
    expect(projectTranscript(rows, compact, { showApiUsageDetails: true })).toEqual(projectTranscript(rows, compact));
  });

  it("untouched disclosure defaults derive from the current shared category policy", () => {
    const entry = tool("read", 0);
    expect(presentationDefaultOpen(entry, getTimelineDetail({ autoExpandTools: false }))).toBe(false);
    expect(presentationDefaultOpen(entry, getTimelineDetail({ autoExpandTools: true }))).toBe(true);
    expect(presentationDefaultOpen(entry, preset("text-only"))).toBe(false);
    const hiddenExpanded = {
      ...preset("everything"),
      tools: { placement: "hidden" as const, details: "expanded" as const },
    };
    expect(presentationDefaultOpen(tool("running", 0, { running: true, done: false }), hiddenExpanded)).toBe(false);
    expect(presentationDefaultOpen(tool("failed", 0, { error: true }), hiddenExpanded)).toBe(true);
  });
});
