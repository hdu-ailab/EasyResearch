import { randomUUID } from "node:crypto";
import type { AgentSessionEvent, JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { runCleanupSteps } from "../runtime/cleanup";
import { type ReservedDispatch, SubagentCoordinator } from "./coordinator";
import type { SubagentJobIdentity, SubagentLaunchDetails } from "./contracts";
import {
  AGENT_STATUS_TYPE,
  formatTerminalNotification,
  notificationBatchId,
  type TerminalNotificationOutcome,
} from "./notifications";
import type {
  StageLaunchHandle,
  StageLaunchOptions,
  StageRunResult,
  StageSessionLauncher,
} from "./stage-session";

export interface SupervisableAgentSession {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  readonly isStreaming: boolean;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  sendCustomMessage(
    message: { customType: string; content: string; display: boolean; details?: unknown },
    options: { deliverAs: "steer"; triggerTurn: boolean },
  ): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
}

interface OwnedChild {
  reservation: ReservedDispatch;
  startup: Promise<StageLaunchHandle>;
  startupPending: boolean;
  handle?: StageLaunchHandle;
  subscription?: () => void;
  completion?: Promise<StageRunResult>;
  settlement?: Promise<void>;
  abort?: (reason?: string) => Promise<void>;
  dispose?: () => Promise<void>;
  abortPromise?: Promise<void>;
  disposePromise?: Promise<void>;
  materialization: "pending" | "materialized" | "failed";
  identity?: SubagentJobIdentity;
  queuedEvents: JsonAgentSessionEvent[];
  acknowledgementEvents: JsonAgentSessionEvent[];
  latestAssistantText?: string;
  terminal?: TerminalNotificationOutcome & { errorMessage?: string };
  terminalRecorded: boolean;
  terminalPublished: boolean;
  completionSettled: boolean;
  subscriptionDisposed: boolean;
  handleDisposed: boolean;
  resourcesDisposed: boolean;
  forcedError?: string;
  removed: boolean;
  finished: Promise<void>;
  resolveFinished: () => void;
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "Unknown subagent failure";
}

function messageText(message: unknown): string | undefined {
  if (message === null || typeof message !== "object" || !("role" in message) || message.role !== "assistant") {
    return undefined;
  }
  const rawContent = "content" in message ? message.content : undefined;
  const content = typeof rawContent === "string" ? [rawContent] : Array.isArray(rawContent) ? rawContent : [];
  const text = content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part === null || typeof part !== "object" || !("type" in part) || part.type !== "text") return "";
      return "text" in part && typeof part.text === "string" ? part.text : "";
    })
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
  return text.trim().length > 0 ? text : undefined;
}

function latestAssistantText(result: StageRunResult): string | undefined {
  for (let index = result.messages.length - 1; index >= 0; index -= 1) {
    const text = messageText(result.messages[index]);
    if (text !== undefined) return text;
  }
  return undefined;
}

