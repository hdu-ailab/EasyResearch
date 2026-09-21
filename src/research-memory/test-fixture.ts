import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryActor, MemoryEntry, MemoryVerification } from "./types.js";

export function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    kind: "method", title: "Verify citation metadata", roles: ["search", "writing"],
    tags: ["citation"], conditions: "When a citation has an identifier",
    procedure: "Compare the identifier against the source metadata before citing.",
    limitations: "Does not establish the scientific claim.", rationale: "Avoid mismatched references.",
    evidencePaths: ["source.md"], ...overrides,
  };
}

export function verification(overrides: Partial<MemoryVerification> = {}): MemoryVerification {
  return {
    outcome: "pass", summary: "Independent replay and regression passed.", evidencePaths: ["verification.md"],
    checks: [
      { name: "metadata replay", kind: "replay", outcome: "pass", details: "The report records a correct identifier match." },
      { name: "retained citation", kind: "regression", outcome: "pass", details: "The report records retention of the old case." },
    ], ...overrides,
  };
}

export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "research-memory-test-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const otherCwd = join(root, "other-project");
  await Promise.all([agentDir, cwd, otherCwd].map(path => mkdir(path)));
  await writeFile(join(cwd, "source.md"), "Observed citation mismatch and corrected identifier.\n");
  await writeFile(join(cwd, "verification.md"), "Held-out replay and retained-case regression attestations.\n");
  const author: MemoryActor = { cwd, sessionId: randomUUID(), agent: "search", model: "test/model" };
  const verifier: MemoryActor = { ...author, sessionId: randomUUID() };
  const assistant: MemoryActor = { ...author, sessionId: randomUUID(), agent: "research-assistant" };
  return { root, agentDir, cwd, otherCwd, author, verifier, assistant, cleanup: () => rm(root, { recursive: true, force: true }) };
}
