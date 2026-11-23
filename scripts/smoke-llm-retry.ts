import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import type { ChildSessionSnapshotDto, LlmRecoveryDto, LlmRetryStateEventDto, SessionSnapshotDto, SubagentSessionSummaryDto } from "../src/web/contracts";
import { readSubagentJournal, SUBAGENT_JOB_ENTRY } from "../src/subagent/job-journal";
import { AGENT_STATUS_TYPE } from "../src/subagent/notifications";
import { smokeAgentText } from "./smoke-agent-scenario";
import type { LlmRetryFixture, RetryFixtureCase } from "./smoke-llm-retry-fixture";

export async function retrySmokeWait<T>(label: string, deadline: number, read: () => T | Promise<T>, accept: (value: T) => boolean): Promise<T> {
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (accept(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`${label}: deadline exceeded; last observation ${JSON.stringify(last)}`);
}

export async function retrySmokeRequest(base: string, path: string, body?: unknown, expected = 200) {
  const response = await fetch(`${base}${path}`, { proxy: "", signal: AbortSignal.timeout(15_000),
    ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  const value = await response.json();
  assert.equal(response.status, expected, `${path}: ${JSON.stringify(value)}`);
  return value;
}

/** Full replacements only; null clears are part of the installed wire contract. */
export function retryStateInFrame(frame: unknown): LlmRetryStateEventDto | undefined {
  if (!frame || typeof frame !== "object") return;
  const value = frame as Record<string, unknown>;
  if (value.type === "subagent_supervisor") return retryStateInFrame(value.event);
  if (value.type !== "llm_retry_state") return;
  assert(typeof value.targetSessionId === "string" && value.targetSessionId);
  assert(Object.hasOwn(value, "automaticRetry") && Object.hasOwn(value, "llmRecovery"), "Retry event must replace both fields");
  for (const key of ["automaticRetry", "llmRecovery"]) assert(value[key] === null || typeof value[key] === "object" && value[key]);
  const state = value as unknown as LlmRetryStateEventDto;
  if (state.automaticRetry) {
    const retry = state.automaticRetry;
    assert(["agent", "compaction", "branchSummary"].includes(retry.source));
    assert(Number.isInteger(retry.attempt) && retry.attempt > 0 && retry.attempt <= retry.maxAttempts);
    assert(Number.isInteger(retry.maxAttempts) && Number.isFinite(retry.delayMs) && retry.delayMs >= 0);
    assert(Number.isFinite(retry.remainingMs) && retry.remainingMs >= 0 && retry.remainingMs <= retry.delayMs);
    assert.equal(typeof retry.errorMessage, "string");
  }
  if (state.llmRecovery) {
    assert.equal(state.llmRecovery.targetSessionId, state.targetSessionId);
    assert(state.llmRecovery.failureId && state.llmRecovery.failedEntryId);
    assert(["available", "starting"].includes(state.llmRecovery.status));
  }
  return state;
}

export async function watchRetrySmokeEvents(base: string, rootId: string) {
  const abort = new AbortController();
  const headerTimeout = setTimeout(() => abort.abort(), 15_000);
  let response: Response;
  try { response = await fetch(`${base}/api/sessions/${rootId}/events`, { signal: abort.signal, proxy: "" }); }
  finally { clearTimeout(headerTimeout); }
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const frames: Array<Record<string, any>> = [];
  const states: LlmRetryStateEventDto[] = [];
  let failure: unknown;
  const task = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const next = await reader.read();
      if (next.done) { assert(abort.signal.aborted, "Retry SSE ended unexpectedly"); return; }
      buffer += decoder.decode(next.value, { stream: true });
      assert(buffer.length < 4 * 1024 * 1024 && frames.length < 20_000, "Retry SSE fixture exceeded its bounds");
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end).trimEnd();
        buffer = buffer.slice(end + 1);
        if (!line.startsWith("data:")) continue;
        const frame = JSON.parse(line.slice(5));
        frames.push(frame);
        const state = retryStateInFrame(frame);
        if (state) states.push(state);
        assert(!JSON.stringify(frame).includes("easyresearch:llm-retry"), "Private retry wake leaked to public SSE");
      }
    }
  })().catch(error => { if (!abort.signal.aborted) failure = error; });
  return { frames, states, check() { if (failure) throw failure; },
    async close() { abort.abort(); await reader.cancel().catch(() => {}); await task; if (failure) throw failure; } };
}

type JsonEntry = Record<string, any>;

