// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXPAND_TRANSITION_MS, useExpandable } from "./useExpandable";

describe("useExpandable", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays unmounted while open is false", () => {
    const { result } = renderHook(() => useExpandable(false));
    expect(result.current.mounted).toBe(false);
  });

  it("mounts in the enter phase when open starts true", () => {
    const { result } = renderHook(() => useExpandable(true));
    expect(result.current).toEqual({ mounted: true, phase: "enter" });
  });

  it("mounts on open and switches to exit on close, unmounting after the duration", () => {
    const { result, rerender } = renderHook(({ open }: { open: boolean }) => useExpandable(open), {
      initialProps: { open: false },
    });
    rerender({ open: true });
    expect(result.current).toEqual({ mounted: true, phase: "enter" });
    rerender({ open: false });
    expect(result.current).toEqual({ mounted: true, phase: "exit" });
    act(() => vi.advanceTimersByTime(EXPAND_TRANSITION_MS));
    expect(result.current.mounted).toBe(false);
  });

  it("reopening during the exit phase cancels the unmount timer", () => {
    const { result, rerender } = renderHook(({ open }: { open: boolean }) => useExpandable(open), {
      initialProps: { open: true },
    });
    rerender({ open: false });
    expect(result.current.phase).toBe("exit");
    rerender({ open: true });
    expect(result.current.phase).toBe("enter");
    act(() => vi.advanceTimersByTime(EXPAND_TRANSITION_MS * 2));
    expect(result.current.mounted).toBe(true);
  });
});