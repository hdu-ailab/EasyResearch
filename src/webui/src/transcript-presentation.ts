import type { ApiUsageRecordDto, ApiUsageTotalsDto, CompactionStateDto } from "../../web/contracts";
import type { SessionCompletionView, SessionMessageView, SessionSummaryView, ToolView } from "./session-reducer";
import type { TimelineCategory, TimelineDetail } from "./timeline-detail";
import type { TranscriptEntry } from "./transcript-entries";

export type ThinkingEntry = { kind: "thinking"; key: string; message: SessionMessageView; concealed: boolean };
export type NoticeEntry = { kind: "notice"; key: string; message: SessionMessageView };
export type ActivityEntry = ToolView | SessionCompletionView | ThinkingEntry | NoticeEntry;
export type ActivityGroup = { kind: "activity-group"; key: string; entries: ActivityEntry[] };
export type PresentationEntry =
  | TranscriptEntry
  | ThinkingEntry
  | NoticeEntry
  | ActivityGroup
  | { kind: "usage"; key: string; record: ApiUsageRecordDto }
  | { kind: "subtree-usage"; key: string; sessionId: string }
  | { kind: "compaction-state"; key: string; state: Exclude<CompactionStateDto, "idle"> };

export function isSummaryEntry(entry: PresentationEntry): entry is SessionSummaryView {
  return "kind" in entry && (entry.kind === "compaction" || entry.kind === "branch-summary");
}

export function activityCategory(entry: ActivityEntry): TimelineCategory;
export function activityCategory(entry: PresentationEntry): TimelineCategory | undefined;
export function activityCategory(entry: PresentationEntry): TimelineCategory | undefined {
  if ("name" in entry) {
    if (["bash", "powershell", "ssh-bash"].includes(entry.name)) return "shell";
    if (["edit", "write", "patch", "apply_patch"].includes(entry.name)) return "edit";
    if (entry.name === "subagent") return "subagents";
    return "tools";
  }
  if (!("kind" in entry)) return undefined;
  if (entry.kind === "thinking") return "thinking";
  if (entry.kind === "notice") return "notices";
  if (entry.kind === "subagent-completion") return "subagents";
  return undefined;
}

export function activityFailed(entry: ActivityEntry): boolean {
  if ("name" in entry) return entry.error || entry.interrupted === true;
  if (entry.kind === "subagent-completion") return entry.status === "error";
  return entry.message.error;
}

/** Visibility takes precedence over disclosure; actual diagnostics remain inspectable. */
export function presentationConcealsContent(entry: PresentationEntry, detail: TimelineDetail): boolean {
  const category = activityCategory(entry);
  return (
    category !== undefined &&
    detail[category].placement === "hidden" &&
    (category === "thinking" || !activityFailed(entry as ActivityEntry))
  );
}

function activityRequired(entry: ActivityEntry): boolean {
  if ("kind" in entry && entry.kind === "thinking")
    return entry.message.isThinking === true || (entry.message.streaming && !entry.message.text.trim());
  if (activityFailed(entry)) return true;
  if ("name" in entry) return entry.running && !entry.done;
  if (entry.kind === "subagent-completion") return false;
  return entry.message.isThinking === true || entry.message.streaming;
}

export function presentationDefaultOpen(entry: PresentationEntry, detail: TimelineDetail): boolean {
  if ("kind" in entry && entry.kind === "activity-group")
    return entry.entries.some((item) => presentationDefaultOpen(item, detail));
  const category = activityCategory(entry);
  if (!category) return false; // Persisted summaries always start folded.
  const policy = detail[category];
  return policy.placement === "hidden" ? activityFailed(entry as ActivityEntry) : policy.details === "expanded";
}

function presentationKey(entry: PresentationEntry): string {
  return "kind" in entry && entry.kind === "pending" ? "pending" : entry.key;
}

/** Compare presentation-owned wrappers only. Reducer-owned tools, summaries and
 * completions keep their source identity; inspecting tool output here would put
 * historical content work back on every streaming delta. */
function samePresentationRow(previous: PresentationEntry, next: PresentationEntry): boolean {
  if (previous === next) return true;
  if ("kind" in previous || "kind" in next) {
    if (!("kind" in previous) || !("kind" in next)) return false;
    switch (next.kind) {
      case "thinking":
        return (
          previous.kind === "thinking" && previous.message === next.message && previous.concealed === next.concealed
        );
      case "notice":
        return previous.kind === "notice" && previous.message === next.message;
      case "activity-group":
        return (
          previous.kind === "activity-group" &&
          previous.entries.length === next.entries.length &&
          previous.entries.every((entry, index) => entry === next.entries[index])
        );
      case "usage":
        return previous.kind === "usage" && previous.record === next.record;
      case "subtree-usage":
        return previous.kind === "subtree-usage" && previous.sessionId === next.sessionId;
      case "compaction-state":
        return previous.kind === "compaction-state" && previous.state === next.state;
      case "pending":
        return previous.kind === "pending";
      default:
        return false;
    }
  }
  if ("name" in previous || "name" in next) return false;
  // A mixed message's answer is a shallow projection with reasoning removed.
  // Compare all remaining fields so new usage/identity/status still invalidates
  // it, while thought-only changes do not rerender the unchanged answer.
  const keys = Object.keys(previous) as (keyof SessionMessageView)[];
  return (
    keys.length === Object.keys(next).length &&
    keys.every((key) => Object.hasOwn(next, key) && Object.is(previous[key], next[key]))
  );
}

