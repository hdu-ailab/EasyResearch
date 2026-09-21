import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { newRecordCandidates } from "./capacity.js";
import { captureEvidence, checkEvidence } from "./evidence.js";
import { listNames, memoryDirectory, publishRevision, readBoundedFile, readBudget } from "./filesystem.js";
import type { DirectoryGuard, ReadBudget } from "./filesystem.js";
import {
  assertActivationAllowed, assertAuthority, byteBound, captureActor, checkAbort, ensure,
  MEMORY_LIMITS, memoryId, MemoryError, parseRequest, safeError,
} from "./policy.js";
import { parseSnapshot, projectRecord } from "./snapshot.js";
import type {
  MemoryActor, MemoryEntry, MemoryIdentity, MemoryResult, MemoryScope, MemorySummary,
  ResearchMemoryRequest, ResearchMemoryStore, StoredRecord,
} from "./types.js";

function namespace(scope: MemoryScope, cwd: string): string[] {
  return scope === "shared" ? ["shared"] : ["projects", createHash("sha256").update(cwd).digest("hex")];
}

function identity({ cwd, sessionId, agent, model }: MemoryActor): MemoryIdentity {
  return { cwd, sessionId, agent, model };
}

function assertGeneralized(entry: MemoryEntry, actor: MemoryActor): void {
  const { kind: _kind, evidencePaths, basedOn: _basedOn, ...content } = entry;
  const values = Object.values(content).flat();
  ensure(![actor.cwd, actor.sessionId, ...evidencePaths].some(privateValue => values.some(value => value.includes(privateValue))), "INVALID_REQUEST", "Shared content must generalize private project paths and session identities.");
}

function summary(record: StoredRecord): MemorySummary {
  const version = record.active!;
  const e = version.entry;
  return {
    ref: { id: record.id, scope: record.scope, revision: record.revision }, proposalRevision: version.proposalRevision,
    kind: e.kind, title: e.title, roles: [...e.roles], tags: [...e.tags],
    conditions: e.conditions.slice(0, 600), procedure: e.procedure.slice(0, 1200), limitations: e.limitations.slice(0, 600),
  };
}

function relevance(entry: MemoryEntry, query?: string): number {
  if (!query) return 1;
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])];
  return terms.reduce((score, term) => score
    + (entry.title.toLowerCase().includes(term) ? 4 : 0)
    + (entry.tags.join(" ").toLowerCase().includes(term) ? 3 : 0)
    + ([entry.conditions, entry.procedure, entry.limitations, entry.rationale].join(" ").toLowerCase().includes(term) ? 1 : 0), 0);
}

