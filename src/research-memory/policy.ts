import { isAbsolute, win32 } from "node:path";
import type {
  MemoryActor, MemoryComparison, MemoryEntry, MemoryIdentity, MemoryRef, MemoryScope,
  MemoryVerification, ResearchMemoryRequest, VerificationCheck,
} from "./types.js";

export const MEMORY_LIMITS = Object.freeze({
  entryBytes: 16_384, verificationBytes: 16_384, recordBytes: 131_072,
  evidenceFiles: 8, evidenceFileBytes: 1_048_576, evidenceTotalBytes: 4_194_304,
  records: 256, revisions: 1024, directoryEntries: 1088, scanEntries: 16_384,
  scanBytes: 8_388_608, results: 20, defaultResults: 5, outputBytes: 131_072,
});

export type MemoryErrorCode = "INVALID_REQUEST" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "CORRUPT" | "LIMIT" | "EVIDENCE" | "UNSAFE_PATH" | "ABORTED" | "IO";
export class MemoryError extends Error {
  constructor(public readonly code: MemoryErrorCode, message: string) {
    super(message);
    this.name = "MemoryError";
  }
}

export function ensure(condition: unknown, code: MemoryErrorCode, message: string): asserts condition {
  if (!condition) throw new MemoryError(code, message);
}

export function checkAbort(signal?: AbortSignal): void {
  // Never propagate signal.reason: it may contain private paths or arbitrary data.
  ensure(!signal?.aborted, "ABORTED", "Memory operation aborted before publication.");
}

export function safeError(error: unknown): MemoryError {
  return error instanceof MemoryError ? error : new MemoryError("IO", "Memory operation failed; check local storage access and retry.");
}

export function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  ensure(value !== null && typeof value === "object" && !Array.isArray(value), "INVALID_REQUEST", "Expected a memory object.");
  const result = value as Record<string, unknown>;
  ensure(Object.keys(result).every(key => keys.includes(key)), "INVALID_REQUEST", "Unexpected or irrelevant memory fields.");
  return result;
}

export function text(value: unknown, max = 4096): string {
  ensure(typeof value === "string" && value.trim().length > 0 && !value.includes("\0"), "INVALID_REQUEST", "Expected non-empty memory text.");
  ensure(Buffer.byteLength(value) <= max, "LIMIT", "Memory text exceeds its size limit.");
  return value;
}

export function choice<T extends string>(value: unknown, values: readonly T[]): T {
  ensure(typeof value === "string" && values.includes(value as T), "INVALID_REQUEST", "Invalid memory option.");
  return value as T;
}

export function integer(value: unknown, max: number = MEMORY_LIMITS.revisions): number {
  ensure(typeof value === "number" && Number.isSafeInteger(value) && value > 0, "INVALID_REQUEST", "Expected a positive memory revision or limit.");
  ensure(value <= max, "LIMIT", "Memory revision or limit exceeds its bound.");
  return value;
}

export function array<T>(value: unknown, max: number, parse: (item: unknown) => T, min = 1): T[] {
  ensure(Array.isArray(value), "INVALID_REQUEST", "Expected a memory list.");
  ensure(value.length >= min, "INVALID_REQUEST", "Required memory list is empty.");
  ensure(value.length <= max, "LIMIT", "Too many memory items; list exceeds its limit.");
  return Array.from(value, parse);
}

function unique(values: string[]): string[] {
  ensure(new Set(values).size === values.length, "INVALID_REQUEST", "Memory list items must be distinct.");
  return values;
}

export function evidencePath(value: unknown): string {
  const path = text(value, 1024);
  ensure(!isAbsolute(path) && !win32.isAbsolute(path) && !path.includes(":"), "EVIDENCE", "Evidence must use a project-relative file path.");
  const normalized = path.replaceAll("\\", "/");
  ensure(normalized.split("/").every(part => part !== "" && part !== "." && part !== ".."), "EVIDENCE", "Evidence paths must stay within the exact project.");
  return normalized;
}

export function evidencePaths(value: unknown): string[] {
  return unique(array(value, MEMORY_LIMITS.evidenceFiles, evidencePath));
}

