interface SessionEntryReader {
  getEntries(): readonly unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Publish Pi's exact entry after a usage-bearing lifecycle event is persisted. */
export function publishPersistedUsageEntry(
  event: unknown,
  sessionManager: SessionEntryReader,
  publish: (event: { type: "entry_appended"; entry: unknown }) => void,
): void {
  if (!isRecord(event)) return;
  let matches: (candidate: Record<string, unknown>) => boolean;
  if (event.type === "message_end" && isRecord(event.message)) {
    const message = event.message;
    if (
      (message.role !== "assistant" && message.role !== "toolResult")
      || !isRecord(message.usage)
    ) return;
    matches = (candidate) => candidate.type === "message" && candidate.message === message;
  } else if (
    event.type === "compaction_end"
    && isRecord(event.result)
    && isRecord(event.result.usage)
  ) {
    const usage = event.result.usage;
    matches = (candidate) => candidate.type === "compaction" && candidate.usage === usage;
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
      // Usage projection is observational and must never affect Agent execution.
    }
  });
}
