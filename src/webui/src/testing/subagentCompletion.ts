import type { TranscriptTimelineEntryDto } from "../../../web/contracts";

export function completionEntry(
  overrides: Partial<Extract<TranscriptTimelineEntryDto, { kind: "subagent-completion" }>> = {},
): Extract<TranscriptTimelineEntryDto, { kind: "subagent-completion" }> {
  return {
    kind: "subagent-completion",
    entryId: "notification-1",
    timestamp: "2026-09-16T12:00:00.000Z",
    batchId: "batch-1",
    outcomes: [
      { launchId: "launch-1", agentId: "search_0", status: "complete", text: "First sentence.\n\nFinal **details**." },
      { launchId: "launch-2", agentId: "search_1", status: "error" },
    ],
    ...overrides,
  };
}
