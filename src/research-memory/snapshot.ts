import {
  array, assertActivationAllowed, choice, ensure, evidencePath, integer, MEMORY_LIMITS,
  object, parseEntry, parseIdentity, parseVerification, text, MemoryError,
} from "./policy.js";
import type {
  EvidenceProof, MemoryIdentity, MemoryProvenance, MemoryRecord, MemoryRef,
  MemoryVersion, StoredRecord, StoredVersion,
} from "./types.js";

function parseProofs(value: unknown, paths: string[]): EvidenceProof[] {
  const proofs = array(value, MEMORY_LIMITS.evidenceFiles, item => {
    const proof = object(item, ["path", "sha256", "size"]);
    const path = evidencePath(proof.path);
    ensure(typeof proof.sha256 === "string" && /^[a-f0-9]{64}$/.test(proof.sha256), "CORRUPT", "Invalid evidence digest.");
    ensure(typeof proof.size === "number" && Number.isSafeInteger(proof.size) && proof.size >= 0 && proof.size <= MEMORY_LIMITS.evidenceFileBytes, "CORRUPT", "Invalid evidence size.");
    return { path, sha256: proof.sha256, size: proof.size };
  });
  ensure(proofs.length === paths.length && proofs.every((proof, i) => proof.path === paths[i]) && proofs.reduce((sum, proof) => sum + proof.size, 0) <= MEMORY_LIMITS.evidenceTotalBytes, "CORRUPT", "Evidence does not match the recorded paths or bounds.");
  return proofs;
}

function parseVersion(value: unknown, ref: MemoryRef, cwd: string, active: boolean): StoredVersion {
  const v = object(value, ["entry", "proposalRevision", "author", "sourceEvidence", "verification"]);
  const entry = parseEntry(v.entry);
  const author = parseIdentity(v.author);
  const proposalRevision = integer(v.proposalRevision);
  ensure(proposalRevision <= ref.revision && (ref.scope === "shared" || author.cwd === cwd), "CORRUPT", "Invalid proposal provenance.");
  ensure(ref.scope !== "shared" || author.agent === "research-assistant", "CORRUPT", "Shared proposal lacks publication authority.");
  const version: StoredVersion = { entry, author, proposalRevision, sourceEvidence: parseProofs(v.sourceEvidence, entry.evidencePaths) };
  if (v.verification !== undefined) {
    const verification = object(v.verification, ["proposalRevision", "actor", "result", "evidence"]);
    const actor = parseIdentity(verification.actor);
    const result = parseVerification(verification.result);
    ensure(verification.proposalRevision === proposalRevision && actor.cwd === author.cwd && actor.sessionId !== author.sessionId, "CORRUPT", "Invalid independent verification provenance.");
    version.verification = { proposalRevision, actor, result, evidence: parseProofs(verification.evidence, result.evidencePaths) };
  }
  if (active) {
    ensure(version.verification, "CORRUPT", "Active memory lacks verification.");
    assertActivationAllowed(ref.scope, entry, version.verification.result);
  }
  return version;
}

