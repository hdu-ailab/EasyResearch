import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ApiUsageRecordDto, TranscriptPageDto, TranscriptTimelineEntryDto } from "./contracts";

type Transcript = Pick<TranscriptPageDto, "timeline" | "inlineUsage">;
interface Cursor { session: string; anchor: string; before: string }
export class TranscriptCursorError extends Error {
  constructor() { super("History changed or the cursor is invalid. Reload the session history."); }
}

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const clip = (value: string, size: number) => value.length > size ? `${value.slice(0, size).replace(/[\uD800-\uDBFF]$/, "")}…` : value;

function decodeCursor(session: string, token: string): Cursor {
  try {
    if (token.length > 4096 || !/^[\w-]+$/.test(token)) throw new Error();
    const value = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (value.session !== session || typeof value.anchor !== "string" || !value.anchor
      || typeof value.before !== "string" || !value.before) throw new Error();
    return value;
  } catch { throw new TranscriptCursorError(); }
}

/** Small display-only arguments, never passed back to an Agent or tool. */
function previewValue(value: unknown, textLimit: number, depth = 0): unknown {
  if (typeof value === "string") return clip(value, textLimit);
  if (value === null || typeof value !== "object") return value;
  if (depth >= 2) return "…";
  if (Array.isArray(value)) return value.slice(0, 4).map((item) => previewValue(item, textLimit, depth + 1));
  return Object.fromEntries(Object.entries(value).slice(0, 4).map(([key, item]) => [clip(key, 64), previewValue(item, textLimit, depth + 1)]));
}

function previewEntry(entry: TranscriptTimelineEntryDto, bytes: number, budget: number): TranscriptTimelineEntryDto {
  const textLimit = Math.max(32, Math.min(2000, Math.floor(budget / 128)));
  const deferred = { bytes };
  if (entry.kind === "compaction" || entry.kind === "branch-summary") {
    return { ...entry, summary: entry.summary === undefined ? undefined : clip(entry.summary, textLimit), deferred };
  }
  if (entry.kind === "subagent-completion") {
    return { ...entry, deferred, outcomes: entry.outcomes.slice(0, 8).map((outcome) => ({
      ...outcome, ...(outcome.text === undefined ? {} : { text: clip(outcome.text, textLimit) }),
    })) };
  }
  const source = entry.message as unknown as Record<string, unknown>;
  const message: Record<string, unknown> = {};
  for (const key of ["role", "id", "timestamp", "toolCallId", "toolName", "isError", "stopReason", "errorMessage", "customType", "display"]) {
    const value = source[key];
    if (value !== undefined) message[key] = typeof value === "string" ? clip(value, key === "errorMessage" ? textLimit : 512) : value;
  }
  message.content = typeof source.content === "string" ? clip(source.content, textLimit)
    : Array.isArray(source.content) ? source.content.slice(0, 8).map((block: Record<string, unknown>) => {
      if (block.type === "toolCall") return {
        type: "toolCall", id: block.id, name: block.name, arguments: previewValue(block.arguments, Math.max(1, Math.min(128, Math.floor(budget / 2048)))),
      };
      if (block.type === "thinking") return { type: "thinking", thinking: clip(String(block.thinking ?? ""), textLimit) };
      return { type: "text", text: clip(String(block.text ?? "…"), textLimit) };
    }) : [];
  const preview = { kind: "message" as const, entryId: entry.entryId, message: message as unknown as AgentMessage, deferred };
  if (jsonBytes(preview) <= budget) return preview;
  // Even argument keys/identities may be unusually large. Keep a valid visible
  // placeholder rather than leaking an unbounded display projection onto SSE.
  return { kind: "message", entryId: entry.entryId, deferred, message: {
    role: source.role,
    timestamp: source.timestamp,
    ...(typeof source.stopReason === "string" ? { stopReason: clip(source.stopReason, 64) } : {}),
    ...(typeof source.errorMessage === "string" ? { errorMessage: clip(source.errorMessage, 128) } : {}),
    ...(source.role === "toolResult" ? { toolCallId: entry.entryId, toolName: clip(String(source.toolName ?? "tool"), 64), isError: source.isError } : {}),
    content: [{ type: "text", text: "…" }],
  } as AgentMessage };
}

function windowUsage(records: readonly ApiUsageRecordDto[], timeline: readonly TranscriptTimelineEntryDto[]): ApiUsageRecordDto[] {
  const entries = new Set(timeline.map((entry) => entry.entryId));
  // Each projected record is keyed by its own persisted Pi entry. A render
  // anchor may live on a different page (or reuse a provider tool-call id).
  return records.filter((record) => entries.has(record.id));
}

/** A cursor pins immutable Pi entries. New appends do not move an older page. */
export function pageTranscript(
  session: string,
  source: Transcript,
  token?: string,
  limits: { entries?: number; bytes?: number } = {},
): TranscriptPageDto {
  const maxEntries = limits.entries ?? 64;
  const maxBytes = limits.bytes ?? 1024 * 1024;
  const maxEntryBytes = Math.min(128 * 1024, Math.floor(maxBytes / 4));
  const cursor = token === undefined ? undefined : decodeCursor(session, token);
  const timeline = source.timeline;
  const anchor = cursor?.anchor ?? timeline.at(-1)?.entryId;
  const end = cursor === undefined ? timeline.length : timeline.findIndex((entry) => entry.entryId === cursor.before);
  if (cursor && (end < 0 || timeline.findIndex((entry) => entry.entryId === cursor.anchor) < end)) throw new TranscriptCursorError();
  let start = end;
  let bytes = 1024;
  const selected: TranscriptTimelineEntryDto[] = [];
  while (start > 0 && selected.length < maxEntries) {
    const original = timeline[start - 1]!;
    const originalBytes = jsonBytes(original);
    const entry = originalBytes <= maxEntryBytes ? original : previewEntry(original, originalBytes, maxEntryBytes);
    const size = jsonBytes(entry);
    if (selected.length && bytes + size > maxBytes) break;
    selected.unshift(entry);
    start--;
    bytes += size;
  }
  const result = (): TranscriptPageDto => ({
    timeline: selected,
    ...(source.inlineUsage === undefined ? {} : { inlineUsage: windowUsage(source.inlineUsage, selected) }),
    ...(start > 0 && anchor ? { history: { cursor: Buffer.from(JSON.stringify({ session, anchor, before: selected[0]!.entryId } satisfies Cursor)).toString("base64url") } } : {}),
  });
  let page = result();
  // Usage records and the opaque cursor also belong to the serialized page budget.
  while (selected.length > 1 && jsonBytes(page) > maxBytes) {
    selected.shift();
    start++;
    page = result();
  }
  return page;
}

export function readTranscriptEntry(source: Transcript, entryId: string): TranscriptTimelineEntryDto | undefined {
  return source.timeline.find((entry) => entry.entryId === entryId);
}

export function windowTranscript<T extends Transcript & { subagents?: Array<{ latestMessage?: string }> }>(session: string, snapshot: T): T & TranscriptPageDto {
  return {
    ...snapshot,
    ...pageTranscript(session, snapshot),
    ...(snapshot.subagents === undefined ? {} : { subagents: snapshot.subagents.map((item) => ({
      ...item, ...(item.latestMessage === undefined ? {} : { latestMessage: clip(item.latestMessage, 4000) }),
    })) }),
  };
}
