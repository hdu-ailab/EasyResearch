import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MEMORY_LIMITS } from "./policy.js";
import { createResearchMemoryStore } from "./store.js";
import { entry, fixture, verification } from "./test-fixture.js";
import type { MemoryRecord, MemoryScope } from "./types.js";

describe("namespace capacity admission", () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let store: ReturnType<typeof createResearchMemoryStore>;
  beforeEach(async () => { f = await fixture(); store = createResearchMemoryStore(f.agentDir); });
  afterEach(async () => { await f.cleanup(); });
  const target = (record: MemoryRecord) => ({ scope: record.scope, id: record.id, expectedRevision: record.revision });

  async function seedActive(count: number, scope: MemoryScope = "project") {
    const author = scope === "shared" ? f.assistant : f.author;
    const proposed = (await store.execute({ action: "propose", scope, entry: entry() }, author)).record!;
    const proof = verification();
    if (scope === "shared") proof.checks.push({ name: "transfer", kind: "transfer", outcome: "pass", details: "Held-out task attested in the report." });
    const checked = (await store.execute({ action: "verify", ...target(proposed), verification: proof }, f.verifier)).record!;
    const active = (await store.execute({ action: "activate", ...target(checked) }, f.assistant)).record!;
    const namespace = join(f.agentDir, "research-memory", ...(scope === "shared" ? ["shared"] : ["projects", createHash("sha256").update(f.cwd).digest("hex")]));
    const history = await Promise.all([1, 2, 3].map(async revision => JSON.parse(await readFile(join(namespace, active.id, `${revision}.json`), "utf8"))));
    // Seed actual valid on-disk histories from the consuming store's snapshots.
    // UUIDv4 copies also exercise admission alongside pre-fix record identities.
    await Promise.all(Array.from({ length: count - 1 }, async () => {
      const id = randomUUID();
      await mkdir(join(namespace, id));
      await Promise.all(history.map(snapshot => writeFile(join(namespace, id, `${snapshot.revision}.json`), JSON.stringify({ ...snapshot, id }))));
    }));
    return { active, namespace, author };
  }

  it.each(["project", "shared"] as const)("refuses a new %s record at capacity while preserving active discovery and replacement", async scope => {
    const { active, namespace, author } = await seedActive(MEMORY_LIMITS.records, scope);
    const before = await store.execute({ action: "recall", scope, query: "citation" }, f.author);
    expect(before.memories).toHaveLength(MEMORY_LIMITS.defaultResults);
    expect(before.diagnostics).toEqual([]);
    await expect(store.execute({ action: "propose", scope, entry: entry() }, author)).rejects.toMatchObject({ code: "LIMIT" });
    expect(await store.execute({ action: "recall", scope, query: "citation" }, f.author)).toEqual(before);
    expect(await readdir(namespace)).toHaveLength(MEMORY_LIMITS.records);
    const replacement = (await store.execute({ action: "propose", ...target(active), entry: entry({ title: "Improved citation method" }) }, author)).record!;
    expect(replacement.active).toEqual(active.active);
    await store.execute({ action: "reject", ...target(replacement), reason: "Keep the incumbent" }, f.assistant);
    expect((await store.execute({ action: "get", scope, id: active.id }, f.author)).record?.active).toEqual(active.active);
    expect(await readdir(namespace)).toHaveLength(MEMORY_LIMITS.records);
  });

  it("admits only one concurrent creator into the final slot across independent stores", async () => {
    const { namespace } = await seedActive(MEMORY_LIMITS.records - 1);
    const before = await store.execute({ action: "recall", query: "citation" }, f.author);
    const results = await Promise.allSettled(Array.from({ length: 8 }, () =>
      createResearchMemoryStore(f.agentDir).execute({ action: "propose", entry: entry() }, f.author)));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results) if (result.status === "rejected") expect(result.reason.code).toBe("LIMIT");
    expect(await readdir(namespace)).toHaveLength(MEMORY_LIMITS.records);
    expect(await store.execute({ action: "recall", query: "citation" }, f.author)).toEqual(before);
  });

  it("reuses an interrupted empty final slot without removing another writer's draft", async () => {
    const { namespace } = await seedActive(MEMORY_LIMITS.records - 1);
    const interrupted = (await store.execute({ action: "propose", entry: entry() }, f.author)).record!;
    // Reproduce the disk state of a crash before the first exclusive publication:
    // the record directory and an inert draft exist, but no revision was linked.
    await unlink(join(namespace, interrupted.id, "1.json"));
    await writeFile(join(namespace, interrupted.id, ".draft-interrupted"), "unfinished foreign draft");
    const recovered = (await createResearchMemoryStore(f.agentDir).execute({ action: "propose", entry: entry() }, f.author)).record!;
    expect(recovered.id).toBe(interrupted.id);
    expect(recovered.pending?.entry).toEqual(entry());
    expect(await readdir(namespace)).toHaveLength(MEMORY_LIMITS.records);
    expect(await readFile(join(namespace, interrupted.id, ".draft-interrupted"), "utf8")).toBe("unfinished foreign draft");
    expect((await store.execute({ action: "recall" }, f.author)).memories).toHaveLength(MEMORY_LIMITS.defaultResults);
  });

  it("allows concurrent creators to retry occupied first-revision slots while capacity remains", async () => {
    const records = await Promise.all(Array.from({ length: 8 }, async () =>
      (await createResearchMemoryStore(f.agentDir).execute({ action: "propose", entry: entry() }, f.author)).record!));
    expect(new Set(records.map(record => record.id)).size).toBe(records.length);
    for (const record of records) {
      expect((await store.execute({ action: "get", id: record.id }, f.author)).record?.pending?.entry).toEqual(entry());
    }
  });
});
