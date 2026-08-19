import { randomUUID } from "node:crypto";
import { SubagentCoordinator } from "./coordinator";
import type { InternalSubagentJob, NotificationBatchRecord, SubagentJournalState } from "./job-journal";
import { AGENT_STATUS_TYPE, formatTerminalNotification } from "./notifications";

export interface RecoverySessionStore {
  inspect(path: string): Promise<{
    readable: boolean;
    sessionId?: string;
    cwd?: string;
    latestAssistantText?: string;
  }>;
  appendHiddenMessage(path: string, message: {
    customType: string;
    content: string;
    display: false;
    details: { batchId: string };
  }): Promise<void>;
}

export interface SubagentRecoveryReport {
  interruptedLaunchIds: string[];
  unmaterializedLaunchIds: string[];
  acknowledgedBatchIds: string[];
  notifications: Array<{ ownerSessionId: string; content: string; triggerTurn: false }>;
}

const INTERRUPTION_ERROR = "Subagent interrupted by process restart.";
const UNMATERIALIZED_ERROR = "Subagent recovery could not validate an exact materialized session.";

function ownerSessionPath(
  coordinator: SubagentCoordinator,
  state: SubagentJournalState,
  ownerSessionId: string,
): string | undefined {
  const root = coordinator.getRootSessionManager();
  if (ownerSessionId === root.getSessionId()) return root.getSessionFile();

  const paths = new Set<string>();
  for (const job of state.jobs.values()) {
    if (job.childSessionId === ownerSessionId && job.sessionPath) paths.add(job.sessionPath);
  }
  return paths.size === 1 ? [...paths][0] : undefined;
}

function isTerminal(job: InternalSubagentJob): boolean {
  return job.status === "complete"
    || job.status === "error"
    || job.status === "pre_materialization_failed";
}

function nextBatchId(state: SubagentJournalState): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const batchId = randomUUID();
    if (
      !state.pendingBatches.some((batch) => batch.batchId === batchId)
      && !state.acknowledgedBatchIds.has(batchId)
      && !state.supersededBatchIds.has(batchId)
    ) return batchId;
  }
  throw new Error("Could not allocate a unique recovery notification batch id.");
}

