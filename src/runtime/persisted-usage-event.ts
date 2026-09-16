import { notificationBatchId } from "../subagent/notifications";

interface SessionEntryReader {
  getEntries(): readonly unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Publish Pi's exact entry after usage or supervisor-message persistence. */
export function publishPersistedUsageEntry(
  event: unknown,
  sessionManager: SessionEntryReader,
  publish: (event: { type: "entry_appended"; entry: unknown }) => void,
): void {
  if (!isRecord(event)) return;
  let matches: (candidate: Record<string, unknown>) => boolean;
  if (event.type === "message_end" && isRecord(event.message)) {
    const message = event.message;
    if (message.role === "custom" && notificationBatchId(message)) {
      // Pi copies custom-message fields, but retains this delivery's details object.
      matches = (candidate) => candidate.type === "custom_message"
        && candidate.customType === message.customType
        && candidate.details === message.details
        && candidate.content === message.content
        && candidate.display === message.display;
    } else {
      if ((message.role !== "assistant" && message.role !== "toolResult") || !isRecord(message.usage)) return;
      matches = (candidate) => candidate.type === "message" && candidate.message === message;
    }
  } else {
    return;
  }

  queueMicrotask(() => {
    try {
      const entry = [...sessionManager.getEntries()].reverse().find((candidate) =>
        isRecord(candidate)
        && matches(candidate)
      );
      if (entry) publish({ type: "entry_appended", entry });
    } catch {
      // Projection is observational and must never affect Agent execution.
    }
  });
}
