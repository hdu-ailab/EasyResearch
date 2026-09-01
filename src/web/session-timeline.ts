import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { AGENT_STATUS_TYPE } from "../subagent/notifications";
import type { TranscriptTimelineEntryDto } from "./contracts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAgentMessage(value: unknown): value is AgentMessage {
  return isRecord(value) && typeof value.role === "string" && value.role.length > 0;
}

function isHiddenStatusMessage(value: unknown): boolean {
  return isRecord(value)
    && value.role === "custom"
    && value.customType === AGENT_STATUS_TYPE;
}

export function projectSessionTimeline(entries: readonly unknown[]): TranscriptTimelineEntryDto[] {
  const timeline: TranscriptTimelineEntryDto[] = [];
  for (const value of entries) {
    if (!isRecord(value) || typeof value.id !== "string") continue;
    if (value.type === "message" && isAgentMessage(value.message) && !isHiddenStatusMessage(value.message)) {
      timeline.push({ kind: "message", entryId: value.id, message: value.message });
      continue;
    }
    if (
      value.type === "custom_message"
      && value.display === true
      && typeof value.customType === "string"
      && (typeof value.content === "string" || Array.isArray(value.content))
    ) {
      const parsedTimestamp = typeof value.timestamp === "string" ? Date.parse(value.timestamp) : Number.NaN;
      timeline.push({
        kind: "message",
        entryId: value.id,
        message: {
          role: "custom",
          customType: value.customType,
          content: value.content,
          display: true,
          timestamp: Number.isFinite(parsedTimestamp) ? parsedTimestamp : 0,
        },
      });
      continue;
    }
    if (value.type !== "compaction" && value.type !== "branch_summary") continue;
    timeline.push({
      kind: value.type === "compaction" ? "compaction" : "branch-summary",
      entryId: value.id,
      timestamp: typeof value.timestamp === "string" ? value.timestamp : "",
      ...(typeof value.summary === "string" ? { summary: value.summary } : {}),
    });
  }
  return timeline;
}