function failedResult(result: StageRunResult): boolean {
  return result.wasAborted === true
    || result.exitCode !== 0
    || result.stopReason === "error"
    || result.stopReason === "aborted";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isHiddenStatusMessage(value: unknown): boolean {
  return isObject(value) && value.customType === AGENT_STATUS_TYPE;
}

function publicChildEvent(event: JsonAgentSessionEvent): JsonAgentSessionEvent | undefined {
  const value = event.type === "message_start" || event.type === "message_end"
    ? event.message
    : event.type === "entry_appended"
      ? event.entry
      : undefined;
  if (isHiddenStatusMessage(value)) return undefined;
  if (event.type !== "agent_end") return event;
  return {
    ...event,
    messages: event.messages.filter((message) => !isHiddenStatusMessage(message)),
  };
}

function requiresLaunchAcknowledgement(event: JsonAgentSessionEvent): boolean {
  return event.type === "agent_end" || event.type === "agent_settled";
}

export class SubagentSupervisor {
  private readonly coordinator: SubagentCoordinator;
  private readonly launchStage: StageSessionLauncher;
  private readonly now: () => string;
  private readonly createId: () => string;
  private readonly schedule: (run: () => void) => void;
  private readonly children = new Map<string, OwnedChild>();
  private readonly quiescenceWaiters = new Set<() => void>();
  private readonly finalizedUnacknowledgedLaunchIds = new Set<string>();
  private parent?: SupervisableAgentSession;
  private parentSubscription?: () => void;
  private sendPromise?: Promise<void>;
  private notificationScheduled = false;
  private closing = false;
  private disposed = false;
  private abortPromise?: Promise<void>;
  private disposePromise?: Promise<void>;
  private closingBatchId?: string;

  constructor(options: {
    coordinator: SubagentCoordinator;
    launchStage: StageSessionLauncher;
    now?: () => string;
    createId?: () => string;
    schedule?: (run: () => void) => void;
  }) {
    this.coordinator = options.coordinator;
    this.launchStage = options.launchStage;
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? randomUUID;
    this.schedule = options.schedule ?? queueMicrotask;
  }

  attach(session: SupervisableAgentSession): void {
    if (this.disposed) throw new Error("Cannot attach a disposed subagent supervisor.");
    if (this.parent === session) return;
    if (this.parent) throw new Error("Subagent supervisor is already attached to another AgentSession.");
    this.parent = session;
    this.parentSubscription = session.subscribe((event) => this.observeParentEvent(event));
    if (this.hasPendingNotifications()) this.scheduleNotification();
    this.stateChanged();
  }

  observeParentEvent(event: AgentSessionEvent): void {
    if (event.type === "tool_execution_end" && event.toolName === "subagent" && !event.isError) {
      const state = this.coordinator.journal();
      for (const job of state.jobs.values()) {
        if (
          job.ownerSessionId !== this.parent?.sessionId
          || job.toolCallId !== event.toolCallId
          || job.launchAcknowledged
          || this.finalizedUnacknowledgedLaunchIds.has(job.launchId)
          || job.status === "pre_materialization_failed"
          || !job.childSessionId
        ) continue;
        this.coordinator.recordLaunchAcknowledged(job.launchId);
        const child = this.children.get(job.launchId);
        if (child) {
          this.publishAcknowledgedEvents(child);
          this.recordTerminalIfReady(child);
          this.publishTerminalIfReady(child);
          this.removeChildIfFinished(child);
        }
      }
      if (this.hasDeliverableOutcomes()) this.scheduleNotification();
      this.stateChanged();
      return;
    }

    const message = event.type === "message_end"
      ? event.message
      : event.type === "entry_appended"
        ? event.entry
        : undefined;
    const batchId = notificationBatchId(message);
    if (!batchId || !this.parent) return;
    const pending = this.coordinator.journal().pendingBatches.find(
      (batch) => batch.batchId === batchId && batch.ownerSessionId === this.parent!.sessionId,
    );
    if (!pending) return;
    this.coordinator.acknowledgeNotification(batchId);
    if (this.hasDeliverableOutcomes()) this.scheduleNotification();
    this.stateChanged();
  }

  async launch(
    reservation: ReservedDispatch,
    options: Omit<StageLaunchOptions, "reservation" | "coordinator">,
  ): Promise<SubagentLaunchDetails> {
    const parent = this.requireParent();
    if (this.closing || this.disposed) throw new Error("Cannot launch a subagent while its supervisor is closing.");
    if (reservation.ownerSessionId !== parent.sessionId) {
      throw new Error("Subagent reservation owner does not match the attached AgentSession.");
    }
    if (this.children.has(reservation.launchId)) throw new Error(`Subagent launch ${reservation.launchId} is already owned.`);

    let resolveFinished!: () => void;
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });
    const child: OwnedChild = {
      reservation,
      startup: Promise.resolve(undefined as never),
      startupPending: true,
      materialization: "pending",
      queuedEvents: [],
      acknowledgementEvents: [],
      terminalRecorded: false,
      terminalPublished: false,
      completionSettled: false,
      subscriptionDisposed: false,
      handleDisposed: false,
      resourcesDisposed: false,
      removed: false,
      finished,
      resolveFinished,
    };
    this.children.set(reservation.launchId, child);

    const startup = Promise.resolve()
      .then(() => this.launchStage({ ...options, reservation, coordinator: this.coordinator }))
      .then((handle) => {
        child.startupPending = false;
        this.ownHandle(child, handle);
        this.stateChanged();
        return handle;
      }, (error) => {
        child.startupPending = false;
        this.stateChanged();
        throw error;
      });
    child.startup = startup;
    this.stateChanged();

    let handle: StageLaunchHandle;
    try {
      handle = await startup;
    } catch (error) {
      child.materialization = "failed";
      this.coordinator.recordPreMaterializationFailure(reservation, error);
      if (child.handle) {
        await this.abortChild(child, describeError(error));
        await child.settlement;
        await this.disposeChildResources(child);
      }
      this.removeChild(child);
      throw error;
    }

    this.coordinator.recordChildCreated(reservation, {
      childSessionId: handle.childSessionId,
      sessionPath: handle.sessionPath,
    });
    if (this.closing) void this.abortChild(child, child.forcedError);

    try {
      await handle.materialized;
    } catch (error) {
      child.materialization = "failed";
      this.coordinator.recordPreMaterializationFailure(reservation, error);
      await this.abortChild(child, describeError(error));
      await child.settlement;
      await this.disposeChildResources(child);
      this.removeChild(child);
      throw error;
    }

    child.materialization = "materialized";
    child.identity = this.coordinator.recordMaterialized(reservation, {
      childSessionId: handle.childSessionId,
      sessionPath: handle.sessionPath,
    });
    this.coordinator.publish({ type: "subagent_supervisor", ...child.identity, status: "working" });
    for (const event of child.queuedEvents.splice(0)) this.publishProgress(child, event);
    this.publishAcknowledgedEvents(child);
    this.recordTerminalIfReady(child);
    this.publishTerminalIfReady(child);
    if (child.completionSettled) {
      void this.disposeChildResources(child)
        .then(() => this.removeChildIfFinished(child))
        .catch(() => {});
    }
    this.stateChanged();

    return {
      mode: "single",
      background: true,
      job: { ...child.identity, status: "working" },
    };
  }

  hasRunningChildren(): boolean {
    for (const child of this.children.values()) {
      if (child.startupPending || (child.handle !== undefined && !child.resourcesDisposed)) return true;
    }
    return false;
  }

  hasPendingNotifications(): boolean {
    const ownerSessionId = this.parent?.sessionId;
    if (!ownerSessionId) return false;
    const state = this.coordinator.journal();
    if (state.pendingBatches.some((batch) => batch.ownerSessionId === ownerSessionId)) return true;
    const pendingLaunchIds = new Set(
      state.pendingBatches
        .filter((batch) => batch.ownerSessionId === ownerSessionId)
        .flatMap((batch) => batch.launchIds),
    );
    for (const job of state.jobs.values()) {
      if (job.ownerSessionId !== ownerSessionId || !job.terminalStatus) continue;
      if (!job.launchAcknowledged) {
        if (!this.closing) return true;
        continue;
      }
      if (!pendingLaunchIds.has(job.launchId) && !state.acknowledgedNotificationLaunchIds.has(job.launchId)) return true;
    }
    return false;
  }

  isQuiescent(): boolean {
    return !this.hasRunningChildren() && !this.sendPromise && !this.hasPendingNotifications();
  }

  waitForQuiescence(): Promise<void> {
    if (this.isQuiescent()) return Promise.resolve();
    return new Promise((resolve) => this.quiescenceWaiters.add(resolve));
  }

  flushNotifications(options: { triggerTurn?: boolean } = {}): Promise<void> {
    return this.flushNotificationBatch(options.triggerTurn ?? !this.closing, false);
  }

  private flushClosingNotification(): Promise<void> {
    return this.flushNotificationBatch(false, true);
  }

  private flushNotificationBatch(triggerTurn: boolean, closingBatch: boolean): Promise<void> {
    if (this.sendPromise) return this.sendPromise;
    let tracked!: Promise<void>;
    tracked = Promise.resolve()
      .then(() => this.sendNextBatch(triggerTurn, closingBatch))
      .finally(() => {
        if (this.sendPromise === tracked) this.sendPromise = undefined;
        this.stateChanged();
      });
    this.sendPromise = tracked;
    this.stateChanged();
    return tracked;
  }

  abortAll(reason: string): Promise<void> {
    if (this.abortPromise) return this.abortPromise;
    this.closing = true;
    for (const child of this.children.values()) {
      this.forceChildError(child, reason);
    }
    this.stateChanged();

    let tracked!: Promise<void>;
    tracked = (async () => {
      const owned = [...this.children.values()];
      await Promise.all(owned.map(async (child) => {
        try {
          await child.startup;
        } catch {
          await child.finished;
          return;
        }
        await this.abortChild(child, reason);
        await child.settlement;
        await this.disposeChildResources(child);
        this.recordTerminalIfReady(child);
        this.publishTerminalIfReady(child);
        this.removeChildIfFinished(child);
        if (!child.removed && !this.coordinator.journal().jobs.get(child.reservation.launchId)?.launchAcknowledged) {
          this.removeChild(child);
        }
        await child.finished;
      }));

      while (this.sendPromise) {
        const activeSend = this.sendPromise;
        try {
          await activeSend;
        } catch {
          // The persisted batch remains available for closing supersession.
        }
        if (this.sendPromise === activeSend) break;
      }
      const ownerSessionId = this.parent?.sessionId;
      if (!ownerSessionId) return;
      for (const batch of this.coordinator.journal().pendingBatches) {
        if (batch.ownerSessionId === ownerSessionId && batch.batchId !== this.closingBatchId) {
          this.coordinator.supersedeNotification(batch.batchId);
        }
      }
      await this.flushClosingNotification();
      await this.waitForQuiescence();
    })()
      .catch((error) => {
        if (this.abortPromise === tracked) this.abortPromise = undefined;
        throw error;
      })
      .finally(() => this.stateChanged());
    this.abortPromise = tracked;
    return tracked;
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    let tracked!: Promise<void>;
    tracked = (async () => {
      if (!this.isQuiescent()) await this.abortAll("Subagent supervisor disposed.");
      this.parentSubscription?.();
      this.parentSubscription = undefined;
      this.parent = undefined;
      this.disposed = true;
      this.stateChanged();
    })().catch((error) => {
      if (this.disposePromise === tracked) this.disposePromise = undefined;
      throw error;
    });
    this.disposePromise = tracked;
    return tracked;
  }

  private requireParent(): SupervisableAgentSession {
    if (!this.parent) throw new Error("Subagent supervisor is not attached to an AgentSession.");
    return this.parent;
  }

  private ownHandle(child: OwnedChild, handle: StageLaunchHandle): void {
    child.handle = handle;
    child.completion = handle.completion;
    child.abort = (reason) => handle.abort(reason);
    child.dispose = () => handle.dispose();
    child.settlement = handle.completion.then(
      (result) => this.settleChild(child, result),
      (error) => this.settleChild(child, undefined, error),
    );
    if (
      handle.agentId !== child.reservation.agentId
      || (child.reservation.continuation && child.reservation.childSessionId !== handle.childSessionId)
      || (child.reservation.continuation && child.reservation.sessionPath !== handle.sessionPath)
    ) {
      throw new Error("Stage launch handle identity does not match its reservation.");
    }
    child.subscription = handle.subscribe((event) => this.observeChildEvent(child, event));
  }

  private observeChildEvent(child: OwnedChild, event: JsonAgentSessionEvent): void {
    if (event.type === "message_end") {
      const text = messageText(event.message);
      if (text !== undefined) child.latestAssistantText = text;
    }
    const publicEvent = publicChildEvent(event);
    if (!publicEvent) return;
    if (requiresLaunchAcknowledgement(publicEvent) && !this.isLaunchAcknowledged(child)) {
      child.acknowledgementEvents.push(publicEvent);
      return;
    }
    if (!child.identity) child.queuedEvents.push(publicEvent);
    else this.publishProgress(child, publicEvent);
  }

  private publishProgress(child: OwnedChild, event: JsonAgentSessionEvent): void {
    if (!child.identity || child.materialization !== "materialized" || child.terminalPublished) return;
    this.coordinator.publish({
      type: "subagent_supervisor",
      ...child.identity,
      status: "working",
      ...(child.latestAssistantText === undefined ? {} : { latestMessage: child.latestAssistantText }),
      event,
    });
  }

  private publishAcknowledgedEvents(child: OwnedChild): void {
    if (!child.identity || !this.isLaunchAcknowledged(child)) return;
    for (const event of child.acknowledgementEvents.splice(0)) this.publishProgress(child, event);
  }

  private isLaunchAcknowledged(child: OwnedChild): boolean {
    return this.coordinator.journal().jobs.get(child.reservation.launchId)?.launchAcknowledged === true;
  }

  private async settleChild(child: OwnedChild, result?: StageRunResult, failure?: unknown): Promise<void> {
    if (result) child.latestAssistantText = latestAssistantText(result) ?? child.latestAssistantText;
    const forcedError = child.forcedError;
    const status = forcedError || failure !== undefined || (result && failedResult(result)) ? "error" : "complete";
    const errorMessage = forcedError
      ?? (failure === undefined ? result?.errorMessage || result?.stderr || undefined : describeError(failure));
    child.terminal = {
      launchId: child.reservation.launchId,
      agentId: child.reservation.agentId,
      status,
      sessionPath: child.handle!.sessionPath,
      ...(child.latestAssistantText === undefined ? {} : { latestAssistantText: child.latestAssistantText }),
      ...(errorMessage === undefined ? {} : { errorMessage }),
    };
    child.completionSettled = true;
    this.recordTerminalIfReady(child);
    this.publishTerminalIfReady(child);
    if (child.materialization !== "pending") {
      try {
        await this.disposeChildResources(child);
      } catch {
        // The supervisor retains the handle and retries during later teardown.
      }
    }
    this.removeChildIfFinished(child);
    this.stateChanged();
  }

  private recordTerminalIfReady(child: OwnedChild): void {
    if (
      child.terminalRecorded
      || child.materialization !== "materialized"
      || !child.terminal
    ) return;
    this.coordinator.recordTerminal({
      launchId: child.reservation.launchId,
      status: child.terminal.status,
      ...(child.terminal.latestAssistantText === undefined ? {} : { latestAssistantText: child.terminal.latestAssistantText }),
      ...(child.terminal.errorMessage === undefined ? {} : { errorMessage: child.terminal.errorMessage }),
    });
    child.terminalRecorded = true;
  }

  private publishTerminalIfReady(child: OwnedChild): void {
    if (child.terminalPublished || !child.terminalRecorded || !child.terminal || !child.identity) return;
    const job = this.coordinator.journal().jobs.get(child.reservation.launchId);
    if (!job?.launchAcknowledged) return;
    child.terminalPublished = true;
    this.coordinator.publish({
      type: "subagent_supervisor",
      ...child.identity,
      status: child.terminal.status,
      ...(child.terminal.latestAssistantText === undefined ? {} : { latestMessage: child.terminal.latestAssistantText }),
    });
    if (!this.closing) this.scheduleNotification();
  }

  private abortChild(child: OwnedChild, reason?: string): Promise<void> {
    if (!child.abort) return Promise.resolve();
    child.abortPromise ??= Promise.resolve()
      .then(() => child.abort!(reason))
      .catch(() => {});
    return child.abortPromise;
  }

  private forceChildError(child: OwnedChild, reason: string): void {
    if (child.terminalPublished) return;
    child.forcedError = reason;
    if (!child.terminal) return;
    child.terminal = { ...child.terminal, status: "error", errorMessage: reason };
    if (!child.terminalRecorded || child.materialization !== "materialized") return;
    this.coordinator.recordTerminal({
      launchId: child.reservation.launchId,
      status: "error",
      ...(child.terminal.latestAssistantText === undefined ? {} : { latestAssistantText: child.terminal.latestAssistantText }),
      errorMessage: reason,
    });
  }

  private disposeChildResources(child: OwnedChild): Promise<void> {
    if (child.resourcesDisposed) return Promise.resolve();
    if (!child.dispose || !child.completionSettled) return Promise.resolve();
    if (child.disposePromise) return child.disposePromise;
    let tracked!: Promise<void>;
    tracked = runCleanupSteps([
      () => {
        if (child.subscriptionDisposed) return;
        child.subscription?.();
        child.subscription = undefined;
        child.subscriptionDisposed = true;
      },
      async () => {
        if (child.handleDisposed) return;
        await child.dispose!();
        child.handleDisposed = true;
      },
    ], "Subagent child cleanup failed.").then(
      () => {
        child.resourcesDisposed = true;
        this.stateChanged();
      },
      (error) => {
        if (child.disposePromise === tracked) child.disposePromise = undefined;
        this.stateChanged();
        throw error;
      },
    );
    child.disposePromise = tracked;
    return tracked;
  }

  private removeChildIfFinished(child: OwnedChild): void {
    if (!child.resourcesDisposed) return;
    if (
      this.closing
      && child.materialization === "materialized"
      && child.terminalRecorded
      && !this.isLaunchAcknowledged(child)
    ) {
      this.finalizedUnacknowledgedLaunchIds.add(child.reservation.launchId);
    }
    if (child.materialization === "failed" || child.terminalPublished || this.closing) this.removeChild(child);
  }

  private removeChild(child: OwnedChild): void {
    if (child.removed) return;
    child.removed = true;
    this.children.delete(child.reservation.launchId);
    child.resolveFinished();
    this.stateChanged();
  }

  private scheduleNotification(): void {
    if (this.notificationScheduled || !this.parent) return;
    this.notificationScheduled = true;
    try {
      this.schedule(() => {
        this.notificationScheduled = false;
        void this.flushNotifications({ triggerTurn: !this.closing }).catch(() => {});
      });
    } catch {
      this.notificationScheduled = false;
    }
  }

  private hasDeliverableOutcomes(): boolean {
    return this.collectDeliverableOutcomes().length > 0;
  }

  private collectDeliverableOutcomes(): TerminalNotificationOutcome[] {
    const ownerSessionId = this.parent?.sessionId;
    if (!ownerSessionId) return [];
    const state = this.coordinator.journal();
    const pendingLaunchIds = new Set(
      state.pendingBatches
        .filter((batch) => batch.ownerSessionId === ownerSessionId)
        .flatMap((batch) => batch.launchIds),
    );
    const outcomes: TerminalNotificationOutcome[] = [];
    for (const job of state.jobs.values()) {
      if (
        job.ownerSessionId !== ownerSessionId
        || !job.launchAcknowledged
        || !job.terminalStatus
        || !job.sessionPath
        || pendingLaunchIds.has(job.launchId)
        || state.acknowledgedNotificationLaunchIds.has(job.launchId)
      ) continue;
      outcomes.push({
        launchId: job.launchId,
        agentId: job.agentId,
        status: job.terminalStatus,
        sessionPath: job.sessionPath,
        ...(job.latestAssistantText === undefined ? {} : { latestAssistantText: job.latestAssistantText }),
      });
    }
    return outcomes;
  }

  private async sendNextBatch(triggerTurn: boolean, closingBatch: boolean): Promise<void> {
    const parent = this.requireParent();
    let batch = closingBatch && this.closingBatchId
      ? this.coordinator.journal().pendingBatches.find(
        (candidate) => candidate.ownerSessionId === parent.sessionId && candidate.batchId === this.closingBatchId,
      )
      : closingBatch
        ? undefined
        : this.coordinator.journal().pendingBatches.find(
          (candidate) => candidate.ownerSessionId === parent.sessionId,
        );
    if (!batch) {
      const outcomes = this.collectDeliverableOutcomes();
      if (outcomes.length === 0) return;
      const state = this.coordinator.journal();
      const workingAgentIds = [...state.jobs.values()]
        .filter((job) => job.ownerSessionId === parent.sessionId && job.status === "working")
        .map((job) => job.agentId);
      const content = formatTerminalNotification({ time: this.now(), workingAgentIds, outcomes });
      const batchId = this.nextBatchId();
      this.coordinator.recordNotificationBatch({
        batchId,
        ownerSessionId: parent.sessionId,
        launchIds: outcomes.map(({ launchId }) => launchId),
        content,
      });
      batch = { batchId, ownerSessionId: parent.sessionId, launchIds: outcomes.map(({ launchId }) => launchId), content, createdAt: this.now() };
    }
    if (closingBatch) this.closingBatchId = batch.batchId;

    await parent.sendCustomMessage(
      {
        customType: AGENT_STATUS_TYPE,
        content: batch.content,
        display: false,
        details: { batchId: batch.batchId },
      },
      { deliverAs: "steer", triggerTurn },
    );
  }

  private nextBatchId(): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const batchId = this.createId();
      const state = this.coordinator.journal();
      if (
        !state.pendingBatches.some((batch) => batch.batchId === batchId)
        && !state.acknowledgedBatchIds.has(batchId)
        && !state.supersededBatchIds.has(batchId)
      ) return batchId;
    }
    throw new Error("Could not allocate a unique subagent notification batch id.");
  }

  private stateChanged(): void {
    if (!this.isQuiescent()) return;
    for (const resolve of this.quiescenceWaiters) resolve();
    this.quiescenceWaiters.clear();
  }
}
