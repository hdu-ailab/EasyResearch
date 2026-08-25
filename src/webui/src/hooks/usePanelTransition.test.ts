import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PANEL_TRANSITION_MS, usePanelTransition } from "./usePanelTransition";

describe("usePanelTransition", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays closed while open is false", () => {
    const { result } = renderHook(() => usePanelTransition(false));
    expect(result.current).toBe("closed");
  });

  it("starts open without an initial closed frame when open starts true", () => {
    const phases: string[] = [];
    const { result } = renderHook(() => {
      const phase = usePanelTransition(true);
      phases.push(phase);
      return phase;
    });
    expect(phases[0]).toBe("open");
    expect(result.current).toBe("open");
  });

  it("passes through closing and lands on closed after the panel duration", () => {
    const { result, rerender } = renderHook(({ open }: { open: boolean }) => usePanelTransition(open), {
      initialProps: { open: true },
    });
    expect(result.current).toBe("open");
    rerender({ open: false });
    expect(result.current).toBe("closing");
    act(() => vi.advanceTimersByTime(PANEL_TRANSITION_MS));
    expect(result.current).toBe("closed");
  });

  it("reopening during closing returns to open and cancels the close timer", () => {
    const { result, rerender } = renderHook(({ open }: { open: boolean }) => usePanelTransition(open), {
      initialProps: { open: true },
    });
    rerender({ open: false });
    expect(result.current).toBe("closing");
    rerender({ open: true });
    expect(result.current).toBe("open");
    act(() => vi.advanceTimersByTime(PANEL_TRANSITION_MS * 2));
    expect(result.current).toBe("open");
  });

  it("unmounting mid-close cancels the timer without errors", () => {
    const { result, rerender, unmount } = renderHook(({ open }: { open: boolean }) => usePanelTransition(open), {
      initialProps: { open: true },
    });
    rerender({ open: false });
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(PANEL_TRANSITION_MS));
    expect(result.current).toBe("closing");
  });
});
