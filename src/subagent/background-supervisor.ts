import type { BackgroundTask } from "../background/contracts";
import { randomUUID } from "node:crypto";
import type { ReservedDispatch, SubagentCoordinator } from "./coordinator";
import { RetryableStageSessionCreationError, type StageLaunchHandle, type StageLaunchOptions, type StageSessionLauncher } from "./stage-session";
import { isThinkingLevel } from "../thinking-levels";
import { runCleanupSteps } from "../runtime/cleanup";
import type { SubagentJobIdentity, SubagentProgressEvent, SubagentLaunchDetails } from "./contracts";

interface Runtime {
  reservation: ReservedDispatch;
  options: Omit<StageLaunchOptions, "reservation" | "coordinator">;
  handle?: StageLaunchHandle;
  startup?: Promise<StageLaunchHandle>;
  busy: boolean;
  cancelled: boolean;
  suspended: boolean;
  cleanupPending?: boolean;
  cancellationComplete?: boolean;
  unsubscribe?: () => void;
}

/** Reusable native child owners; each durable launch id represents one busy period. */
export class BackgroundSubagentSupervisor {
  private readonly runtimes = new Map<string, Runtime>();
  private readonly starting = new Set<Runtime>();
  private readonly failedStartups = new Set<() => Promise<void>>();
  private readonly childOperations = new Map<string, Promise<void>>();
  private readonly admissions = new Map<string, Promise<SubagentLaunchDetails>>();
  private closed = false;
  constructor(private readonly deps: {
    coordinator: SubagentCoordinator;
    launchStage: StageSessionLauncher;
    ownerSessionID(): string;
    changed(): void;
    notify(): void;
    publish(identity: SubagentJobIdentity, event: SubagentProgressEvent): void;
  }) {}

  tasks(): BackgroundTask[] {
    const jobs = [...this.deps.coordinator.journal().jobs.values()];
    const ownsWork = (sessionID: string): boolean => {
      const descendants = new Set([sessionID]);
      for (let changed = true; changed;) {
        changed = false;
        for (const job of jobs) if (descendants.has(job.ownerSessionId) && job.childSessionId && !descendants.has(job.childSessionId)) {
          descendants.add(job.childSessionId); changed = true;
        }
      }
      return [...descendants].some((id) => this.deps.coordinator.getShellService()?.hasWork(id))
        || jobs.some((job) => job.childSessionId !== sessionID && descendants.has(job.ownerSessionId) && job.status === "working" && !job.terminalStatus && !job.terminalSuppressed);
    };
    return [...this.runtimes.values()].filter((runtime) => !runtime.suspended && !runtime.cancelled
      && (runtime.busy || runtime.handle?.background?.hasRecovery() || runtime.handle?.background?.hasBackgroundWork()
        || (runtime.handle && ownsWork(runtime.handle.childSessionId))))
      .map((runtime) => ({ id: runtime.handle!.childSessionId, kind: "subagent", sessionID: runtime.handle!.childSessionId,
        description: runtime.reservation.description ?? runtime.options.task,
        status: "running", blocking: false, agent: runtime.reservation.agent }));
  }

  hasWork(): boolean { return this.childOperations.size > 0 || this.starting.size > 0 || this.failedStartups.size > 0 || this.tasks().length > 0 || [...this.runtimes.values()].some((runtime) => runtime.cleanupPending); }

  private serializeChild<T>(sessionID: string, operation: () => Promise<T>): Promise<T> {
    const preceding = this.childOperations.get(sessionID) ?? Promise.resolve();
    const result = preceding.then(operation);
    const settled = result.then(() => {}, () => {});
    this.childOperations.set(sessionID, settled);
    this.deps.changed();
    void settled.then(() => {
      if (this.childOperations.get(sessionID) === settled) this.childOperations.delete(sessionID);
      this.deps.changed();
    });
    return result;
  }

  launch(reservation: ReservedDispatch, options: Omit<StageLaunchOptions, "reservation" | "coordinator">): Promise<SubagentLaunchDetails> {
    if (reservation.replayed) {
      if (!reservation.childSessionId || reservation.ownerSessionId !== this.deps.ownerSessionID()) return Promise.reject(new Error("Admitted subagent input has no matching native owner."));
      return Promise.resolve<SubagentLaunchDetails>({ mode: "single", background: true, sessionID: reservation.childSessionId, job: {
        launchId: reservation.launchId, ownerSessionId: reservation.ownerSessionId, toolCallId: reservation.toolCallId,
        agent: reservation.agent, agentId: reservation.agentId, childSessionId: reservation.childSessionId, status: "working",
      } });
    }
    const inputID = options.inputID ?? reservation.inputID;
    const pending = inputID && this.admissions.get(inputID);
    if (pending) return pending;
    const launchOptions = reservation.resumeAdmission ? { ...options, resume: true } : options;
    const operation = reservation.childSessionId
      ? this.serializeChild(reservation.childSessionId, () => this.launchOwned(reservation, launchOptions))
      : this.launchOwned(reservation, launchOptions);
    if (inputID) {
      this.admissions.set(inputID, operation);
      void operation.finally(() => { if (this.admissions.get(inputID) === operation) this.admissions.delete(inputID); }).catch(() => {});
    }
    return operation;
  }

