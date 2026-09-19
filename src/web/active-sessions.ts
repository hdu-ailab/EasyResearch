import type { SessionTreeNode } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import type {
  ActiveSessionDto,
  ApiUsageRecordDto,
  CompactionPolicyDto,
  CompactionStateDto,
  ContextUsageDto,
  SessionActivityChangedEventDto,
  SessionDeletedEventDto,
  TranscriptTimelineEntryDto,
} from "./contracts";
import type {
  SessionAdapter,
  SessionFactory,
  StartSessionOptions,
  TreeNavigationOptions,
  TreeNavigationResult,
  WebTreeFilterMode,
  WebSlashCommand,
} from "./session-adapter";
import { createLogger } from "../runtime/logger";
import { attachEventLogger } from "./event-logger";
import type { Logger } from "../runtime/logger";
import { createNoopFileWatcherFactory, type FileWatcher, type FileWatcherFactory } from "./file-watcher";
import type { ManualCompactionAcceptedState } from "./manual-compaction";
import type { SessionHistoryTarget } from "./session-deletion";

const logger = createLogger("web-registry");

export class UnknownSessionError extends Error {}

export class SessionLifecycleConflictError extends Error {
  constructor() { super("A conflicting session lifecycle operation is in progress."); }
}

export class SessionBusyError extends Error {
  readonly code = "SESSION_BUSY";
  constructor() { super("The session has active work. Confirm Stop and delete to continue."); }
}

interface LifecycleOperation {
  id: string;
  path?: string;
  kind: "delete" | "rename" | "restart";
  promise: Promise<unknown>;
}

export interface SessionDeletionDependencies {
  resolve(id: string): Promise<SessionHistoryTarget>;
  remove(target: SessionHistoryTarget, allowMissingRoot: boolean): Promise<unknown>;
}

export class SessionRegistryShuttingDownError extends Error {
  constructor() {
    super("Session registry is shutting down.");
    this.name = "SessionRegistryShuttingDownError";
  }
}

interface ActiveRecord {
  dto: ActiveSessionDto;
  cwd: string;
  sessionPath?: string;
  client: SessionAdapter;
  fileWatcher: FileWatcher;
  listeners: Set<(event: unknown) => void>;
  dispose: () => void;
  stopPromise: Promise<void> | null;
  stopNotified: boolean;
  fileWatcherClosed: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  supervisorActive: boolean;
  rootActivityRevision: number;
  closing: boolean;
  clientStopped: boolean;
  listenersDisposed: boolean;
  mutations: Set<Promise<unknown>>;
  historyMayBeMissing: boolean;
}

type LaunchOptions = StartSessionOptions & { adoptListeners?: Set<(event: unknown) => void> };

interface PendingLaunch {
  options: LaunchOptions;
  cancelled: boolean;
  initialSettled: boolean;
  settlement: Promise<void>;
  resolveSettlement: () => void;
  rejectSettlement: (error: unknown) => void;
  record?: ActiveRecord;
  clientStopped: boolean;
  listenersDisposed: boolean;
  cleanupPromise?: Promise<void>;
}

export interface CreateSessionInput {
  cwd: string;
}

export interface OpenSessionInput {
  cwd: string;
  sessionPath: string;
  sessionId?: string;
}

export interface ActiveSessionRegistryOptions {
  idleTimeoutMs?: number;
  /** Resolves the Research Assistant thinking default for fresh session launches. */
  resolveLaunchThinking?: (cwd: string) => Promise<string | undefined>;
  /** Persistent hosts revalidate physical identity under admission before Pi opens. */
  validateOpen?: (input: OpenSessionInput) => void;
}

/**
 * In-memory registry owning one Pi AgentSession adapter per connected Web
 * session. Browser disconnects only unsubscribe listeners; explicit stop,
 * restart, or registry shutdown disposes adapters but preserves session paths.
 */
export class ActiveSessionRegistry {
  private readonly records = new Map<string, ActiveRecord>();
  private readonly opening = new Map<string, Promise<ActiveSessionDto>>();
  private readonly pendingLaunches = new Set<PendingLaunch>();
  private readonly lifecycleOperations = new Set<LifecycleOperation>();
  private readonly subscriptions = new Map<string, Set<(event: unknown) => void>>();
  private readonly fileWatchLeases = new Map<string, { id: string; watcher: FileWatcher }>();
  private readonly idleTimeoutMs: number;
  private readonly resolveLaunchThinking?: (cwd: string) => Promise<string | undefined>;
  private readonly validateOpen?: (input: OpenSessionInput) => void;
  private shuttingDown = false;

