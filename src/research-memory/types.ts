export type MemoryScope = "project" | "shared";
export type MemoryKind = "method" | "strategy";
export type VerificationOutcome = "pass" | "fail" | "inconclusive";
export type CheckKind = "replay" | "regression" | "transfer" | "mechanism";

/** Supplied by the initialized runtime, never by tool arguments. */
export interface MemoryActor {
  cwd: string;
  sessionId: string;
  agent: string;
  model: string;
  signal?: AbortSignal;
}

export type MemoryIdentity = Omit<MemoryActor, "signal">;
export type MemoryProvenance = Pick<MemoryIdentity, "agent" | "model"> & Partial<Pick<MemoryIdentity, "cwd" | "sessionId">>;

export interface MemoryRef {
  scope: MemoryScope;
  id: string;
  revision: number;
}

export interface MemoryEntry {
  kind: MemoryKind;
  title: string;
  roles: string[];
  tags: string[];
  conditions: string;
  procedure: string;
  limitations: string;
  rationale: string;
  evidencePaths: string[];
  basedOn?: MemoryRef[];
}

export interface VerificationCheck {
  name: string;
  kind: CheckKind;
  outcome: VerificationOutcome;
  details: string;
}

export interface MemoryComparison {
  baseline: number;
  candidate: number;
  direction: "maximize" | "minimize";
  baselineBudget: number;
  candidateBudget: number;
  budgetUnit: string;
  protocol: string;
  heldOutTask: string;
}

export interface MemoryVerification {
  outcome: VerificationOutcome;
  summary: string;
  evidencePaths: string[];
  checks: VerificationCheck[];
  comparison?: MemoryComparison;
}

type Scoped = { scope?: MemoryScope };
type MutationTarget = Scoped & { id: string; expectedRevision: number };
export type ResearchMemoryRequest =
  | (Scoped & { action: "recall"; query?: string; role?: string; kind?: MemoryKind; limit?: number })
  | (Scoped & { action: "get"; id: string; revision?: number })
  | (Scoped & { action: "propose"; id?: string; expectedRevision?: number; entry: MemoryEntry })
  | (MutationTarget & { action: "verify"; verification: MemoryVerification })
  | (MutationTarget & { action: "activate" })
  | (MutationTarget & { action: "reject" | "retire"; reason: string })
  | (MutationTarget & { action: "rollback"; revision: number; reason: string });

export type MemoryAction = ResearchMemoryRequest["action"];
export type MutationAction = Exclude<MemoryAction, "get" | "recall">;

export interface EvidenceProof {
  path: string;
  sha256: string;
  size: number;
}

export interface StoredVerification {
  proposalRevision: number;
  actor: MemoryIdentity;
  result: MemoryVerification;
  evidence: EvidenceProof[];
}

export interface StoredVersion {
  entry: MemoryEntry;
  proposalRevision: number;
  author: MemoryIdentity;
  sourceEvidence: EvidenceProof[];
  verification?: StoredVerification;
}

export interface StoredRecord extends MemoryRef {
  schemaVersion: 1;
  timestamp: string;
  action: MutationAction;
  actor: MemoryIdentity;
  active?: StoredVersion;
  pending?: StoredVersion;
  retired: boolean;
  reason?: string;
}

/** Private proof paths and session/cwd identity are absent in foreign projections. */
export type ProjectedProof = Omit<EvidenceProof, "path"> & { path?: string };
export interface MemoryVersion {
  entry: MemoryEntry;
  proposalRevision: number;
  author: MemoryProvenance;
  sourceEvidence: ProjectedProof[];
  verification?: {
    proposalRevision: number;
    actor: MemoryProvenance;
    outcome: VerificationOutcome;
    evidence: ProjectedProof[];
    /** Omitted outside the verification's project: report prose can contain paths. */
    result?: MemoryVerification;
  };
}

export interface MemoryRecord extends MemoryRef {
  schemaVersion: 1;
  timestamp: string;
  action: MutationAction;
  actor: MemoryProvenance;
  active?: MemoryVersion;
  pending?: MemoryVersion;
  retired: boolean;
  reason?: string;
  historical: boolean;
}

export interface MemorySummary {
  ref: MemoryRef;
  proposalRevision: number;
  kind: MemoryKind;
  title: string;
  roles: string[];
  tags: string[];
  conditions: string;
  procedure: string;
  limitations: string;
}

export interface MemoryResult {
  record?: MemoryRecord;
  memories?: MemorySummary[];
  diagnostics?: string[];
  truncated?: boolean;
}

export interface ResearchMemoryStore {
  execute(request: ResearchMemoryRequest, actor: MemoryActor): Promise<MemoryResult>;
}
