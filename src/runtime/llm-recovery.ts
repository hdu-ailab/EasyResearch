import { randomUUID } from "node:crypto";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AutomaticRetryDto, LlmRecoveryDto, LlmRetryAcceptedDto, LlmRetryStateEventDto } from "../web/contracts";

export const LLM_RETRY_CONTROL_TYPE = "easyresearch:llm-retry";

export type LlmRetryErrorCode = "LLM_RETRY_STALE" | "LLM_RETRY_UNAVAILABLE" | "LLM_RETRY_BUSY";

export class LlmRetryError extends Error {
  constructor(readonly code: LlmRetryErrorCode) {
    super(code === "LLM_RETRY_STALE" ? "This model failure has already changed. Refresh and try again."
      : code === "LLM_RETRY_BUSY" ? "The Agent is busy. Wait for its current operation to finish."
        : "This model request is no longer available for retry.");
    this.name = "LlmRetryError";
  }
}

export interface RecoverableAgentSession {
  readonly sessionId: string;
  readonly isIdle: boolean;
  readonly isStreaming: boolean;
  readonly sessionManager: {
    getBranch(): readonly unknown[];
  };
  subscribe(listener: (event: unknown) => void): () => void;
  sendCustomMessage(
    message: { customType: string; content: string; display: boolean; details?: unknown },
    options: { deliverAs: "steer"; triggerTurn: boolean },
  ): Promise<void>;
}

interface AutomaticRetrySource {
  getAutomaticRetry(): AutomaticRetryDto | null;
  subscribe(listener: () => void): () => void;
}

export interface LlmRecoveryAdmission {
  release(): void;
  validate?(): void;
}

/** Attempt both independent observers; retain registration until cleanup succeeds. */
export function disposeLlmRecoveryRuntime(
  recovery: LlmRecoveryController,
  policy: { dispose(): void } | undefined,
  release: (() => void) | undefined,
): void {
  const failures: unknown[] = [];
  try { recovery.dispose(); } catch (error) { failures.push(error); }
  try { policy?.dispose(); } catch (error) { failures.push(error); }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "LLM recovery runtime cleanup failed.");
  release?.();
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isLlmRetryControl(value: unknown): boolean {
  return record(value) && value.customType === LLM_RETRY_CONTROL_TYPE;
}

/** One live native request checkpoint, never a request queue or retry scheduler. */
export class LlmRecoveryController {
  private session?: RecoverableAgentSession;
  private policy?: AutomaticRetrySource;
  private unsubscribe?: () => void;
  private unsubscribePolicy?: () => void;
  private checkpoint: LlmRecoveryDto | null = null;
  private failedMessage?: unknown;
  private branchAnchorId?: string;
  private lastAssistant?: unknown;
  private requestObserved = false;
  private blockedRun = false;
  private cancelled = false;
  private disposed = false;
  private generation = 0;
  private readonly operations = new Set<Promise<void>>();
  private readonly listeners = new Set<() => void>();
  private preflight?: (signal: AbortSignal) => Promise<LlmRecoveryAdmission>;
  private isBusy?: () => boolean;
  private operationAbort?: AbortController;

  attach(
    session: RecoverableAgentSession,
    policy: AutomaticRetrySource,
    preflight: (signal: AbortSignal) => Promise<LlmRecoveryAdmission>,
    isBusy: () => boolean = () => false,
  ): void {
    if (this.session || this.disposed) throw new Error("LLM recovery already attached or disposed.");
    this.session = session;
    this.policy = policy;
    this.preflight = preflight;
    this.isBusy = isBusy;
    this.unsubscribe = session.subscribe((event) => {
      try { this.observe(event as AgentSessionEvent); }
      catch { this.blockCurrentRun(); }
    });
    this.unsubscribePolicy = policy.subscribe(() => this.changed());
  }

  /** Called from the final host context hook, before the native provider request. */
  observeRequest(): void {
    this.requestObserved = true;
  }

