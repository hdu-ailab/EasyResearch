import type { AgentSession, AgentSessionEvent, SettingsManager } from "@earendil-works/pi-coding-agent";

export const DEFAULT_LLM_MAX_RETRIES = 10;
export const DEFAULT_LLM_RETRY_BASE_DELAY_MS = 5_000;
export const MAX_LLM_RETRY_DELAY_MS = 120_000;
export const MAX_LLM_RETRY_ERROR_CHARS = 2_048;

export type LlmRetrySettingsManager = Pick<
  SettingsManager,
  "getRetrySettings" | "getGlobalSettings" | "getProjectSettings"
>;
export type LlmRetryPolicySession = Pick<
  AgentSession,
  "subscribe" | "retryAttempt" | "isCompacting" | "isIdle"
>;
export type LlmSummarySource = "compaction" | "branchSummary";

export interface AutomaticRetrySnapshot {
  source: "agent" | LlmSummarySource;
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  remainingMs: number;
  errorMessage: string;
}

export interface LlmRetryPolicyBinding {
  attach(session: LlmRetryPolicySession): void;
  getAutomaticRetry(): AutomaticRetrySnapshot | null;
  subscribe(listener: () => void): () => void;
  beginSummary(source: LlmSummarySource): void;
  /** Also called by the branch-navigation owner in finally, including failure. */
  finishSummary(): void;
  /** The owner must settle native work before releasing this runtime binding. */
  dispose(): void;
}

type RetryPolicy = ReturnType<SettingsManager["getRetrySettings"]>;
type RetryWait = Omit<AutomaticRetrySnapshot, "remainingMs"> & { deadline: number };

function projectedBase(nominal: number, previousAttempts: number): number {
  return Math.min(nominal, MAX_LLM_RETRY_DELAY_MS / 2 ** previousAttempts);
}

/**
 * Pi 0.85.1 public-method adapter; retain the real SettingsManager and its writers.
 * AgentSession reads getRetrySettings before incrementing public retryAttempt.
 * Its native summarizers instead retain the returned plain policy and reread its
 * base for each retry. Their scheduled event follows calculation of the current
 * delay, so a projection there affects only the NEXT native wait. Split-turn
 * compaction shares one policy across two summary calls: finished resets its base
 * without releasing it. Keep real-Pi tests for these contracts when upgrading Pi.
 * This binding owns no timer, retry counter, request, or continuation loop.
 */
