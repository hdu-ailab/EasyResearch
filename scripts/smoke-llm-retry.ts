import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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
function entries(path: string, directory: string): JsonEntry[] {
  const resolved = realpathSync(path);
  const rel = relative(realpathSync(directory), resolved);
  assert(rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`), "Retry acceptance may read only its private fixture histories");
  return readFileSync(resolved, "utf8").trimEnd().split("\n").map(line => JSON.parse(line));
}

const identity = (job: SubagentSessionSummaryDto) => ({ childSessionId: job.childSessionId, ownerSessionId: job.ownerSessionId,
  launchId: job.launchId, toolCallId: job.toolCallId, agentId: job.agentId, agent: job.agent });

export function assertCounterOnce(item: RetryFixtureCase): void {
  assert.deepEqual(readFileSync(item.counter, "utf8").trimEnd().split(/\r?\n/), [item.leaf.marker], "Manual/automatic retry replayed the completed side-effecting tool");
}

/** Captures native ids/paths once, then compares the same logical tree on recovery. */
export function captureRetryEvidence(snapshot: SessionSnapshotDto, recovery: LlmRecoveryDto, item: RetryFixtureCase, directory: string) {
  const rootPath = snapshot.session.sessionFile;
  assert(rootPath, "Native root did not materialize");
  const rootEntries = entries(rootPath, directory);
  const jobs = [...readSubagentJournal(rootEntries).jobs.values()];
  assert.equal(jobs.length, item.depth, "Recovery changed the number of logical launches");
  const target = item.depth ? jobs.find(job => job.childSessionId === recovery.targetSessionId) : undefined;
  assert(!item.depth || target?.sessionPath);
  const targetPath = target?.sessionPath ?? rootPath;
  const paths = new Map([[snapshot.session.id, rootPath], ...jobs.map(job => {
    assert(job.childSessionId && job.sessionPath && job.launchAcknowledged);
    return [job.childSessionId, job.sessionPath] as const;
  })]);
  const targetEntries = entries(targetPath, directory);
  const failed = targetEntries.find(entry => entry.id === recovery.failedEntryId);
  assert.equal(failed?.message?.role, "assistant");
  assert.equal(failed?.message?.stopReason, "error", "Retry checkpoint must name the real persisted failure");
  assert.equal(targetEntries.filter(entry => entry.type === "message" && entry.message?.role === "user").length, 1);
  assertCounterOnce(item);
  const original = snapshot.subagents.map(identity).sort((a, b) => a.childSessionId.localeCompare(b.childSessionId));
  assert.equal(original.length, item.depth);
  if (item.depth === 2) {
    const owner = original.find(job => job.agent.endsWith("-owner"));
    const leaf = original.find(job => job.childSessionId === recovery.targetSessionId);
    assert(owner && leaf);
    assert.equal(owner.ownerSessionId, snapshot.session.id);
    assert.equal(leaf.ownerSessionId, owner.childSessionId, "Nested retry must retain the immediate original owner");
  } else if (target) assert.equal(target.ownerSessionId, snapshot.session.id);
  const check = (current: SessionSnapshotDto, terminal?: "complete" | "error") => {
    assert.equal(current.session.id, snapshot.session.id);
    assert.equal(current.session.sessionFile, rootPath);
    assert.deepEqual(current.subagents.map(identity).sort((a, b) => a.childSessionId.localeCompare(b.childSessionId)), original,
      "Retry replaced a child session, launch, alias or immediate owner");
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
    assert.equal(readSubagentJournal(journalEntries).jobs.size, jobs.length);
    for (const job of jobs) {
      const outcomes = journalEntries.filter(entry => entry.customType === SUBAGENT_JOB_ENTRY
        && entry.data?.kind === "terminal" && entry.data.launchId === job.launchId);
      assert.equal(outcomes.length, terminal ? 1 : 0, "Premature or duplicate terminal child outcome");
      if (terminal) assert.equal(outcomes[0]!.data.status, terminal);
      const ownerHistory = entries(paths.get(job.ownerSessionId)!, directory);
      const handoffs = ownerHistory.filter(entry => entry.type === "custom_message" && entry.customType === AGENT_STATUS_TYPE
        && entry.details?.outcomes?.some((outcome: { launchId: string }) => outcome.launchId === job.launchId));
      assert.equal(handoffs.length, terminal ? 1 : 0, "Premature or duplicate original-owner handoff");
    }
    if (!terminal && item.depth) assert.equal(current.session.status, "running", "Parked descendant must still count as owned work");
    return { rootId: snapshot.session.id, targetSessionId: recovery.targetSessionId, identities: original,
      userRows: paths.size, toolExecutions: 1, terminalOutcomes: terminal ? jobs.length : 0 };
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
    const parkRoot = await create(fast);
    await retrySmokeRequest(base, `/api/sessions/${parkRoot.id}/messages`, { message: parked.prompt });
    const parkedState = await recoverySnapshot(base, parkRoot.id, fixture, deadline);
    const parkedEvidence = captureRetryEvidence(parkedState.snapshot, parkedState.recovery, parked, root);
    await retrySmokeRequest(base, `/api/sessions/${parkRoot.id}/abort`, {});
    const stopped = await retrySmokeWait("parked descendant reusable Stop", deadline,
      () => retrySmokeRequest(base, `/api/sessions/${parkRoot.id}/snapshot`) as Promise<SessionSnapshotDto>,
      snapshot => snapshot.session.status === "ready" && !snapshot.llmRecovery && snapshot.subagents.every(job => !job.llmRecovery));
    receipts.push({ kind: "stop-parked", ...parkedEvidence.check(stopped, "error") });
    await assertRetryRejected(base, parkRoot.id, parkedState.recovery);

    const cancelLane = fixture.addProbe("native_stop_backoff", true);
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
