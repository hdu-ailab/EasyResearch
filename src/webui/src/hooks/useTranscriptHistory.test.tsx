import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptPageDto } from "../../../web/contracts";
import { ApiError, getTranscriptPage } from "../api";
import { useTranscriptHistory } from "./useTranscriptHistory";

vi.mock("../api", async (original) => ({ ...(await original<typeof import("../api")>()), getTranscriptPage: vi.fn() }));
beforeEach(() => vi.mocked(getTranscriptPage).mockReset());

describe("history request ownership", () => {
  it("deduplicates requests and captures the scroll anchor only immediately before publication", async () => {
    const request = Promise.withResolvers<TranscriptPageDto>();
    vi.mocked(getTranscriptPage).mockReturnValue(request.promise);
    const order: string[] = [];
    const { result } = renderHook(() =>
      useTranscriptHistory({
        sessionId: "root",
        cursor: "older",
        hydrationRevision: 1,
        disabled: false,
        publish: () => order.push("publish"),
        refresh() {},
      }),
    );
    let loading!: Promise<void>;
    act(() => {
      loading = result.current.loadOlder(() => order.push("anchor"));
    });
    await act(() => result.current.loadOlder());
    expect(getTranscriptPage).toHaveBeenCalledTimes(1);
    expect(result.current.loading).toBe(true);
    expect(order).toEqual([]);
    await act(async () => {
      request.resolve({ timeline: [] });
      await loading;
    });
    expect(order).toEqual(["anchor", "publish"]);
    expect(result.current.loading).toBe(false);
  });

  it.each(["rehydrate", "child", "delete"])("discards late pages after %s", async (change) => {
    const request = Promise.withResolvers<TranscriptPageDto>();
    vi.mocked(getTranscriptPage).mockReturnValue(request.promise);
    const published: TranscriptPageDto[] = [];
    const { result, rerender } = renderHook(
      (props: { childId?: string; hydrationRevision: number; disabled: boolean }) =>
        useTranscriptHistory({
          sessionId: "root",
          cursor: "older",
          ...props,
          publish: (page) => published.push(page),
          refresh() {},
        }),
      { initialProps: { childId: undefined as string | undefined, hydrationRevision: 1, disabled: false } },
    );
    let loading!: Promise<void>;
    act(() => {
      loading = result.current.loadOlder();
    });
    const signal = vi.mocked(getTranscriptPage).mock.calls[0]![3]!;
    rerender({
      childId: change === "child" ? "child" : undefined,
      hydrationRevision: change === "rehydrate" ? 2 : 1,
      disabled: change === "delete",
    });
    expect(signal.aborted).toBe(true);
    await act(async () => {
      request.resolve({ timeline: [] });
      await loading;
    });
    expect(published).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it("resynchronizes a changed branch and allows retry after a transient HTTP failure", async () => {
    let refreshed = 0;
    let published = 0;
    vi.mocked(getTranscriptPage)
      .mockRejectedValueOnce(new ApiError(409, { code: "HISTORY_CHANGED" }))
      .mockRejectedValueOnce(new Error("temporary network failure"))
      .mockResolvedValue({ timeline: [] });
    const { result } = renderHook(() =>
      useTranscriptHistory({
        sessionId: "root",
        childId: "child",
        cursor: "older",
        hydrationRevision: 1,
        disabled: false,
        publish: () => published++,
        refresh: () => refreshed++,
      }),
    );
    await act(() => result.current.loadOlder());
    expect(refreshed).toBe(1);
    await act(() => result.current.loadOlder());
    expect(result.current.error).toBe(true);
    await act(() => result.current.loadOlder());
    expect(result.current.error).toBe(false);
    expect(published).toBe(1);
  });
});