  private observe(event: AgentSessionEvent): void {
    if (this.disposed) return;
    if (event.type === "agent_start") {
      this.lastAssistant = undefined;
      this.requestObserved = false;
      this.blockedRun = false;
      if (!this.cancelled && this.checkpoint) {
        // Another admitted user/native run supersedes an outstanding checkpoint
        // or retry preflight. Its later failure must survive that old HTTP result.
        this.generation += 1;
        this.operationAbort?.abort();
        this.clearCheckpoint();
      }
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      this.lastAssistant = event.message;
    } else if (event.type === "agent_settled") {
      // Native persistence precedes real settlement, including the entire retry /
      // overflow-compaction loop. Never infer authority from old disk errors.
      if (this.cancelled || this.blockedRun || !this.requestObserved || !this.session?.isIdle) return;
      this.requestObserved = false;
      const message = this.lastAssistant;
      if (!record(message) || message.role !== "assistant" || message.stopReason !== "error") return;
      const branch = this.session.sessionManager.getBranch();
      const entry = branch.findLast((item) =>
        record(item) && item.type === "message" && item.message === message);
      if (!record(entry) || typeof entry.id !== "string" || !entry.id) return;
      const tail = contextTail(branch);
      if (!record(tail) || typeof tail.id !== "string" || (tail.type === "message" && tail !== entry)) return;
      this.failedMessage = message;
      this.branchAnchorId = tail.id;
      this.checkpoint = {
        targetSessionId: this.session.sessionId,
        failureId: randomUUID(),
        failedEntryId: entry.id,
        status: "available",
      };
      if (!this.validAnchor()) this.clearCheckpoint();
      else this.changed();
    }
  }

  /** A failed host configuration boundary is not a provider recovery authority. */
  blockCurrentRun(): void {
    this.blockedRun = true;
    this.lastAssistant = undefined;
    this.clearCheckpoint();
  }

  hasWork(): boolean {
    return this.checkpoint !== null || this.operations.size > 0;
  }

  /** Also holds late completions between the failed response and final settlement. */
  holdsAutomaticWake(): boolean {
    return this.checkpoint !== null || (this.session?.isStreaming === true && !this.cancelled && !this.blockedRun
      && record(this.lastAssistant) && this.lastAssistant.stopReason === "error");
  }

