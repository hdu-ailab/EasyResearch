import { createHash } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MEMORY_LIMITS } from "./policy.js";
import { createResearchMemoryStore } from "./store.js";
import { entry, fixture, verification } from "./test-fixture.js";
import type { MemoryRecord, StoredRecord } from "./types.js";

describe("recall exact scan exhaustion", () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let store: ReturnType<typeof createResearchMemoryStore>;
  beforeEach(async () => { f = await fixture(); store = createResearchMemoryStore(f.agentDir); });
  afterEach(async () => { await f.cleanup(); });
  const target = (record: MemoryRecord) => ({ id: record.id, expectedRevision: record.revision });

  async function library(prefixCount: number) {
    const proposed = (await store.execute({ action: "propose", entry: entry({ title: "unvisitedneedle" }) }, f.author)).record!;
    const checked = (await store.execute({ action: "verify", ...target(proposed), verification: verification() }, f.verifier)).record!;
    const active = (await store.execute({ action: "activate", ...target(checked) }, f.assistant)).record!;
    const namespace = join(f.agentDir, "research-memory", "projects", createHash("sha256").update(f.cwd).digest("hex"));
    const history: StoredRecord[] = await Promise.all(Array.from({ length: active.revision }, async (_, i) =>
      JSON.parse(await readFile(join(namespace, active.id, `${i + 1}.json`), "utf8"))));
    // Real, valid disk histories copied from store-published snapshots, ordered
    // before the UUIDv5 target. Only the target's authored content matches.
    const prefixes = await Promise.all(Array.from({ length: prefixCount }, async (_, i) => {
      const id = `00000000-0000-4000-8000-${i.toString().padStart(12, "0")}`;
      expect(id < active.id).toBe(true);
      const directory = join(namespace, id);
      await mkdir(directory);
      await Promise.all(history.map(async snapshot => {
        const copy = structuredClone(snapshot);
        copy.id = id;
        for (const version of [copy.active, copy.pending]) if (version) version.entry.title = "Ordinary citation check";
        await writeFile(join(directory, `${copy.revision}.json`), JSON.stringify(copy));
      }));
      return directory;
    }));
    return { active, prefixes, targetPath: join(namespace, active.id, `${active.revision}.json`) };
  }

  it.each(["entries", "bytes"] as const)("reports exact %s exhaustion only when records remain unvisited", async budget => {
    const prefixCount = Math.ceil(budget === "entries"
      ? MEMORY_LIMITS.scanEntries / MEMORY_LIMITS.directoryEntries
      : MEMORY_LIMITS.scanBytes / MEMORY_LIMITS.recordBytes);
    const { active, prefixes, targetPath } = await library(prefixCount);
    let releaseTargetBudget: () => Promise<void>;
    if (budget === "entries") {
      // Namespace ids and every revision/draft name consume the real entry
      // budget. Inert crash drafts fill it without exceeding any directory cap.
      let remaining = MEMORY_LIMITS.scanEntries - (prefixCount + 1);
      for (const [i, directory] of prefixes.entries()) {
        const names = Math.min(MEMORY_LIMITS.directoryEntries, remaining - (prefixCount - i - 1) * active.revision);
        await Promise.all(Array.from({ length: names - active.revision }, (_, j) => writeFile(join(directory, `.draft-budget-${j}`), "")));
        remaining -= names;
      }
      expect(remaining).toBe(0);
      releaseTargetBudget = async () => {
        await Promise.all(Array.from({ length: active.revision }, (_, i) => unlink(join(prefixes[0]!, `.draft-budget-${i}`))));
      };
    } else {
      // Legal JSON whitespace changes only actual bytes read, not the record's
      // content or validation. No mocked read or production budget override.
      let remaining = MEMORY_LIMITS.scanBytes;
      for (const directory of prefixes) {
        const path = join(directory, `${active.revision}.json`);
        const bytes = await readFile(path);
        const size = Math.min(MEMORY_LIMITS.recordBytes, remaining);
        await writeFile(path, Buffer.concat([bytes, Buffer.alloc(size - bytes.length, " ")]));
        remaining -= size;
      }
      expect(remaining).toBe(0);
      releaseTargetBudget = async () => {
        const path = join(prefixes[0]!, `${active.revision}.json`);
        const bytes = await readFile(path);
        await writeFile(path, bytes.subarray(0, bytes.length - (await readFile(targetPath)).length));
      };
    }

    // The hidden match is valid and accessible on its own budget.
    expect((await store.execute({ action: "get", id: active.id }, f.author)).record?.active?.entry.title).toBe("unvisitedneedle");
    expect(await store.execute({ action: "recall", scope: "project", query: "unvisitedneedle" }, f.author))
      .toEqual({ memories: [], diagnostics: [], truncated: true });

    // Make exactly enough room for the target: exhausting the budget at the
    // final record is complete, including when no record matches the query.
    await releaseTargetBudget();
    const complete = await store.execute({ action: "recall", scope: "project", query: "unvisitedneedle" }, f.author);
    expect(complete.memories?.map(memory => memory.ref)).toEqual([{ scope: "project", id: active.id, revision: active.revision }]);
    expect(complete.diagnostics).toEqual([]);
    expect(complete.truncated).toBe(false);
    expect(await store.execute({ action: "recall", scope: "project", query: "absentneedle" }, f.author))
      .toEqual({ memories: [], diagnostics: [], truncated: false });
  }, 30_000);
});