export async function recoverSubagentTree(options: {
  coordinator: SubagentCoordinator;
  store: RecoverySessionStore;
  expectedCwd: string;
  now?: () => string;
}): Promise<SubagentRecoveryReport> {
  const report: SubagentRecoveryReport = {
    interruptedLaunchIds: [],
    unmaterializedLaunchIds: [],
    acknowledgedBatchIds: [],
    notifications: [],
  };
  const initialState = options.coordinator.journal();
  if (initialState.jobs.size === 0 && initialState.pendingBatches.length === 0) return report;

  const deliver = async (batch: NotificationBatchRecord): Promise<boolean> => {
    const state = options.coordinator.journal();
    const path = ownerSessionPath(options.coordinator, state, batch.ownerSessionId);
    if (!path) return false;
    const inspected = await options.store.inspect(path);
    if (
      !inspected.readable
      || inspected.sessionId !== batch.ownerSessionId
      || inspected.cwd !== options.expectedCwd
    ) return false;

    await options.store.appendHiddenMessage(path, {
      customType: AGENT_STATUS_TYPE,
      content: batch.content,
      display: false,
      details: { batchId: batch.batchId },
    });
    options.coordinator.acknowledgeNotification(batch.batchId);
    report.acknowledgedBatchIds.push(batch.batchId);
    report.notifications.push({
      ownerSessionId: batch.ownerSessionId,
      content: batch.content,
      triggerTurn: false,
    });
    return true;
  };

  for (const batch of [...initialState.pendingBatches]) await deliver(batch);

  const outcomesByOwner = new Map<string, InternalSubagentJob[]>();
  const addOutcome = (job: InternalSubagentJob): void => {
    const ownerJobs = outcomesByOwner.get(job.ownerSessionId) ?? [];
    ownerJobs.push(job);
    outcomesByOwner.set(job.ownerSessionId, ownerJobs);
  };
  const stateAfterPending = options.coordinator.journal();
  const pendingLaunchIds = new Set(stateAfterPending.pendingBatches.flatMap(({ launchIds }) => launchIds));
  for (const job of stateAfterPending.jobs.values()) {
    if (
      job.terminalSuppressed
      || (job.status !== "complete" && job.status !== "error")
      || !job.sessionPath
      || pendingLaunchIds.has(job.launchId)
      || stateAfterPending.acknowledgedNotificationLaunchIds.has(job.launchId)
    ) continue;
    addOutcome(job);
  }

  for (const initialJob of [...options.coordinator.journal().jobs.values()]) {
    if (initialJob.terminalSuppressed) continue;
    if (initialJob.terminalStatus) {
      if (initialJob.status === initialJob.terminalStatus) continue;
      options.coordinator.recordTerminal({
        launchId: initialJob.launchId,
        status: initialJob.terminalStatus,
        recovered: true,
        ...(initialJob.latestAssistantText === undefined
          ? {}
          : { latestAssistantText: initialJob.latestAssistantText }),
        ...(initialJob.errorMessage === undefined ? {} : { errorMessage: initialJob.errorMessage }),
      });
      const promoted = options.coordinator.journal().jobs.get(initialJob.launchId);
      if (
        promoted
        && !pendingLaunchIds.has(promoted.launchId)
        && !options.coordinator.journal().acknowledgedNotificationLaunchIds.has(promoted.launchId)
      ) addOutcome(promoted);
      continue;
    }
    if (isTerminal(initialJob)) continue;
    const { childSessionId, sessionPath } = initialJob;
    if (!childSessionId || !sessionPath) {
      options.coordinator.recordPreMaterializationFailure(
        { launchId: initialJob.launchId },
        new Error(UNMATERIALIZED_ERROR),
      );
      report.unmaterializedLaunchIds.push(initialJob.launchId);
      continue;
    }

    const inspected = await options.store.inspect(sessionPath);
    if (
      !inspected.readable
      || inspected.sessionId !== childSessionId
      || inspected.cwd !== options.expectedCwd
    ) {
      options.coordinator.recordPreMaterializationFailure(
        { launchId: initialJob.launchId },
        new Error(UNMATERIALIZED_ERROR),
      );
      report.unmaterializedLaunchIds.push(initialJob.launchId);
      continue;
    }

    options.coordinator.recordTerminal({
      launchId: initialJob.launchId,
      status: "error",
      recovered: true,
      latestAssistantText: inspected.latestAssistantText ?? initialJob.latestAssistantText,
      errorMessage: INTERRUPTION_ERROR,
    });
    const recovered = options.coordinator.journal().jobs.get(initialJob.launchId);
    if (!recovered) continue;
    addOutcome(recovered);
    report.interruptedLaunchIds.push(initialJob.launchId);
  }

  for (const [ownerSessionId, jobs] of outcomesByOwner) {
    const state = options.coordinator.journal();
    const outcomes = jobs.flatMap((job) =>
      job.sessionPath
        ? [{
            launchId: job.launchId,
            agentId: job.agentId,
            status: job.terminalStatus ?? (job.status === "complete" ? "complete" as const : "error" as const),
            sessionPath: job.sessionPath,
            ...(job.latestAssistantText === undefined ? {} : { latestAssistantText: job.latestAssistantText }),
          }]
        : []);
    if (outcomes.length === 0) continue;
    const content = formatTerminalNotification({
      time: options.now?.() ?? new Date().toISOString(),
      workingAgentIds: [...state.jobs.values()]
        .filter((job) =>
          job.ownerSessionId === ownerSessionId
          && job.status === "working"
          && !job.terminalSuppressed)
        .map((job) => job.agentId),
      outcomes,
    });
    const batchId = nextBatchId(state);
    options.coordinator.recordNotificationBatch({
      batchId,
      ownerSessionId,
      launchIds: outcomes.map(({ launchId }) => launchId),
      content,
      triggerTurn: false,
    });
    const batch = options.coordinator.journal().pendingBatches.find(
      (candidate) => candidate.batchId === batchId,
    );
    if (batch) await deliver(batch);
  }

  return report;
}