/** UI-only projection. Pi/reducer history and its ordering remain untouched. */
export function projectTranscript(
  entries: readonly TranscriptEntry[],
  detail: TimelineDetail,
  options: {
    showApiUsageDetails?: boolean;
    subtreeUsage?: ReadonlyMap<string, ApiUsageTotalsDto>;
    compactionState?: CompactionStateDto;
    previous?: readonly PresentationEntry[];
  } = {},
): PresentationEntry[] {
  const result: PresentationEntry[] = [];
  let adjacent: ActivityEntry[] = [];
  const flush = () => {
    const first = adjacent[0];
    if (!first) return;
    result.push({ kind: "activity-group", key: `activity:${first.key}`, entries: adjacent });
    adjacent = [];
  };
  const usage = (entry: { key: string; apiUsage?: ApiUsageRecordDto }) => {
    if (!options.showApiUsageDetails || !entry.apiUsage) return;
    flush();
    result.push({ kind: "usage", key: `${entry.key}:usage`, record: entry.apiUsage });
  };
  const activity = (entry: ActivityEntry) => {
    const category = activityCategory(entry);
    const placement = detail[category].placement;
    if (placement === "hidden" && !activityRequired(entry)) {
      if (
        options.showApiUsageDetails &&
        "name" in entry &&
        entry.name === "subagent" &&
        entry.sessionId &&
        options.subtreeUsage?.has(entry.sessionId)
      ) {
        flush();
        result.push({ kind: "subtree-usage", key: `${entry.key}:usage`, sessionId: entry.sessionId });
      } else if ("apiUsage" in entry) usage(entry);
      else if ("kind" in entry && entry.kind === "notice") usage(entry.message);
      else if ("kind" in entry && entry.kind === "thinking" && !entry.message.text.trim() && !entry.message.error)
        usage(entry.message);
      return;
    }
    // Failures and current work must not disappear inside a collapsed group.
    if (placement === "grouped" && !activityRequired(entry)) adjacent.push(entry);
    else {
      flush();
      result.push(entry);
    }
  };
  for (const entry of entries) {
    if ("name" in entry || ("kind" in entry && entry.kind === "subagent-completion")) {
      activity(entry);
      continue;
    }
    if ("kind" in entry) {
      flush();
      result.push(entry);
      continue;
    }
    if (entry.usageOnly) {
      usage(entry);
      continue;
    }
    if (entry.role !== "assistant" && entry.role !== "user") {
      activity({ kind: "notice", key: entry.key, message: entry });
      continue;
    }
    if (entry.role === "assistant" && (entry.reasoning || entry.isThinking)) {
      activity({
        kind: "thinking",
        key: `${entry.key}:thinking`,
        message: entry,
        concealed: detail.thinking.placement === "hidden",
      });
      // A thought and its answer have independent visibility and disclosure identity.
      if (!entry.text.trim() && !entry.error) {
        continue;
      }
      flush();
      result.push({ ...entry, reasoning: undefined, isThinking: false });
      continue;
    }
    flush();
    result.push(entry);
  }
  flush();
  if (options.compactionState && options.compactionState !== "idle")
    result.push({ kind: "compaction-state", key: "compaction-state", state: options.compactionState });

  // Reuse an overlapping group's identity when older history is prepended.
  // Reserve exact keys first so splitting a group cannot assign one key twice.
  const priorByMember = new Map<string, string>();
  const previousByKey = new Map<string, PresentationEntry>();
  for (const row of options.previous ?? []) {
    previousByKey.set(presentationKey(row), row);
    if ("kind" in row && row.kind === "activity-group") {
      for (const member of row.entries) {
        priorByMember.set(member.key, row.key);
        previousByKey.set(member.key, member);
      }
    }
  }
  const reserved = new Set(result.flatMap((row) => ("kind" in row && row.kind === "activity-group" ? [row.key] : [])));
  const claimed = new Set<string>();
  for (const row of result) {
    if (!("kind" in row) || row.kind !== "activity-group") continue;
    const previous = row.entries
      .map((member) => priorByMember.get(member.key))
      .find((key) => key !== undefined && !claimed.has(key) && (key === row.key || !reserved.has(key)));
    if (previous) row.key = previous;
    claimed.add(row.key);
  }

  // Like V2 reuseTimelineRows, stable keys also retain unchanged row objects so
  // the existing React virtual-row memo boundary isolates unrelated deltas.
  // Canonicalize members first; any changed source/member or concealment keeps
  // its new wrapper and invalidates exactly the containing group.
  const reuse = <T extends PresentationEntry>(entry: T): T => {
    const previous = previousByKey.get(presentationKey(entry));
    return previous && samePresentationRow(previous, entry) ? (previous as T) : entry;
  };
  for (let index = 0; index < result.length; index++) {
    const row = result[index];
    if (!row) continue;
    if ("kind" in row && row.kind === "activity-group") row.entries = row.entries.map(reuse);
    result[index] = reuse(row);
  }
  return result;
}