export function createLlmRetryPolicyBinding(settings: LlmRetrySettingsManager): LlmRetryPolicyBinding {
  const originalGetter = settings.getRetrySettings;
  const originalDescriptor = Object.getOwnPropertyDescriptor(settings, "getRetrySettings");
  // Extra diagnostic getter reads must not displace a policy held by Pi's loop.
  const summaryPolicies = new Map<RetryPolicy, number>();
  const listeners = new Set<() => void>();
  let session: LlmRetryPolicySession | undefined;
  let unsubscribeSession: (() => void) | undefined;
  let summarySource: LlmSummarySource | undefined;
  let wait: RetryWait | undefined;
  let disposed = false;

  const notify = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // Backoff display is observational and cannot interrupt native retries.
      }
    }
  };
  const clearWait = (source?: "agent" | "summary"): void => {
    if (!wait || (source === "agent" && wait.source !== "agent")
      || (source === "summary" && wait.source === "agent")) return;
    wait = undefined;
    notify();
  };
  const resetSummaryBases = (): void => {
    for (const [policy, nominal] of summaryPolicies) {
      policy.baseDelayMs = projectedBase(nominal, 0);
    }
  };
  const releaseSummaryPolicies = (): void => {
    resetSummaryBases();
    summaryPolicies.clear();
  };
  const finishSummary = (): void => {
    releaseSummaryPolicies();
    summarySource = undefined;
    clearWait("summary");
  };
  const beginSummary = (source: LlmSummarySource): void => {
    if (disposed) return;
    finishSummary();
    summarySource = source;
  };

  const projectedGetter = function (this: LlmRetrySettingsManager): RetryPolicy {
    const native = originalGetter.call(this);
    const global = this.getGlobalSettings().retry;
    const project = this.getProjectSettings().retry;
    const nominal = project?.baseDelayMs ?? global?.baseDelayMs ?? DEFAULT_LLM_RETRY_BASE_DELAY_MS;
    const policy: RetryPolicy = {
      ...native,
      maxRetries: project?.maxRetries ?? global?.maxRetries ?? DEFAULT_LLM_MAX_RETRIES,
      baseDelayMs: projectedBase(nominal, 0),
    };
    // Public isCompacting includes branch summarization as well as both compact modes.
    if (session?.isCompacting) {
      summaryPolicies.set(policy, nominal);
    } else {
      releaseSummaryPolicies();
      policy.baseDelayMs = projectedBase(nominal, session?.retryAttempt ?? 0);
    }
    return policy;
  };
  settings.getRetrySettings = projectedGetter;

  const observeWait = (
    source: AutomaticRetrySnapshot["source"],
    event: Extract<AgentSessionEvent, { type: "auto_retry_start" | "summarization_retry_scheduled" }>,
  ): void => {
    wait = {
      source,
      attempt: event.attempt,
      maxAttempts: event.maxAttempts,
      delayMs: event.delayMs,
      deadline: performance.now() + event.delayMs,
      errorMessage: event.errorMessage.slice(0, MAX_LLM_RETRY_ERROR_CHARS),
    };
    notify();
  };

  const observe = (event: AgentSessionEvent): void => {
    switch (event.type) {
      case "auto_retry_start":
        observeWait("agent", event);
        break;
      case "agent_start":
      case "auto_retry_end":
        clearWait("agent");
        break;
      case "compaction_start":
        // Automatic compaction publishes this before setting its controller. The
        // getter checks isCompacting later, at Pi's actual policy capture point.
        beginSummary("compaction");
        break;
      case "summarization_retry_scheduled":
        for (const [policy, nominal] of summaryPolicies) {
          policy.baseDelayMs = projectedBase(nominal, event.attempt);
        }
        // Compaction always publishes compaction_start first; branch navigation
        // normally supplies its source through the shared before-tree extension.
        observeWait(summarySource ?? "branchSummary", event);
        break;
      case "summarization_retry_attempt_start":
        summarySource = event.source;
        clearWait("summary");
        break;
      case "summarization_retry_finished":
        resetSummaryBases();
        clearWait("summary");
        break;
      case "compaction_end":
        finishSummary();
        break;
      case "agent_settled":
        clearWait("agent");
        if (!session?.isCompacting) finishSummary();
        break;
    }
  };

  return {
    attach(attached) {
      if (disposed) throw new Error("LLM retry policy binding has been disposed.");
      if (session) throw new Error("LLM retry policy binding is already attached.");
      const unsubscribe = attached.subscribe(observe);
      session = attached;
      unsubscribeSession = unsubscribe;
    },
    getAutomaticRetry() {
      if (!wait) return null;
      const { deadline, ...snapshot } = wait;
      return {
        ...snapshot,
        remainingMs: Math.max(0, Math.min(snapshot.delayMs, Math.ceil(deadline - performance.now()))),
      };
    },
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    beginSummary,
    finishSummary,
    dispose() {
      if (disposed) return;
      if (session && !session.isIdle) {
        throw new Error("Wait for native Agent work to settle before disposing its LLM retry policy.");
      }
      unsubscribeSession?.();
      unsubscribeSession = undefined;
      releaseSummaryPolicies();
      summarySource = undefined;
      if (settings.getRetrySettings === projectedGetter) {
        if (originalDescriptor) Object.defineProperty(settings, "getRetrySettings", originalDescriptor);
        else Reflect.deleteProperty(settings, "getRetrySettings");
      }
      disposed = true;
      clearWait();
      listeners.clear();
      session = undefined;
    },
  };
}
