import { describe, expect, it, vi } from "vitest";
import { LlmRecoveryController, type LlmRecoveryAdmission } from "./llm-recovery";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(preflight: (signal: AbortSignal) => Promise<LlmRecoveryAdmission> = async () => ({ release() {} })) {
  const listeners = new Set<(event: unknown) => void>();
  const entries: unknown[] = [];
  const session = {
    sessionId: "native-session", isIdle: true, isStreaming: false,
    sessionManager: { getBranch: () => entries },
    subscribe(listener: (event: unknown) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    sendCustomMessage: vi.fn(async () => {}),
  };
  const recovery = new LlmRecoveryController();
  recovery.attach(session, { getAutomaticRetry: () => null, subscribe: () => () => {} }, preflight);
  const emit = (event: unknown) => { for (const listener of listeners) listener(event); };
  const start = () => { session.isIdle = false; session.isStreaming = true; emit({ type: "agent_start" }); };
  const finish = (message: unknown, requestObserved = true) => {
    if (requestObserved) recovery.observeRequest();
    emit({ type: "message_end", message });
    entries.push({ type: "message", id: `entry-${entries.length}`, message });
    session.isIdle = true;
    session.isStreaming = false;
    emit({ type: "agent_settled" });
  };
  const fail = () => {
    start();
    finish({ role: "assistant", stopReason: "error", errorMessage: "503 overloaded", timestamp: 1 });
    return recovery.state().llmRecovery!;
  };
  return { session, recovery, listeners, entries, emit, start, finish, fail };
}

describe("owned LLM failure checkpoints", () => {
  it("claims before async preflight and rotates authority after a rejected admission", async () => {
    const gate = deferred<void>();
    const f = fixture(async () => { await gate.promise; throw new Error("configuration unavailable"); });
    const original = f.fail();
    const first = f.recovery.retry(original.failureId);
    const rejected = expect(first).rejects.toThrow("configuration unavailable");
    expect(f.recovery.state().llmRecovery?.status).toBe("starting");
    expect(() => f.recovery.retry(original.failureId)).toThrow(expect.objectContaining({ code: "LLM_RETRY_BUSY" }));
    gate.resolve();
    await rejected;
    await f.recovery.settleOperations();
    expect(f.recovery.state().llmRecovery).toMatchObject({ status: "available", failedEntryId: original.failedEntryId });
    expect(f.recovery.state().llmRecovery?.failureId).not.toBe(original.failureId);
    expect(() => f.recovery.retry(original.failureId)).toThrow(expect.objectContaining({ code: "LLM_RETRY_STALE" }));
    expect(f.session.sendCustomMessage).not.toHaveBeenCalled();
    f.recovery.dispose();
    expect(f.listeners.size).toBe(0);
  });

  it("cancels a claimed checkpoint before waiting for preflight and never wakes later", async () => {
    const gate = deferred<void>();
    const release = vi.fn();
    const f = fixture(async () => { await gate.promise; return { release }; });
    const checkpoint = f.fail();
    const first = f.recovery.retry(checkpoint.failureId);
    const rejection = expect(first).rejects.toMatchObject({ code: "LLM_RETRY_UNAVAILABLE" });
    f.recovery.cancel();
    expect(f.recovery.state().llmRecovery).toBeNull();
    expect(f.recovery.hasWork()).toBe(true);
    gate.resolve();
    await rejection;
    await f.recovery.settleOperations();
    expect(release).toHaveBeenCalledOnce();
    expect(f.session.sendCustomMessage).not.toHaveBeenCalled();
    expect(f.recovery.hasWork()).toBe(false);
    f.recovery.dispose();
  });

  it("keeps the complete accepted managed wake owned after admission", async () => {
    const gate = deferred<void>();
    const f = fixture();
    f.session.sendCustomMessage.mockImplementation(() => gate.promise);
    const checkpoint = f.fail();
    await f.recovery.retry(checkpoint.failureId);
    expect(f.recovery.state().llmRecovery).toBeNull();
    expect(f.recovery.hasWork()).toBe(true);
    f.recovery.cancel();
    expect(() => f.recovery.dispose()).toThrow(/settlement/);
    gate.resolve();
    await f.recovery.settleOperations();
    f.recovery.dispose();
  });

  it("does not let obsolete preflight completion consume a newer run's failure", async () => {
    const gate = deferred<void>();
    const f = fixture(async () => { await gate.promise; return { release() {} }; });
    const old = f.fail();
    const starting = f.recovery.retry(old.failureId);
    const rejected = expect(starting).rejects.toMatchObject({ code: "LLM_RETRY_STALE" });
    const current = f.fail();
    gate.resolve();
    await rejected;
    await f.recovery.settleOperations();
    expect(f.recovery.state().llmRecovery).toEqual(current);
    expect(f.session.sendCustomMessage).not.toHaveBeenCalled();
    f.recovery.dispose();
  });

  it("validates persisted entry identity on the selected branch rather than timestamps", () => {
    const f = fixture();
    const checkpoint = f.fail();
    f.entries.splice(0, 1, { type: "message", id: "other-branch", message: {
      role: "assistant", stopReason: "error", errorMessage: "503 overloaded", timestamp: 1,
    } });
    expect(() => f.recovery.retry(checkpoint.failureId)).toThrow(expect.objectContaining({ code: "LLM_RETRY_STALE" }));
    expect(f.session.sendCustomMessage).not.toHaveBeenCalled();
    f.recovery.dispose();
  });

  it.each(["tool", "setup", "configuration", "stop", "summary"])("does not advertise %s failures as recoverable model requests", (kind) => {
    const f = fixture();
    f.start();
    if (kind === "configuration") f.recovery.blockCurrentRun();
    if (kind === "stop") f.recovery.cancel();
    if (kind === "summary") f.emit({ type: "compaction_end", errorMessage: "503 overloaded", aborted: false, willRetry: false });
    f.finish(kind === "tool"
      ? { role: "toolResult", toolName: "write", isError: true, content: "EACCES permission denied" }
      : { role: "assistant", stopReason: kind === "summary" ? "stop" : "error", errorMessage: "failed" }, kind !== "setup");
    expect(f.recovery.state().llmRecovery).toBeNull();
    f.recovery.dispose();
  });

  it("does not re-authorize an old error on repeated settlement or historical attachment", () => {
    const f = fixture();
    const original = f.fail();
    f.emit({ type: "agent_settled" });
    expect(f.recovery.state().llmRecovery).toEqual(original);
    f.recovery.dispose();
    const reopened = fixture();
    reopened.entries.push(...f.entries);
    reopened.emit({ type: "agent_settled" });
    expect(reopened.recovery.state().llmRecovery).toBeNull();
    reopened.recovery.dispose();
  });
});
