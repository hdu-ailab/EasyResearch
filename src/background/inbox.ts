import { assertNativeJournalEntryDurable, assertNativeJournalMaterialized } from "./execution-claims";

export const BACKGROUND_INBOX_TYPE = "easyresearch:background_inbox";

export interface BackgroundInput {
  id: string;
  customType: string;
  content: string;
  wake?: boolean;
}

export interface BackgroundInboxJournal {
  getSessionId(): string;
  getEntries(): readonly unknown[];
  appendCustomEntry(type: string, data: unknown): string;
  getSessionFile?(): string | undefined;
  appendCustomMessageEntry?(type: string, content: string, display: boolean, details: unknown): string;
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const same = (left: BackgroundInput, right: BackgroundInput) => left.customType === right.customType && left.content === right.content;

function input(value: unknown): value is BackgroundInput {
  return object(value) && typeof value.id === "string" && !!value.id
    && typeof value.customType === "string" && !!value.customType && typeof value.content === "string"
    && (value.wake === undefined || typeof value.wake === "boolean");
}

function state(journal: BackgroundInboxJournal) {
  const pending = new Map<string, BackgroundInput>();
  const delivered = new Map<string, BackgroundInput>();
  const pendingEntries = new Map<string, unknown>();
  const deliveredEntries = new Map<string, unknown>();
  const sessionID = journal.getSessionId();
  for (const entry of journal.getEntries()) {
    if (!object(entry)) continue;
    if (entry.type === "custom" && entry.customType === BACKGROUND_INBOX_TYPE && object(entry.data)
      && entry.data.ownerSessionID === sessionID && input(entry.data)) {
      const value: BackgroundInput = { id: entry.data.id, customType: entry.data.customType, content: entry.data.content,
        ...(typeof entry.data.wake === "boolean" ? { wake: entry.data.wake } : {}) };
      const previous = pending.get(value.id);
      if (previous && !same(previous, value)) throw new Error("Background inbox ID conflict.");
      // Delivery policy is first-admission-wins, not part of identity or content.
      if (!previous) { pending.set(value.id, value); pendingEntries.set(value.id, entry); }
    }
    if (entry.type === "custom_message" && object(entry.details) && entry.details.ownerSessionID === sessionID
      && typeof entry.details.inputID === "string" && typeof entry.customType === "string" && typeof entry.content === "string") {
      const value = { id: entry.details.inputID, customType: entry.customType, content: entry.content };
      const previous = delivered.get(value.id);
      if (previous && !same(previous, value)) throw new Error("Background inbox ID conflict.");
      delivered.set(value.id, value);
      deliveredEntries.set(value.id, entry);
    }
  }
  for (const [id, value] of delivered) {
    const previous = pending.get(id);
    if (previous && !same(previous, value)) throw new Error("Background inbox ID conflict.");
  }
  return { pending, delivered, pendingEntries, deliveredEntries };
}

/** Commit one stable notification identity before asking Pi to wake or steer. */
export function admitBackgroundInput(journal: BackgroundInboxJournal, value: BackgroundInput): "delivered" | "pending" {
  if (!input(value)) throw new Error("Invalid background input.");
  const { pending, delivered, pendingEntries, deliveredEntries } = state(journal);
  const existing = delivered.get(value.id) ?? pending.get(value.id);
  if (existing && !same(existing, value)) throw new Error("Background inbox ID conflict.");
  if (delivered.has(value.id)) {
    assertNativeJournalEntryDurable(journal, deliveredEntries.get(value.id));
    return "delivered";
  }
  if (!pending.has(value.id)) {
    assertNativeJournalMaterialized(journal);
    const id = journal.appendCustomEntry(BACKGROUND_INBOX_TYPE, { ...value, ownerSessionID: journal.getSessionId() });
    assertNativeJournalEntryDurable(journal, journal.getEntries().find((entry) => object(entry) && entry.id === id));
  } else assertNativeJournalEntryDurable(journal, pendingEntries.get(value.id));
  return "pending";
}

export function pendingBackgroundInputs(journal: BackgroundInboxJournal): BackgroundInput[] {
  const { pending, delivered, pendingEntries } = state(journal);
  return [...pending.values()].filter((value) => !delivered.has(value.id)).map((value) => {
    assertNativeJournalEntryDurable(journal, pendingEntries.get(value.id));
    return value;
  });
}

/** At terminal idle, retain accepted results in native history without granting a wake. */
export function preserveBackgroundInputsWithoutWake(journal: BackgroundInboxJournal): void {
  for (const value of state(journal).pending.values()) {
    // This also verifies previously committed progress after a partial write failure.
    if (admitBackgroundInput(journal, value) === "delivered") continue;
    if (!journal.appendCustomMessageEntry) throw new Error("Native inbox disposition requires custom-message persistence.");
    const id = journal.appendCustomMessageEntry(value.customType, value.content, false, {
      inputID: value.id, ownerSessionID: journal.getSessionId(),
    });
    assertNativeJournalEntryDurable(journal, journal.getEntries().find((entry) => object(entry) && entry.id === id));
  }
}