const evidenceKeys = new Set([
  "type", "id", "parentId", "customType", "timestamp", "data", "message", "details", "session", "subagents",
  "kind", "version", "sessionId", "sessionID", "ownerSessionId", "ownerSessionID", "childSessionId", "targetSessionId",
  "launchId", "launchIds", "toolCallId", "toolCallID", "agent", "agentId", "batchId", "inputID", "notificationID",
  "periodId", "failedEntryId", "failureId", "status", "state", "role", "stopReason", "toolName", "isError",
  "triggerTurn", "wake", "display", "pending", "active", "outcome", "outcomes", "result", "batch", "outstanding",
  "createdAt", "finishedAt", "acknowledgedAt", "continuation", "attempts", "ids", "llmRecovery", "automaticRetry",
]);
function retryEvidenceMetadata(value: unknown, depth = 0): unknown {
  if (depth > 10) return { truncated: true };
  if (Array.isArray(value)) return value.slice(0, 2000).map(item => retryEvidenceMetadata(item, depth + 1));
  if (!value || typeof value !== "object") return typeof value === "string" ? value.slice(0, 512) : value;
  const result: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (["content", "text", "errorMessage", "command", "description"].includes(key) || key === "message" && typeof field === "string") {
      const encoded = JSON.stringify(field) ?? "undefined";
      result[`${key}Sha256`] = createHash("sha256").update(encoded).digest("hex");
      result[`${key}Bytes`] = Buffer.byteLength(encoded);
    } else if (evidenceKeys.has(key)) result[key] = retryEvidenceMetadata(field, depth + 1);
  }
  return result;
}

/** Failure-only metadata archive, outside the native smoke's auto-deleted root. No auth/config files or message bodies. */
export function preserveRetryFailureEvidence(options: {
  root: string; caseName: string; phase: string; snapshots: readonly SessionSnapshotDto[]; parentDirectory?: string;
}): string {
  const parent = options.parentDirectory ?? (existsSync("/tmp/opencode") ? "/tmp/opencode" : tmpdir());
  const archive = mkdtempSync(join(parent, "easyresearch-retry-failure-"));
  const withinRoot = (path: string) => {
    const rel = relative(realpathSync(options.root), realpathSync(path));
    return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
  };
  assert(!withinRoot(archive), "Retry failure archive must survive fixture-root cleanup");
  const queue = options.snapshots.slice(-8).flatMap(snapshot => snapshot.session.sessionFile ? [snapshot.session.sessionFile] : []);
  const seen = new Set<string>();
  const histories: Array<{ source: string; entries: unknown[]; truncated?: boolean; skipped?: string }> = [];
  let budget = 3 * 1024 * 1024;
  while (queue.length && histories.length < 24) {
    const path = queue.shift()!;
    if (seen.has(path)) continue;
    seen.add(path);
    try {
      if (!path.endsWith(".jsonl") || !withinRoot(path)) throw new Error("not an isolated native history");
      if (statSync(path).size > 2 * 1024 * 1024) {
        histories.push({ source: path, entries: [], skipped: "source exceeds 2 MiB bound" });
        continue;
      }
      const rows = readFileSync(path, "utf8").trimEnd().split("\n").map(line => JSON.parse(line));
      if (rows[0]?.type !== "session" || typeof rows[0].id !== "string") throw new Error("not a native session history");
      for (const job of readSubagentJournal(rows).jobs.values()) if (job.sessionPath) queue.push(job.sessionPath);
      const projected: unknown[] = [];
      let truncated = rows.length > 2000;
      for (const row of rows.slice(-2000)) {
        const metadata = retryEvidenceMetadata(row);
        const bytes = Buffer.byteLength(JSON.stringify(metadata));
        if (bytes > budget) { truncated = true; break; }
        budget -= bytes;
        projected.push(metadata);
      }
      histories.push({ source: path, entries: projected, ...(truncated ? { truncated } : {}) });
    } catch { histories.push({ source: path, entries: [], skipped: "unavailable or outside isolated fixture" }); }
  }
  const report = { caseName: options.caseName, phase: options.phase, histories,
    snapshots: options.snapshots.slice(-8).map(snapshot => retryEvidenceMetadata({ session: snapshot.session, subagents: snapshot.subagents,
      llmRecovery: snapshot.llmRecovery, automaticRetry: snapshot.automaticRetry })), truncated: queue.length > 0 };
  const text = JSON.stringify(report);
  assert(Buffer.byteLength(text) + 1 <= 4 * 1024 * 1024, "Retry failure evidence exceeded its 4 MiB bound");
  const path = join(archive, "evidence.json");
  writeFileSync(path, text + "\n", { mode: 0o600 });
  return path;
}

