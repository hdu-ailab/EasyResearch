export const SUBAGENT_JOB_ENTRY = "easyresearch:subagent_job";

export type SubagentJobJournalRecord =
  | { kind: "reserved"; launchId: string; ownerSessionId: string; toolCallId: string; agent: string; agentId: string; continuation: boolean; createdAt: string }
  | { kind: "created"; launchId: string; childSessionId: string; sessionPath: string }
  | { kind: "materialized"; launchId: string }
  | { kind: "launch_acknowledged"; launchId: string; acknowledgedAt: string }
  | { kind: "pre_materialization_failed"; launchId: string; reason: string; failedAt: string }
  | { kind: "terminal"; launchId: string; status: "complete" | "error"; latestAssistantText?: string; errorMessage?: string; recovered?: boolean; finishedAt: string }
  | { kind: "launch_suppressed"; launchId: string; suppressedAt: string }
  | { kind: "notification_batch"; batchId: string; ownerSessionId: string; launchIds: string[]; content: string; triggerTurn?: boolean; createdAt: string }
  | { kind: "notification_ack"; batchId: string; acknowledgedAt: string }
  | { kind: "notification_superseded"; batchId: string; supersededAt: string };

export interface InternalSubagentJob {
  launchId: string;
  ownerSessionId: string;
  toolCallId: string;
  agent: string;
  agentId: string;
  continuation: boolean;
  createdAt: string;
  status: "reserved" | "created" | "working" | "complete" | "error" | "pre_materialization_failed";
  childSessionId?: string;
  sessionPath?: string;
  launchAcknowledged: boolean;
  terminalStatus?: "complete" | "error";
  terminalRecovered?: boolean;
  terminalSuppressed?: boolean;
  latestAssistantText?: string;
  errorMessage?: string;
}

export interface NotificationBatchRecord {
  batchId: string;
  ownerSessionId: string;
  launchIds: string[];
  content: string;
  triggerTurn: boolean;
  createdAt: string;
}

