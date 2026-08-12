/**
 * ADR-022: subagent invocations are strictly serial. Pi has no concurrency
 * configuration, so the subagent tool serializes invocations with an
 * in-process lock: a call made while another subagent run is active is
 * rejected immediately (no queueing).
 *
 * The lock is per process. Each agent runtime (Paper Assistant or stage agent)
 * serializes only its own subagent calls, which is the intended scope.
 */
let active = false;

export function tryAcquireSubagentLock(): boolean {
  if (active) return false;
  active = true;
  return true;
}

export function releaseSubagentLock(): void {
  active = false;
}
