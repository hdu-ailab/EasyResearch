import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutomaticRetryDto, LlmRecoveryDto, SessionSnapshotDto } from "../../../web/contracts";
import { ApiError, llmRetryConflict, retryModelRequest } from "../api";
import { fromSnapshot, mergeSnapshot, reduceSessionEvent } from "../session-reducer";
import { parseChildSnapshot, parseLlmRetryState, parseSessionSnapshot, parseSubagentSupervisorEvent } from "./parsers";

const recovery: LlmRecoveryDto = {
  targetSessionId: "root",
  failureId: "failure-a",
  failedEntryId: "failed-entry",
  status: "available",
};
const automaticRetry: AutomaticRetryDto = {
  source: "agent",
  attempt: 6,
  maxAttempts: 10,
  delayMs: 120_000,
  remainingMs: 2300,
  errorMessage: "provider unavailable",
};
const snapshot: SessionSnapshotDto = {
  session: { id: "root", cwd: "/fixture", status: "ready", isStreaming: false },
  runtimeConfigurationGeneration: 1,
  compactionPolicy: { triggerPercent: 70, enabled: true },
  timeline: [],
  subagents: [],
  automaticRetry,
  llmRecovery: recovery,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("model retry API", () => {
  it("sends only the target and failure to the root control route, with view cancellation", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(Response.json({ accepted: true, targetSessionId: "child", failureId: "f" }, { status: 202 }));
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    await retryModelRequest(
      "root /中",
      { targetSessionId: "child", failureId: "f", message: "never send" } as never,
      controller.signal,
    );
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]).toEqual([
      "/api/sessions/root%20%2F%E4%B8%AD/retry",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetSessionId: "child", failureId: "f" }),
        signal: controller.signal,
      },
    ]);
  });

  it.each([404, 409, 503])("does not retry POST or reopen/resend on HTTP %s", async (status) => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ code: "LLM_RETRY_STALE", error: "expired" }, { status }));
    vi.stubGlobal("fetch", fetch);
    await expect(retryModelRequest("root", recovery)).rejects.toMatchObject({ status });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects an acknowledgment for another target or failure", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(Response.json({ accepted: true, targetSessionId: "other", failureId: "f" }));
    vi.stubGlobal("fetch", fetch);
    await expect(retryModelRequest("root", recovery)).rejects.toMatchObject({ status: 502 });
  });

  it("requires an explicit acceptance body even for a successful empty response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(retryModelRequest("root", recovery)).rejects.toMatchObject({ status: 502 });
  });

  it("recognizes only typed retry admission conflicts", () => {
    for (const code of ["LLM_RETRY_STALE", "LLM_RETRY_BUSY", "LLM_RETRY_UNAVAILABLE"] as const) {
      expect(llmRetryConflict(new ApiError(409, { code }))).toBe(code);
      expect(llmRetryConflict(new ApiError(503, { code }))).toBeNull();
    }
    expect(llmRetryConflict(new Error("LLM_RETRY_STALE"))).toBeNull();
    expect(llmRetryConflict(new ApiError(409, { code: "SESSION_BUSY" }))).toBeNull();
  });
});