export function memoryId(value: unknown): string {
  ensure(typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value), "INVALID_REQUEST", "Expected a memory UUID.");
  return value;
}

export function parseRef(value: unknown): MemoryRef {
  const ref = object(value, ["scope", "id", "revision"]);
  return { scope: choice(ref.scope, ["project", "shared"]), id: memoryId(ref.id), revision: integer(ref.revision) };
}

export function byteBound(value: unknown, max: number): void {
  ensure(Buffer.byteLength(JSON.stringify(value)) <= max, "LIMIT", "Memory content exceeds its byte limit.");
}

export function parseEntry(value: unknown): MemoryEntry {
  const e = object(value, ["kind", "title", "roles", "tags", "conditions", "procedure", "limitations", "rationale", "evidencePaths", "basedOn"]);
  const entry: MemoryEntry = {
    kind: choice(e.kind, ["method", "strategy"]), title: text(e.title, 240),
    roles: unique(array(e.roles, 16, item => text(item, 128))),
    tags: unique(array(e.tags, 16, item => text(item, 128), 0)),
    conditions: text(e.conditions), procedure: text(e.procedure, 8192),
    limitations: text(e.limitations), rationale: text(e.rationale), evidencePaths: evidencePaths(e.evidencePaths),
    ...(e.basedOn === undefined ? {} : { basedOn: array(e.basedOn, 16, parseRef, 0) }),
  };
  if (entry.basedOn) unique(entry.basedOn.map(ref => `${ref.scope}:${ref.id}:${ref.revision}`));
  byteBound(entry, MEMORY_LIMITS.entryBytes);
  return entry;
}

function finite(value: unknown, positive = false): number {
  ensure(typeof value === "number" && Number.isFinite(value) && (!positive || value > 0), "INVALID_REQUEST", "Comparison values must be finite; budgets must be positive.");
  return value;
}

function parseComparison(value: unknown): MemoryComparison {
  const c = object(value, ["baseline", "candidate", "direction", "baselineBudget", "candidateBudget", "budgetUnit", "protocol", "heldOutTask"]);
  return {
    baseline: finite(c.baseline), candidate: finite(c.candidate), direction: choice(c.direction, ["maximize", "minimize"]),
    baselineBudget: finite(c.baselineBudget, true), candidateBudget: finite(c.candidateBudget, true),
    budgetUnit: text(c.budgetUnit, 128), protocol: text(c.protocol, 2048), heldOutTask: text(c.heldOutTask, 1024),
  };
}

export function parseVerification(value: unknown): MemoryVerification {
  const v = object(value, ["outcome", "summary", "evidencePaths", "checks", "comparison"]);
  const checks = array(v.checks, 16, (item): VerificationCheck => {
    const c = object(item, ["name", "kind", "outcome", "details"]);
    return { name: text(c.name, 128), kind: choice(c.kind, ["replay", "regression", "transfer", "mechanism"]), outcome: choice(c.outcome, ["pass", "fail", "inconclusive"]), details: text(c.details, 2048) };
  });
  unique(checks.map(check => check.name.trim().toLowerCase()));
  const result: MemoryVerification = {
    outcome: choice(v.outcome, ["pass", "fail", "inconclusive"]), summary: text(v.summary, 2048),
    evidencePaths: evidencePaths(v.evidencePaths), checks,
    ...(v.comparison === undefined ? {} : { comparison: parseComparison(v.comparison) }),
  };
  byteBound(result, MEMORY_LIMITS.verificationBytes);
  return result;
}

export function parseIdentity(value: unknown): MemoryIdentity {
  const a = object(value, ["cwd", "sessionId", "agent", "model"]);
  const cwd = text(a.cwd, 4096);
  ensure(isAbsolute(cwd), "INVALID_REQUEST", "Memory caller requires an absolute exact cwd.");
  return { cwd, sessionId: text(a.sessionId, 256), agent: text(a.agent, 128), model: text(a.model, 256) };
}

