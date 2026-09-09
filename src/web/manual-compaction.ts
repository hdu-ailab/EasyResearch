import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

export type ManualCompactionState = "idle" | "queued" | "running";
export type ManualCompactionAcceptedState = Exclude<ManualCompactionState, "idle">;

type StopAfterTurn = (...args: unknown[]) => boolean | Promise<boolean>;

export interface ManualCompactionSession {
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
  agent: {
    shouldStopAfterTurn?: StopAfterTurn;
  };
  compact(customInstructions?: string): Promise<unknown>;
  abort(): Promise<void>;
  abortCompaction(): void;
}

interface PendingCompaction {
  customInstructions?: string;
}

/** Owns one Web manual-compaction request for one Pi AgentSession. */
export class ManualCompactionController {
  private session: ManualCompactionSession | undefined;
  private pending: PendingCompaction | undefined;
  private running: Promise<void> | undefined;
  private nativeCompactionRunning = false;
  private nativeCompactionCompletion: Promise<void> | undefined;
  private resolveNativeCompaction: (() => void) | undefined;
  private currentState: ManualCompactionState = "idle";
  private previousStopAfterTurn: StopAfterTurn | undefined;
  private installedStopAfterTurn: StopAfterTurn | undefined;
  private disposed = false;
  private cancellationRequested = false;
  private readonly listeners = new Set<(state: ManualCompactionState) => void>();

  attach(session: ManualCompactionSession): void {
    if (this.disposed) throw new Error("Manual compaction controller has been disposed");
    if (this.session) throw new Error("Manual compaction controller is already attached");
    this.session = session;
    this.previousStopAfterTurn = session.agent.shouldStopAfterTurn;
    this.installedStopAfterTurn = async (...args) => {
      if (this.pending) return true;
      return await this.previousStopAfterTurn?.apply(session.agent, args) ?? false;
    };
    session.agent.shouldStopAfterTurn = this.installedStopAfterTurn;
  }

  request(customInstructions?: string): { state: ManualCompactionAcceptedState } {
    if (this.disposed) throw new Error("Manual compaction controller has been disposed");
    if (this.cancellationRequested) throw new Error("Session cancellation is still in progress");
    const session = this.requiredSession();
    if (this.running || this.nativeCompactionRunning) return { state: "running" };
    if (session.isCompacting) {
      throw new Error("Wait for active summarization to finish before compacting.");
    }
    if (session.isStreaming) {
      this.pending = customInstructions === undefined ? {} : { customInstructions };
      this.setState("queued", true);
      return { state: "queued" };
    }
    this.startCompaction(this.requestValue(customInstructions), false);
    return { state: "running" };
  }

  /** Awaited by the named inline `agent_end` extension before Pi continues queues. */
  async onAgentEnd(): Promise<void> {
    if (!this.pending || this.running || this.disposed) return;
    const request = this.pending;
    this.pending = undefined;
    this.startCompaction(request, true);
    await this.running;
  }

  state(): ManualCompactionState {
    return this.currentState;
  }

  hasWork(): boolean {
    return this.pending !== undefined || this.running !== undefined || this.nativeCompactionRunning;
  }

  observeNativeCompaction(event: "start" | "end"): void {
    if (this.disposed || this.running) return;
    if (event === "start") {
      this.beginNativeCompaction();
      this.setState("running");
      return;
    }
    if (!this.nativeCompactionRunning) return;
    this.nativeCompactionRunning = false;
    const resolve = this.resolveNativeCompaction;
    this.resolveNativeCompaction = undefined;
    this.nativeCompactionCompletion = undefined;
    this.setState(this.pending ? "queued" : "idle");
    resolve?.();
  }

  subscribe(listener: (state: ManualCompactionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async cancel(): Promise<void> {
    this.cancellationRequested = true;
    const session = this.session;
    const hadPending = this.pending !== undefined;
    this.pending = undefined;
    const nativeCompletion = this.nativeCompactionCompletion;
    if (hadPending && !this.running && !this.nativeCompactionRunning) this.setState("idle");
    // isCompacting also includes branch summaries, which never emit compaction_end.
    if (session && (this.running || this.nativeCompactionRunning)) session.abortCompaction();
    await Promise.all([this.running, nativeCompletion].filter((value) => value !== undefined));
  }

  isCancelling(): boolean {
    return this.cancellationRequested;
  }

  finishCancellation(): void {
    this.cancellationRequested = false;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    await this.cancel();
    const session = this.session;
    if (session && session.agent.shouldStopAfterTurn === this.installedStopAfterTurn) {
      session.agent.shouldStopAfterTurn = this.previousStopAfterTurn;
    }
    this.listeners.clear();
    this.session = undefined;
    this.disposed = true;
  }

  private requestValue(customInstructions?: string): PendingCompaction {
    return customInstructions === undefined ? {} : { customInstructions };
  }

  private beginNativeCompaction(): void {
    this.nativeCompactionRunning = true;
    if (this.nativeCompactionCompletion) return;
    this.nativeCompactionCompletion = new Promise((resolve) => {
      this.resolveNativeCompaction = resolve;
    });
  }

  private startCompaction(request: PendingCompaction, atTurnBoundary: boolean): void {
    const session = this.requiredSession();
    this.pending = undefined;
    this.setState("running");
    let nativeOperation: Promise<unknown>;
    try {
      nativeOperation = atTurnBoundary
        ? this.compactAtTurnBoundary(session, request.customInstructions)
        : session.compact(request.customInstructions);
    } catch (error) {
      nativeOperation = Promise.reject(error);
    }
    let tracked!: Promise<void>;
    tracked = nativeOperation
      .then(() => {}, () => {})
      .finally(() => {
        if (this.running !== tracked) return;
        this.running = undefined;
        this.setState("idle");
      });
    this.running = tracked;
  }

  private compactAtTurnBoundary(
    session: ManualCompactionSession,
    customInstructions?: string,
  ): Promise<unknown> {
    const originalAbort = session.abort;
    let bypassed = false;
    session.abort = async () => {
      if (!bypassed) {
        bypassed = true;
        return;
      }
      await originalAbort.call(session);
    };
    let operation: Promise<unknown>;
    try {
      // Pi compact() calls abort synchronously before its first await. The agent_end
      // hook is already at a completed-turn boundary, where waiting for that same
      // run to become idle would deadlock the awaited hook.
      operation = session.compact(customInstructions);
    } finally {
      session.abort = originalAbort;
    }
    if (!bypassed) {
      session.abortCompaction();
      return Promise.reject(new Error("Pi manual compaction did not enter through the safe turn boundary"));
    }
    return operation;
  }

  private setState(state: ManualCompactionState, repeat = false): void {
    if (!repeat && this.currentState === state) return;
    this.currentState = state;
    for (const listener of this.listeners) listener(state);
  }

  private requiredSession(): ManualCompactionSession {
    if (!this.session) throw new Error("Manual compaction controller is not attached");
    return this.session;
  }
}

export function createManualCompactionExtension(
  controller: Pick<ManualCompactionController, "onAgentEnd">,
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.on("agent_end", async () => {
      await controller.onAgentEnd();
    });
  };
}
