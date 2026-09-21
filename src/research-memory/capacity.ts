import { createHash } from "node:crypto";
import { listNames, memoryDirectory } from "./filesystem.js";
import type { ReadBudget } from "./filesystem.js";
import { checkAbort, ensure, MEMORY_LIMITS } from "./policy.js";

function slotId(namespace: string, slot: number): string {
  // RFC UUIDv5 in the standard URL namespace. These are identities, not secrets;
  // evidence hashing remains SHA-256. Physical namespace identity makes aliases
  // of one initialized agentDir compete for exactly the same finite slots.
  const bytes = createHash("sha1")
    .update(Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex"))
    .update(`easyresearch:research-memory:${namespace}:${slot}`)
    .digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex", 0, 16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A directory is only a candidate; exclusive publication of 1.json claims it. */
export async function* newRecordCandidates(agentDir: string, parts: string[], budget: ReadBudget, signal?: AbortSignal) {
  const namespace = await memoryDirectory(agentDir, parts, true, signal);
  ensure(namespace, "IO", "Memory namespace is unavailable.");
  const names = await listNames(namespace, MEMORY_LIMITS.records, budget, signal);
  const slots = Array.from({ length: MEMORY_LIMITS.records }, (_, slot) => slotId(namespace.path, slot));
  const slotSet = new Set(slots);
  const legacyCount = names.filter(name => !slotSet.has(name)).length;

  // Existing non-slot histories never disappear or change identity. New writers
  // all use this same finite prefix, so even overlapping directory snapshots
  // cannot over-admit. Empty/draft-only slots left by interruption are reusable.
  for (const id of slots.slice(0, MEMORY_LIMITS.records - legacyCount)) {
    checkAbort(signal);
    await namespace.assert();
    const directory = await memoryDirectory(agentDir, [...parts, id], true, signal);
    ensure(directory, "IO", "Memory publication directory is unavailable.");
    const files = await listNames(directory, MEMORY_LIMITS.directoryEntries, budget, signal);
    if (files.some(name => !name.startsWith(".draft-"))) continue;
    await namespace.assert();
    yield { id, directory };
  }
}
