import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LlmRecoveryDto } from "../../../web/contracts";
import * as api from "../api";
import { ViewActivityProvider } from "../view-activity";
import { useLlmRecovery } from "./useLlmRecovery";

vi.mock("../api", async (original) => ({ ...(await original<typeof import("../api")>()), retryModelRequest: vi.fn() }));

function deferred() {
  let resolve!: (value: { accepted: true; targetSessionId: string; failureId: string }) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<{ accepted: true; targetSessionId: string; failureId: string }>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const recovery = (targetSessionId = "root", failureId = "f1"): LlmRecoveryDto => ({
  targetSessionId,
  failureId,
  failedEntryId: `entry-${failureId}`,
  status: "available",
});
const options = () => ({
  rootId: "root",
  targetSessionId: "root",
  parentHydrationRevision: 1,
  hydrationRevision: 1,
  recovery: recovery() as LlmRecoveryDto | null,
  enabled: true,
  refresh: vi.fn(),
});

beforeEach(() => {
  vi.mocked(api.retryModelRequest).mockReset();
});
afterEach(() => vi.restoreAllMocks());

it("claims synchronously and stays single-flight after HTTP acceptance until server state changes", async () => {
  const request = deferred();
  vi.mocked(api.retryModelRequest).mockReturnValue(request.promise);
  const { result } = renderHook(useLlmRecovery, { initialProps: options() });
  let first!: Promise<void>;
  act(() => {
    first = result.current.retry();
    void result.current.retry();
    void result.current.retry();
  });
  expect(api.retryModelRequest).toHaveBeenCalledOnce();
  expect(result.current.busy).toBe(true);
  await act(async () => {
    request.resolve({ accepted: true, targetSessionId: "root", failureId: "f1" });
    await first;
  });
  await act(() => result.current.retry());
  expect(api.retryModelRequest).toHaveBeenCalledOnce();
  expect(result.current.busy).toBe(true);
});

it.each(["success", "failure"])("admits a fresh repeated failure and ignores an older late %s", async (outcome) => {
  const old = deferred();
  const fresh = deferred();
  vi.mocked(api.retryModelRequest).mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  const initial = options();
  const { result, rerender } = renderHook(useLlmRecovery, { initialProps: initial });
  let first!: Promise<void>;
  act(() => {
    first = result.current.retry();
  });
  const oldSignal = vi.mocked(api.retryModelRequest).mock.calls[0]?.[2];
  const oldClick = result.current.retry;
  rerender({ ...initial, recovery: recovery("root", "f2") });
  expect(oldSignal?.aborted).toBe(true);
  expect(result.current.busy).toBe(false);
  await act(oldClick);
  expect(api.retryModelRequest).toHaveBeenCalledOnce();
  act(() => {
    void result.current.retry();
  });
  expect(api.retryModelRequest).toHaveBeenCalledTimes(2);
  expect(vi.mocked(api.retryModelRequest).mock.calls[1]?.[1]).toEqual({ targetSessionId: "root", failureId: "f2" });
  await act(async () => {
    if (outcome === "success") old.resolve({ accepted: true, targetSessionId: "root", failureId: "f1" });
    else old.reject(new api.ApiError(409, { code: "LLM_RETRY_STALE", error: "old" }));
    await first;
  });
  expect(result.current.busy).toBe(true);
  expect(result.current.error).toBeNull();
  expect(initial.refresh).not.toHaveBeenCalled();
});

it.each(["target", "root", "hydration", "disabled"])(
  "fences a pending view request on %s replacement",
  async (change) => {
    const old = deferred();
    vi.mocked(api.retryModelRequest).mockReturnValue(old.promise);
    const initial = options();
    const { result, rerender, unmount } = renderHook(useLlmRecovery, { initialProps: initial });
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.retry();
    });
    const signal = vi.mocked(api.retryModelRequest).mock.calls[0]?.[2];
    rerender({
      ...initial,
      ...(change === "target" ? { targetSessionId: "nested", recovery: recovery("nested") } : {}),
      ...(change === "root" ? { rootId: "other" } : {}),
      ...(change === "hydration" ? { hydrationRevision: 2 } : {}),
      ...(change === "disabled" ? { enabled: false } : {}),
    });
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      old.reject(new Error("late error"));
      await pending;
    });
    expect(result.current.error).toBeNull();
    expect(result.current.busy).toBe(false);
    unmount();
  },
);

it("reconciles stale admission once without resubmitting and accepts the fresh snapshot checkpoint", async () => {
  vi.mocked(api.retryModelRequest).mockRejectedValueOnce(
    new api.ApiError(409, { code: "LLM_RETRY_STALE", error: "expired" }),
  );
  const initial = options();
  const { result, rerender } = renderHook(useLlmRecovery, { initialProps: initial });
  await act(() => result.current.retry());
  expect(initial.refresh).toHaveBeenCalledOnce();
  expect(api.retryModelRequest).toHaveBeenCalledOnce();
  expect(result.current.error).toBe("expired");
  rerender({ ...initial, hydrationRevision: 2, recovery: recovery("root", "fresh") });
  expect(result.current.error).toBeNull();
  expect(result.current.busy).toBe(false);
});

it("rejects starting/historical authority and aborts only the view request on disposal", () => {
  const initial = options();
  const request = deferred();
  vi.mocked(api.retryModelRequest).mockReturnValue(request.promise);
  const { result, rerender, unmount } = renderHook(useLlmRecovery, {
    initialProps: { ...initial, recovery: null as LlmRecoveryDto | null },
  });
  act(() => {
    void result.current.retry();
  });
  rerender({ ...initial, recovery: { ...recovery(), status: "starting" } });
  act(() => {
    void result.current.retry();
  });
  expect(api.retryModelRequest).not.toHaveBeenCalled();
  rerender(initial);
  act(() => {
    void result.current.retry();
  });
  const signal = vi.mocked(api.retryModelRequest).mock.calls[0]?.[2];
  unmount();
  expect(signal?.aborted).toBe(true);
});

it("hiding a retained root cancels HTTP ownership and leaves sibling retry admission independent", () => {
  const request = deferred();
  vi.mocked(api.retryModelRequest).mockReturnValue(request.promise);
  const initial = options();
  let visible = true;
  const { result, rerender } = renderHook(() => useLlmRecovery(initial), {
    wrapper: ({ children }) => (
      <ViewActivityProvider visible={visible} interactive={visible}>
        {children}
      </ViewActivityProvider>
    ),
  });
  act(() => {
    void result.current.retry();
  });
  const rootSignal = vi.mocked(api.retryModelRequest).mock.calls[0]?.[2];
  // Independent owners do not share a module-global lock.
  const sibling = renderHook(useLlmRecovery, {
    initialProps: { ...options(), targetSessionId: "sibling", recovery: recovery("sibling") },
  });
  act(() => {
    void sibling.result.current.retry();
  });
  expect(api.retryModelRequest).toHaveBeenCalledTimes(2);
  const siblingSignal = vi.mocked(api.retryModelRequest).mock.calls[1]?.[2];
  visible = false;
  rerender();
  expect(rootSignal?.aborted).toBe(true);
  expect(siblingSignal?.aborted).toBe(false);
});
