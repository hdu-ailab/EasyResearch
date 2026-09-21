import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createResearchMemoryStore } from "./store.js";
import type { MemoryRecord, MemoryScope, ResearchMemoryRequest } from "./types.js";
import { entry, fixture, verification } from "./test-fixture.js";

describe("immutable memory store", () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let store: ReturnType<typeof createResearchMemoryStore>;
  beforeEach(async () => { f = await fixture(); store = createResearchMemoryStore(f.agentDir); });
  afterEach(async () => { await f.cleanup(); });
  const identity = (record: MemoryRecord) => ({ scope: record.scope, id: record.id, expectedRevision: record.revision });
  async function propose(scope: MemoryScope = "project") {
    return (await store.execute({ action: "propose", scope, entry: entry() }, scope === "shared" ? f.assistant : f.author)).record!;
  }
  async function activate(record: MemoryRecord) {
    const result = verification();
    if (record.scope === "shared") result.checks.push({ name: "new task", kind: "transfer", outcome: "pass", details: "Held-out transfer attested in the report." });
    const checked = (await store.execute({ action: "verify", ...identity(record), verification: result }, f.verifier)).record!;
    return (await store.execute({ action: "activate", ...identity(checked) }, f.assistant)).record!;
  }
  function recordDir(record: MemoryRecord) {
    const namespace = record.scope === "shared" ? ["shared"] : ["projects", createHash("sha256").update(f.cwd).digest("hex")];
    return join(f.agentDir, "research-memory", ...namespace, record.id);
  }

  it("is lazy, and missing memory is empty without creating storage", async () => {
    expect(await readdir(f.agentDir)).toEqual([]);
    expect(await store.execute({ action: "recall", query: "citation" }, f.author)).toEqual({ memories: [], diagnostics: [], truncated: false });
    expect(await readdir(f.agentDir)).toEqual([]);
  });

  it("keeps proposals out of recall and binds verification to another real caller identity", async () => {
    const proposed = await propose();
    expect(proposed.pending?.entry.title).toBe(entry().title);
    expect((await store.execute({ action: "recall", query: "citation" }, f.author)).memories).toEqual([]);
    await expect(store.execute({ action: "verify", ...identity(proposed), verification: verification() }, f.author)).rejects.toThrow(/independent|session/i);
    const accepted = await activate(proposed);
    expect(accepted.pending).toBeUndefined();
    expect(accepted.active?.proposalRevision).toBe(proposed.revision);
    const recalled = await store.execute({ action: "recall", query: "citation", role: "writing" }, f.author);
    expect(recalled.memories?.[0]?.ref).toEqual({ scope: accepted.scope, id: accepted.id, revision: accepted.revision });
    expect((await store.execute({ action: "recall", query: "unrelated spectroscopy" }, f.author)).memories).toEqual([]);
    expect((await store.execute({ action: "recall", role: "experiment" }, f.author)).memories).toEqual([]);
  });

  it("preserves incumbent and pinned bytes during replacement, rejection, retirement and rollback", async () => {
    const first = await activate(await propose());
    const originalBytes = await readFile(join(recordDir(first), `${first.revision}.json`));
    const pending = (await store.execute({ action: "propose", ...identity(first), entry: entry({ title: "Improved metadata matching" }) }, f.author)).record!;
    expect(pending.active?.entry).toEqual(first.active?.entry);
    expect((await store.execute({ action: "recall" }, f.author)).memories?.[0]?.title).toBe(first.active?.entry.title);
    await expect(store.execute({ action: "propose", ...identity(pending), entry: entry() }, f.author)).rejects.toThrow(/pending/i);
    await expect(store.execute({ action: "rollback", ...identity(pending), revision: first.revision, reason: "restore" }, f.assistant)).rejects.toThrow(/pending/i);
    const rejected = (await store.execute({ action: "reject", ...identity(pending), reason: "Insufficient evidence" }, f.assistant)).record!;
    expect(rejected.active?.entry).toEqual(first.active?.entry);
    const candidate = (await store.execute({ action: "propose", ...identity(rejected), entry: entry({ title: "Improved metadata matching" }) }, f.author)).record!;
    const second = await activate(candidate);
    expect(second.active?.entry.title).not.toBe(first.active?.entry.title);
    const retired = (await store.execute({ action: "retire", ...identity(second), reason: "Regression discovered" }, f.assistant)).record!;
    expect((await store.execute({ action: "recall" }, f.author)).memories).toEqual([]);
    const restored = (await store.execute({ action: "rollback", ...identity(retired), revision: first.revision, reason: "Restore proven incumbent" }, f.assistant)).record!;
    expect(restored.active).toEqual(first.active);
    expect(restored.revision).toBeGreaterThan(retired.revision);
    const pinned = (await store.execute({ action: "get", id: first.id, revision: first.revision }, f.author)).record!;
    expect(pinned.historical).toBe(true);
    expect(pinned.active).toEqual(first.active);
    expect(await readFile(join(recordDir(first), `${first.revision}.json`))).toEqual(originalBytes);
  });

  it("publishes exactly one winner across independent store instances at the same expected revision", async () => {
    const proposed = await propose();
    const request = { action: "verify", ...identity(proposed), verification: verification() } as const;
    const results = await Promise.allSettled([store.execute(request, f.verifier), createResearchMemoryStore(f.agentDir).execute(request, f.verifier)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const failure = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(failure.reason.code).toBe("CONFLICT");
    expect((await readdir(recordDir(proposed))).sort()).toEqual(["1.json", "2.json"]);
    await expect(store.execute(request, f.verifier)).rejects.toThrow(/revision|conflict/i);
  });

  it.each(["source.md", "verification.md"])("rejects activation when %s no longer matches captured proof", async path => {
    const proposed = await propose();
    const checked = (await store.execute({ action: "verify", ...identity(proposed), verification: verification() }, f.verifier)).record!;
    await writeFile(join(f.cwd, path), "Changed bytes after attestation");
    await expect(store.execute({ action: "activate", ...identity(checked) }, f.assistant)).rejects.toThrow(/evidence|changed|stale/i);
    expect((await store.execute({ action: "get", id: proposed.id }, f.author)).record?.revision).toBe(checked.revision);
  });

  it("isolates exact cwd namespaces and redacts foreign shared provenance including mutation results", async () => {
    const local = await activate(await propose());
    const shared = await activate(await propose("shared"));
    const foreign = { ...f.assistant, cwd: f.otherCwd };
    await expect(store.execute({ action: "get", id: local.id }, foreign)).rejects.toThrow();
    const result = await store.execute({ action: "get", scope: "shared", id: shared.id }, foreign);
    const serialized = JSON.stringify(result);
    for (const secret of [f.cwd, f.author.sessionId, f.verifier.sessionId, f.assistant.sessionId, "source.md", "verification.md"]) expect(serialized).not.toContain(secret);
    expect(result.record?.active?.entry.procedure).toBe(entry().procedure);
    expect((await store.execute({ action: "recall" }, foreign)).memories?.map(value => value.ref.id)).toEqual([shared.id]);
    const retired = await store.execute({ action: "retire", ...identity(shared), reason: "No longer applicable" }, foreign);
    expect(JSON.stringify(retired)).not.toContain(f.cwd);
  });

  it("keeps shared verification and activation in the pending origin, including a new project's replacement", async () => {
    const shared = await propose("shared");
    const foreign = { ...f.assistant, cwd: f.otherCwd };
    await expect(store.execute({ action: "verify", ...identity(shared), verification: verification() }, foreign)).rejects.toThrow(/origin|project/i);
    const checked = (await store.execute({ action: "verify", ...identity(shared), verification: verification({ checks: [...verification().checks, { name: "transfer", kind: "transfer", outcome: "pass", details: "new task" }] }) }, f.verifier)).record!;
    await expect(store.execute({ action: "activate", ...identity(checked) }, foreign)).rejects.toThrow(/origin|project/i);
    const active = (await store.execute({ action: "activate", ...identity(checked) }, f.assistant)).record!;
    await writeFile(join(f.otherCwd, "source.md"), "new project evidence");
    await writeFile(join(f.otherCwd, "verification.md"), "new project independent verification");
    const next = (await store.execute({ action: "propose", ...identity(active), entry: entry({ title: "Generalized replacement" }) }, foreign)).record!;
    const verified = (await store.execute({ action: "verify", ...identity(next), verification: verification({ checks: [...verification().checks, { name: "transfer", kind: "transfer", outcome: "pass", details: "new task" }] }) }, { ...f.verifier, cwd: f.otherCwd })).record!;
    await expect(store.execute({ action: "activate", ...identity(verified) }, f.assistant)).rejects.toThrow(/origin|project/i);
    expect((await store.execute({ action: "activate", ...identity(verified) }, foreign)).record?.active?.entry.title).toBe("Generalized replacement");
  });

  it("enforces role permissions on every publication action", async () => {
    await expect(store.execute({ action: "propose", scope: "shared", entry: entry() }, f.author)).rejects.toThrow(/Research Assistant/i);
    const proposed = await propose();
    for (const action of ["activate", "reject", "retire", "rollback"] as const) {
      const request = { action, ...identity(proposed), ...(action !== "activate" ? { reason: "test" } : {}), ...(action === "rollback" ? { revision: 1 } : {}) } as ResearchMemoryRequest;
      await expect(store.execute(request, f.verifier)).rejects.toThrow(/Research Assistant/i);
    }
  });

  it("snapshots caller authority and nested request data before asynchronous work", async () => {
    const request = { action: "propose", entry: entry() } as const;
    const actor = { ...f.author };
    const promise = store.execute(request, actor);
    request.entry.procedure = "tampered procedure";
    request.entry.evidencePaths[0] = "../private";
    actor.cwd = f.otherCwd;
    actor.sessionId = f.verifier.sessionId;
    const proposed = (await promise).record!;
    expect(proposed.pending?.entry.procedure).toBe(entry().procedure);
    expect(proposed.pending?.author.sessionId).toBe(f.author.sessionId);
    expect((await store.execute({ action: "get", id: proposed.id }, f.author)).record?.id).toBe(proposed.id);
    const checking = verification();
    const verifier = { ...f.verifier };
    const checkedPromise = store.execute({ action: "verify", ...identity(proposed), verification: checking }, verifier);
    checking.checks[0]!.outcome = "fail";
    verifier.sessionId = f.author.sessionId;
    const checked = (await checkedPromise).record!;
    const publisher = { ...f.author };
    const unauthorized = store.execute({ action: "activate", ...identity(checked) }, publisher);
    publisher.agent = "research-assistant";
    await expect(unauthorized).rejects.toThrow(/Research Assistant/i);
    expect((await store.execute({ action: "activate", ...identity(checked) }, f.assistant)).record?.active).toBeDefined();
  });

  it("aborts without publication and never exposes a caller-controlled abort reason", async () => {
    const active = await activate(await propose());
    const controller = new AbortController();
    const promise = store.execute({ action: "propose", ...identity(active), entry: entry() }, { ...f.author, signal: controller.signal });
    controller.abort(new Error(join(f.root, "private-secret")));
    await expect(promise).rejects.toMatchObject({ code: "ABORTED" });
    try { await promise; } catch (error) { expect(String(error)).not.toContain(f.root); }
    expect((await store.execute({ action: "get", id: active.id }, f.author)).record?.revision).toBe(active.revision);
    expect((await readdir(recordDir(active))).every(name => name.endsWith(".json"))).toBe(true);
  });

  it("ignores incomplete owned-style drafts but reports a corrupt latest record without recalling the incumbent", async () => {
    const active = await activate(await propose());
    await writeFile(join(recordDir(active), ".draft-abandoned"), "partial bytes");
    expect((await store.execute({ action: "get", id: active.id }, f.author)).record?.revision).toBe(active.revision);
    await writeFile(join(recordDir(active), `${active.revision + 1}.json`), "{broken");
    await expect(store.execute({ action: "get", id: active.id }, f.author)).rejects.toThrow(/corrupt|invalid/i);
    const recall = await store.execute({ action: "recall" }, f.author);
    expect(recall.memories).toEqual([]);
    expect(recall.diagnostics?.length).toBeGreaterThan(0);
    expect(JSON.stringify(recall)).not.toContain(f.root);
    expect(await readFile(join(recordDir(active), ".draft-abandoned"), "utf8")).toBe("partial bytes");
  });

  it("rejects redirected store children and permits an ordinarily symlinked project root without merging namespaces", async () => {
    const alias = join(f.root, "project-alias");
    await symlink(f.cwd, alias, "junction");
    const actor = { ...f.author, cwd: alias };
    const proposed = (await store.execute({ action: "propose", entry: entry() }, actor)).record!;
    await expect(store.execute({ action: "get", id: proposed.id }, f.author)).rejects.toThrow();
    expect((await store.execute({ action: "get", id: proposed.id }, actor)).record?.id).toBe(proposed.id);
    await mkdir(join(f.agentDir, "research-memory", "shared"));
    await symlink(join(f.agentDir, "research-memory", "projects", createHash("sha256").update(alias).digest("hex"), proposed.id), join(f.agentDir, "research-memory", "shared", proposed.id), "junction");
    await expect(store.execute({ action: "get", scope: "shared", id: proposed.id }, actor)).rejects.toThrow();
  });

  it("pins basedOn to accessible active history and keeps returned objects detached from disk", async () => {
    const pending = await propose();
    const reference = { scope: pending.scope, id: pending.id, revision: pending.revision };
    await expect(store.execute({ action: "propose", entry: entry({ basedOn: [reference] }) }, f.author)).rejects.toThrow(/active/i);
    const active = await activate(pending);
    reference.revision = active.revision;
    const proposed = (await store.execute({ action: "propose", entry: entry({ basedOn: [reference] }) }, f.author)).record!;
    proposed.pending!.entry.procedure = "changed returned object";
    const pinned = (await store.execute({ action: "get", id: proposed.id }, f.author)).record!;
    expect(pinned.pending?.entry.procedure).toBe(entry().procedure);
    expect(pinned.pending?.entry.basedOn).toEqual([reference]);
    await expect(store.execute({ action: "propose", entry: entry({ basedOn: [reference] }) }, { ...f.author, cwd: f.otherCwd })).rejects.toThrow();
  });

  it("reports result truncation deterministically while excluding pending content from relevance", async () => {
    const first = await activate(await propose());
    const second = await activate(await propose());
    await store.execute({ action: "propose", ...identity(first), entry: entry({ title: "special pending needle" }) }, f.author);
    expect((await store.execute({ action: "recall", query: "needle" }, f.author)).memories).toEqual([]);
    const all = (await store.execute({ action: "recall", query: "citation", limit: 2 }, f.author)).memories!;
    expect(all.map(value => value.ref.id)).toEqual([first.id, second.id].sort());
    const limited = await store.execute({ action: "recall", query: "citation", limit: 1 }, f.author);
    expect(limited.memories).toEqual(all.slice(0, 1));
    expect(limited.truncated).toBe(true);
  });

  it("allows new verification of changed verification evidence without changing the proposal revision", async () => {
    const proposed = await propose();
    const checked = (await store.execute({ action: "verify", ...identity(proposed), verification: verification() }, f.verifier)).record!;
    await writeFile(join(f.cwd, "verification.md"), "Fresh independent report");
    await expect(store.execute({ action: "activate", ...identity(checked) }, f.assistant)).rejects.toThrow(/evidence/i);
    const refreshed = (await store.execute({ action: "verify", ...identity(checked), verification: verification() }, f.verifier)).record!;
    expect(refreshed.pending?.proposalRevision).toBe(proposed.revision);
    expect((await store.execute({ action: "activate", ...identity(refreshed) }, f.assistant)).record?.active?.proposalRevision).toBe(proposed.revision);
  });

  it("refuses explicitly private shared content before publication", async () => {
    for (const privateValue of [f.cwd, f.assistant.sessionId, "source.md"]) {
      await expect(store.execute({ action: "propose", scope: "shared", entry: entry({ procedure: `Read ${privateValue}` }) }, f.assistant)).rejects.toThrow(/generalize|private/i);
    }
    expect((await store.execute({ action: "recall" }, f.assistant)).memories).toEqual([]);
  });

  it("checks shared content values without mistaking schema keys for private filenames", async () => {
    await writeFile(join(f.cwd, "title"), "Inspectable source report with a schema-key filename");
    const proposed = (await store.execute({ action: "propose", scope: "shared", entry: entry({ evidencePaths: ["title"] }) }, f.assistant)).record!;
    expect(proposed.pending?.entry.evidencePaths).toEqual(["title"]);
    expect(proposed.pending?.entry.title).toBe(entry().title);
    await expect(store.execute({ action: "propose", scope: "shared", entry: entry({ evidencePaths: ["title"], tags: ["title"] }) }, f.assistant)).rejects.toThrow(/generalize|private/i);
  });

  it.each(["method", "strategy"] as const)("accepts shared %s evidence named after its fixed kind discriminator", async kind => {
    await writeFile(join(f.cwd, kind), "Inspectable source report with a discriminator filename");
    const content = entry({ kind, evidencePaths: [kind] });
    const proposed = (await store.execute({ action: "propose", scope: "shared", entry: content }, f.assistant)).record!;
    const stored = (await store.execute({ action: "get", scope: "shared", id: proposed.id }, f.assistant)).record!;
    expect(stored.pending?.entry).toEqual(content);
    expect(stored.pending?.sourceEvidence[0]?.path).toBe(kind);
  });

  it.each(["method", "strategy"] as const)("still rejects private %s filenames in authored prose, tags and roles", async kind => {
    await writeFile(join(f.cwd, kind), "Inspectable source report");
    for (const field of ["title", "conditions", "procedure", "limitations", "rationale", "tags", "roles"] as const) {
      const content = entry({ kind, evidencePaths: [kind], [field]: field === "tags" || field === "roles" ? [kind] : `Read ${kind}` });
      await expect(store.execute({ action: "propose", scope: "shared", entry: content }, f.assistant)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
    expect(await readdir(f.agentDir)).toEqual([]);
  });

  it("does not trust structurally corrupted active shared authors or same-session verification", async () => {
    const active = await activate(await propose("shared"));
    const path = join(recordDir(active), `${active.revision}.json`);
    const original = JSON.parse(await readFile(path, "utf8"));
    const invalidAuthor = structuredClone(original);
    invalidAuthor.active.author.agent = "search";
    await writeFile(path, JSON.stringify(invalidAuthor));
    await expect(store.execute({ action: "get", scope: "shared", id: active.id }, f.author)).rejects.toMatchObject({ code: "CORRUPT" });
    const invalidVerifier = structuredClone(original);
    invalidVerifier.active.verification.actor.sessionId = invalidVerifier.active.author.sessionId;
    await writeFile(path, JSON.stringify(invalidVerifier));
    await expect(store.execute({ action: "get", scope: "shared", id: active.id }, f.author)).rejects.toMatchObject({ code: "CORRUPT" });
  });
});