describe("authoritative retry state", () => {
  it("hydrates remaining time and fully replaces recovery on reconnect", () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const view = fromSnapshot(parseSessionSnapshot(snapshot));
    expect(view.retry?.endsAt).toBe(3300);
    expect(view.llmRecovery).toEqual(recovery);
    const refreshed = mergeSnapshot(
      view,
      parseSessionSnapshot({ ...snapshot, automaticRetry: null, llmRecovery: null }),
    );
    expect(refreshed.retry).toBeNull();
    expect(refreshed.llmRecovery).toBeNull();
    const { automaticRetry: _retry, llmRecovery: _recovery, ...historical } = snapshot;
    expect(mergeSnapshot(view, parseSessionSnapshot(historical)).llmRecovery).toBeNull();
  });

  it.each(["agent", "compaction", "branchSummary"] as const)(
    "hydrates %s from child snapshots and full replacement events",
    (source) => {
      const state = { automaticRetry: { ...automaticRetry, source }, llmRecovery: recovery };
      expect(
        parseChildSnapshot({ session: { id: "root", cwd: "/fixture" }, timeline: [], subagents: [], ...state }),
      ).toMatchObject(state);
      const event = parseLlmRetryState({ type: "llm_retry_state", targetSessionId: "root", ...state });
      const view = reduceSessionEvent(fromSnapshot(snapshot), event);
      expect(view.retry?.source).toBe(source);
      expect(view.llmRecovery).toEqual(recovery);
    },
  );

  it.each([
    { attempt: 0 },
    { attempt: 11 },
    { maxAttempts: 0 },
    { delayMs: -1 },
    { remainingMs: -1 },
    { remainingMs: 120001 },
    { remainingMs: Number.POSITIVE_INFINITY },
    { attempt: 1.5 },
    { source: "tool" },
    { errorMessage: 4 },
  ])("rejects malformed backoff %j", (patch) => {
    expect(() => parseSessionSnapshot({ ...snapshot, automaticRetry: { ...automaticRetry, ...patch } })).toThrow();
  });

  it.each([{ failureId: "" }, { failedEntryId: " " }, { targetSessionId: "foreign" }, { status: "failed" }])(
    "rejects malformed recovery %j for root and child",
    (patch) => {
      expect(() => parseSessionSnapshot({ ...snapshot, llmRecovery: { ...recovery, ...patch } })).toThrow();
      expect(() => parseChildSnapshot({ ...snapshot, llmRecovery: { ...recovery, ...patch } })).toThrow();
    },
  );

  it("requires both replacement fields and fences nested events to their child", () => {
    expect(() =>
      parseLlmRetryState({ type: "llm_retry_state", targetSessionId: "root", llmRecovery: recovery }),
    ).toThrow();
    const envelope = {
      type: "subagent_supervisor",
      ownerSessionId: "ancestor",
      toolCallId: "launch",
      launchId: "launch-id",
      agent: "custom",
      agentId: "custom_0",
      childSessionId: "root",
      status: "working",
      event: { type: "llm_retry_state", targetSessionId: "root", automaticRetry: null, llmRecovery: recovery },
    };
    expect(parseSubagentSupervisorEvent(envelope).event).toEqual(envelope.event);
    expect(() => parseSubagentSupervisorEvent({ ...envelope, childSessionId: "foreign" })).toThrow();
  });

  it("keeps summary backoff and manual authority independent of native Agent settlement", () => {
    const view = fromSnapshot({ ...snapshot, automaticRetry: { ...automaticRetry, source: "compaction" } });
    const settled = reduceSessionEvent(view, { type: "agent_settled" } as never);
    expect(settled.retry).toBe(view.retry);
    expect(settled.llmRecovery).toBe(view.llmRecovery);
    const ended = reduceSessionEvent(settled, { type: "auto_retry_end", success: false, attempt: 1 } as never);
    expect(ended.retry).toBe(view.retry);
    const cleared = reduceSessionEvent(
      ended,
      parseLlmRetryState({
        type: "llm_retry_state",
        targetSessionId: "root",
        automaticRetry: null,
        llmRecovery: null,
      }),
    );
    expect(cleared.retry).toBeNull();
    expect(cleared.llmRecovery).toBeNull();
  });

  it("keeps a paused launch discoverable outside the bounded transcript without making historical failures actionable", () => {
    const child = {
      ownerSessionId: "root",
      toolCallId: "old-launch",
      childSessionId: "child",
      agent: "custom",
      status: "working",
      llmRecovery: { ...recovery, targetSessionId: "child" },
    };
    const view = fromSnapshot(parseSessionSnapshot({ ...snapshot, llmRecovery: null, subagents: [child] }));
    expect(view.tools).toEqual([
      expect.objectContaining({ toolCallId: "old-launch", running: true, done: false, llmRecovery: child.llmRecovery }),
    ]);
    const historical = fromSnapshot(
      parseSessionSnapshot({
        ...snapshot,
        llmRecovery: null,
        subagents: [{ ...child, status: "error", llmRecovery: null }],
      }),
    );
    expect(historical.tools).toEqual([]);
    expect(historical.llmRecovery).toBeNull();
  });
});