  constructor(
    private readonly factory: SessionFactory,
    private readonly logger?: Logger,
    options: ActiveSessionRegistryOptions = {},
    private readonly fileWatcherFactory: FileWatcherFactory = createNoopFileWatcherFactory(),
  ) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? 3_600_000;
    this.resolveLaunchThinking = options.resolveLaunchThinking;
    this.validateOpen = options.validateOpen;
  }

  async create(input: CreateSessionInput): Promise<ActiveSessionDto> {
    return this.launch(this.reserveLaunch({ cwd: input.cwd }));
  }

  open(input: OpenSessionInput): Promise<ActiveSessionDto> {
    if (this.shuttingDown) return Promise.reject(new SessionRegistryShuttingDownError());
    if (this.conflictingOperation(input.sessionId, input.sessionPath)) {
      return Promise.reject(new SessionLifecycleConflictError());
    }
    if ([...this.pendingLaunches].some((launch) =>
      launch.options.sessionPath === input.sessionPath && (launch.cancelled || launch.initialSettled))) {
      return Promise.reject(new SessionLifecycleConflictError());
    }
    for (const record of this.records.values()) {
      if (record.sessionPath === input.sessionPath && record.closing) {
        return Promise.reject(new SessionLifecycleConflictError());
      }
      if (record.cwd === input.cwd && record.sessionPath === input.sessionPath && record.dto.status === "error") {
        return this.restart(record.dto.id);
      }
      if (
        record.cwd === input.cwd &&
        record.sessionPath === input.sessionPath &&
        (record.dto.status === "starting" || record.dto.status === "ready" || record.dto.status === "running")
      ) {
        this.resetIdleTimer(record);
        return Promise.resolve({ ...record.dto });
      }
    }
    const key = JSON.stringify([input.cwd, input.sessionPath]);
    const pending = this.opening.get(key);
    if (pending) return pending;

    let tracked!: Promise<ActiveSessionDto>;
    try {
      tracked = this.launch(this.reserveLaunch({
        cwd: input.cwd,
        sessionPath: input.sessionPath,
      }), input).finally(() => {
        if (this.opening.get(key) === tracked) this.opening.delete(key);
      });
    } catch (error) {
      return Promise.reject(error);
    }
    this.opening.set(key, tracked);
    return tracked;
  }

  list(): ActiveSessionDto[] {
    return [...this.records.values()].map((r) => ({ ...r.dto }));
  }

  listActive(): ActiveSessionDto[] {
    return [...this.records.values()]
      .filter((record) => isConnectedStatus(record.dto.status))
      .map((record) => ({ ...record.dto }));
  }

  activeWorkCount(): number {
    let count = this.pendingLaunches.size + this.lifecycleOperations.size;
    for (const record of this.records.values()) {
      if (this.isBusy(record)) count += 1;
    }
    return count;
  }

  beginShutdown(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    for (const launch of this.pendingLaunches) launch.cancelled = true;
  }

  async snapshot(
    id: string,
    onMessagesAcquired?: () => void,
  ): Promise<{
    session: ActiveSessionDto;
    timeline: TranscriptTimelineEntryDto[];
    inlineUsage: ApiUsageRecordDto[];
    steering: string[];
    runtimeConfigurationGeneration: number;
    contextUsage?: ContextUsageDto;
    compactionPolicy: CompactionPolicyDto;
    compactionState: CompactionStateDto;
  }> {
    return this.withRecord(id, async (record) => {
      await this.refreshFromClient(record);
      const live =
        record.dto.status === "starting" ||
        record.dto.status === "ready" ||
        record.dto.status === "running";
      const transcript = live
        ? await record.client.getTranscriptSnapshot()
        : { timeline: [], inlineUsage: [] };
      const contextUsage = live ? record.client.getContextUsage() : undefined;
      const runtimeConfigurationGeneration = record.client.getRuntimeConfigurationGeneration();
      onMessagesAcquired?.();
      return {
        session: { ...record.dto },
        timeline: transcript.timeline,
        inlineUsage: transcript.inlineUsage,
        steering: live ? [...record.client.getSteeringMessages()] : [],
        runtimeConfigurationGeneration,
        ...(contextUsage !== undefined ? { contextUsage } : {}),
        compactionPolicy: record.client.getCompactionPolicy(),
        compactionState: live ? record.client.getCompactionState() : "idle",
      };
    });
  }

  /**
   * Dispatch a prompt without touching the DTO status: a session counts as
   * `running` only while a real agent run is active (`agent_start` →
   * `agent_settled`), never while a prompt is merely in flight. Pi's RPC
   * `prompt` resolves even when the run never starts (e.g. missing
   * model/auth preflight failure), and no `agent_settled` follows then;
   * pre-marking `running` here would leave an idle session stuck `running`.
   */
  async prompt(id: string, message: string): Promise<void> {
    if (this.shuttingDown) throw new SessionRegistryShuttingDownError();
    return this.withMutation(id, async (record) => {
      this.clearIdleTimer(record);
      try {
        await record.client.prompt(message);
      } catch (error) {
        if (record.dto.status === "ready") this.scheduleIdleStop(record);
        throw error;
      }
      if (record.dto.status === "ready") this.scheduleIdleStop(record);
    });
  }

  async abort(id: string): Promise<void> {
    return this.withMutation(id, async (record) => {
      await record.client.abort();
      await this.refreshFromClient(record);
    });
  }

  async touch(id: string): Promise<void> {
    return this.withRecord(id, async (record) => {
      this.resetIdleTimer(record);
    });
  }

  async setModel(id: string, provider: string, modelId: string): Promise<void> {
    return this.withMutation(id, (record) => record.client.setModel(provider, modelId));
  }

  /**
   * Set the Research Assistant's live thinking level. Pi applies the change to
   * the next LLM call, even while a run is in progress.
   */
  async setThinkingLevel(id: string, level: string): Promise<void> {
    return this.withMutation(id, (record) => record.client.setThinkingLevel(level));
  }

  /** Includes records retained for retryable terminal cleanup. */
  has(id: string): boolean {
    return this.records.has(id);
  }

  /** True only for an exact cwd spelling currently owned by a connected session. */
  hasConnectedCwd(cwd: string): boolean {
    return [...this.records.values()].some(
      (record) => record.cwd === cwd && isConnectedStatus(record.dto.status),
    );
  }

  async getSessionPath(id: string): Promise<string | undefined> {
    return this.withRecord(id, (record) => Promise.resolve(record.sessionPath));
  }

  async getCwd(id: string): Promise<string> {
    return this.withRecord(id, (record) => Promise.resolve(record.cwd));
  }

  /**
   * The Research Assistant's current model as a `provider/id` string, the level-4
   * fallback for stage agents in this session. Undefined when the session has
   * no model (e.g. no auth configured).
   */
  async getResearchAssistantModel(id: string): Promise<string | undefined> {
    return this.withRecord(id, async (record) => {
      const state = await record.client.getState();
      const model = state.model;
      return model ? `${model.provider}/${model.id}` : undefined;
    });
  }

  /**
   * The Research Assistant's live thinking level from session state, the level-4
   * fallback for stage agents in this session. Undefined when the session has
   * no level (e.g. no active session record).
   */
  async getResearchAssistantThinking(id: string): Promise<string | undefined> {
    return this.withRecord(id, async (record) => {
      const state = await record.client.getState();
      return state.thinkingLevel ?? undefined;
    });
  }

  /**
   * Commands available on the session's agent (extension commands, prompt
   * templates, and the agent's registered skills).
   */
  async getCommands(id: string): Promise<WebSlashCommand[]> {
    return this.withRecord(id, (record) => record.client.getCommands());
  }

  async getTree(id: string): Promise<{
    tree: SessionTreeNode[];
    leafId: string | null;
    filterMode: WebTreeFilterMode;
    skipBranchSummaryPrompt: boolean;
  }> {
    return this.withRecord(id, (record) => record.client.getTree());
  }

  /**
   * Move the session leaf to a target entry in place (same session file),
   * driven by the web-tree extension command. Navigate then re-fetch the
   * snapshot to view the new branch path.
   */
  async navigateTree(
    id: string,
    entryId: string,
    options?: TreeNavigationOptions,
  ): Promise<TreeNavigationResult> {
    return this.withMutation(id, (record) => record.client.navigateTree(entryId, options));
  }

  async compact(id: string, customInstructions?: string): Promise<{ state: ManualCompactionAcceptedState }> {
    return this.withMutation(id, (record) => record.client.compact(customInstructions));
  }

  async stop(id: string): Promise<void> {
    if (this.conflictingOperation(id)) throw new SessionLifecycleConflictError();
    const record = this.records.get(id);
    if (!record) return;
    return this.stopRecord(record);
  }

  private async stopRecord(record: ActiveRecord): Promise<void> {
    const id = record.dto.id;
    record.closing = true;
    this.clearIdleTimer(record);
    if (!record.stopPromise) {
      let tracked!: Promise<void>;
      tracked = (async () => {
        if (!record.fileWatcherClosed) {
          record.fileWatcherClosed = true;
          await record.fileWatcher.close().catch((error: unknown) => {
            (this.logger ?? logger).warn("file watcher close failed", {
              sessionId: record.dto.id,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
        if (!record.clientStopped) {
          await record.client.stop();
          record.clientStopped = true;
        }
        // Native Stop cancels its writers; registry-owned calls must also settle.
        await Promise.allSettled([...record.mutations]);
        if (!record.listenersDisposed) {
          record.dispose();
          record.listenersDisposed = true;
        }
        if (!record.stopNotified) {
          record.stopNotified = true;
          this.publishEvent(record, { type: "session_deactivated", sessionId: record.dto.id });
        }
        record.dto.isStreaming = false;
        record.dto.status = "stopped";
        record.dto.error = undefined;
        (this.logger ?? logger).info("session deactivated", { sessionId: record.dto.id });
        if (this.records.get(id) === record) this.records.delete(id);
      })().catch((error) => {
        if (record.stopPromise === tracked) record.stopPromise = null;
        throw error;
      });
      record.stopPromise = tracked;
    }
    await record.stopPromise;
    if (this.records.get(id) === record) this.records.delete(id);
  }

  async restart(id: string): Promise<ActiveSessionDto> {
    const record = this.records.get(id);
    if (!record) {
      throw new UnknownSessionError(`Unknown session: ${id}`);
    }
    return this.runLifecycle({ id, path: record.sessionPath, kind: "restart" }, async () => {
      const pending = this.reserveLaunch({
        cwd: record.cwd,
        sessionPath: record.sessionPath,
        adoptListeners: record.listeners,
      });
      let launchStarted = false;
      try {
        await this.stopRecord(record);
        launchStarted = true;
        return await this.launch(pending, record.sessionPath ? {
          cwd: record.cwd, sessionPath: record.sessionPath, sessionId: id,
        } : undefined);
      } catch (error) {
        if (!launchStarted) this.releasePendingReservation(pending);
        throw error;
      }
    });
  }

  withHistoryMutation<T>(target: SessionHistoryTarget, run: () => Promise<T>): Promise<T> {
    if (this.records.has(target.id) || [...this.pendingLaunches].some((launch) =>
      launch.options.sessionPath === target.path)) return Promise.reject(new SessionLifecycleConflictError());
    return this.runLifecycle({ id: target.id, path: target.path, kind: "rename" }, run);
  }

  deleteSession(id: string, force: boolean, history: SessionDeletionDependencies): Promise<void> {
    const existing = this.deletionCompletion(id);
    if (existing) return existing;
    const record = this.records.get(id);
    if (!force && record && this.isBusy(record)) return Promise.reject(new SessionBusyError());
    return this.runLifecycle({ id, path: record?.sessionPath, kind: "delete" }, async (operation) => {
      const target = record?.sessionPath
        ? { id, cwd: record.cwd, path: record.sessionPath }
        : await history.resolve(id);
      if (this.conflictingOperation(id, target.path, operation)) throw new SessionLifecycleConflictError();
      operation.path = target.path;
      // An already-admitted open can finish while the native listing resolves.
      const live = this.records.get(id) ?? record;
      if (target.id !== id || live && (live.sessionPath !== target.path || live.cwd !== target.cwd)) {
        throw new SessionLifecycleConflictError();
      }
      const pending = [...this.pendingLaunches].filter((launch) => launch.options.sessionPath === target.path);
      if (!force && (pending.length > 0 || live && this.isBusy(live))) throw new SessionBusyError();
      const allowMissingRoot = live?.historyMayBeMissing === true && !existsSync(target.path);
      for (const launch of pending) launch.cancelled = true;
      const cleanup = await Promise.allSettled([
        ...pending.map((launch) => this.settlePendingForShutdown(launch)),
        ...(live ? [this.stopRecord(live)] : []),
      ]);
      const failures = cleanup.flatMap((outcome) => outcome.status === "rejected" ? [outcome.reason] : []);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "Session deletion cleanup failed");
      try {
        await history.remove(target, allowMissingRoot);
      } catch (error) {
        // A lazy root has no durable listing from which a failed attempt can retry.
        if (allowMissingRoot && live) this.records.set(id, live);
        throw error;
      }
      if (this.records.get(id) === live) this.records.delete(id);
      this.publishTo(this.subscriptions.get(id), { type: "session_deleted", sessionId: id } satisfies SessionDeletedEventDto);
    });
  }

  deletionCompletion(id: string): Promise<void> | undefined {
    return [...this.lifecycleOperations].find((operation) => operation.id === id && operation.kind === "delete")
      ?.promise as Promise<void> | undefined;
  }

  subscribe(id: string, listener: (event: unknown) => void): () => void {
    const record = this.records.get(id);
    if (!record) throw new UnknownSessionError(`Unknown session: ${id}`);
    this.subscriptions.set(id, record.listeners);
    record.listeners.add(listener);
    const listeners = record.listeners;
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && this.subscriptions.get(id) === listeners) this.subscriptions.delete(id);
    };
  }

  acquireFileWatchLease(id: string): string {
    const record = this.records.get(id);
    if (!record) throw new UnknownSessionError(`Unknown session: ${id}`);
    const leaseId = record.fileWatcher.acquireLease();
    this.fileWatchLeases.set(leaseId, { id, watcher: record.fileWatcher });
    return leaseId;
  }

  replaceFileWatchLease(
    id: string,
    leaseId: string,
    revision: number,
    directories: readonly string[],
  ): boolean {
    const record = this.records.get(id);
    if (!record) throw new UnknownSessionError(`Unknown session: ${id}`);
    return record.fileWatcher.replaceLease(leaseId, revision, directories);
  }

  releaseFileWatchLease(id: string, leaseId: string): void {
    const lease = this.fileWatchLeases.get(leaseId);
    if (lease?.id !== id) return;
    this.fileWatchLeases.delete(leaseId);
    lease.watcher.releaseLease(leaseId);
  }

  async shutdown(): Promise<void> {
    this.beginShutdown();
    const pending = [...this.pendingLaunches];
    const outcomes = await Promise.allSettled(
      [
        ...[...this.records.values()].map((record) => this.stopRecord(record)),
        ...pending.map((launch) => this.settlePendingForShutdown(launch)),
        // Request errors belong to their callers; shutdown still owns settlement.
        ...[...this.lifecycleOperations].map((operation) => operation.promise.catch(() => {})),
      ],
    );
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason] : [],
    );
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Active session shutdown failed");
  }

  private reserveLaunch(options: LaunchOptions): PendingLaunch {
    if (this.shuttingDown) throw new SessionRegistryShuttingDownError();
    let resolveSettlement!: () => void;
    let rejectSettlement!: (error: unknown) => void;
    const settlement = new Promise<void>((resolve, reject) => {
      resolveSettlement = resolve;
      rejectSettlement = reject;
    });
    void settlement.catch(() => {});
    const pending: PendingLaunch = {
      options,
      cancelled: false,
      initialSettled: false,
      settlement,
      resolveSettlement,
      rejectSettlement,
      clientStopped: false,
      listenersDisposed: false,
    };
    this.pendingLaunches.add(pending);
    return pending;
  }

  private releasePendingReservation(pending: PendingLaunch): void {
    if (pending.initialSettled) return;
    pending.initialSettled = true;
    this.pendingLaunches.delete(pending);
    pending.resolveSettlement();
  }

  private throwIfLaunchCancelled(pending: PendingLaunch): void {
    if (this.shuttingDown) throw new SessionRegistryShuttingDownError();
    if (pending.cancelled) throw new SessionLifecycleConflictError();
  }

  private async launch(pending: PendingLaunch, historical?: OpenSessionInput): Promise<ActiveSessionDto> {
    const { options } = pending;
    const dto: ActiveSessionDto = {
      id: "",
      cwd: options.cwd,
      sessionFile: options.sessionPath,
      isStreaming: false,
      status: "starting",
    };
    try {
      this.throwIfLaunchCancelled(pending);
      const { assertSafeExtensionSources } = await import("../runtime/extensions-guard");
      this.throwIfLaunchCancelled(pending);
      assertSafeExtensionSources({ cwd: options.cwd });
      this.throwIfLaunchCancelled(pending);
      const listeners = options.adoptListeners ?? new Set<(event: unknown) => void>();
      // Fresh launch metadata reflects the global Research Assistant default;
      // the in-process runtime binding remains authoritative.
      const launchThinking = !options.sessionPath ? await this.resolveLaunchThinking?.(options.cwd) : undefined;
      this.throwIfLaunchCancelled(pending);
      if (historical) this.validateOpen?.(historical);
      const client = this.factory.create(launchThinking === undefined ? options : { ...options, thinking: launchThinking });
      const record: ActiveRecord = {
        dto,
        cwd: options.cwd,
        sessionPath: options.sessionPath,
        client,
        fileWatcher: createNoopFileWatcherFactory().create({ cwd: options.cwd, onEvent: () => {} }),
        listeners,
        dispose: () => {},
        stopPromise: null,
        stopNotified: false,
        fileWatcherClosed: false,
        idleTimer: null,
        supervisorActive: false,
        rootActivityRevision: 0,
        closing: false,
        clientStopped: false,
        listenersDisposed: false,
        mutations: new Set(),
        historyMayBeMissing: !options.sessionPath,
      };
      pending.record = record;
      (this.logger ?? logger).info("session launch", { cwd: options.cwd, sessionPath: options.sessionPath ?? "" });
      let eventsLive = false;
      const launchEvents: unknown[] = [];
      const publishOrBuffer = (event: unknown): void => {
        if (eventsLive) this.publishEvent(record, event);
        else launchEvents.push(event);
      };
      try {
        record.fileWatcher = this.fileWatcherFactory.create({
          cwd: record.cwd,
          onEvent: (event) => {
            publishOrBuffer(event);
          },
        });
      } catch (error) {
        (this.logger ?? logger).warn("file watcher unavailable", {
          cwd: record.cwd,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      let eventLogCancel = () => {};
      const eventCancel = client.onEvent((event) => {
        const activityChanged = this.syncDtoFromEvent(record, event);
        if ((event as { type?: unknown }).type !== "session_activity_changed") {
          publishOrBuffer(event);
        }
        const replacement = activityChanged ? this.activityReplacement(record) : undefined;
        if (replacement) publishOrBuffer(replacement);
      });
      record.dispose = () => {
        eventCancel();
        eventLogCancel();
      };

      await client.start();
      this.throwIfLaunchCancelled(pending);
      const rootActivityRevision = record.rootActivityRevision;
      const state = await client.getState();
      this.throwIfLaunchCancelled(pending);
      dto.id = state.sessionId;
      record.listeners = this.subscriptions.get(dto.id) ?? record.listeners;
      if (state.sessionFile) {
        dto.sessionFile = state.sessionFile;
        // Resume must target the real session file, even when it was created
        // during this launch (create has no sessionPath up front).
        record.sessionPath = state.sessionFile;
        if (existsSync(state.sessionFile)) record.historyMayBeMissing = false;
      }
      if (state.sessionName) dto.sessionName = state.sessionName;
      if (rootActivityRevision === record.rootActivityRevision) dto.isStreaming = state.isStreaming;
      record.supervisorActive = client.isSupervisorActive();
      this.syncActivityStatus(record);
      const finalActivity = this.activityReplacement(record);
      const lastLaunchEvent = launchEvents.at(-1) as Partial<SessionActivityChangedEventDto> | undefined;
      if (
        finalActivity
        && (
          lastLaunchEvent?.type !== finalActivity.type
          || lastLaunchEvent.status !== finalActivity.status
          || lastLaunchEvent.isStreaming !== finalActivity.isStreaming
        )
      ) launchEvents.push(finalActivity);
      eventLogCancel = attachEventLogger(dto.id, record.cwd, client.onEvent.bind(client), this.logger ?? logger);

      this.throwIfLaunchCancelled(pending);
      this.records.set(dto.id, record);
      eventsLive = true;
      this.releasePendingReservation(pending);
      for (const event of launchEvents) this.publishEvent(record, event);
      this.scheduleIdleStop(record);
    } catch (error) {
      (this.logger ?? logger).error("session runtime launch failed", {
        cwd: options.cwd,
        sessionPath: options.sessionPath ?? "",
        error: error instanceof Error ? error.message : String(error),
      });
      let cleanupError: unknown;
      try {
        await this.cleanupPendingLaunch(pending);
      } catch (failure) {
        cleanupError = failure;
      }
      if (!pending.initialSettled) {
        pending.initialSettled = true;
        if (cleanupError === undefined) pending.resolveSettlement();
        else pending.rejectSettlement(cleanupError);
      }
      this.throwIfLaunchCancelled(pending);
      throw error;
    }
    return { ...dto };
  }

  private settlePendingForShutdown(pending: PendingLaunch): Promise<void> {
    if (!pending.initialSettled) return pending.settlement;
    return this.cleanupPendingLaunch(pending);
  }

  private cleanupPendingLaunch(pending: PendingLaunch): Promise<void> {
    if (pending.cleanupPromise) return pending.cleanupPromise;
    const attempt = (async () => {
      const record = pending.record;
      if (!record) {
        this.pendingLaunches.delete(pending);
        return;
      }
      const failures: unknown[] = [];
      if (!record.fileWatcherClosed) {
        try {
          await record.fileWatcher.close();
          record.fileWatcherClosed = true;
        } catch (error) {
          failures.push(error);
        }
      }
      if (!pending.clientStopped) {
        try {
          await record.client.stop();
          pending.clientStopped = true;
        } catch (error) {
          failures.push(error);
        }
      }
      if (!pending.listenersDisposed) {
        try {
          record.dispose();
          pending.listenersDisposed = true;
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "Pending session launch cleanup failed");
      this.pendingLaunches.delete(pending);
    })();
    pending.cleanupPromise = attempt;
    void attempt.then(
      () => {
        if (pending.cleanupPromise === attempt) pending.cleanupPromise = undefined;
      },
      () => {
        if (pending.cleanupPromise === attempt) pending.cleanupPromise = undefined;
      },
    );
    return attempt;
  }

  private publishEvent(record: ActiveRecord, event: unknown): void {
    this.publishTo(record.listeners, event);
  }

  private publishTo(listeners: Set<(event: unknown) => void> | undefined, event: unknown): void {
    for (const listener of [...listeners ?? []]) {
      try {
        listener(event);
      } catch {
        // Registry subscribers observe state; they never control session ownership.
      }
    }
  }

  /**
   * Root streaming, compaction, and supervisor activity are independent inputs.
   * Status stays running until all are idle, while `isStreaming` remains the
   * root AgentSession's state for composer and cursor behavior.
   */
  private syncDtoFromEvent(record: ActiveRecord, event: unknown): boolean {
    const type = (event as { type?: string }).type;
    if (type === "message_end" && (event as { message?: { role?: string } }).message?.role === "assistant") {
      record.historyMayBeMissing = false;
    }
    let activityChanged = false;
    if (type === "agent_start") {
      this.clearIdleTimer(record);
      record.dto.isStreaming = true;
      record.rootActivityRevision += 1;
      activityChanged = true;
      this.syncActivityStatus(record);
    }
    if (type === "agent_settled") {
      record.dto.isStreaming = false;
      record.rootActivityRevision += 1;
      activityChanged = true;
      this.syncActivityStatus(record);
    }
    if (type === "session_activity_changed") {
      const active = (event as { active?: unknown }).active;
      if (typeof active === "boolean") {
        record.supervisorActive = active;
        activityChanged = true;
        this.syncActivityStatus(record);
      }
    }
    if (type === "compaction_state_changed") {
      activityChanged = true;
      this.syncActivityStatus(record);
    }
    if (type === "session_info_changed") {
      const name = (event as { name?: unknown }).name;
      record.dto.sessionName = typeof name === "string" ? name : undefined;
    }
    this.reconcileIdleLease(record);
    return activityChanged;
  }

  private syncActivityStatus(record: ActiveRecord): void {
    if (record.dto.status === "stopped" || record.dto.status === "error") return;
    const compaction = record.client.getCompactionState();
    record.dto.status = record.dto.isStreaming || record.supervisorActive || compaction === "queued" || compaction === "running"
      ? "running" : "ready";
  }

  private activityReplacement(record: ActiveRecord): SessionActivityChangedEventDto | undefined {
    if (record.dto.status !== "ready" && record.dto.status !== "running") return undefined;
    return {
      type: "session_activity_changed",
      status: record.dto.status,
      isStreaming: record.dto.isStreaming,
    };
  }

  private clearIdleTimer(record: ActiveRecord): void {
    if (record.idleTimer === null) return;
    clearTimeout(record.idleTimer);
    record.idleTimer = null;
  }

  private resetIdleTimer(record: ActiveRecord): void {
    this.clearIdleTimer(record);
    this.scheduleIdleStop(record);
  }

  private scheduleIdleStop(record: ActiveRecord): void {
    this.clearIdleTimer(record);
    if (this.idleTimeoutMs < 0 || !this.canIdleStop(record)) return;
    record.idleTimer = setTimeout(() => {
      record.idleTimer = null;
      if (this.records.get(record.dto.id) === record && this.canIdleStop(record)) {
        void this.stop(record.dto.id).catch((error: unknown) => {
          (this.logger ?? logger).warn("idle session cleanup failed", {
            sessionId: record.dto.id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    }, this.idleTimeoutMs);
  }

  private reconcileIdleLease(record: ActiveRecord): void {
    if (!this.canIdleStop(record)) {
      this.clearIdleTimer(record);
      return;
    }
    if (record.idleTimer === null) this.scheduleIdleStop(record);
  }

  private canIdleStop(record: ActiveRecord): boolean {
    return record.dto.status === "ready"
      && !record.closing
      && !this.conflictingOperation(record.dto.id, record.sessionPath)
      && record.mutations.size === 0
      && !record.dto.isStreaming
      && !record.client.hasBackgroundWork();
  }

  private async refreshFromClient(record: ActiveRecord): Promise<void> {
    try {
      const rootActivityRevision = record.rootActivityRevision;
      const state = await record.client.getState();
      if (rootActivityRevision === record.rootActivityRevision) {
        record.dto.isStreaming = state.isStreaming;
        this.syncActivityStatus(record);
      }
      if (state.sessionFile) record.dto.sessionFile = state.sessionFile;
      if (state.sessionName) record.dto.sessionName = state.sessionName;
      this.reconcileIdleLease(record);
    } catch (error) {
      if (record.dto.status !== "stopped") {
        record.dto.status = "error";
        record.dto.error = error instanceof Error ? error.message : String(error);
      }
    }
  }

  private withRecord<T>(id: string, run: (record: ActiveRecord) => Promise<T>): Promise<T> {
    const record = this.records.get(id);
    if (!record) return Promise.reject(new UnknownSessionError(`Unknown session: ${id}`));
    return run(record);
  }

  private isBusy(record: ActiveRecord): boolean {
    if (record.dto.status === "stopped") return false;
    return record.dto.status === "starting" || record.dto.isStreaming || record.supervisorActive
      || record.mutations.size > 0 || record.closing || record.client.hasBackgroundWork()
      || record.client.isSupervisorActive() || record.client.getCompactionState() !== "idle";
  }

  private withMutation<T>(id: string, run: (record: ActiveRecord) => Promise<T>): Promise<T> {
    if (this.shuttingDown) return Promise.reject(new SessionRegistryShuttingDownError());
    return this.withRecord(id, (record) => {
      if (record.closing || this.conflictingOperation(id, record.sessionPath)) {
        return Promise.reject(new SessionLifecycleConflictError());
      }
      const operation = run(record);
      record.mutations.add(operation);
      void operation.finally(() => {
        record.mutations.delete(operation);
        this.reconcileIdleLease(record);
      }).catch(() => {});
      return operation;
    });
  }

  private conflictingOperation(id?: string, path?: string, except?: LifecycleOperation): boolean {
    return [...this.lifecycleOperations].some((operation) => operation !== except
      && (id !== undefined && operation.id === id || path !== undefined && operation.path === path));
  }

  private runLifecycle<T>(
    input: Omit<LifecycleOperation, "promise">,
    run: (operation: LifecycleOperation) => Promise<T>,
  ): Promise<T> {
    if (this.shuttingDown) return Promise.reject(new SessionRegistryShuttingDownError());
    if (this.conflictingOperation(input.id, input.path)) return Promise.reject(new SessionLifecycleConflictError());
    const operation: LifecycleOperation = { ...input, promise: Promise.resolve() };
    this.lifecycleOperations.add(operation);
    const promise = Promise.resolve().then(() => run(operation)).finally(() => {
      this.lifecycleOperations.delete(operation);
      for (const record of this.records.values()) {
        if (record.dto.id === input.id || record.sessionPath === operation.path) this.reconcileIdleLease(record);
      }
    });
    operation.promise = promise;
    return promise;
  }
}

function isConnectedStatus(status: ActiveSessionDto["status"]): boolean {
  return status === "starting" || status === "ready" || status === "running";
}
