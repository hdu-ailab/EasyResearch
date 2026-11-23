import { randomUUID } from "node:crypto";
import {
  AGENT_ALIAS_ENTRY,
  formatAgentId,
  readAgentAliases,
  resolveAgentAlias,
} from "./agent-alias";
import type { AgentConfig } from "./agents";
import type {
  SubagentJobIdentity,
  SubagentJobSummary,
  SubagentSupervisorEvent,
} from "./contracts";
import {
  SUBAGENT_JOB_ENTRY,
  readSubagentJournal,
  type SubagentJobJournalRecord,
  type SubagentJournalState,
  type NotificationBatchRecord,
} from "./job-journal";
import { privateSubagentEventDataReason, readCompletionOutcomes } from "./notifications";
import { SUBAGENT_SESSION_LINK_ENTRY } from "./session-links";
import { LlmRetryError, type LlmRecoveryController } from "../runtime/llm-recovery";
import type { LlmRetryAcceptedDto, LlmRetryStateEventDto } from "../web/contracts";
import type { BackgroundTask } from "../background/contracts";
import { formatBackgroundResult, type BackgroundAdmission, type BackgroundPeriodResult, type SubagentShellService } from "./background-periods";
import { ownedSubagentJournal } from "./ownership";

export interface CoordinatorSessionManager {
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getEntries(): unknown[];
  appendCustomEntry(customType: string, data?: unknown): string;
}

export interface AgentCatalog {
  all: readonly AgentConfig[];
  available: readonly AgentConfig[];
}

export interface ReservedDispatch {
  inputID?: string;
  inputFingerprint?: string;
  replayed?: boolean;
  resumeAdmission?: boolean;
  description?: string;
  joined?: boolean;
  launchId: string;
  ownerSessionId: string;
  toolCallId: string;
  agent: string;
  agentId: string;
  continuation: boolean;
  childSessionId?: string;
  sessionPath?: string;
}

const RUNNING_STATUSES = new Set(["reserved", "created", "working"]);
const RESUMABLE_ALIAS_STATUSES = new Set(["working", "complete", "error"]);

function now(): string {
  return new Date().toISOString();
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "Unknown pre-materialization failure";
}

export class SubagentCoordinator {
  private recoveryPreparation?: Promise<void>;
  private shellService?: SubagentShellService;
  private readonly backgroundOwners = new Map<string, { tasks(): BackgroundTask[]; cancel(sessionID: string): Promise<void> }>();
  private state: SubagentJournalState;
  private readonly listeners = new Set<(event: SubagentSupervisorEvent) => void>();
  private researchAssistantState?: { model(): string | undefined; thinking(): string | undefined };
  private lifecycle: "open" | "cancelling" | "closing" = "open";
  private readonly recoveryOwners = new Map<string, {
    sessionPath: string;
    ownerSessionId?: string;
    launchId?: string;
    recovery: LlmRecoveryController;
  }>();

  constructor(private readonly rootSessionManager: CoordinatorSessionManager) {
    this.state = readSubagentJournal(rootSessionManager.getEntries());
  }

