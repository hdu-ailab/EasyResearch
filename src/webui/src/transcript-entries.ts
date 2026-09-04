import type { ApiUsageStatisticsDto, ApiUsageTotalsDto } from "../../web/contracts";
import type { SessionMessageView, SessionSummaryView, ToolView } from "./session-reducer";

export type PendingTranscriptEntry = { kind: "pending" };
export type TranscriptEntry = SessionMessageView | ToolView | SessionSummaryView | PendingTranscriptEntry;

export function mergeTranscriptEntries(
  messages: readonly SessionMessageView[],
  tools: readonly ToolView[],
  summaries: readonly SessionSummaryView[],
  pending: boolean,
): TranscriptEntry[] {
  const result: TranscriptEntry[] = [];
  let messageIndex = 0;
  let toolIndex = 0;
  let summaryIndex = 0;

  while (messageIndex < messages.length || toolIndex < tools.length || summaryIndex < summaries.length) {
    const message = messages[messageIndex];
    const tool = tools[toolIndex];
    const summary = summaries[summaryIndex];
    const order = Math.min(
      message?.order ?? Number.POSITIVE_INFINITY,
      tool?.order ?? Number.POSITIVE_INFINITY,
      summary?.order ?? Number.POSITIVE_INFINITY,
    );
    if (message?.order === order) {
      result.push(message);
      messageIndex += 1;
      continue;
    }
    if (tool?.order === order) {
      result.push(tool);
      toolIndex += 1;
      continue;
    }
    if (summary) {
      result.push(summary);
      summaryIndex += 1;
    }
  }
  if (pending) result.push({ kind: "pending" });
  return result;
}

export function indexSubtreeUsage(value?: ApiUsageStatisticsDto): ReadonlyMap<string, ApiUsageTotalsDto> {
  return new Map(value?.sessions.map((session) => [session.sessionId, session.subtree] as const) ?? []);
}
