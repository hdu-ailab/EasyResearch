import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionTreeNode } from "@earendil-works/pi-coding-agent";
import type { ActiveSessionDto, ApiUsageRecordDto, CompactionPolicyDto, CompactionStateDto, ContextUsageDto } from "./contracts";
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

const logger = createLogger("web-registry");

export class UnknownSessionError extends Error {}

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
}

export interface ActiveSessionRegistryOptions {
  idleTimeoutMs?: number;
  /** Resolves the Research Assistant thinking default for fresh session launches. */
  resolveLaunchThinking?: (cwd: string) => Promise<string | undefined>;
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
  private readonly idleTimeoutMs: number;
  private readonly resolveLaunchThinking?: (cwd: string) => Promise<string | undefined>;
  private shuttingDown = false;

  constructor(
    private readonly factory: SessionFactory,
    private readonly logger?: Logger,
    options: ActiveSessionRegistryOptions = {},
    private readonly fileWatcherFactory: FileWatcherFactory = createNoopFileWatcherFactory(),
  ) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? 3_600_000;
    this.resolveLaunchThinking = options.resolveLaunchThinking;
  }

  async create(input: CreateSessionInput): Promise<ActiveSessionDto> {
    return this.launch(this.reserveLaunch({ cwd: input.cwd }));
  }

  open(input: OpenSessionInput): Promise<ActiveSessionDto> {
    for (const record of this.records.values()) {
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
      })).finally(() => {
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

  async snapshot(
    id: string,
    onMessagesAcquired?: () => void,
  ): Promise<{
    session: ActiveSessionDto;
    messages: AgentMessage[];
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
      const messages = live ? await record.client.getMessages() : [];
      const contextUsage = live ? record.client.getContextUsage() : undefined;
      const runtimeConfigurationGeneration = record.client.getRuntimeConfigurationGeneration();
      onMessagesAcquired?.();
      return {
        session: { ...record.dto },
        messages,
        inlineUsage: live ? record.client.getInlineUsage() : [],
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
    return this.withRecord(id, async (record) => {
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
    return this.withRecord(id, async (record) => {
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
    return this.withRecord(id, (record) => record.client.setModel(provider, modelId));
  }

  /**
   * Set the Research Assistant's live thinking level. Pi applies the change to
   * the next LLM call, even while a run is in progress.
   */
  async setThinkingLevel(id: string, level: string): Promise<void> {
    return this.withRecord(id, (record) => record.client.setThinkingLevel(level));
  }

  /** True when a live registry record exists for the id (i.e. the session is connected). */
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
    return this.withRecord(id, (record) => record.client.navigateTree(entryId, options));
  }

  async compact(id: string, customInstructions?: string): Promise<{ state: ManualCompactionAcceptedState }> {
    return this.withRecord(id, (record) => record.client.compact(customInstructions));
  }

  async stop(id: string): Promise<void> {
    const record = this.records.get(id);
    if (!record) return;
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
        await record.client.stop();
        if (!record.stopNotified) {
          record.stopNotified = true;
          this.publishEvent(record, { type: "session_deactivated", sessionId: record.dto.id });
        }
        record.dto.isStreaming = false;
        record.dto.status = "stopped";
        record.dto.error = undefined;
        record.dispose();
        (this.logger ?? logger).info("session deactivated", { sessionId: record.dto.id });
        if (this.records.get(id) === record) this.records.delete(id);
      })().catch((error) => {
        if (record.stopPromise === tracked) record.stopPromise = null;
        throw error;
      });
      record.stopPromise = tracked;
    }
    await record.stopPromise;
  }

  async restart(id: string): Promise<ActiveSessionDto> {
    const record = this.records.get(id);
    if (!record) {
      throw new UnknownSessionError(`Unknown session: ${id}`);
    }
    const oldListeners = record.listeners;
    const pending = this.reserveLaunch({
      cwd: record.cwd,
      sessionPath: record.sessionPath,
      adoptListeners: oldListeners,
    });
    let launchStarted = false;
    try {
      await this.stop(id);
      launchStarted = true;
      return await this.launch(pending);
    } catch (error) {
      if (!launchStarted) this.releasePendingReservation(pending);
      throw error;
    }
  }

  subscribe(id: string, listener: (event: unknown) => void): () => void {
    const record = this.records.get(id);
    if (!record) throw new UnknownSessionError(`Unknown session: ${id}`);
    record.listeners.add(listener);
    return () => record.listeners.delete(listener);
  }

  acquireFileWatchLease(id: string): string {
    const record = this.records.get(id);
    if (!record) throw new UnknownSessionError(`Unknown session: ${id}`);
    return record.fileWatcher.acquireLease();
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
    // The session may have stopped before its EventSource cancellation runs.
    this.records.get(id)?.fileWatcher.releaseLease(leaseId);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const pending = [...this.pendingLaunches];
    for (const launch of pending) launch.cancelled = true;
    const outcomes = await Promise.allSettled(
      [
        ...[...this.records.values()].map((record) => this.stop(record.dto.id)),
        ...pending.map((launch) => this.settlePendingForShutdown(launch)),
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
    if (pending.cancelled || this.shuttingDown) throw new SessionRegistryShuttingDownError();
  }

  private async launch(pending: PendingLaunch): Promise<ActiveSessionDto> {
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
      };
      pending.record = record;
      (this.logger ?? logger).info("session launch", { cwd: options.cwd, sessionPath: options.sessionPath ?? "" });
      await client.start();
      this.throwIfLaunchCancelled(pending);
      const state = await client.getState();
      this.throwIfLaunchCancelled(pending);
      dto.id = state.sessionId;
      if (state.sessionFile) {
        dto.sessionFile = state.sessionFile;
        // Resume must target the real session file, even when it was created
        // during this launch (create has no sessionPath up front).
        record.sessionPath = state.sessionFile;
      }
      if (state.sessionName) dto.sessionName = state.sessionName;
      dto.isStreaming = state.isStreaming;
      dto.status = state.isStreaming ? "running" : "ready";

      try {
        record.fileWatcher = this.fileWatcherFactory.create({
          cwd: record.cwd,
          onEvent: (event) => {
            this.publishEvent(record, event);
          },
        });
      } catch (error) {
        (this.logger ?? logger).warn("file watcher unavailable", {
          cwd: record.cwd,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      const eventCancel = client.onEvent((event) => {
        this.publishEvent(record, event);
        this.syncDtoFromEvent(record, event);
      });
      const eventLogCancel = attachEventLogger(dto.id, record.cwd, client.onEvent.bind(client), this.logger ?? logger);
      record.dispose = () => {
        eventCancel();
        eventLogCancel();
      };

      this.throwIfLaunchCancelled(pending);
      this.records.set(dto.id, record);
      this.releasePendingReservation(pending);
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
      if (pending.cancelled || this.shuttingDown) throw new SessionRegistryShuttingDownError();
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
    for (const listener of [...record.listeners]) {
      try {
        listener(event);
      } catch {
        // Registry subscribers observe state; they never control session ownership.
      }
    }
  }

  /**
   * The DTO status must reflect an actual agent run, never user focus,
   * session launch, or a prompt send. `agent_start`/`agent_settled` are Pi's
   * authoritative run boundaries: a run that fails preflight emits neither,
   * so the session stays `ready` instead of being marked `running`. Message
   * events are intentionally ignored here — `message_start` fires for user
   * and queued messages too, which would mark the session running while no
   * agent is active.
   */
  private syncDtoFromEvent(record: ActiveRecord, event: unknown): void {
    const type = (event as { type?: string }).type;
    if (type === "agent_start") {
      this.clearIdleTimer(record);
      record.dto.isStreaming = true;
      if (record.dto.status !== "stopped" && record.dto.status !== "error") {
        record.dto.status = "running";
      }
    }
    if (type === "agent_settled") {
      record.dto.isStreaming = false;
      if (record.dto.status !== "stopped" && record.dto.status !== "error") {
        record.dto.status = "ready";
        this.scheduleIdleStop(record);
      }
    }
    if (type === "session_info_changed") {
      const name = (event as { name?: unknown }).name;
      record.dto.sessionName = typeof name === "string" ? name : undefined;
    }
    if (type !== "agent_start" && type !== "agent_settled") this.reconcileIdleLease(record);
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
      && !record.dto.isStreaming
      && !record.client.hasBackgroundWork();
  }

  private async refreshFromClient(record: ActiveRecord): Promise<void> {
    try {
      const state = await record.client.getState();
      record.dto.isStreaming = state.isStreaming;
      if (record.dto.status !== "stopped" && record.dto.status !== "error") {
        record.dto.status = state.isStreaming ? "running" : "ready";
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
}

function isConnectedStatus(status: ActiveSessionDto["status"]): boolean {
  return status === "starting" || status === "ready" || status === "running";
}