  private async launchOwned(reservation: ReservedDispatch, options: Omit<StageLaunchOptions, "reservation" | "coordinator">) {
    if (this.closed) throw new Error("Background subagent owner is closed.");
    options.signal?.throwIfAborted();
    if (reservation.ownerSessionId !== this.deps.ownerSessionID()) throw new Error("Subagent is not an immediate child of the caller.");
    const existing = reservation.childSessionId && this.runtimes.get(reservation.childSessionId);
    if (existing && (existing.cancelled || existing.suspended || existing.cleanupPending)) throw new Error("Subagent runtime cleanup must finish before continuation.");
    if (existing && !existing.cancelled && !existing.suspended) {
      if (existing.startup) await existing.startup;
      const handle = existing.handle!;
      const previousReservation = existing.reservation;
      const previousOptions = existing.options;
      if (!existing.busy && !reservation.joined) { existing.reservation = reservation; existing.options = { ...existing.options, ...options }; }
      try {
        const inputID = options.inputID ?? `host:${randomUUID()}`;
        const admitted = await handle.background!.followUp({ task: options.task, agent: options.agent, model: options.model,
          ...(isThinkingLevel(options.thinking) ? { thinking: options.thinking } : {}), inputID: `subagent-input:${inputID}`, signal: options.signal });
        if (!admitted && existing.reservation !== previousReservation) {
          this.deps.coordinator.recordLaunchSuppressed(existing.reservation.launchId);
          existing.reservation = previousReservation; existing.options = previousOptions;
        }
        this.deps.coordinator.recordInputAdmission(existing.reservation.launchId, inputID, options.inputFingerprint);
      } catch (error) {
        existing.reservation = previousReservation; existing.options = previousOptions;
        throw error;
      }
      return this.details(existing);
    }
    if (reservation.joined) throw new Error("Running subagent must be reconstructed by verified restart recovery before accepting follow-ups.");
    const runtime: Runtime = { reservation, options, busy: false, cancelled: false, suspended: false };
    this.starting.add(runtime);
    this.deps.changed();
    try {
      runtime.startup = this.deps.launchStage({ ...options, reservation, coordinator: this.deps.coordinator,
        backgroundLifecycle: {
          activity: () => this.deps.changed(),
          started: () => this.begin(runtime),
          settled: (result) => {
            if (runtime.suspended) return;
            this.deps.coordinator.commitBackgroundReport(runtime.reservation.launchId, result);
            runtime.busy = false;
            this.deps.coordinator.publish({ type: "subagent_supervisor", ...this.details(runtime).job,
              status: result.state === "completed" ? "complete" : "error", latestMessage: result.text });
            this.deps.notify(); this.deps.changed();
          },
        },
      });
      const handle = await runtime.startup;
      runtime.handle = handle;
      runtime.startup = undefined;
      this.runtimes.set(handle.childSessionId, runtime);
      if (!handle.background) throw new Error("Stage launcher does not implement durable background admission.");
      if (reservation.continuation && (handle.childSessionId !== reservation.childSessionId || handle.sessionPath !== reservation.sessionPath)) throw new Error("Continued child identity does not match its reservation.");
      await handle.materialized;
      if (this.runtimes.get(handle.childSessionId) !== runtime) throw new Error("Subagent admission no longer owns its native runtime.");
      if (!options.restoreIdle) this.deps.coordinator.recordMaterialized(reservation, { childSessionId: handle.childSessionId, sessionPath: handle.sessionPath });
      reservation.childSessionId = handle.childSessionId;
      reservation.sessionPath = handle.sessionPath;
      runtime.unsubscribe = handle.subscribe((event) => {
        this.deps.publish(this.details(runtime).job, event);
      });
      if (runtime.suspended) { await handle.background.suspend(); return this.details(runtime); }
      if (runtime.cancelled || options.signal?.aborted || this.closed) throw new Error("Subagent admission was cancelled.");
      if (!options.restoreIdle) this.admit(runtime);
      handle.background.start();
      return this.details(runtime);
    } catch (error) {
      runtime.cleanupPending = true;
      if (error instanceof RetryableStageSessionCreationError) this.failedStartups.add(error.retryCleanup);
      await runCleanupSteps([
        () => this.deps.coordinator.recordPreMaterializationFailure(reservation, error),
        async () => {
          if (error instanceof RetryableStageSessionCreationError) { await error.retryCleanup(); this.failedStartups.delete(error.retryCleanup); }
          if (runtime.handle) { await runtime.handle.abort("Subagent admission failed"); await runtime.handle.dispose(); }
          runtime.cleanupPending = false;
          if (runtime.handle && this.runtimes.get(runtime.handle.childSessionId) === runtime) this.runtimes.delete(runtime.handle.childSessionId);
        },
        () => { throw error; },
      ], "Subagent admission cleanup failed.");
      throw error;
    } finally {
      this.starting.delete(runtime);
      this.deps.changed();
    }
  }