  state(): LlmRetryStateEventDto {
    return {
      type: "llm_retry_state",
      targetSessionId: this.session?.sessionId ?? "",
      automaticRetry: this.policy?.getAutomaticRetry() ?? null,
      llmRecovery: this.checkpoint ? { ...this.checkpoint } : null,
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  retry(failureId: string): Promise<LlmRetryAcceptedDto> {
    const session = this.session;
    if (!session || this.disposed || this.cancelled) throw new LlmRetryError("LLM_RETRY_UNAVAILABLE");
    const checkpoint = this.checkpoint;
    const failedMessage = this.failedMessage;
    const branchAnchorId = this.branchAnchorId;
    if (!checkpoint || checkpoint.failureId !== failureId) throw new LlmRetryError("LLM_RETRY_STALE");
    if (checkpoint.status === "starting" || this.operations.size || !session.isIdle || this.isBusy?.()) {
      throw new LlmRetryError("LLM_RETRY_BUSY");
    }
    if (!this.validAnchor()) {
      this.clearCheckpoint();
      throw new LlmRetryError("LLM_RETRY_STALE");
    }
    // Claim before the first await: two tabs cannot both enter native preflight.
    this.checkpoint = { ...checkpoint, status: "starting" };
    const generation = this.generation;
    const cancellation = new AbortController();
    this.operationAbort = cancellation;
    let resolve!: (result: LlmRetryAcceptedDto) => void;
    let reject!: (error: unknown) => void;
    const admitted = new Promise<LlmRetryAcceptedDto>((accept, fail) => { resolve = accept; reject = fail; });
    let started = false;
    let operation!: Promise<void>;
    operation = Promise.resolve().then(async () => {
      let release: (() => void) | undefined;
      try {
        const admission = await this.preflight!(cancellation.signal);
        release = admission.release;
        if (this.cancelled || this.disposed) {
          throw new LlmRetryError("LLM_RETRY_UNAVAILABLE");
        }
        if (generation !== this.generation || cancellation.signal.aborted || this.checkpoint?.failureId !== failureId) {
          throw new LlmRetryError("LLM_RETRY_STALE");
        }
        if (!this.validAnchor()) throw new LlmRetryError("LLM_RETRY_STALE");
        if (!session.isIdle || this.isBusy?.()) throw new LlmRetryError("LLM_RETRY_BUSY");
        admission.validate?.();
        this.checkpoint = null;
        this.failedMessage = undefined;
        this.branchAnchorId = undefined;
        this.lastAssistant = undefined;
        const native = session.sendCustomMessage({
          customType: LLM_RETRY_CONTROL_TYPE,
          content: "",
          display: false,
          details: { failedEntryId: checkpoint.failedEntryId },
        }, { deliverAs: "steer", triggerTurn: true });
        started = true;
        // The managed wake owns native agent_start / retry / settlement. Its
        // complete promise remains here after HTTP admission has returned.
        resolve({ accepted: true, targetSessionId: session.sessionId, failureId });
        this.changed();
        try {
          release();
          release = undefined;
        } finally {
          await native;
        }
      } catch (error) {
        if (!started) {
          if (!this.cancelled && !this.disposed && generation === this.generation
            && (this.checkpoint === null || this.checkpoint.failureId === failureId)) {
            this.checkpoint = checkpoint;
            this.failedMessage = failedMessage;
            this.branchAnchorId = branchAnchorId;
            if (this.validAnchor()) this.checkpoint = { ...checkpoint, failureId: randomUUID(), status: "available" };
            else this.clearCheckpoint();
          }
          reject(error);
        }
      } finally {
        release?.();
      }
    }).finally(() => {
      this.operations.delete(operation);
      if (this.operationAbort === cancellation) this.operationAbort = undefined;
      this.changed();
    });
    this.operations.add(operation);
    void operation.catch(() => {});
    this.changed();
    return admitted;
  }

  /** Synchronous invalidation precedes the owner's native/descendant abort. */
  cancel(): void {
    this.cancelled = true;
    this.generation += 1;
    this.operationAbort?.abort();
    this.lastAssistant = undefined;
    this.clearCheckpoint();
  }

  finishCancellation(): void {
    if (!this.disposed) this.cancelled = false;
  }

  async settleOperations(): Promise<void> {
    while (this.operations.size) await Promise.allSettled([...this.operations]);
  }

  async waitForResolution(): Promise<void> {
    while (this.hasWork()) {
      await new Promise<void>((resolve) => {
        const unsubscribe = this.subscribe(() => { unsubscribe(); resolve(); });
        if (!this.hasWork()) { unsubscribe(); resolve(); }
      });
    }
  }

  /** A completion-woken caller may fail while its initial finish waits on children. */
  async untilRecovery(operation: Promise<void>): Promise<void> {
    let unsubscribe = () => {};
    const recovery = new Promise<void>((resolve) => {
      unsubscribe = this.subscribe(() => { if (this.hasWork()) resolve(); });
      if (this.hasWork()) resolve();
    });
    try { await Promise.race([operation, recovery]); }
    finally { unsubscribe(); }
  }

  dispose(): void {
    if (this.disposed) return;
    if (this.operations.size) throw new Error("Cannot dispose an owned LLM retry operation before settlement.");
    this.cancel();
    const failures: unknown[] = [];
    try { this.unsubscribe?.(); this.unsubscribe = undefined; } catch (error) { failures.push(error); }
    try { this.unsubscribePolicy?.(); this.unsubscribePolicy = undefined; } catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, "LLM recovery listener cleanup failed.");
    this.disposed = true;
    this.listeners.clear();
  }

  private validAnchor(): boolean {
    const checkpoint = this.checkpoint;
    if (!checkpoint || !this.session || checkpoint.targetSessionId !== this.session.sessionId) return false;
    let branch: readonly unknown[];
    try { branch = this.session.sessionManager.getBranch(); } catch { return false; }
    // Coordinator metadata may append while siblings work. Only native context /
    // branch entries can replace the failed request's conversation anchor.
    const tail = contextTail(branch);
    return record(tail) && tail.id === this.branchAnchorId && branch.some((entry) => record(entry)
      && entry.id === checkpoint.failedEntryId && entry.message === this.failedMessage);
  }

  private clearCheckpoint(): void {
    this.checkpoint = null;
    this.failedMessage = undefined;
    this.branchAnchorId = undefined;
    this.changed();
  }

  private changed(): void {
    for (const listener of [...this.listeners]) {
      try { listener(); } catch { /* Observers never own native execution. */ }
    }
  }
}

function contextTail(branch: readonly unknown[]): unknown {
  return branch.findLast((entry) => record(entry)
    && (entry.type === "message" || entry.type === "compaction" || entry.type === "branch_summary"));
}
