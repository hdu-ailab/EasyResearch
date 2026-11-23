import { randomUUID } from "node:crypto";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentRuntimeBinding } from "../runtime/agent-runtime-binding";
import { assertModelRequestReady } from "../runtime/model-request-error";
import type { AgentConfig } from "./agents";
import { BACKGROUND_INPUT, BACKGROUND_WAKE, RESTART_PROMPT, type BackgroundPeriodResult } from "./background-periods";
import type { SubagentCoordinator } from "./coordinator";
import type { StageAgentSession, StageLaunchOptions, StageRunResult } from "./stage-session";
import type { SubagentSupervisor } from "./supervisor";
import { ExecutionClaims } from "../background/execution-claims";
import { admitBackgroundInput, pendingBackgroundInputs } from "../background/inbox";
import type { LlmRecoveryController } from "../runtime/llm-recovery";
import { installExecutionClaimBoundary } from "../background/execution-boundary";
import type { PrepareRequest } from "@earendil-works/pi-agent-core";
import { runCleanupSteps } from "../runtime/cleanup";

export const CHILD_SELECTION = "easyresearch:child_selection";
const SELECTION = CHILD_SELECTION;
const CANCELLED_INPUTS = "easyresearch:subagent_cancelled_inputs";
type ChildSelection = { agentName: string; model?: string; thinking?: ThinkingLevel };

export interface StageBackgroundController {
  readonly firstPeriod: Promise<void>;
  isBusy(): boolean;
  isStarted(): boolean;
  hasRecovery(): boolean;
  hasBackgroundWork(): boolean;
  selection(): { agent: string; model?: string; thinking: ThinkingLevel };
  prepareWake(): Promise<void>;
  drainPending(): Promise<void>;
  start(): void;
  begin(): void;
  followUp(input: { task: string; agent: AgentConfig; model?: string; thinking?: ThinkingLevel; inputID: string; signal?: AbortSignal }): Promise<boolean>;
  notify(notice: { id: string; content: string; wake?: boolean; recovered?: boolean }): Promise<void>;
  requestCancellation(): void;
  cancel(reason?: string): Promise<void>;
  suspend(reason?: string): Promise<void>;
  dispose(): Promise<void>;
}

function text(message: AgentMessage): string | undefined {
  if (message.role !== "assistant") return;
  const value = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n\n");
  return value.trim() || undefined;
}

