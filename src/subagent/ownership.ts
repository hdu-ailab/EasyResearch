import type { InternalSubagentJob, NotificationBatchRecord, SubagentJournalState } from "./job-journal";

/** Native forks copy history, never the original root's execution authority. */
export function ownedSubagentJournal(rootSessionID: string, state: SubagentJournalState): SubagentJournalState {
  const identities = new Map<string, { owner: string; path: string }>();
  const conflicting = new Set<string>();
  for (const job of state.jobs.values()) {
    if (job.terminalSuppressed || !job.childSessionId || !job.sessionPath) continue;
    const previous = identities.get(job.childSessionId);
    if (job.childSessionId === rootSessionID || job.childSessionId === job.ownerSessionId
      || (previous && (previous.owner !== job.ownerSessionId || previous.path !== job.sessionPath))) {
      conflicting.add(job.childSessionId);
    } else identities.set(job.childSessionId, { owner: job.ownerSessionId, path: job.sessionPath });
  }
  const reachable = new Set([rootSessionID]);
  const admitted = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const job of state.jobs.values()) {
      if (job.terminalSuppressed || !reachable.has(job.ownerSessionId)
        || (job.childSessionId && conflicting.has(job.childSessionId))) continue;
      admitted.add(job.launchId);
      // Completed parents still own descendants. Status is not an ownership edge.
      if (job.childSessionId && job.sessionPath && !reachable.has(job.childSessionId)) {
        reachable.add(job.childSessionId);
        changed = true;
      }
    }
  }
  const jobs = new Map<string, InternalSubagentJob>([...state.jobs].filter(([id]) => admitted.has(id)));
  const ownsBatch = (batch: NotificationBatchRecord): boolean => reachable.has(batch.ownerSessionId)
    && batch.launchIds.length > 0 && new Set(batch.launchIds).size === batch.launchIds.length
    && batch.launchIds.every((id) => {
      const job = jobs.get(id);
      return job?.ownerSessionId === batch.ownerSessionId && !!job.childSessionId && !!job.sessionPath;
    });
  const notificationBatches = new Map([...state.notificationBatches].filter(([, batch]) => ownsBatch(batch)));
  const acknowledgedBatchIds = new Set([...state.acknowledgedBatchIds].filter((id) => notificationBatches.has(id)));
  const acknowledgedNotificationLaunchIds = new Set<string>();
  for (const id of acknowledgedBatchIds) for (const launchId of notificationBatches.get(id)!.launchIds) acknowledgedNotificationLaunchIds.add(launchId);
  return {
    jobs,
    notificationBatches,
    pendingBatches: state.pendingBatches.filter(ownsBatch),
    acknowledgedBatchIds,
    acknowledgedNotificationLaunchIds,
    supersededBatchIds: new Set([...state.supersededBatchIds].filter((id) => notificationBatches.has(id))),
  };
}