/** Validate disk content, not just JSON syntax; corrupt latest data never falls back. */
export function parseSnapshot(bytes: Buffer, ref: MemoryRef, cwd: string): StoredRecord {
  try {
    const r = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), ["schemaVersion", "id", "scope", "revision", "timestamp", "action", "actor", "active", "pending", "retired", "reason"]);
    ensure(r.schemaVersion === 1 && r.id === ref.id && r.scope === ref.scope && r.revision === ref.revision, "CORRUPT", "Memory snapshot identity mismatch.");
    const actor = parseIdentity(r.actor);
    ensure(ref.scope === "shared" || actor.cwd === cwd, "CORRUPT", "Memory snapshot project mismatch.");
    const timestamp = text(r.timestamp, 64);
    ensure(Number.isFinite(Date.parse(timestamp)), "CORRUPT", "Invalid memory timestamp.");
    const action = choice(r.action, ["propose", "verify", "activate", "reject", "retire", "rollback"] as const);
    ensure(typeof r.retired === "boolean", "CORRUPT", "Invalid memory retirement state.");
    const record: StoredRecord = {
      ...ref, schemaVersion: 1, timestamp, action, actor, retired: r.retired,
      ...(r.active === undefined ? {} : { active: parseVersion(r.active, ref, cwd, true) }),
      ...(r.pending === undefined ? {} : { pending: parseVersion(r.pending, ref, cwd, false) }),
      ...(r.reason === undefined ? {} : { reason: text(r.reason, 2048) }),
    };
    ensure(!record.retired || record.active, "CORRUPT", "Retirement lacks an active snapshot.");
    const management = ["activate", "reject", "retire", "rollback"].includes(action);
    ensure(!management || actor.agent === "research-assistant", "CORRUPT", "Invalid memory publication authority.");
    ensure(["reject", "retire", "rollback"].includes(action) === (record.reason !== undefined), "CORRUPT", "Memory action and reason disagree.");
    if (action === "propose") ensure(record.pending?.proposalRevision === ref.revision && record.pending.author.sessionId === actor.sessionId && record.pending.author.cwd === actor.cwd, "CORRUPT", "Proposal does not match its revision or author.");
    if (action === "verify") ensure(record.pending?.verification?.actor.sessionId === actor.sessionId && record.pending.author.cwd === actor.cwd, "CORRUPT", "Verification does not match its author.");
    if (action === "activate" || action === "rollback") ensure(record.active && !record.pending && !record.retired, "CORRUPT", "Invalid activated memory state.");
    if (action === "activate") ensure(record.active?.author.cwd === actor.cwd, "CORRUPT", "Activation crossed the proposal origin.");
    if (action === "reject") ensure(!record.pending, "CORRUPT", "Rejected memory still has pending work.");
    if (action === "retire") ensure(record.retired, "CORRUPT", "Retired memory is still enabled.");
    return record;
  } catch {
    throw new MemoryError("CORRUPT", "Memory snapshot is corrupt or invalid; inspect local memory storage.");
  }
}

function provenance(identity: MemoryIdentity, cwd: string): MemoryProvenance {
  return identity.cwd === cwd ? { ...identity } : { agent: identity.agent, model: identity.model };
}

function projectVersion(version: StoredVersion, cwd: string): MemoryVersion {
  const local = version.author.cwd === cwd;
  const entry = structuredClone(version.entry);
  if (!local) {
    entry.evidencePaths = [];
    if (entry.basedOn) entry.basedOn = entry.basedOn.filter(ref => ref.scope === "shared");
  }
  const projected: MemoryVersion = {
    entry, proposalRevision: version.proposalRevision, author: provenance(version.author, cwd),
    sourceEvidence: version.sourceEvidence.map(({ path, ...proof }) => local ? { path, ...proof } : proof),
  };
  if (version.verification) {
    const v = version.verification;
    const own = v.actor.cwd === cwd;
    projected.verification = {
      proposalRevision: v.proposalRevision, actor: provenance(v.actor, cwd), outcome: v.result.outcome,
      evidence: v.evidence.map(({ path, ...proof }) => own ? { path, ...proof } : proof),
      ...(own ? { result: structuredClone(v.result) } : {}),
    };
  }
  return projected;
}

export function projectRecord(record: StoredRecord, cwd: string, historical = false): MemoryRecord {
  return {
    schemaVersion: record.schemaVersion, id: record.id, scope: record.scope, revision: record.revision,
    timestamp: record.timestamp, action: record.action, actor: provenance(record.actor, cwd),
    retired: record.retired, historical,
    ...(record.reason !== undefined && record.actor.cwd === cwd ? { reason: record.reason } : {}),
    ...(record.active ? { active: projectVersion(record.active, cwd) } : {}),
    ...(record.pending ? { pending: projectVersion(record.pending, cwd) } : {}),
  };
}