  reserveDispatch(input: { ownerSessionId: string; toolCallId: string; requested: string; catalog: AgentCatalog; sessionID?: string; description?: string; inputID?: string; inputFingerprint?: string }): ReservedDispatch {
    if (this.lifecycle !== "open") {
      throw new Error(`Cannot reserve a subagent while the coordinator is ${this.lifecycle}.`);
    }
    if (!input.ownerSessionId.trim() || !input.toolCallId.trim() || !input.requested.trim()) {
      throw new Error("Owner session id, tool call id, and Agent name are required.");
    }

    this.refresh();
    if (input.description !== undefined) {
      const agent = input.catalog.available.find((candidate) => candidate.name === input.requested);
      if (!agent) throw new Error(`Agent "${input.requested}" is disabled or unavailable.`);
      if (input.inputID) {
        const previous = [...this.ownedJournal().jobs.values()].find((job) => job.ownerSessionId === input.ownerSessionId
          && (job.inputID === input.inputID || job.inputAdmissions?.some((admitted) => admitted.inputID === input.inputID)));
        if (previous) {
          const admitted = previous.inputAdmissions?.find((candidate) => candidate.inputID === input.inputID);
          const fingerprint = admitted?.fingerprint ?? previous.inputFingerprint;
          if ((fingerprint !== undefined && input.inputFingerprint !== fingerprint)
            || (input.sessionID !== undefined && previous.childSessionId !== input.sessionID)) throw new Error("Subagent input identity conflicts with an earlier invocation.");
          if (previous.status === "pre_materialization_failed") throw new Error(previous.errorMessage ?? "Previous subagent admission failed.");
          return { ...previous, description: previous.background?.description ?? previous.description ?? input.description,
            ...(admitted ? { replayed: true, continuation: true } : previous.childSessionId ? { continuation: true, resumeAdmission: true } : {}) };
        }
      }
      if (input.sessionID) {
        const matching = [...this.ownedJournal().jobs.values()].filter((job) => job.childSessionId === input.sessionID);
        const previous = matching.at(-1);
        if (!previous || previous.ownerSessionId !== input.ownerSessionId || matching.some((job) => job.ownerSessionId !== input.ownerSessionId)) {
          throw new Error(`Session ${input.sessionID} is not an immediate child of the current session.`);
        }
        const active = matching.find((job) => RUNNING_STATUSES.has(job.status) && !job.terminalStatus);
        if (active) return { ...active, continuation: true, joined: true, description: active.background?.description ?? active.description ?? input.description,
          inputID: input.inputID, inputFingerprint: input.inputFingerprint };
        const reservation: ReservedDispatch = { launchId: this.nextLaunchId(), ownerSessionId: input.ownerSessionId,
          toolCallId: input.toolCallId, agent: agent.name, agentId: previous.agentId, continuation: true,
          childSessionId: previous.childSessionId, sessionPath: previous.sessionPath, description: input.description,
          inputID: input.inputID, inputFingerprint: input.inputFingerprint };
        this.append({ kind: "reserved", ...reservation, createdAt: now() });
        if (reservation.childSessionId && reservation.sessionPath) this.recordChildCreated(reservation, {
          childSessionId: reservation.childSessionId, sessionPath: reservation.sessionPath,
        });
        return reservation;
      }
    }
    const persistedAliases = readAgentAliases(this.rootSessionManager.getEntries());
    const alias = input.description === undefined ? resolveAgentAlias(persistedAliases, input.requested) : undefined;
    const exactAgent = input.catalog.all.find((candidate) => candidate.name === input.requested);
    if (alias && exactAgent) {
      throw new Error(`Ambiguous subagent target "${input.requested}": it is both an Agent name and a saved agent id.`);
    }

    let reservation: ReservedDispatch;
    if (alias) {
      const aliasJobs = [...this.state.jobs.values()].filter((job) =>
        job.agentId === alias.id && job.agent === alias.agent);
      if (aliasJobs.some((job) => job.terminalSuppressed)) {
        throw new Error(`Agent id "${alias.id}" cannot be continued after its launch was suppressed.`);
      }
      const matchingJobs = aliasJobs.filter((job) =>
        job.childSessionId === alias.sessionId
        && job.sessionPath === alias.sessionPath);
      if (
        matchingJobs.length > 0
        && !matchingJobs.some((job) => RESUMABLE_ALIAS_STATUSES.has(job.status))
      ) {
        throw new Error(`Agent id "${alias.id}" cannot be continued after failing before materialization.`);
      }
      if (!matchingJobs.some((job) => job.ownerSessionId === input.ownerSessionId && this.ownedJournal().jobs.has(job.launchId))) {
        throw new Error(`Saved Agent id "${alias.id}" is not an owned immediate child of this session.`);
      }
      if (!input.catalog.available.some((candidate) => candidate.name === alias.agent)) {
        throw new Error(`Agent "${alias.agent}" for saved id "${alias.id}" is disabled or no longer available.`);
      }
      if (this.isRunning(alias.id)) {
        throw new Error(`Agent id "${alias.id}" is still running and cannot be continued.`);
      }
      reservation = {
        launchId: this.nextLaunchId(),
        ownerSessionId: input.ownerSessionId,
        toolCallId: input.toolCallId,
        agent: alias.agent,
        agentId: alias.id,
        continuation: true,
        childSessionId: alias.sessionId,
        sessionPath: alias.sessionPath,
      };
    } else {
      if (!exactAgent) throw new Error(`Unknown Agent "${input.requested}".`);
      if (!input.catalog.available.some((candidate) => candidate.name === exactAgent.name)) {
        throw new Error(`Agent "${exactAgent.name}" is disabled or unavailable.`);
      }

      const consumedIds = new Set([
        ...persistedAliases.map((candidate) => candidate.id),
        ...[...this.state.jobs.values()].map((job) => job.agentId),
      ]);
      const actualNames = new Set(input.catalog.all.map((candidate) => candidate.name));
      let sequence = 0;
      let agentId = formatAgentId(exactAgent.name, sequence);
      while (consumedIds.has(agentId) || actualNames.has(agentId)) {
        sequence += 1;
        agentId = formatAgentId(exactAgent.name, sequence);
      }
      reservation = {
        launchId: this.nextLaunchId(),
        ownerSessionId: input.ownerSessionId,
        toolCallId: input.toolCallId,
        agent: exactAgent.name,
        agentId,
        continuation: false,
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.inputID === undefined ? {} : { inputID: input.inputID, inputFingerprint: input.inputFingerprint }),
      };
    }

