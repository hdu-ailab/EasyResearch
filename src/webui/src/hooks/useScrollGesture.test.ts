import { act, renderHook } from "@testing-library/react";
import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useScrollGesture } from "./useScrollGesture";

function makeRoot() {
  const el = document.createElement("div");
  el.setAttribute("data-scrollable", "");
  return el;
}

function nestedScroller(overrides: Partial<{ scrollTop: number; scrollHeight: number; clientHeight: number }> = {}) {
  const el = document.createElement("div");
  el.setAttribute("data-scrollable", "");
  Object.defineProperty(el, "scrollTop", { configurable: true, value: overrides.scrollTop ?? 0 });
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: overrides.scrollHeight ?? 600 });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: overrides.clientHeight ?? 200 });
  return el;
}

function attach(root: HTMLElement, child: HTMLElement) {
  root.appendChild(child);
  return child;
}

let now = 1_000_000;

beforeEach(() => {
  now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});

describe("useScrollGesture", () => {
  it("arms on a target inside the root", () => {
    const root = makeRoot();
    const ref = createRef<HTMLDivElement>();
    ref.current = root;
    const { result } = renderHook(() => useScrollGesture(ref));

    act(() => result.current.markScrollGesture(root));
    expect(result.current.hasScrollGesture()).toBe(true);

    now += 300;
    expect(result.current.hasScrollGesture()).toBe(false);
  });

  it("ignores targets inside a nested data-scrollable region", () => {
    const root = makeRoot();
    const ref = createRef<HTMLDivElement>();
    ref.current = root;
    const nested = attach(root, nestedScroller());
    const { result } = renderHook(() => useScrollGesture(ref));

    act(() => result.current.markScrollGesture(nested));
    expect(result.current.hasScrollGesture()).toBe(false);
  });

  it("arms a wheel gesture over the root itself regardless of delta", () => {
    const root = makeRoot();
    const ref = createRef<HTMLDivElement>();
    ref.current = root;
    const { result } = renderHook(() => useScrollGesture(ref));

    act(() => result.current.markBoundaryWheel(root, -20));
    expect(result.current.hasScrollGesture()).toBe(true);
  });

  it("arms a wheel gesture over a nested scroller only when it hits the boundary", () => {
    const root = makeRoot();
    const ref = createRef<HTMLDivElement>();
    ref.current = root;
    // Nested at scrollTop 100, max scroll 400. A small upward delta does not
    // reach the top boundary, so it must not arm.
    const nested = attach(root, nestedScroller({ scrollTop: 100 }));
    const { result } = renderHook(() => useScrollGesture(ref));

    act(() => result.current.markBoundaryWheel(nested, -20));
    expect(result.current.hasScrollGesture()).toBe(false);

    // A delta that reaches the top boundary arms the outer gesture.
    act(() => result.current.markBoundaryWheel(nested, -200));
    expect(result.current.hasScrollGesture()).toBe(true);
  });

  it("arms a wheel gesture over a nested scroller at the bottom boundary", () => {
    const root = makeRoot();
    const ref = createRef<HTMLDivElement>();
    ref.current = root;
    const nested = attach(root, nestedScroller({ scrollTop: 380 }));
    const { result } = renderHook(() => useScrollGesture(ref));

    act(() => result.current.markBoundaryWheel(nested, 40));
    expect(result.current.hasScrollGesture()).toBe(true);
  });

  it("does not arm for a nested wheel gesture that stays inside the nested range", () => {
    const root = makeRoot();
    const ref = createRef<HTMLDivElement>();
    ref.current = root;
    const nested = attach(root, nestedScroller({ scrollTop: 100 }));
    const { result } = renderHook(() => useScrollGesture(ref));

    act(() => result.current.markBoundaryWheel(nested, 40));
    expect(result.current.hasScrollGesture()).toBe(false);
  });

  it("re-arms on a fresh gesture inside the window", () => {
    const root = makeRoot();
    const ref = createRef<HTMLDivElement>();
    ref.current = root;
    const { result } = renderHook(() => useScrollGesture(ref));

    act(() => result.current.markScrollGesture(root));
    now += 100;
    act(() => result.current.markScrollGesture(root));
    now += 200;
    expect(result.current.hasScrollGesture()).toBe(true);
    now += 100;
    expect(result.current.hasScrollGesture()).toBe(false);
  });
});