export interface SubagentJournalState {
  jobs: Map<string, InternalSubagentJob>;
  pendingBatches: NotificationBatchRecord[];
  acknowledgedBatchIds: Set<string>;
  acknowledgedNotificationLaunchIds: Set<string>;
  supersededBatchIds: Set<string>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

function readRecord(entry: unknown): SubagentJobJournalRecord | undefined {
  if (!isObject(entry) || entry.type !== "custom" || entry.customType !== SUBAGENT_JOB_ENTRY || !isObject(entry.data)) {
    return undefined;
  }
  const data = entry.data;
  if (typeof data.kind !== "string") return undefined;

  switch (data.kind) {
    case "reserved":
      if (
        !isNonEmptyString(data.launchId)
        || !isNonEmptyString(data.ownerSessionId)
        || !isNonEmptyString(data.toolCallId)
        || !isNonEmptyString(data.agent)
        || !isNonEmptyString(data.agentId)
        || typeof data.continuation !== "boolean"
        || !isNonEmptyString(data.createdAt)
      ) return undefined;
      return {
        kind: data.kind,
        launchId: data.launchId,
        ownerSessionId: data.ownerSessionId,
        toolCallId: data.toolCallId,
        agent: data.agent,
        agentId: data.agentId,
        continuation: data.continuation,
        createdAt: data.createdAt,
      };
    case "created":
      if (!isNonEmptyString(data.launchId) || !isNonEmptyString(data.childSessionId) || !isNonEmptyString(data.sessionPath)) return undefined;
      return { kind: data.kind, launchId: data.launchId, childSessionId: data.childSessionId, sessionPath: data.sessionPath };
    case "materialized":
      if (!isNonEmptyString(data.launchId)) return undefined;
      return { kind: data.kind, launchId: data.launchId };
    case "launch_acknowledged":
      if (!isNonEmptyString(data.launchId) || !isNonEmptyString(data.acknowledgedAt)) return undefined;
      return { kind: data.kind, launchId: data.launchId, acknowledgedAt: data.acknowledgedAt };
    case "pre_materialization_failed":
      if (!isNonEmptyString(data.launchId) || !isNonEmptyString(data.reason) || !isNonEmptyString(data.failedAt)) return undefined;
      return { kind: data.kind, launchId: data.launchId, reason: data.reason, failedAt: data.failedAt };
    case "terminal":
      if (
        !isNonEmptyString(data.launchId)
        || (data.status !== "complete" && data.status !== "error")
        || !isOptionalString(data.latestAssistantText)
        || !isOptionalString(data.errorMessage)
        || !isOptionalBoolean(data.recovered)
        || !isNonEmptyString(data.finishedAt)
      ) return undefined;
      return {
        kind: data.kind,
        launchId: data.launchId,
        status: data.status,
        ...(data.latestAssistantText === undefined ? {} : { latestAssistantText: data.latestAssistantText }),
        ...(data.errorMessage === undefined ? {} : { errorMessage: data.errorMessage }),
        ...(data.recovered === undefined ? {} : { recovered: data.recovered }),
        finishedAt: data.finishedAt,
      };
    case "launch_suppressed":
      if (!isNonEmptyString(data.launchId) || !isNonEmptyString(data.suppressedAt)) return undefined;
      return { kind: data.kind, launchId: data.launchId, suppressedAt: data.suppressedAt };
    case "notification_batch":
      if (
        !isNonEmptyString(data.batchId)
        || !isNonEmptyString(data.ownerSessionId)
        || !Array.isArray(data.launchIds)
        || !data.launchIds.every(isNonEmptyString)
        || !isNonEmptyString(data.content)
        || !isOptionalBoolean(data.triggerTurn)
        || !isNonEmptyString(data.createdAt)
      ) return undefined;
      return {
        kind: data.kind,
        batchId: data.batchId,
        ownerSessionId: data.ownerSessionId,
        launchIds: [...data.launchIds],
        content: data.content,
        ...(data.triggerTurn === undefined ? {} : { triggerTurn: data.triggerTurn }),
        createdAt: data.createdAt,
      };
    case "notification_ack":
      if (!isNonEmptyString(data.batchId) || !isNonEmptyString(data.acknowledgedAt)) return undefined;
      return { kind: data.kind, batchId: data.batchId, acknowledgedAt: data.acknowledgedAt };
    case "notification_superseded":
      if (!isNonEmptyString(data.batchId) || !isNonEmptyString(data.supersededAt)) return undefined;
      return { kind: data.kind, batchId: data.batchId, supersededAt: data.supersededAt };
    default:
      return undefined;
  }
}

export function readSubagentJournal(entries: readonly unknown[]): SubagentJournalState {
  const jobs = new Map<string, InternalSubagentJob>();
  const pendingBatches = new Map<string, NotificationBatchRecord>();
  const notificationBatches = new Map<string, NotificationBatchRecord>();
  const acknowledgedBatchIds = new Set<string>();
  const supersededBatchIds = new Set<string>();

  for (const entry of entries) {
    const record = readRecord(entry);
    if (!record) continue;

    if (record.kind === "reserved") {
      jobs.delete(record.launchId);
      jobs.set(record.launchId, {
        launchId: record.launchId,
        ownerSessionId: record.ownerSessionId,
        toolCallId: record.toolCallId,
        agent: record.agent,
        agentId: record.agentId,
        continuation: record.continuation,
        createdAt: record.createdAt,
        status: "reserved",
        launchAcknowledged: false,
      });
      continue;
    }

    if (record.kind === "notification_batch") {
      acknowledgedBatchIds.delete(record.batchId);
      supersededBatchIds.delete(record.batchId);
      pendingBatches.delete(record.batchId);
      const batch = {
        batchId: record.batchId,
        ownerSessionId: record.ownerSessionId,
        launchIds: [...record.launchIds],
        content: record.content,
        triggerTurn: record.triggerTurn ?? true,
        createdAt: record.createdAt,
      };
      notificationBatches.set(record.batchId, batch);
      pendingBatches.set(record.batchId, batch);
      continue;
    }
    if (record.kind === "notification_ack") {
      pendingBatches.delete(record.batchId);
      supersededBatchIds.delete(record.batchId);
      acknowledgedBatchIds.add(record.batchId);
      continue;
    }
    if (record.kind === "notification_superseded") {
      pendingBatches.delete(record.batchId);
      acknowledgedBatchIds.delete(record.batchId);
      supersededBatchIds.add(record.batchId);
      continue;
    }

    const job = jobs.get(record.launchId);
    if (!job) continue;
    switch (record.kind) {
      case "created":
        jobs.set(record.launchId, {
          ...job,
          status: "created",
          childSessionId: record.childSessionId,
          sessionPath: record.sessionPath,
        });
        break;
      case "materialized":
        jobs.set(record.launchId, { ...job, status: "working" });
        break;
      case "launch_acknowledged":
        if (job.terminalSuppressed) break;
        jobs.set(record.launchId, {
          ...job,
          launchAcknowledged: true,
          status: job.terminalStatus ?? job.status,
        });
        break;
      case "pre_materialization_failed":
        jobs.set(record.launchId, {
          ...job,
          status: "pre_materialization_failed",
          errorMessage: record.reason,
        });
        break;
      case "terminal":
        const recovered = record.recovered === true || job.terminalRecovered === true;
        jobs.set(record.launchId, {
          ...job,
          status: job.launchAcknowledged || recovered ? record.status : job.status,
          terminalStatus: record.status,
          ...(recovered ? { terminalRecovered: true } : {}),
          latestAssistantText: record.latestAssistantText,
          errorMessage: record.errorMessage,
        });
        break;
      case "launch_suppressed":
        jobs.set(record.launchId, { ...job, terminalSuppressed: true });
        break;
    }
  }

  const acknowledgedNotificationLaunchIds = new Set<string>();
  for (const batchId of acknowledgedBatchIds) {
    const batch = notificationBatches.get(batchId);
    if (!batch) continue;
    for (const launchId of batch.launchIds) acknowledgedNotificationLaunchIds.add(launchId);
  }

  return {
    jobs,
    pendingBatches: [...pendingBatches.values()],
    acknowledgedBatchIds,
    acknowledgedNotificationLaunchIds,
    supersededBatchIds,
  };
}