/** Owns native run promises, including later shell/descendant-notification wakes. */
export function createStageBackgroundController(deps: {
  session: StageAgentSession;
  binding: AgentRuntimeBinding;
  supervisor: SubagentSupervisor;
  coordinator: SubagentCoordinator;
  options: StageLaunchOptions;
  initialResult: StageRunResult;
  disposeRecovery(): void;
  recovery: LlmRecoveryController;
  shell?: () => { path?: string; commandPrefix?: string };
  onResult(result: BackgroundPeriodResult): void;
}): StageBackgroundController {
  const { session, binding, supervisor, coordinator, options } = deps;
  const journal = { getSessionId: () => session.sessionId,
    getSessionFile: () => session.sessionFile,
    getEntries: () => session.sessionManager.getEntries(),
    appendCustomEntry: (type: string, data: unknown) => session.sessionManager.appendCustomEntry!(type, data) };
  const claims = new ExecutionClaims(journal);
  const cancelledInputs = new Set<string>();
  for (const entry of journal.getEntries() as Array<any>) {
    if (entry.type === "custom" && entry.customType === CANCELLED_INPUTS && entry.data?.ownerSessionID === session.sessionId && Array.isArray(entry.data.ids)) {
      for (const id of entry.data.ids) if (typeof id === "string") cancelledInputs.add(id);
    }
  }
  const pendingInputs = () => pendingBackgroundInputs(journal).filter((entry) => !cancelledInputs.has(entry.id));
  let busy = false;
  let started = false;
  let suspended = false;
  let cancelled = false;
  let cancellationRequested = false;
  let cancellationNeedsPeriod = false;
  let disposed = false;
  let latestText: string | undefined;
  let failure: string | undefined;
  let initialDone!: () => void;
  const firstPeriod = new Promise<void>((resolve) => { initialDone = resolve; });
  const runs = new Set<Promise<void>>();
  const queued = new Set<string>();
  let releaseShell: (() => void) | undefined;
  let admission = Promise.resolve();
  let pendingSelection: ChildSelection | undefined;
  let admissionFailure: Error | undefined;
  let cancellation: Promise<void> | undefined;
  let suspension: Promise<void> | undefined;
  for (const entry of session.sessionManager.getEntries() as Array<any>) {
    if (entry.type === "custom" && entry.customType === SELECTION && typeof entry.data?.selection?.agentName === "string") {
      pendingSelection = entry.data.pending ? entry.data.selection : undefined;
    }
  }

  const begin = (forCancellation = false) => {
    if (admissionFailure) throw admissionFailure;
    if (busy || suspended || cancelled || disposed || (cancellationRequested && !forCancellation)) return;
    try { options.backgroundLifecycle?.started(); claims.start(); }
    catch (error) { admissionFailure = error instanceof Error ? error : new Error(String(error)); throw admissionFailure; }
    busy = true;
    latestText = undefined;
    failure = undefined;
  };
  const finish = (error?: unknown) => {
    if (!busy) return;
    try { executionBoundary.assertHealthy(); }
    catch (failure) { error ??= failure; deps.recovery.blockCurrentRun(); }
    busy = false;
    try {
      if (!suspended) deps.onResult({
        state: cancelled || cancellationRequested ? "cancelled" : error || failure ? "error" : "completed",
        text: cancelled || cancellationRequested ? "Subagent cancelled" : error ? String(error instanceof Error ? error.message : error) : failure ?? latestText,
        outstanding: coordinator.outstanding(session.sessionId),
      });
      if (!suspended) { if (cancelled || cancellationRequested) claims.cancel(); else claims.settle(); }
      if (pendingSelection && !suspended && !cancelled) {
        queueMicrotask(() => { void serial(applyPendingSelection).catch(() => {}); });
      }
    } finally { initialDone(); }
  };
  const agent = session.agent as StageAgentSession["agent"] & { prepareRequest?: PrepareRequest };
  const previousPrepare = agent.prepareRequest;
  const prepare: PrepareRequest = async (request, signal) => {
    if (suspended || cancelled || cancellationRequested || disposed) throw new Error("Subagent execution is no longer admitted.");
    begin();
    const result = await previousPrepare?.call(agent, request, signal);
    return result || undefined;
  };
  agent.prepareRequest = prepare;
  const executionBoundary = installExecutionClaimBoundary(session as unknown as Parameters<typeof installExecutionClaimBoundary>[0], claims);
  const previousSend = session.sendCustomMessage;
  session.sendCustomMessage = (message, sendOptions) => executionBoundary.observe(() => previousSend.call(session, message, sendOptions))
    .catch((error) => { finish(error); throw error; });
  const own = (operation: Promise<void>) => {
    let tracked!: Promise<void>;
    tracked = operation.catch((error) => {
      deps.initialResult.exitCode = 1;
      deps.initialResult.errorMessage = error instanceof Error ? error.message : String(error);
      try { finish(error); }
      catch (failure) { admissionFailure = failure instanceof Error ? failure : new Error(String(failure)); }
    }).finally(() => { runs.delete(tracked); });
    runs.add(tracked);
    return tracked;
  };
  const unsubscribe = session.subscribe((raw) => {
    const event = raw as { type: string; message?: AgentMessage };
    if (event.type === "agent_start") begin();
    if (event.type === "message_end" && event.message?.role === "assistant") {
      // The latest response in this period, including an empty response, replaces the old one.
      latestText = text(event.message);
      failure = event.message.stopReason === "error" ? event.message.errorMessage || "Subagent model request failed" : undefined;
    }
    if (event.type === "agent_settled") {
      try { finish(); }
      catch (error) { admissionFailure = error instanceof Error ? error : new Error(String(error)); }
    }
  });
  const unsubscribeActivity = supervisor.subscribeActivity(() => options.backgroundLifecycle?.activity?.());

  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const operation = admission.then(run);
    admission = operation.then(() => {}, () => {});
    return operation;
  };
  const applyPendingSelection = async (): Promise<void> => {
    if (!pendingSelection || !session.isIdle || suspended || cancelled || cancellationRequested || disposed) return;
    const selected = pendingSelection;
    await binding.setChildSelection?.(selected);
    session.sessionManager.appendCustomEntry!(SELECTION, { selection: selected, pending: false });
    if (pendingSelection === selected) pendingSelection = undefined;
  };
  const deliver = async (id: string, content: string, customType: string, wake = true, signal?: AbortSignal): Promise<boolean> => {
    signal?.throwIfAborted();
    if (disposed || suspended || cancelled || cancellationRequested) throw new Error("Subagent runtime is no longer accepting input.");
    if (!session.isStreaming) {
      await session.waitForIdle();
      await applyPendingSelection();
      await binding.ensureCurrent();
      if (!binding.current().enabled) throw new Error("The selected Agent is not enabled in the current valid configuration.");
      assertModelRequestReady(binding.modelRuntime(), binding.model());
    }
    if (disposed || suspended || cancelled || cancellationRequested) throw new Error("Subagent runtime is no longer accepting input.");
    signal?.throwIfAborted();
    if (admitBackgroundInput(journal, { id, content, customType, wake }) === "delivered" || queued.has(id)) return false;
    begin();
    queued.add(id);
    own(session.sendCustomMessage({ customType, content, display: false, details: { inputID: id, ownerSessionID: session.sessionId } }, { deliverAs: "steer", triggerTurn: true })
      .catch((error) => { queued.delete(id); throw error; }));
    return true;
  };

  const controller: StageBackgroundController = {
    firstPeriod,
    isBusy: () => busy || !session.isIdle,
    isStarted: () => started,
    hasRecovery: () => deps.recovery.hasWork(),
    hasBackgroundWork: () => !supervisor.isQuiescent(),
    selection: () => ({ agent: binding.current().name, model: session.model ? `${session.model.provider}/${session.model.id}` : undefined, thinking: session.thinkingLevel }),
    prepareWake() {
      return serial(async () => {
        if (cancellationRequested) throw new Error("Subagent cancellation is pending.");
        if (session.isStreaming) return;
        await session.waitForIdle();
        await applyPendingSelection();
        await binding.ensureCurrent();
        if (cancellationRequested) throw new Error("Subagent cancellation is pending.");
        if (!binding.current().enabled) throw new Error("The selected Agent is not enabled in the current valid configuration.");
        assertModelRequestReady(binding.modelRuntime(), binding.model());
      });
    },
    drainPending() {
      return serial(async () => {
        for (const input of pendingInputs()) if (!queued.has(input.id)) await deliver(input.id, input.content, input.customType);
      });
    },
    begin,
    start() {
      started = true;
      if (!options.restoreIdle) begin();
      releaseShell ??= coordinator.getShellService()?.attachOwner({ sessionID: session.sessionId, cwd: options.cwd, shell: deps.shell, notify: controller.notify });
      own(serial(async () => {
        if (options.resume || options.restoreIdle) await supervisor.recoverBackground({ cwd: options.cwd, liveConfiguration: options.liveConfiguration, verifiedPriorOwnerDead: true });
        void supervisor.flushNotifications().catch(() => {});
        if (options.restoreIdle) { initialDone(); return; }
        // Replay only inbox entries which native Pi has not consumed. Delivered IDs remain authoritative.
        const pending = pendingInputs();
        if (pending.length) {
          for (const entry of pending) await deliver(entry.id, entry.content, entry.customType);
        } else {
          await deliver(randomUUID(), options.resume ? RESTART_PROMPT : "", BACKGROUND_WAKE);
        }
      }));
    },
    followUp(input) {
      return serial(async () => {
        if (cancellationRequested) throw new Error("Subagent cancellation is pending.");
        input.signal?.throwIfAborted();
        const roleChanged = (pendingSelection?.agentName ?? binding.current().name) !== input.agent.name;
        if (roleChanged || input.model) {
          const selection: ChildSelection = { agentName: input.agent.name,
            model: input.model ?? (roleChanged ? input.agent.model : undefined) ?? pendingSelection?.model ?? (session.model && `${session.model.provider}/${session.model.id}`),
            thinking: input.thinking ?? pendingSelection?.thinking ?? session.thinkingLevel };
          if (session.isIdle) {
            await binding.setChildSelection?.(selection);
            session.sessionManager.appendCustomEntry!(SELECTION, { selection, pending: false });
            pendingSelection = undefined;
          }
          else {
            session.sessionManager.appendCustomEntry!(SELECTION, { selection, pending: true });
            pendingSelection = selection;
          }
        }
        input.signal?.throwIfAborted();
        if (session.isIdle) for (const previous of pendingInputs()) {
          if (previous.id !== input.inputID) await deliver(previous.id, previous.content, previous.customType);
        }
        return deliver(input.inputID, input.task, BACKGROUND_INPUT, true, input.signal);
      });
    },
    async notify(notice) {
      if (disposed || suspended) throw new Error("Subagent runtime is no longer accepting input.");
      if (cancelled || cancellationRequested) {
        admitBackgroundInput(journal, { id: notice.id, content: notice.content, customType: "easyresearch:background_result", wake: false });
        return;
      }
      const admitted = admitBackgroundInput(journal, { id: notice.id, content: notice.content, customType: "easyresearch:background_result", wake: notice.wake ?? true });
      if (admitted === "delivered" || cancelledInputs.has(notice.id)) return;
      const wake = pendingInputs().find((entry) => entry.id === notice.id)?.wake !== false;
      if (!wake && !session.isStreaming) return;
      // The shell outbox stays owned while a failed native request awaits explicit Retry.
      // Do not put this wait in the admission queue: a user follow-up may supersede it.
      if (deps.recovery.holdsAutomaticWake()) await deps.recovery.waitForResolution();
      await serial(() => deliver(notice.id, notice.content, "easyresearch:background_result", wake));
    },
    requestCancellation() {
      if (cancellationRequested) return;
      cancellationNeedsPeriod = !busy && (coordinator.outstanding(session.sessionId).length > 0 || deps.recovery.hasWork());
      cancellationRequested = true;
      // Invalidates Retry preflight before the serialized disposal gate can wait.
      deps.recovery.cancel();
    },
    cancel(reason) {
      if (cancellation) return cancellation;
      controller.requestCancellation();
      const shouldBegin = !cancelled && !busy && cancellationNeedsPeriod && coordinator.acceptsBackgroundPeriods();
      let beginFailure: unknown;
      if (shouldBegin) try { begin(true); } catch (error) { beginFailure = error; }
      cancelled = true;
      deps.recovery.cancel();
      const shells = coordinator.getShellService()?.tasks().filter((task) => task.sessionID === session.sessionId && task.status === "running") ?? [];
      let tracked!: Promise<void>;
      tracked = runCleanupSteps([
        () => { if (beginFailure) throw beginFailure; },
        () => claims.cancel(),
        () => {
          const ids = pendingInputs().map((input) => input.id);
          if (ids.length) journal.appendCustomEntry(CANCELLED_INPUTS, { ownerSessionID: session.sessionId, ids });
          for (const id of ids) cancelledInputs.add(id);
        },
        () => session.abortCompaction(), () => session.abortBranchSummary(),
        async () => {
          const outcomes = await Promise.allSettled([session.abort(), supervisor.abortAll(reason ?? "Subagent cancelled"),
            ...shells.map((task) => coordinator.getShellService()!.cancel(task.id))]);
          await runCleanupSteps(outcomes.map((outcome) => () => { if (outcome.status === "rejected") throw outcome.reason; }), "Subagent native cancellation failed.");
        },
        () => admission,
        () => coordinator.getShellService()?.flushNotifications?.(session.sessionId),
        () => finish(),
        () => { initialDone(); },
        async () => { await Promise.all([...runs]); await deps.recovery.settleOperations(); },
      ], "Subagent cancellation cleanup failed.").catch((error) => { if (cancellation === tracked) cancellation = undefined; throw error; });
      cancellation = tracked;
      return tracked;
    },
    suspend(reason) {
      if (suspension) return suspension;
      suspended = true;
      deps.recovery.cancel();
      claims.suspend();
      releaseShell?.(); releaseShell = undefined;
      let tracked!: Promise<void>;
      tracked = runCleanupSteps([
        () => session.abortCompaction(), () => session.abortBranchSummary(),
        async () => {
          const outcomes = await Promise.allSettled([supervisor.suspendAll(reason ?? "Server restart"), session.abort()]);
          await runCleanupSteps(outcomes.map((outcome) => () => { if (outcome.status === "rejected") throw outcome.reason; }), "Subagent native suspension failed.");
        },
        () => { initialDone(); }, () => admission,
        async () => { await Promise.all([...runs]); await deps.recovery.settleOperations(); },
      ], "Subagent suspension cleanup failed.").catch((error) => { if (suspension === tracked) suspension = undefined; throw error; });
      suspension = tracked;
      return tracked;
    },
    async dispose() {
      if (disposed) return;
      if (!suspended && (busy || coordinator.outstanding(session.sessionId).length)) await controller.cancel();
      disposed = true;
      releaseShell?.(); releaseShell = undefined;
      unsubscribe();
      unsubscribeActivity();
      executionBoundary.dispose();
      if (agent.prepareRequest === prepare) agent.prepareRequest = previousPrepare;
      session.sendCustomMessage = previousSend;
      initialDone();
      deps.disposeRecovery();
    },
  };
  return controller;
}