  private admit(runtime: Runtime): void {
    const existing = this.deps.coordinator.journal().jobs.get(runtime.reservation.launchId);
    const selected = runtime.handle?.background?.selection();
    if (!existing?.background) this.deps.coordinator.recordBackgroundAdmission(runtime.reservation.launchId, {
      cwd: runtime.options.cwd, callerAgent: runtime.options.callerAgent, description: runtime.reservation.description!,
      model: selected?.model ?? runtime.options.model, thinking: selected?.thinking ?? runtime.options.thinking,
    });
    this.deps.coordinator.recordLaunchAcknowledged(runtime.reservation.launchId);
    if (runtime.reservation.inputID) this.deps.coordinator.recordInputAdmission(runtime.reservation.launchId, runtime.reservation.inputID, runtime.reservation.inputFingerprint);
  }

  private begin(runtime: Runtime): void {
    if (runtime.busy || runtime.suspended || runtime.cancelled) return;
    const job = this.deps.coordinator.journal().jobs.get(runtime.reservation.launchId);
    if (job?.terminalStatus) {
      const currentAgent = runtime.handle!.background!.selection().agent;
      const agent = { ...runtime.options.agent, name: currentAgent };
      runtime.options = { ...runtime.options, agent };
      const reservation = this.deps.coordinator.reserveDispatch({ ownerSessionId: runtime.reservation.ownerSessionId,
        toolCallId: `wake:${runtime.reservation.launchId}`, requested: currentAgent,
        catalog: { all: [agent], available: [agent] },
        sessionID: runtime.handle!.childSessionId, description: runtime.reservation.description! });
      runtime.reservation = reservation;
    }
    this.deps.coordinator.recordMaterialized(runtime.reservation, { childSessionId: runtime.handle!.childSessionId, sessionPath: runtime.handle!.sessionPath });
    this.admit(runtime);
    this.deps.coordinator.bindRecoveryPeriod(runtime.handle!.childSessionId, runtime.reservation.launchId);
    runtime.busy = true;
    this.deps.changed();
  }

  private details(runtime: Runtime) {
    return { mode: "single" as const, background: true as const, sessionID: runtime.handle!.childSessionId,
      job: { launchId: runtime.reservation.launchId, ownerSessionId: runtime.reservation.ownerSessionId,
        toolCallId: runtime.reservation.toolCallId, agent: runtime.reservation.agent, agentId: runtime.reservation.agentId,
        childSessionId: runtime.handle!.childSessionId, status: "working" as const } };
  }

  cancel(sessionID: string): Promise<void> {
    const runtime = this.runtimes.get(sessionID);
    if (!runtime || runtime.reservation.ownerSessionId !== this.deps.ownerSessionID()) return Promise.reject(new Error("Subagent is not an immediate child of the caller."));
    const stopping = this.serializeChild(sessionID, () => this.cancelOwned(sessionID, runtime));
    try { runtime.handle?.background?.requestCancellation(); }
    catch (error) { return stopping.then(() => { throw error; }); }
    return stopping;
  }

  private async cancelOwned(sessionID: string, runtime: Runtime): Promise<void> {
    if (this.runtimes.get(sessionID) !== runtime) {
      if (runtime.cancellationComplete) return;
      throw new Error("Subagent cancellation no longer owns this runtime generation.");
    }
    try {
      const cancelling = runtime.handle!.background!.cancel();
      runtime.cancelled = true;
      await cancelling;
      runtime.busy = false;
      runtime.unsubscribe?.();
      await runtime.handle!.dispose();
      runtime.cancellationComplete = true;
      runtime.cleanupPending = false;
      if (this.runtimes.get(sessionID) === runtime) this.runtimes.delete(sessionID);
    } catch (error) { runtime.cleanupPending = true; throw error; }
    finally { this.deps.changed(); }
  }