/** No filesystem work occurs until execute; agentDir is the initialized Pi path. */
export function createResearchMemoryStore(agentDir: string): ResearchMemoryStore {
  ensure(typeof agentDir === "string" && isAbsolute(agentDir), "INVALID_REQUEST", "An initialized absolute agent directory is required.");

  async function commit(record: StoredRecord, directory: DirectoryGuard, actor: MemoryActor): Promise<MemoryResult> {
    const result = { record: projectRecord(record, actor.cwd) };
    byteBound(result, MEMORY_LIMITS.outputBytes);
    byteBound(record, MEMORY_LIMITS.recordBytes);
    await publishRevision(directory, record.revision, JSON.stringify(record), actor.signal);
    return result;
  }

  async function load(scope: MemoryScope, id: string, actor: MemoryActor, budget: ReadBudget, pinned?: number) {
    const directory = await memoryDirectory(agentDir, [...namespace(scope, actor.cwd), id], false, actor.signal);
    ensure(directory, "NOT_FOUND", "Memory was not found in this scope.");
    const names = await listNames(directory, MEMORY_LIMITS.directoryEntries, budget, actor.signal);
    const revisions = names.filter(name => !name.startsWith(".draft-")).map(name => {
      ensure(/^[1-9][0-9]*\.json$/.test(name), "CORRUPT", "Memory history contains an invalid revision file.");
      const revision = Number(name.slice(0, -5));
      ensure(Number.isSafeInteger(revision) && revision <= MEMORY_LIMITS.revisions, "LIMIT", "Memory history exceeds its revision bound.");
      return revision;
    }).sort((a, b) => a - b);
    ensure(revisions.length > 0, "NOT_FOUND", "Memory has no published revision.");
    ensure(revisions.every((revision, i) => revision === i + 1), "CORRUPT", "Memory history has missing or duplicate revisions.");
    const current = revisions[revisions.length - 1]!;
    const revision = pinned ?? current;
    ensure(revision <= current, "NOT_FOUND", "Requested memory revision was not found.");
    const bytes = await readBoundedFile(directory, `${revision}.json`, Math.min(MEMORY_LIMITS.recordBytes, budget.bytes), actor.signal);
    budget.bytes -= bytes.length;
    const record = parseSnapshot(bytes, { scope, id, revision }, actor.cwd);
    return { record, directory, current };
  }

  async function recall(request: Extract<ResearchMemoryRequest, { action: "recall" }>, actor: MemoryActor, budget: ReadBudget): Promise<MemoryResult> {
    const diagnostics: string[] = [];
    const candidates: { score: number; memory: MemorySummary }[] = [];
    let truncated = false;
    function diagnose(error: unknown) {
      const safe = safeError(error);
      if (safe.code === "ABORTED") throw safe;
      if (safe.code === "LIMIT") truncated = true;
      if (diagnostics.length < 16 && !diagnostics.includes(safe.message)) diagnostics.push(safe.message);
    }
    for (const scope of request.scope ? [request.scope] : ["project", "shared"] as const) {
      try {
        const directory = await memoryDirectory(agentDir, namespace(scope, actor.cwd), false, actor.signal);
        if (!directory) continue;
        // Overflow skips this whole namespace rather than ranking an arbitrary OS
        // directory-order prefix. Small libraries have deterministic ordering.
        const ids = await listNames(directory, MEMORY_LIMITS.records, budget, actor.signal);
        for (const id of ids) {
          if (budget.entries <= 0 || budget.bytes <= 0) { truncated = true; break; }
          try {
            memoryId(id);
            const { record } = await load(scope, id, actor, budget);
            if (!record.active || record.retired) continue;
            const e = record.active.entry;
            if ((request.role && !e.roles.includes(request.role)) || (request.kind && e.kind !== request.kind)) continue;
            const score = relevance(e, request.query);
            if (score > 0) candidates.push({ score, memory: summary(record) });
          } catch (error) { diagnose(error); }
        }
      } catch (error) { diagnose(error); }
    }
    candidates.sort((a, b) => b.score - a.score || (a.memory.ref.scope === b.memory.ref.scope ? 0 : a.memory.ref.scope === "project" ? -1 : 1)
      || (a.memory.ref.id < b.memory.ref.id ? -1 : a.memory.ref.id > b.memory.ref.id ? 1 : 0));
    const limit = request.limit ?? MEMORY_LIMITS.defaultResults;
    truncated ||= candidates.length > limit;
    const memories = candidates.slice(0, limit).map(candidate => candidate.memory);
    while (Buffer.byteLength(JSON.stringify({ memories, diagnostics, truncated })) > MEMORY_LIMITS.outputBytes) { memories.pop(); truncated = true; }
    checkAbort(actor.signal);
    return { memories, diagnostics, truncated };
  }

  return {
    async execute(input, caller) {
      try {
        const actor = captureActor(caller);
        const request = parseRequest(input);
        checkAbort(actor.signal);
        assertAuthority(request, actor);
        const budget = readBudget();
        if (request.action === "recall") return await recall(request, actor, budget);
        const scope = request.scope ?? "project";
        if (request.action === "get") {
          const { record, current } = await load(scope, request.id, actor, budget, request.revision);
          const result = { record: projectRecord(record, actor.cwd, record.revision !== current) };
          byteBound(result, MEMORY_LIMITS.outputBytes);
          return result;
        }
        const previous = request.id ? await load(scope, request.id, actor, budget) : undefined;
        if (previous) ensure(previous.current === request.expectedRevision, "CONFLICT", "Memory revision conflict; get the current revision and retry.");
        // New identities are assigned by finite namespace admission before any
        // serialization/publication. Existing records retain their exact UUID.
        const id = previous?.record.id ?? "";
        const revision = (previous?.current ?? 0) + 1;
        const record: StoredRecord = {
          ...(previous?.record ?? {}), schemaVersion: 1, id, scope, revision,
          timestamp: new Date().toISOString(), action: request.action, actor: identity(actor), retired: previous?.record.retired ?? false,
        };
        delete record.reason;
        switch (request.action) {
          case "propose": {
            ensure(!record.pending, "CONFLICT", "Resolve the existing pending proposal before proposing a replacement.");
            if (scope === "shared") assertGeneralized(request.entry, actor);
            for (const ref of request.entry.basedOn ?? []) {
              const source = await load(ref.scope, ref.id, actor, budget, ref.revision);
              ensure(source.record.active && !source.record.retired, "INVALID_REQUEST", "basedOn must pin an active memory snapshot.");
            }
            const sourceEvidence = await captureEvidence(actor.cwd, request.entry.evidencePaths, actor.signal);
            record.pending = { entry: request.entry, author: identity(actor), proposalRevision: revision, sourceEvidence };
            break;
          }
          case "verify": {
            const pending = record.pending;
            ensure(pending, "CONFLICT", "Memory has no pending proposal to verify.");
            ensure(pending.author.cwd === actor.cwd, "FORBIDDEN", "Verification must occur in the proposal's originating project.");
            ensure(pending.author.sessionId !== actor.sessionId, "FORBIDDEN", "Verification requires an independent session.");
            await checkEvidence(actor.cwd, pending.sourceEvidence, actor.signal);
            const evidence = await captureEvidence(actor.cwd, request.verification.evidencePaths, actor.signal);
            pending.verification = { proposalRevision: pending.proposalRevision, actor: identity(actor), result: request.verification, evidence };
            break;
          }
          case "activate": {
            const pending = record.pending;
            ensure(pending, "CONFLICT", "Memory has no pending proposal to activate.");
            ensure(pending.author.cwd === actor.cwd, "FORBIDDEN", "Activation must occur in the proposal's originating project.");
            ensure(pending.verification, "EVIDENCE", "Activation requires independent verification.");
            assertActivationAllowed(scope, pending.entry, pending.verification.result);
            await checkEvidence(actor.cwd, pending.sourceEvidence, actor.signal);
            await checkEvidence(actor.cwd, pending.verification.evidence, actor.signal);
            record.active = pending;
            delete record.pending;
            record.retired = false;
            break;
          }
          case "reject":
            ensure(record.pending, "CONFLICT", "Memory has no pending proposal to reject.");
            delete record.pending;
            record.reason = request.reason;
            break;
          case "retire":
            ensure(record.active && !record.retired, "CONFLICT", "Memory has no enabled active version to retire.");
            record.retired = true;
            record.reason = request.reason;
            break;
          case "rollback": {
            ensure(!record.pending, "CONFLICT", "Resolve pending work before rollback.");
            ensure(previous && request.revision < previous.current, "INVALID_REQUEST", "Rollback requires a prior active revision.");
            const target = await load(scope, id, actor, budget, request.revision);
            ensure(target.record.active && !target.record.retired, "INVALID_REQUEST", "Rollback target must contain an enabled active snapshot.");
            record.active = target.record.active;
            record.retired = false;
            record.reason = request.reason;
            break;
          }
        }
        checkAbort(actor.signal);
        if (previous) return await commit(record, previous.directory, actor);
        for await (const candidate of newRecordCandidates(agentDir, namespace(scope, actor.cwd), budget, actor.signal)) {
          record.id = candidate.id;
          try { return await commit(record, candidate.directory, actor); } catch (error) {
            if (!(error instanceof MemoryError) || error.code !== "CONFLICT") throw error;
            // A competing creator claimed this first revision. Try another slot;
            // existing-record mutations still return their original CAS conflict.
          }
        }
        throw new MemoryError("LIMIT", "Memory namespace is at record capacity; use an existing record for replacement proposals.");
      } catch (error) { throw safeError(error); }
    },
  };
}