function entries(path: string, directory: string): JsonEntry[] {
  const resolved = realpathSync(path);
  const rel = relative(realpathSync(directory), resolved);
  assert(rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`), "Retry acceptance may read only its private fixture histories");
  return readFileSync(resolved, "utf8").trimEnd().split("\n").map(line => JSON.parse(line));
}

const identity = (job: SubagentSessionSummaryDto) => ({ childSessionId: job.childSessionId, ownerSessionId: job.ownerSessionId,
  agentId: job.agentId, agent: job.agent });

function logicalIdentities(periods: readonly SubagentSessionSummaryDto[]) {
  const children = new Map<string, ReturnType<typeof identity>>();
  for (const period of periods) {
    const current = identity(period);
    const previous = children.get(period.childSessionId);
    if (previous) assert.deepEqual(current, previous, "Retry replaced a child identity, alias or immediate owner between visible periods");
    else children.set(period.childSessionId, current);
  }
  return [...children.values()].sort((a, b) => a.childSessionId.localeCompare(b.childSessionId));
}

export function assertCounterOnce(item: RetryFixtureCase): void {
  assert.deepEqual(readFileSync(item.counter, "utf8").trimEnd().split(/\r?\n/), [item.leaf.marker], "Manual/automatic retry replayed the completed side-effecting tool");
}

/** Captures native ids/paths once, then compares the same logical tree on recovery. */
export function captureRetryEvidence(snapshot: SessionSnapshotDto, recovery: LlmRecoveryDto, item: RetryFixtureCase, directory: string) {
  const rootPath = snapshot.session.sessionFile;
  assert(rootPath, "Native root did not materialize");
  const rootEntries = entries(rootPath, directory);
  const jobs = [...readSubagentJournal(rootEntries).jobs.values()];
  assert.equal(new Set(jobs.map(job => job.childSessionId)).size, item.depth, "Recovery changed the number of logical children");
  const target = item.depth ? jobs.find(job => job.childSessionId === recovery.targetSessionId) : undefined;
  assert(!item.depth || target?.sessionPath);
  const targetPath = target?.sessionPath ?? rootPath;
  const paths = new Map([[snapshot.session.id, rootPath]]);
  for (const job of jobs) {
    assert(job.childSessionId && job.sessionPath && job.launchAcknowledged);
    const previous = paths.get(job.childSessionId);
    if (previous) assert.equal(job.sessionPath, previous, "Child path changed between journal periods");
    paths.set(job.childSessionId, job.sessionPath);
  }
  const targetEntries = entries(targetPath, directory);
  const failed = targetEntries.find(entry => entry.id === recovery.failedEntryId);
  assert.equal(failed?.message?.role, "assistant");
  assert.equal(failed?.message?.stopReason, "error", "Retry checkpoint must name the real persisted failure");
  assert.equal(targetEntries.filter(entry => entry.type === "message" && entry.message?.role === "user").length, 1);
  assertCounterOnce(item);
  const original = logicalIdentities(snapshot.subagents);
  assert.equal(original.length, item.depth);
  if (item.depth === 2) {
    const owner = original.find(job => job.agent.endsWith("-owner"));
    const leaf = original.find(job => job.childSessionId === recovery.targetSessionId);
    assert(owner && leaf);
    assert.equal(owner.ownerSessionId, snapshot.session.id);
    assert.equal(leaf.ownerSessionId, owner.childSessionId, "Nested retry must retain the immediate original owner");
  } else if (target) assert.equal(target.ownerSessionId, snapshot.session.id);
  const verifiedFailures = new Map<string, JsonEntry>();
  const frozenOutcomes = new Map<string, JsonEntry>();
  const observedPeriods = new Set(jobs.map(job => job.launchId));
  const verifyCheckpoint = (checkpoint: LlmRecoveryDto): void => {
    assert(checkpoint.targetSessionId === recovery.targetSessionId && checkpoint.failureId
      && ["available", "starting"].includes(checkpoint.status), "Retry checkpoint targets an unexpected session or state");
    const matches = entries(targetPath, directory).filter(entry => entry.id === checkpoint.failedEntryId);
    assert(matches.length === 1 && matches[0]!.type === "message" && matches[0]!.message?.role === "assistant"
      && matches[0]!.message.stopReason === "error", "Retry checkpoint must identify one real persisted failure");
    const previous = verifiedFailures.get(checkpoint.failedEntryId);
    if (previous) assert.deepEqual(matches[0], previous, "Verified failed assistant entry changed");
    else verifiedFailures.set(checkpoint.failedEntryId, structuredClone(matches[0]!));
  };
  const announced = snapshot.session.id === recovery.targetSessionId ? snapshot.llmRecovery
    : snapshot.subagents.findLast(job => job.childSessionId === recovery.targetSessionId)?.llmRecovery;
  assert.deepEqual(announced, recovery, "Snapshot does not expose the supplied live Retry checkpoint");
  verifyCheckpoint(recovery);
  const check = (current: SessionSnapshotDto, terminal?: "complete" | "error") => {
    assert.equal(current.session.id, snapshot.session.id);
    assert.equal(current.session.sessionFile, rootPath);
    assert.deepEqual(logicalIdentities(current.subagents), original,
      "Retry replaced a child session, alias or immediate owner");
    const latestVisible = new Map(current.subagents.map(period => [period.childSessionId, period]));
    assert.equal(latestVisible.size, item.depth, "Retry changed the number of logical children");
    assertCounterOnce(item);
    for (const [id, path] of paths) {
      const history = entries(path, directory);
      assert.equal(history[0]?.id, id, "Physical JSONL identity changed");
      assert.equal(history.filter(entry => entry.type === "message" && entry.message?.role === "user").length, 1,
        "Retry inserted another native user/Task row");
      for (const control of history.filter(entry => entry.customType === "easyresearch:llm-retry")) {
        assert.equal(control.display, false);
        assert.equal(control.content, "");
      }
    }
    const journalEntries = entries(rootPath, directory);
    const currentJobs = [...readSubagentJournal(journalEntries).jobs.values()];
    assert.equal(new Set(currentJobs.map(job => job.childSessionId)).size, item.depth, "Retry created a replacement logical child");
    // The HTTP snapshot and this file read are not atomic. Each visible period
    // must exist in the journal, but an active child's newer period may already
    // have been appended after the response was produced.
    for (const visible of current.subagents) {
      const job = currentJobs.find(candidate => candidate.launchId === visible.launchId);
      assert(job && job.childSessionId === visible.childSessionId && job.ownerSessionId === visible.ownerSessionId
        && job.agent === visible.agent && job.agentId === visible.agentId && job.toolCallId === visible.toolCallId
        && job.sessionPath === paths.get(visible.childSessionId), "Retry replaced the visible launch without its original native journal identity/path");
    }
    for (const id of observedPeriods) assert(currentJobs.some(job => job.launchId === id), "An earlier execution period disappeared");
    for (const job of currentJobs) observedPeriods.add(job.launchId);
    for (const [id, frozen] of frozenOutcomes) {
      const reports = journalEntries.filter(entry => entry.customType === SUBAGENT_JOB_ENTRY
        && ["terminal", "background_report"].includes(entry.data?.kind) && entry.data.launchId === id);
      assert.equal(reports.length, 1, "A settled period was removed or duplicated");
      assert.deepEqual(reports[0], frozen, "A settled period outcome was changed or overwritten");
    }
    const checkpoints = [current.llmRecovery, ...[...latestVisible.values()].map(job => job.llmRecovery)].filter((value): value is LlmRecoveryDto => !!value);
    if (terminal) assert.equal(checkpoints.length, 0, "Terminal retry outcome retained a live checkpoint");
    for (const checkpoint of checkpoints) verifyCheckpoint(checkpoint);
    const targetHistory = entries(targetPath, directory);
    for (const [id, failure] of verifiedFailures) {
      assert.deepEqual(targetHistory.find(entry => entry.id === id), failure, "Verified failed assistant entry changed or disappeared");
    }
    if (!terminal && checkpoints.length === 0) {
      const consumed = targetHistory.some(entry => entry.type === "custom_message" && entry.customType === "easyresearch:llm-retry"
        && verifiedFailures.has(entry.details?.failedEntryId) && entry.display === false && entry.content === "");
      const currentPeriod = [...currentJobs].reverse().find(job => job.childSessionId === recovery.targetSessionId);
      const active = item.depth ? currentPeriod?.status === "working" && !currentPeriod.terminalStatus
        : current.session.isStreaming || !!current.automaticRetry;
      assert(consumed && active, "Expected a live Retry checkpoint or its admitted active recovery");
    }
    const latest = new Map<string, typeof currentJobs[number]>();
    for (const job of currentJobs) {
      const previous = latest.get(job.childSessionId!);
      const originalJob = jobs.find(candidate => candidate.childSessionId === job.childSessionId);
      assert(originalJob && job.ownerSessionId === originalJob.ownerSessionId && job.agent === originalJob.agent
        && job.agentId === originalJob.agentId && job.sessionPath === originalJob.sessionPath, "Retry replaced the original child identity");
      if (previous) assert(previous.terminalStatus && job.continuation, "A new busy period replaced an unsettled child execution");
      latest.set(job.childSessionId!, job);
      const outcomes = journalEntries.filter(entry => entry.customType === SUBAGENT_JOB_ENTRY
        && ["terminal", "background_report"].includes(entry.data?.kind) && entry.data.launchId === job.launchId);
      assert(outcomes.length <= 1, "Premature or duplicate terminal child outcome");
      const frozen = frozenOutcomes.get(job.launchId);
      if (frozen) assert.deepEqual(outcomes[0], frozen, "A settled period outcome was changed or overwritten");
      else if (outcomes[0]) frozenOutcomes.set(job.launchId, structuredClone(outcomes[0]));
      const outcome = outcomes[0]?.data;
      const intermediate = outcome?.kind === "background_report" && outcome.result.state === "completed" && outcome.result.outstanding.length > 0;
      const recoverableError = outcome?.kind === "background_report" && outcome.result.state === "error"
        && job.childSessionId === recovery.targetSessionId && [...verifiedFailures.values()].some(entry =>
          typeof entry.message.errorMessage === "string" && entry.message.errorMessage.length > 0
          && typeof outcome.result.text === "string" && outcome.result.text.trim() === entry.message.errorMessage.trim());
      if (outcome?.kind === "background_report" && outcome.result.state === "error") {
        assert(recoverableError, "Error period has no verified native Retry checkpoint");
      }
      if (!terminal) assert(!outcome || intermediate || recoverableError, "Premature terminal child outcome");
      const ownerHistory = entries(paths.get(job.ownerSessionId)!, directory);
      const handoffs = ownerHistory.filter(entry => entry.type === "custom_message" && entry.customType === AGENT_STATUS_TYPE
        && entry.details?.outcomes?.some((outcome: { launchId: string }) => outcome.launchId === job.launchId));
      assert(handoffs.length <= 1 && handoffs.length <= outcomes.length, "Premature or duplicate original-owner handoff");
      if (terminal && outcome) assert.equal(handoffs.length, 1,
        `Missing original-owner handoff for settled busy period ${JSON.stringify({ case: item.name, phase: terminal,
          rootId: snapshot.session.id, launchId: job.launchId, childSessionId: job.childSessionId,
          ownerSessionId: job.ownerSessionId, status: job.terminalStatus, periodState: outcome.result?.state,
          batchId: outcome.batch?.batchId, triggerTurn: outcome.batch?.triggerTurn })}`);
    }
    for (const job of latest.values()) {
      if (terminal) {
        const visible = latestVisible.get(job.childSessionId!);
        assert(visible && visible.launchId === job.launchId && visible.toolCallId === job.toolCallId,
          "Terminal snapshot's last visible launch is not the latest native journal period");
        assert.equal(job.terminalStatus, terminal, "Missing final child outcome");
        if (job.backgroundResult) assert.equal(job.backgroundResult.outstanding.length, 0, "Final retry outcome retained background work");
      }
    }
    if (!terminal && item.depth) assert.equal(current.session.status, "running", "Parked descendant must still count as owned work");
    return { rootId: snapshot.session.id, targetSessionId: recovery.targetSessionId, identities: original,
      userRows: paths.size, toolExecutions: 1, terminalOutcomes: terminal ? latest.size : 0 };
  };
  check(snapshot);
  return { check, targetPath, rootPath };
}

export async function recoverySnapshot(base: string, rootId: string, fixture: LlmRetryFixture, deadline: number,
  previousFailureId?: string) {
  const snapshot = await retrySmokeWait("current retry checkpoint", deadline, async () => {
    if (fixture.failure) throw fixture.failure;
    return await retrySmokeRequest(base, `/api/sessions/${rootId}/snapshot`) as SessionSnapshotDto;
  }, value => [value.llmRecovery, ...value.subagents.map(job => job.llmRecovery)]
    .some(state => state?.status === "available" && state.failureId !== previousFailureId));
  const recovery = [snapshot.llmRecovery, ...snapshot.subagents.map(job => job.llmRecovery)]
    .find(state => state?.status === "available" && state.failureId !== previousFailureId)!;
  return { snapshot, recovery };
}

export async function assertRetryRejected(base: string, rootId: string, recovery: LlmRecoveryDto) {
  const result = await retrySmokeRequest(base, `/api/sessions/${rootId}/retry`, {
    targetSessionId: recovery.targetSessionId, failureId: recovery.failureId,
  }, 409);
  assert(["LLM_RETRY_STALE", "LLM_RETRY_BUSY", "LLM_RETRY_UNAVAILABLE"].includes(result.code), "Missing typed retry rejection");
  return result.code as string;
}

export async function acceptRetry(base: string, rootId: string, recovery: LlmRecoveryDto) {
  const body = { targetSessionId: recovery.targetSessionId, failureId: recovery.failureId };
  const accepted = await retrySmokeRequest(base, `/api/sessions/${rootId}/retry`, body, 202);
  assert.deepEqual(accepted, { accepted: true, ...body });
  return accepted;
}

export async function waitRetryComplete(base: string, rootId: string, item: RetryFixtureCase, fixture: LlmRetryFixture, deadline: number) {
  return retrySmokeWait("recovered logical tree completion", deadline, async () => {
    if (fixture.failure) throw fixture.failure;
    return await retrySmokeRequest(base, `/api/sessions/${rootId}/snapshot`) as SessionSnapshotDto;
  }, snapshot => snapshot.session.status === "ready" && !snapshot.session.isStreaming
    && snapshot.timeline.some(entry => entry.kind === "message" && entry.message.role === "assistant"
      && smokeAgentText(entry.message.content) === item.final));
}

/** Called from the existing native smoke after first-run setup. Never builds a candidate. */
export async function runLlmRetrySmoke(options: { base: string; root: string; agentDir: string; deadline: number; fixture: LlmRetryFixture }) {
  const { base, root, agentDir, fixture } = options;
  const deadline = Math.min(options.deadline, Date.now() + 120_000);
  const fast = join(root, "llm-retry-fast");
  const defaults = join(root, "llm-retry-default");
  mkdirSync(join(fast, ".easyresearch"), { recursive: true });
  mkdirSync(join(defaults, ".easyresearch"), { recursive: true });
  // Leave retry entirely absent; keep unrelated automatic summaries out of this
  // first-failure timing probe regardless of the release smoke's global defaults.
  writeFileSync(join(defaults, ".easyresearch", "settings.json"), JSON.stringify({ compaction: { enabled: false } }));
  // Public native project settings, not hidden runtime test switches.
  writeFileSync(join(fast, ".easyresearch", "settings.json"), JSON.stringify({
    compaction: { enabled: false, keepRecentTokens: 20 }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
  }));
  fixture.writeAgents(agentDir);
  await retrySmokeWait("retry custom Agent catalog", deadline,
    () => retrySmokeRequest(base, "/api/agents"), rows => [fixture.leafAgent, fixture.ownerAgent].every(name => rows.some((row: { name: string }) => row.name === name)));
  const receipts: unknown[] = [];
  const sessions = new Set<string>();
  const streams: Array<Awaited<ReturnType<typeof watchRetrySmokeEvents>>> = [];
  let caseName = "native_default";
  let phase = "default-retry";
  let primaryError: unknown;
  const create = async (cwd: string) => {
    const created = await retrySmokeRequest(base, "/api/sessions", { cwd });
    sessions.add(created.id);
    const stream = await watchRetrySmokeEvents(base, created.id);
    streams.push(stream);
    await retrySmokeWait("retry SSE initial barrier", deadline, () => stream.frames, frames => frames.some(frame => frame.type === "snapshot"));
    return { id: created.id as string, stream };
  };
  try {
    const defaultLane = fixture.addProbe("native_default");
    const defaultRoot = await create(defaults);
    await retrySmokeRequest(base, `/api/sessions/${defaultRoot.id}/messages`, { message: fixture.prompt(defaultLane.name) });
    const defaultState = await retrySmokeWait("native default first backoff", deadline,
      () => { defaultRoot.stream.check(); return defaultRoot.stream.states.find(state => state.automaticRetry); }, Boolean);
    assert(defaultState?.automaticRetry);
    assert.equal(defaultState.targetSessionId, defaultRoot.id);
    assert.equal(defaultState.automaticRetry.source, "agent");
    assert.equal(defaultState.automaticRetry.maxAttempts, 10);
    assert.equal(defaultState.automaticRetry.attempt, 1);
    assert.equal(defaultState.automaticRetry.delayMs, 5000);
    const backoff = await retrySmokeRequest(base, `/api/sessions/${defaultRoot.id}/snapshot`) as SessionSnapshotDto;
    assert.equal(backoff.automaticRetry?.delayMs, 5000, "Reconnect snapshot lost automatic backoff");
    await retrySmokeWait("default native retry success", deadline, () => {
      if (fixture.failure) throw fixture.failure;
      defaultRoot.stream.check();
      return defaultLane.complete;
    }, Boolean);
    assert.equal(defaultLane.requests.length, 2, "Provider/SDK retries must stay separate from native Agent retries");
    const realDelayMs = defaultLane.requests[1]!.at - defaultLane.requests[0]!.at;
    assert(realDelayMs >= 5000, `Default native wait was short: ${realDelayMs}ms`);
    receipts.push({ kind: "default", maxAttempts: 10, delayMs: 5000, realDelayMs, providerRequests: 2 });

    for (const depth of [0, 1, 2] as const) {
      caseName = `native_depth_${depth}`;
      phase = "manual-recovery-cycles";
      const item = fixture.addCase(`native_depth_${depth}`, depth);
      const { id, stream } = await create(fast);
      await retrySmokeRequest(base, `/api/sessions/${id}/messages`, { message: item.prompt });
      const first = await recoverySnapshot(base, id, fixture, deadline);
      assert.equal(item.leaf.failures, 2, "Explicit one-retry project policy not applied");
      const evidence = captureRetryEvidence(first.snapshot, first.recovery, item, root);
      const childSnapshot = depth ? await retrySmokeRequest(base, `/api/sessions/${id}/subagents/${first.recovery.targetSessionId}/snapshot`) as ChildSessionSnapshotDto : first.snapshot;
      assert.deepEqual(childSnapshot.llmRecovery, first.recovery);
      const gate = item.leaf.holdNext();
      try {
        await acceptRetry(base, id, first.recovery);
        const duplicateCode = await assertRetryRejected(base, id, first.recovery);
        await retrySmokeWait("manual recovery reached same provider context", deadline, () => gate.hit, Boolean);
        evidence.check(await retrySmokeRequest(base, `/api/sessions/${id}/snapshot`));
        receipts.push({ depth, duplicateCode });
      } finally { gate.release(); }
      const second = await recoverySnapshot(base, id, fixture, deadline, first.recovery.failureId);
      assert.equal(item.leaf.failures, 4, "Manual recovery did not receive a fresh native retry budget");
      assert.notEqual(second.recovery.failedEntryId, first.recovery.failedEntryId);
      assert.equal(second.recovery.targetSessionId, first.recovery.targetSessionId);
      evidence.check(second.snapshot);
      await assertRetryRejected(base, id, first.recovery);
      await acceptRetry(base, id, second.recovery);
      const complete = await waitRetryComplete(base, id, item, fixture, deadline);
      assert.equal(item.leaf.requests.length, 7, "Expected tool, two exhausted cycles, then manual + automatic success");
      assert.equal(item.leaf.failures, 5);
      receipts.push({ kind: "recovery", depth, ...evidence.check(complete, "complete") });
      const targetStates = stream.states.filter(state => state.targetSessionId === first.recovery.targetSessionId);
      const retries = targetStates.filter((state, index) => state.automaticRetry && !targetStates[index - 1]?.automaticRetry);
      assert.equal(retries.length, 3, "Each admitted cycle must expose one native automatic retry");
      for (const state of retries) assert.deepEqual({ attempt: state.automaticRetry!.attempt, max: state.automaticRetry!.maxAttempts, delay: state.automaticRetry!.delayMs },
        { attempt: 1, max: 1, delay: 0 });
      if (depth) {
        const routed = stream.frames.filter(frame => frame.type === "subagent_supervisor" && frame.event?.type === "llm_retry_state"
          && frame.event.targetSessionId === first.recovery.targetSessionId);
        assert(routed.length > 0, "Nested retry state did not cross the original supervisor channel");
        for (const frame of routed) assert.equal(frame.ownerSessionId,
          first.snapshot.subagents.find(job => job.childSessionId === first.recovery.targetSessionId)!.ownerSessionId);
      }
      await assertRetryRejected(base, id, second.recovery);
      stream.check();
    }

    // One compiled summary wiring probe complements the policy owner's real-Pi
    // fake-clock tests for the full capped schedule and split-summary policy reuse.
    const summaryRoot = await create(fast);
    caseName = "native_summary";
    phase = "compaction-retry";
    for (const [name, text] of [["native_summary_history", "Verified evidence with reproducible observations. ".repeat(400)],
      ["native_summary_tail", "Tail retained for native compaction."]] as const) {
      fixture.addText(name, text);
      await retrySmokeRequest(base, `/api/sessions/${summaryRoot.id}/messages`, { message: fixture.prompt(name) });
      await retrySmokeWait("summary fixture native turn", deadline,
        async () => {
          if (fixture.failure) throw fixture.failure;
          return await retrySmokeRequest(base, `/api/sessions/${summaryRoot.id}/snapshot`) as SessionSnapshotDto;
        }, snapshot => snapshot.session.status === "ready" && snapshot.timeline.some(entry => entry.kind === "message"
          && entry.message.role === "assistant" && smokeAgentText(entry.message.content) === text));
    }
    const summary = fixture.addSummary("native_summary");
    await retrySmokeRequest(base, `/api/sessions/${summaryRoot.id}/compact`, { customInstructions: fixture.prompt(summary.name) });
    await retrySmokeWait("compiled compaction retry", deadline, async () => {
      if (fixture.failure) throw fixture.failure;
      summaryRoot.stream.check();
      return await retrySmokeRequest(base, `/api/sessions/${summaryRoot.id}/snapshot`) as SessionSnapshotDto;
    }, snapshot => snapshot.timeline.some(entry => entry.kind === "compaction" && entry.summary?.includes(summary.final)));
    const summaryWait = summaryRoot.stream.states.find(state => state.automaticRetry?.source === "compaction");
    assert(summaryWait?.automaticRetry);
    assert.equal(summaryWait.automaticRetry.maxAttempts, 1);
    assert.equal(summaryWait.automaticRetry.delayMs, 0);
    assert.equal(summary.requests.length, 2);
    receipts.push({ kind: "compaction-wiring", providerRequests: summary.requests.length, nativeRetrySource: summaryWait.automaticRetry.source });

    const parked = fixture.addCase("native_stop_parked", 2);
    caseName = parked.name;
    phase = "parked-task-tree-cancellation";
    const parkRoot = await create(fast);
    await retrySmokeRequest(base, `/api/sessions/${parkRoot.id}/messages`, { message: parked.prompt });
    const parkedState = await recoverySnapshot(base, parkRoot.id, fixture, deadline);
    const parkedEvidence = captureRetryEvidence(parkedState.snapshot, parkedState.recovery, parked, root);
    await retrySmokeRequest(base, `/api/sessions/${parkRoot.id}/abort`, {});
    const stillOwned = await retrySmokeRequest(base, `/api/sessions/${parkRoot.id}/snapshot`) as SessionSnapshotDto;
    assert(stillOwned.subagents.some(job => job.childSessionId === parkedState.recovery.targetSessionId && job.llmRecovery),
      "Root composer Stop incorrectly cancelled a parked descendant");
    parkedEvidence.check(stillOwned);
    const directChild = stillOwned.subagents.find(job => job.ownerSessionId === parkRoot.id);
    assert(directChild, "Missing campaign task for tree cancellation");
    parked.dispatcher?.expectCancellation();
    parked.owner?.expectCancellation();
    await retrySmokeRequest(base, `/api/sessions/${parkRoot.id}/background/${directChild.childSessionId}/cancel`, {});
    const stopped = await retrySmokeWait("parked descendant task-tree cancellation", deadline,
      () => retrySmokeRequest(base, `/api/sessions/${parkRoot.id}/snapshot`) as Promise<SessionSnapshotDto>,
      snapshot => snapshot.session.status === "ready" && !snapshot.llmRecovery && snapshot.subagents.every(job => !job.llmRecovery));
    receipts.push({ kind: "cancel-parked-tree", ...parkedEvidence.check(stopped, "error") });
    await assertRetryRejected(base, parkRoot.id, parkedState.recovery);

    const cancelLane = fixture.addProbe("native_stop_backoff", true);
    caseName = cancelLane.name;
    phase = "root-backoff-cancellation";
    const cancelRoot = await create(defaults);
    await retrySmokeRequest(base, `/api/sessions/${cancelRoot.id}/messages`, { message: fixture.prompt(cancelLane.name) });
    await retrySmokeWait("backoff Stop boundary", deadline, () => cancelRoot.stream.states.some(state => !!state.automaticRetry), Boolean);
    await retrySmokeRequest(base, `/api/sessions/${cancelRoot.id}/abort`, {});
    await new Promise(resolve => setTimeout(resolve, 5100));
    const cancelled = await retrySmokeRequest(base, `/api/sessions/${cancelRoot.id}/snapshot`) as SessionSnapshotDto;
    assert.equal(cancelled.session.status, "ready");
    assert(!cancelled.automaticRetry && !cancelled.llmRecovery);
    assert.equal(cancelLane.requests.length, 1, "Stop allowed a pending native retry to issue");
    receipts.push({ kind: "stop-backoff", providerRequests: cancelLane.requests.length });
    if (fixture.failure) throw fixture.failure;
    writeFileSync(join(root, "llm-retry-report.json"), JSON.stringify(receipts, null, 2));
    console.log(`[smoke] LLM retry: native default 10/5000ms, preserved tool/context/root/direct/nested ids, fresh single-use cycles, one handoff and reusable parked/backoff Stop passed (${Math.round(realDelayMs)}ms real wait)`);
    return receipts;
  } catch (error) {
    primaryError = error;
    try {
      const snapshots = await Promise.all([...sessions].slice(-8).map(async id => {
        try { return await retrySmokeRequest(base, `/api/sessions/${id}/snapshot`) as SessionSnapshotDto; }
        catch { return undefined; }
      }));
      const evidence = preserveRetryFailureEvidence({ root, caseName, phase,
        snapshots: snapshots.filter((snapshot): snapshot is SessionSnapshotDto => snapshot !== undefined) });
      console.error(`[smoke] Retry failure evidence: ${evidence} (case=${caseName}, phase=${phase})`);
      if (error instanceof Error) error.message += `\nRetry failure evidence: ${evidence}`;
    } catch (captureError) {
      console.error(`[smoke] Retry failure evidence unavailable (${captureError instanceof Error ? captureError.name : "unknown error"})`);
    }
    throw error;
  } finally {
    fixture.release();
    const cleanup = await Promise.allSettled([
      ...streams.map(stream => stream.close()),
      ...[...sessions].map(id => retrySmokeRequest(base, `/api/sessions/${id}/stop`, {})),
    ]);
    const failures = cleanup.filter(result => result.status === "rejected");
    if (failures.length) throw new AggregateError([...(primaryError ? [primaryError] : []), ...failures.map(result => result.reason)],
      "LLM retry acceptance cleanup failed");
  }
}