  async cancelAll(): Promise<void> {
    for (const runtime of this.starting) runtime.cancelled = true;
    await Promise.all([...this.starting].map((runtime) => runtime.startup?.catch(() => {})));
    await Promise.all([...this.failedStartups].map(async (cleanup) => { await cleanup(); this.failedStartups.delete(cleanup); }));
    await Promise.all([...this.runtimes.keys()].map((id) => this.cancel(id)));
  }

  async suspendAll(reason?: string): Promise<void> {
    this.closed = true;
    const all = new Set([...this.starting, ...this.runtimes.values()]);
    for (const runtime of all) runtime.suspended = true;
    await Promise.all([...all].map(async (runtime) => {
      const handle = runtime.handle ?? await runtime.startup;
      if (!handle) return;
      await this.serializeChild(handle.childSessionId, async () => {
        if (this.runtimes.get(handle.childSessionId) !== runtime) return;
        await handle.background?.suspend(reason);
        runtime.busy = false;
        runtime.unsubscribe?.();
        await handle.dispose();
        if (this.runtimes.get(handle.childSessionId) === runtime) this.runtimes.delete(handle.childSessionId);
      });
    }));
    this.deps.changed();
  }

  async recover(options: { cwd: string; liveConfiguration: StageLaunchOptions["liveConfiguration"]; verifiedPriorOwnerDead: boolean }): Promise<void> {
    if (!options.verifiedPriorOwnerDead) throw new Error("Restart recovery requires verified prior-owner death.");
    const coordinator = this.deps.coordinator;
    await coordinator.prepareBackgroundRecovery(options.cwd, true);
    const allJobs = [...coordinator.ownedJournal().jobs.values()];
    const neededOwners = new Set([
      ...allJobs.filter((job) => job.background && !job.terminalStatus && !job.terminalSuppressed).map((job) => job.ownerSessionId),
      ...(coordinator.getShellService()?.tasks().filter((task) => coordinator.getShellService()!.hasWork(task.sessionID)).map((task) => task.sessionID) ?? []),
      ...coordinator.ownedJournal().pendingBatches.map((batch) => batch.ownerSessionId),
    ]);
    for (let changed = true; changed;) {
      changed = false;
      for (const job of allJobs) if (job.childSessionId && neededOwners.has(job.childSessionId) && !neededOwners.has(job.ownerSessionId)) {
        neededOwners.add(job.ownerSessionId); changed = true;
      }
    }
    const latest = new Map(allJobs.filter((job) => job.background && job.childSessionId && !job.terminalSuppressed).map((job) => [job.childSessionId!, job]));
    const claims = [...latest.values()].filter((job) => job.ownerSessionId === this.deps.ownerSessionID()
      && (!job.terminalStatus || neededOwners.has(job.childSessionId!)) && job.backgroundResult?.state !== "cancelled");
    // Charge every sibling before any fast child can publish/wake its parent.
    const accepted = claims.filter((job) => {
      if (job.background!.cwd !== options.cwd || !job.childSessionId || !job.sessionPath) return false;
      return true;
    });
    const agents = await options.liveConfiguration.resolveAgents(options.cwd);
    for (const job of accepted) {
      if (this.runtimes.has(job.childSessionId!)) continue;
      const agent = agents.find((candidate) => candidate.name === job.agent && candidate.enabled);
      if (!agent) {
        coordinator.commitBackgroundReport(job.launchId, { state: "error", text: "Subagent is unavailable after restart.", outstanding: [] });
        continue;
      }
      const reservation: ReservedDispatch = { ...job, continuation: true, description: job.background!.description };
      try {
        await this.launch(reservation, { agent, callerAgent: job.background!.callerAgent, task: "", cwd: options.cwd,
          model: job.background!.model, thinking: job.background!.thinking, liveConfiguration: options.liveConfiguration,
          ...(job.terminalStatus ? { restoreIdle: true } : { resume: true }) });
      } catch (error) {
        if (this.failedStartups.size || [...this.runtimes.values()].some((runtime) => runtime.cleanupPending)) throw error;
        coordinator.commitBackgroundReport(job.launchId, { state: "error", text: error instanceof Error ? error.message : String(error), outstanding: [] });
      }
    }
    this.deps.notify();
  }
}