    this.append({
      kind: "reserved",
      launchId: reservation.launchId,
      ownerSessionId: reservation.ownerSessionId,
      toolCallId: reservation.toolCallId,
      agent: reservation.agent,
      agentId: reservation.agentId,
      continuation: reservation.continuation,
      ...(reservation.description === undefined ? {} : { description: reservation.description }),
      ...(reservation.inputID === undefined ? {} : { inputID: reservation.inputID, inputFingerprint: reservation.inputFingerprint }),
      createdAt: now(),
    });
    return reservation;
  }

  recordChildCreated(reservation: ReservedDispatch, child: { childSessionId: string; sessionPath: string }): void {
    this.append({
      kind: "created",
      launchId: reservation.launchId,
      childSessionId: child.childSessionId,
      sessionPath: child.sessionPath,
    });
  }

  recordMaterialized(reservation: ReservedDispatch, child: { childSessionId: string; sessionPath: string }): SubagentJobIdentity {
    const current = this.journal().jobs.get(reservation.launchId);
    if (!current || current.childSessionId !== child.childSessionId || current.sessionPath !== child.sessionPath) {
      this.recordChildCreated(reservation, child);
    }
    this.append({ kind: "materialized", launchId: reservation.launchId });
    this.rootSessionManager.appendCustomEntry(AGENT_ALIAS_ENTRY, {
      id: reservation.agentId,
      agent: reservation.agent,
      sessionId: child.childSessionId,
      sessionPath: child.sessionPath,
    });
    this.rootSessionManager.appendCustomEntry(SUBAGENT_SESSION_LINK_ENTRY, {
      toolCallId: reservation.toolCallId,
      childSessionId: child.childSessionId,
      agent: reservation.agent,
      ownerSessionId: reservation.ownerSessionId,
      launchId: reservation.launchId,
      agentId: reservation.agentId,
    });

    return {
      launchId: reservation.launchId,
      ownerSessionId: reservation.ownerSessionId,
      toolCallId: reservation.toolCallId,
      agent: reservation.agent,
      agentId: reservation.agentId,
      childSessionId: child.childSessionId,
    };
  }

  recordLaunchAcknowledged(launchId: string): void {
    if (this.journal().jobs.get(launchId)?.launchAcknowledged) return;
    this.append({ kind: "launch_acknowledged", launchId, acknowledgedAt: now() });
  }

  recordBackgroundAdmission(launchId: string, admission: BackgroundAdmission): void {
    if (!this.ownedJournal().jobs.has(launchId)) throw new Error("Subagent admission is outside this root's owned tree.");
    this.append({ kind: "background_admitted", launchId, admission });
  }

  recordInputAdmission(launchId: string, inputID: string, fingerprint?: string): void {
    const job = this.ownedJournal().jobs.get(launchId);
    if (!job?.background || !job.childSessionId || !job.sessionPath) throw new Error("Subagent input has no admitted native child owner.");
    const previousJob = [...this.ownedJournal().jobs.values()].find((candidate) => candidate.ownerSessionId === job.ownerSessionId
      && candidate.inputAdmissions?.some((input) => input.inputID === inputID));
    const previous = previousJob?.inputAdmissions?.find((input) => input.inputID === inputID);
    if (previous) {
      if (previous.fingerprint !== fingerprint || previousJob?.childSessionId !== job.childSessionId) throw new Error("Subagent input identity conflicts with an earlier invocation.");
      return;
    }
    this.append({ kind: "input_admitted", launchId, inputID, ...(fingerprint === undefined ? {} : { fingerprint }) });
  }

  commitBackgroundReport(launchId: string, result: BackgroundPeriodResult, options: { triggerTurn?: boolean } = {}): void {
    const job = this.ownedJournal().jobs.get(launchId);
    if (!job?.background || !job.childSessionId || job.terminalStatus || job.terminalSuppressed) return;
    const content = formatBackgroundResult({ ...result, sessionID: job.childSessionId, description: job.background.description });
    // One JSONL append is the commit point for claim release and the durable outbox.
    this.append({ kind: "background_report", launchId, result, batch: {
      batchId: `subagent:${launchId}`, ownerSessionId: job.ownerSessionId, launchIds: [launchId], content,
      triggerTurn: options.triggerTurn ?? true, createdAt: now(),
      outcomes: [{ launchId, agentId: job.agentId, status: result.state === "completed" ? "complete" : "error", text: result.text }],
    } });
  }

  claimBackgroundRestart(launchId: string): boolean {
    const job = this.ownedJournal().jobs.get(launchId);
    if (!job?.background || job.terminalStatus || job.terminalSuppressed || (job.restartAttempts ?? 0) >= 10) return false;
    this.append({ kind: "background_restart", launchId, attempt: (job.restartAttempts ?? 0) + 1 });
    return true;
  }

  setShellService(service: SubagentShellService): void {
    if (this.shellService && this.shellService !== service) throw new Error("The root already owns a shell service.");
    this.shellService = service;
  }

  getShellService(): SubagentShellService | undefined { return this.shellService; }
  acceptsBackgroundPeriods(): boolean { return this.lifecycle === "open"; }


  registerBackgroundOwner(sessionID: string, owner: { tasks(): BackgroundTask[]; cancel(sessionID: string): Promise<void> }): () => void {
    if (this.backgroundOwners.has(sessionID)) throw new Error("Duplicate background runtime owner.");
    this.backgroundOwners.set(sessionID, owner);
    return () => { if (this.backgroundOwners.get(sessionID) === owner) this.backgroundOwners.delete(sessionID); };
  }

  backgroundTasks(): BackgroundTask[] {
    return [...this.backgroundOwners.values()].flatMap((owner) => owner.tasks());
  }

  async cancelTask(sessionID: string): Promise<void> {
    const job = [...this.ownedJournal().jobs.values()].reverse().find((candidate) => candidate.childSessionId === sessionID);
    const owner = job && this.backgroundOwners.get(job.ownerSessionId);
    if (!owner) throw new Error("Subagent task is not owned by this root.");
    await owner.cancel(sessionID);
  }

  outstanding(sessionID: string): BackgroundTask[] {
    const descendants = new Set([sessionID]);
    const jobs = [...this.ownedJournal().jobs.values()];
    if (sessionID !== this.rootSessionManager.getSessionId() && !jobs.some((job) => job.childSessionId === sessionID)) return [];
    for (let changed = true; changed;) {
      changed = false;
      for (const job of jobs) if (descendants.has(job.ownerSessionId) && job.childSessionId && !descendants.has(job.childSessionId)) {
        descendants.add(job.childSessionId); changed = true;
      }
    }
    return [...this.backgroundTasks().filter((task) => task.sessionID !== sessionID && descendants.has(task.sessionID)),
      ...(this.shellService?.tasks().filter((task) => descendants.has(task.sessionID) && task.status === "running") ?? [])];
  }

  prepareBackgroundRecovery(cwd: string, verifiedPriorOwnerDead: boolean): Promise<void> {
    if (!verifiedPriorOwnerDead) return Promise.reject(new Error("Restart recovery requires verified prior-owner death."));
    if (this.recoveryPreparation) return this.recoveryPreparation;
    this.recoveryPreparation = (async () => {
      const { importPi } = await import("../runtime/pi-import");
      const { ExecutionClaims } = await import("../background/execution-claims");
      const pi = await importPi();
      // Charge the entire persisted child tree before opening any runtime or delivering a wake.
      for (const job of this.ownedJournal().jobs.values()) {
        if (!job.background || job.terminalStatus || job.terminalSuppressed) continue;
        if (!job.sessionPath || !job.childSessionId || job.background.cwd !== cwd) continue;
        try {
          const manager = pi.SessionManager.open(job.sessionPath);
          if (manager.getSessionId() !== job.childSessionId || manager.getCwd() !== cwd || manager.getSessionFile() !== job.sessionPath) throw new Error("Recovered child identity does not match its exact native session.");
          const claims = new ExecutionClaims(manager);
          const current = claims.current();
          if (current?.outcome === "cancelled") {
            this.commitBackgroundReport(job.launchId, { state: "cancelled", text: "Subagent cancelled", outstanding: [] });
            continue;
          }
          // A crash can occur after durable admission but before native execution starts.
          if (!current || !current.pending) claims.start();
          if (!claims.prepareResume() || !this.claimBackgroundRestart(job.launchId)) {
            this.commitBackgroundReport(job.launchId, { state: "error", text: "Subagent restart budget exhausted (10 attempts).", outstanding: [] });
          }
        } catch (error) {
          this.commitBackgroundReport(job.launchId, { state: "error", text: error instanceof Error ? error.message : String(error), outstanding: [] });
        }
      }
    })();
    return this.recoveryPreparation;
  }

  /** Terminal Exit can revoke a prepared handoff even after in-memory owners closed. */
  async cancelSuspended(): Promise<void> {
    const { importPi } = await import("../runtime/pi-import");
    const { ExecutionClaims } = await import("../background/execution-claims");
    const pi = await importPi();
    for (const job of this.ownedJournal().jobs.values()) {
      if (!job.background || job.terminalStatus || job.terminalSuppressed || !job.childSessionId || !job.sessionPath) continue;
      const manager = pi.SessionManager.open(job.sessionPath);
      if (manager.getSessionId() !== job.childSessionId || manager.getCwd() !== job.background.cwd || manager.getSessionFile() !== job.sessionPath) {
        throw new Error("Suspended child identity does not match its exact native session.");
      }
      new ExecutionClaims(manager).cancel();
      this.commitBackgroundReport(job.launchId, { state: "cancelled", text: "Subagent cancelled", outstanding: [] }, { triggerTurn: false });
    }
  }

  recordPreMaterializationFailure(reservation: Pick<ReservedDispatch, "launchId">, error: unknown): void {
    if (!this.mayFinalizeReservation(reservation.launchId)) return;
    this.append({
      kind: "pre_materialization_failed",
      launchId: reservation.launchId,
      reason: describeError(error),
      failedAt: now(),
    });
  }

  recordTerminal(input: { launchId: string; status: "complete" | "error"; latestAssistantText?: string; errorMessage?: string; recovered?: boolean }): void {
    if (!this.mayFinalizeReservation(input.launchId)) return;
    this.append({
      kind: "terminal",
      launchId: input.launchId,
      status: input.status,
      ...(input.latestAssistantText === undefined ? {} : { latestAssistantText: input.latestAssistantText }),
      ...(input.errorMessage === undefined ? {} : { errorMessage: input.errorMessage }),
      ...(input.recovered === undefined ? {} : { recovered: input.recovered }),
      finishedAt: now(),
    });
  }

  recordLaunchSuppressed(launchId: string): void {
    const job = this.journal().jobs.get(launchId);
    if (!job || job.terminalSuppressed) return;
    this.append({ kind: "launch_suppressed", launchId, suppressedAt: now() });
  }

  recordNotificationBatch(input: Omit<NotificationBatchRecord, "createdAt">): void {
    this.append({
      kind: "notification_batch",
      batchId: input.batchId,
      ownerSessionId: input.ownerSessionId,
      launchIds: [...input.launchIds],
      content: input.content,
      ...(input.outcomes ? { outcomes: readCompletionOutcomes(input.outcomes) } : {}),
      triggerTurn: input.triggerTurn,
      createdAt: now(),
    });
  }

  acknowledgeNotification(batchId: string): void {
    if (!this.ownedJournal().pendingBatches.some((batch) => batch.batchId === batchId)) return;
    this.append({ kind: "notification_ack", batchId, acknowledgedAt: now() });
  }

  supersedeNotification(batchId: string): void {
    if (!this.ownedJournal().pendingBatches.some((batch) => batch.batchId === batchId)) return;
    this.append({ kind: "notification_superseded", batchId, supersededAt: now() });
  }

  journal(): SubagentJournalState {
    this.refresh();
    return this.state;
  }

  /** Mutation/recovery scope. journal() deliberately retains fork-inherited history. */
  ownedJournal(): SubagentJournalState {
    return ownedSubagentJournal(this.rootSessionManager.getSessionId(), this.journal());
  }

  private mayFinalizeReservation(launchId: string): boolean {
    const job = this.journal().jobs.get(launchId);
    if (!job) return false;
    // Stop may suppress this reservation before its owned cleanup completes.
    // Finalizing its local metadata does not make that suppressed edge traversable.
    return job.ownerSessionId === this.rootSessionManager.getSessionId()
      || [...this.ownedJournal().jobs.values()].some((parent) => parent.childSessionId === job.ownerSessionId && !!parent.sessionPath);
  }

  isRunning(agentId: string): boolean {
    this.refresh();
    return [...this.state.jobs.values()].some((job) =>
      job.agentId === agentId
      && !job.terminalSuppressed
      && RUNNING_STATUSES.has(job.status));
  }

  summaries(): SubagentJobSummary[] {
    this.refresh();
    const summaries: SubagentJobSummary[] = [];
    for (const job of this.state.jobs.values()) {
      if (
        job.terminalSuppressed
        || !job.childSessionId
        || (job.status !== "working" && job.status !== "complete" && job.status !== "error")
      ) continue;
      summaries.push({
        launchId: job.launchId,
        ownerSessionId: job.ownerSessionId,
        toolCallId: job.toolCallId,
        agent: job.agent,
        agentId: job.agentId,
        childSessionId: job.childSessionId,
        status: job.status,
        ...(job.latestAssistantText === undefined ? {} : { latestMessage: job.latestAssistantText }),
      });
    }
    return summaries;
  }

  publish(event: SubagentSupervisorEvent): void {
    const publicEvent: SubagentSupervisorEvent = {
      type: "subagent_supervisor",
      launchId: event.launchId,
      ownerSessionId: event.ownerSessionId,
      toolCallId: event.toolCallId,
      agent: event.agent,
      agentId: event.agentId,
      childSessionId: event.childSessionId,
      status: event.status,
      ...(event.latestMessage === undefined ? {} : { latestMessage: event.latestMessage }),
      ...(event.automaticRetry === undefined ? {} : { automaticRetry: event.automaticRetry }),
      ...(event.llmRecovery === undefined ? {} : { llmRecovery: event.llmRecovery }),
      ...(event.event === undefined || privateSubagentEventDataReason(event.event)
        ? {}
        : { event: event.event }),
    };
    for (const listener of this.listeners) {
      try {
        listener(publicEvent);
      } catch {
        // Supervisor listeners observe state; they never control job ownership.
      }
    }
  }

  subscribe(listener: (event: SubagentSupervisorEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  registerRecovery(input: {
    sessionId: string;
    sessionPath: string;
    ownerSessionId?: string;
    launchId?: string;
    recovery: LlmRecoveryController;
  }): () => void {
    if (this.lifecycle !== "open" || this.recoveryOwners.has(input.sessionId)
      || input.recovery.state().targetSessionId !== input.sessionId) {
      throw new Error("Cannot register duplicate or closing Agent recovery ownership.");
    }
    if (input.launchId) {
      const job = this.journal().jobs.get(input.launchId);
      if (!job || job.ownerSessionId !== input.ownerSessionId || job.terminalSuppressed || (job.terminalStatus && !job.background)
        || (job.childSessionId !== undefined && job.childSessionId !== input.sessionId)
        || (job.sessionPath !== undefined && job.sessionPath !== input.sessionPath)) {
        throw new Error("Agent recovery does not match its original child reservation.");
      }
    } else if (input.sessionId !== this.rootSessionManager.getSessionId()
      || input.sessionPath !== this.rootSessionManager.getSessionFile() || input.ownerSessionId !== undefined) {
      throw new Error("Agent recovery does not match its root session owner.");
    }
    this.recoveryOwners.set(input.sessionId, input);
    return () => {
      if (this.recoveryOwners.get(input.sessionId) === input) this.recoveryOwners.delete(input.sessionId);
    };
  }

  retry(targetSessionId: string, failureId: string): Promise<LlmRetryAcceptedDto> {
    if (this.lifecycle !== "open") throw new LlmRetryError("LLM_RETRY_BUSY");
    const owner = this.recoveryOwners.get(targetSessionId);
    if (!owner) throw new LlmRetryError("LLM_RETRY_UNAVAILABLE");
    if (owner.launchId) {
      const job = this.journal().jobs.get(owner.launchId);
      if (!job || job.childSessionId !== targetSessionId || job.sessionPath !== owner.sessionPath
        || job.ownerSessionId !== owner.ownerSessionId || !job.launchAcknowledged
        || (job.terminalStatus && !job.background) || job.terminalSuppressed
        || !this.recoveryOwners.has(job.ownerSessionId)) throw new LlmRetryError("LLM_RETRY_UNAVAILABLE");
    }
    return owner.recovery.retry(failureId);
  }

  retryState(targetSessionId: string, launchId?: string): LlmRetryStateEventDto | undefined {
    const owner = this.recoveryOwners.get(targetSessionId);
    if (!owner || (launchId !== undefined && launchId !== owner.launchId)) return undefined;
    const state = owner.recovery.state();
    if (!owner.launchId) return state;
    const job = this.journal().jobs.get(owner.launchId);
     if (!job || job.terminalSuppressed || (job.terminalStatus && !job.background)) return undefined;
    return job.launchAcknowledged ? state : { ...state, llmRecovery: null };
  }

  bindRecoveryPeriod(sessionID: string, launchId: string): void {
    const owner = this.recoveryOwners.get(sessionID);
    const job = this.journal().jobs.get(launchId);
    if (!owner || !job || job.childSessionId !== sessionID || job.ownerSessionId !== owner.ownerSessionId
      || job.sessionPath !== owner.sessionPath || job.terminalSuppressed) return;
    owner.launchId = launchId;
  }

  beginCancellation(): void {
    if (this.lifecycle === "open") this.lifecycle = "cancelling";
    for (const owner of this.recoveryOwners.values()) owner.recovery.cancel();
  }

  finishCancellation(): void {
    if (this.lifecycle === "cancelling") {
      this.lifecycle = "open";
      for (const owner of this.recoveryOwners.values()) owner.recovery.finishCancellation();
    }
  }

  beginClosing(): void {
    this.lifecycle = "closing";
    for (const owner of this.recoveryOwners.values()) owner.recovery.cancel();
  }

  getRootSessionManager(): CoordinatorSessionManager {
    return this.rootSessionManager;
  }

  getResearchAssistantModel(): string | undefined {
    return this.researchAssistantState?.model();
  }

  getResearchAssistantThinking(): string | undefined {
    return this.researchAssistantState?.thinking();
  }

  bindResearchAssistantState(read: { model(): string | undefined; thinking(): string | undefined }): void {
    this.researchAssistantState = read;
  }

  private append(record: SubagentJobJournalRecord): void {
    this.rootSessionManager.appendCustomEntry(SUBAGENT_JOB_ENTRY, record);
    this.refresh();
  }

  private refresh(): void {
    this.state = readSubagentJournal(this.rootSessionManager.getEntries());
  }

  private nextLaunchId(): string {
    let launchId = randomUUID();
    while (this.state.jobs.has(launchId)) launchId = randomUUID();
    return launchId;
  }
}