/** Synchronous copies close the caller-mutation race before any filesystem await. */
export function captureActor(actor: MemoryActor): MemoryActor {
  const { cwd, sessionId, agent, model, signal } = actor;
  ensure(signal === undefined || signal instanceof AbortSignal, "INVALID_REQUEST", "Invalid memory cancellation signal.");
  return { ...parseIdentity({ cwd, sessionId, agent, model }), ...(signal ? { signal } : {}) };
}

export function parseRequest(value: unknown): ResearchMemoryRequest {
  const r = object(value, ["action", "scope", "id", "expectedRevision", "revision", "query", "role", "kind", "limit", "entry", "verification", "reason"]);
  const action = choice(r.action, ["recall", "get", "propose", "verify", "activate", "reject", "retire", "rollback"]);
  const fields: Record<typeof action, string[]> = {
    recall: ["query", "role", "kind", "limit"], get: ["id", "revision"], propose: ["id", "expectedRevision", "entry"],
    verify: ["id", "expectedRevision", "verification"], activate: ["id", "expectedRevision"],
    reject: ["id", "expectedRevision", "reason"], retire: ["id", "expectedRevision", "reason"], rollback: ["id", "expectedRevision", "revision", "reason"],
  };
  object(r, ["action", "scope", ...fields[action]]);
  const scope = r.scope === undefined ? {} : { scope: choice(r.scope, ["project", "shared"] as const) };
  if (action === "recall") return {
    action, ...scope, ...(r.query === undefined ? {} : { query: text(r.query, 1024) }),
    ...(r.role === undefined ? {} : { role: text(r.role, 128) }),
    ...(r.kind === undefined ? {} : { kind: choice(r.kind, ["method", "strategy"] as const) }),
    ...(r.limit === undefined ? {} : { limit: integer(r.limit, MEMORY_LIMITS.results) }),
  };
  if (action === "get") return { action, ...scope, id: memoryId(r.id), ...(r.revision === undefined ? {} : { revision: integer(r.revision) }) };
  if (action === "propose") {
    ensure((r.id === undefined) === (r.expectedRevision === undefined), "INVALID_REQUEST", "Replacement proposals require both id and expectedRevision.");
    return { action, ...scope, entry: parseEntry(r.entry), ...(r.id === undefined ? {} : { id: memoryId(r.id), expectedRevision: integer(r.expectedRevision) }) };
  }
  const target = { ...scope, id: memoryId(r.id), expectedRevision: integer(r.expectedRevision) };
  if (action === "verify") return { action, ...target, verification: parseVerification(r.verification) };
  if (action === "activate") return { action, ...target };
  const reason = text(r.reason, 2048);
  if (action === "rollback") return { action, ...target, reason, revision: integer(r.revision) };
  return { action, ...target, reason };
}

export function assertAuthority(request: ResearchMemoryRequest, actor: MemoryActor): void {
  const restricted = ["activate", "reject", "retire", "rollback"].includes(request.action)
    || (request.action === "propose" && request.scope === "shared");
  ensure(!restricted || actor.agent === "research-assistant", "FORBIDDEN", "Only Research Assistant may publish or manage shared proposals.");
}

export function assertActivationAllowed(scope: MemoryScope, entry: MemoryEntry, input: MemoryVerification): void {
  const verification = parseVerification(input);
  ensure(verification.outcome === "pass" && verification.checks.every(check => check.outcome === "pass"), "EVIDENCE", "Activation requires passing verification and checks.");
  const required = ["replay", "regression", ...(scope === "shared" ? ["transfer"] : []), ...(entry.kind === "strategy" ? ["mechanism"] : [])];
  for (const kind of required) ensure(verification.checks.some(check => check.kind === kind), "EVIDENCE", `Activation requires a passing ${kind} check.`);
  if (entry.kind === "strategy") {
    const comparison = verification.comparison;
    ensure(comparison, "EVIDENCE", "Strategy activation requires a held-out comparison.");
    ensure(comparison.baselineBudget === comparison.candidateBudget, "EVIDENCE", "Strategy comparison requires matched budgets.");
    ensure(comparison.direction === "maximize" ? comparison.candidate > comparison.baseline : comparison.candidate < comparison.baseline, "EVIDENCE", "Strategy comparison requires strictly favorable improvement.");
  }
}
