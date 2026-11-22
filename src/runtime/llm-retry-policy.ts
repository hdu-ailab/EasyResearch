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

/**
 * Supply host defaults through the real SettingsManager's public getter. Pi 1.6
 * applies maxAgentDelayMs in both Agent and summary retry loops, including split
 * compaction. Captured native policies remain immutable for their operation.
 * This binding owns no timer, retry counter, request, or continuation loop.
 */
export function createLlmRetryPolicyBinding(settings: LlmRetrySettingsManager): LlmRetryPolicyBinding {
  const originalGetter = settings.getRetrySettings;
  const originalDescriptor = Object.getOwnPropertyDescriptor(settings, "getRetrySettings");
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
  const finishSummary = (): void => {
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
    return {
      ...native,
      maxRetries: project?.maxRetries ?? global?.maxRetries ?? DEFAULT_LLM_MAX_RETRIES,
      baseDelayMs: project?.baseDelayMs ?? global?.baseDelayMs ?? DEFAULT_LLM_RETRY_BASE_DELAY_MS,
      maxAgentDelayMs: Math.min(
        project?.maxAgentDelayMs ?? global?.maxAgentDelayMs ?? MAX_LLM_RETRY_DELAY_MS,
        MAX_LLM_RETRY_DELAY_MS,
      ),
    };
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
        beginSummary("compaction");
        break;
      case "summarization_retry_scheduled":
        // Compaction always publishes compaction_start first; branch navigation
        // normally supplies its source through the shared before-tree extension.
        observeWait(summarySource ?? "branchSummary", event);
        break;
      case "summarization_retry_attempt_start":
        summarySource = event.source;
        clearWait("summary");
        break;
      case "summarization_retry_finished":
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
