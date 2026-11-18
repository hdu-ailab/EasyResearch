import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLlmRetryPolicyBinding,
  MAX_LLM_RETRY_ERROR_CHARS,
  type LlmRetryPolicySession,
  type LlmRetrySettingsManager,
} from "./llm-retry-policy";

function fixture() {
  const settings: LlmRetrySettingsManager = {
    getRetrySettings: () => ({ enabled: true, maxRetries: 3, baseDelayMs: 2_000 }),
    getGlobalSettings: () => ({}),
    getProjectSettings: () => ({}),
  };
  const events = new Set<(event: AgentSessionEvent) => void>();
  const session: LlmRetryPolicySession = {
    retryAttempt: 0,
    isCompacting: false,
    isIdle: true,
    subscribe(listener) {
      events.add(listener);
      return () => { events.delete(listener); };
    },
  };
  const binding = createLlmRetryPolicyBinding(settings);
  binding.attach(session);
  return {
    settings, session, binding,
    emit(event: AgentSessionEvent) { for (const listener of events) listener(event); },
    setActive(value: boolean) { Object.assign(session, { isIdle: !value }); },
  };
}

afterEach(() => { vi.useRealTimers(); });

describe("native retry observation", () => {
  it("computes remaining backoff from monotonic time without a timer or polling notification", () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    const f = fixture();
    const changed = vi.fn();
    f.binding.subscribe(changed);
    f.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 10, delayMs: 5_000, errorMessage: "503 unavailable" });
    const initial = f.binding.getAutomaticRetry()!;
    expect(initial).toMatchObject({ source: "agent", attempt: 1, maxAttempts: 10, delayMs: 5_000, remainingMs: 5_000 });
    vi.advanceTimersByTime(1_250);
    vi.setSystemTime(new Date("1990-01-01T00:00:00Z"));
    expect(f.binding.getAutomaticRetry()!.remainingMs).toBe(3_750);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    initial.remainingMs = 999;
    initial.errorMessage = "changed outside";
    expect(f.binding.getAutomaticRetry()).toMatchObject({ remainingMs: 3_750, errorMessage: "503 unavailable" });
    vi.advanceTimersByTime(20_000);
    expect(f.binding.getAutomaticRetry()!.remainingMs).toBe(0);
    f.emit({ type: "agent_start" });
    expect(f.binding.getAutomaticRetry()).toBeNull();
    expect(changed).toHaveBeenCalledTimes(2);
    f.binding.dispose();
  });

  it.each(["compaction", "branchSummary"] as const)("reports %s waits and clears them at the native attempt boundary", (source) => {
    const f = fixture();
    f.binding.beginSummary(source);
    f.emit({ type: "summarization_retry_scheduled", attempt: 6, maxAttempts: 10, delayMs: 120_000, errorMessage: "503" });
    expect(f.binding.getAutomaticRetry()).toMatchObject({ source, attempt: 6, delayMs: 120_000 });
    f.emit(source === "compaction"
      ? { type: "summarization_retry_attempt_start", source, reason: "manual" }
      : { type: "summarization_retry_attempt_start", source });
    expect(f.binding.getAutomaticRetry()).toBeNull();
    f.binding.dispose();
  });

  it("bounds diagnostic text and isolates throwing or detached observers", () => {
    const f = fixture();
    f.binding.subscribe(() => { throw new Error("display failure"); });
    const received = vi.fn();
    const unsubscribe = f.binding.subscribe(received);
    const long = "Provider unavailable: " + "x".repeat(MAX_LLM_RETRY_ERROR_CHARS * 2);
    expect(() => f.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 10, delayMs: 5_000, errorMessage: long })).not.toThrow();
    const error = f.binding.getAutomaticRetry()!.errorMessage;
    expect(error.length).toBeLessThanOrEqual(MAX_LLM_RETRY_ERROR_CHARS);
    expect(long.startsWith(error)).toBe(true);
    expect(received).toHaveBeenCalledTimes(1);
    unsubscribe();
    f.emit({ type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" });
    expect(f.binding.getAutomaticRetry()).toBeNull();
    expect(received).toHaveBeenCalledTimes(1);
    f.binding.dispose();
  });

  it("clears a branch failure's observational wait from its owner's finally", () => {
    const f = fixture();
    f.binding.beginSummary("branchSummary");
    f.emit({ type: "summarization_retry_scheduled", attempt: 2, maxAttempts: 10, delayMs: 10_000, errorMessage: "503" });
    f.binding.finishSummary();
    expect(f.binding.getAutomaticRetry()).toBeNull();
    f.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 10, delayMs: 5_000, errorMessage: "503" });
    f.binding.finishSummary();
    expect(f.binding.getAutomaticRetry()?.source).toBe("agent");
    f.binding.dispose();
  });
});

describe("retry binding ownership", () => {
  it("rejects duplicate attachment and active disposal, then restores the own descriptor", () => {
    const original = () => ({ enabled: false, maxRetries: 0, baseDelayMs: 0 });
    const settings: LlmRetrySettingsManager = {
      getRetrySettings: original,
      getGlobalSettings: () => ({}),
      getProjectSettings: () => ({}),
    };
    Object.defineProperty(settings, "getRetrySettings", { enumerable: false, configurable: false, writable: true });
    const descriptor = Object.getOwnPropertyDescriptor(settings, "getRetrySettings");
    const binding = createLlmRetryPolicyBinding(settings);
    const f = fixture();
    binding.attach(f.session);
    expect(() => binding.attach(f.session)).toThrow(/already attached/);
    f.setActive(true);
    expect(() => binding.dispose()).toThrow(/settle/);
    expect(settings.getRetrySettings).not.toBe(original);
    f.setActive(false);
    binding.dispose();
    expect(Object.getOwnPropertyDescriptor(settings, "getRetrySettings")).toEqual(descriptor);
    expect(() => binding.dispose()).not.toThrow();
    expect(() => binding.attach(f.session)).toThrow(/disposed/);
    f.binding.dispose();
  });

  it("does not overwrite a later method owner during disposal", () => {
    const f = fixture();
    const replacement = () => ({ enabled: false, maxRetries: 1, baseDelayMs: 1 });
    f.settings.getRetrySettings = replacement;
    f.binding.dispose();
    expect(f.settings.getRetrySettings).toBe(replacement);
  });
});
