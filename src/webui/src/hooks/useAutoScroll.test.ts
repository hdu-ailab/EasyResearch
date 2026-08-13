import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoScroll } from "./useAutoScroll";

let notifyResize: ResizeObserverCallback;
let resizeObserver: ResizeObserverStub;

class ResizeObserverStub {
  constructor(callback: ResizeObserverCallback) {
    notifyResize = callback;
    resizeObserver = this;
  }

  observe = vi.fn();

  unobserve = vi.fn();
  disconnect = vi.fn();
}

// Models a scroll container with clientHeight 200 and a configurable maximum
// scroll position (scrollHeight = bottom + clientHeight). Calling "bottom"
// is the true pinned offset.
let bottom = 400;

function makeElement(): HTMLDivElement {
  const el = document.createElement("div");
  const state: Record<string, number> = { scrollTop: 0 };
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => state.scrollTop,
    set: (value: number) => {
      // Browsers clamp scrollTop to [0, scrollHeight - clientHeight].
      const max = bottom;
      state.scrollTop = Math.max(0, Math.min(value, max));
    },
  });
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () => bottom + 200,
  });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 200 });
  return el as HTMLDivElement & { __state: typeof state };
}

function fireContentResize() {
  act(() => {
    notifyResize([], resizeObserver as unknown as ResizeObserver);
  });
}

function setScrollTop(el: HTMLElement, value: number) {
  el.scrollTop = value;
}

function growContentTo(newBottom: number) {
  bottom = newBottom;
}

let selectionSpy: ReturnType<typeof vi.spyOn>;
let selectionText = "";

beforeEach(() => {
  bottom = 400;
  selectionSpy = vi.spyOn(window, "getSelection").mockReturnValue({
    toString: () => selectionText,
  } as unknown as Selection);
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

afterEach(() => {
  selectionText = "";
  selectionSpy?.mockRestore();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useAutoScroll", () => {
  it("starts pinned with userScrolled false", () => {
    const { result } = renderHook(() => useAutoScroll({ working: false }));
    expect(result.current.userScrolled()).toBe(false);
  });

  it("pins without scrolling when already at the bottom (distance < 2)", () => {
    const { result } = renderHook(() => useAutoScroll({ working: false }));
    const el = makeElement();
    setScrollTop(el, 400);
    const scrollTo = vi.fn();
    Object.defineProperty(el, "scrollTo", { configurable: true, value: scrollTo });
    act(() => result.current.scrollRef(el));

    act(() => result.current.scrollToBottom(true));
    expect(result.current.userScrolled()).toBe(false);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("scrolls to bottom on forceScrollToBottom from a scrolled-away position", () => {
    const { result } = renderHook(() => useAutoScroll({ working: false }));
    const el = makeElement();
    setScrollTop(el, 100);
    act(() => result.current.scrollRef(el));

    act(() => result.current.scrollToBottom(true));
    expect(el.scrollTop).toBe(400);
    expect(result.current.userScrolled()).toBe(false);
  });

  it("pauses on upward wheel and resumes on resume()", () => {
    const onUserInteracted = vi.fn();
    const { result } = renderHook(() => useAutoScroll({ working: false, onUserInteracted }));
    const el = makeElement();
    setScrollTop(el, 400);
    act(() => result.current.scrollRef(el));

    act(() => result.current.handleWheel({ deltaY: -10, target: el } as unknown as WheelEvent));
    expect(result.current.userScrolled()).toBe(true);
    expect(onUserInteracted).toHaveBeenCalledOnce();

    act(() => result.current.resume());
    expect(result.current.userScrolled()).toBe(false);
  });

  it("ignores upward wheels inside a nested data-scrollable region", () => {
    const { result } = renderHook(() => useAutoScroll({ working: false }));
    const el = makeElement();
    act(() => result.current.scrollRef(el));

    const nested = document.createElement("div");
    nested.setAttribute("data-scrollable", "");
    el.appendChild(nested);
    act(() => result.current.handleWheel({ deltaY: -10, target: nested } as unknown as WheelEvent));
    expect(result.current.userScrolled()).toBe(false);
  });

  it("ignores downward wheels entirely", () => {
    const { result } = renderHook(() => useAutoScroll({ working: false }));
    const el = makeElement();
    act(() => result.current.scrollRef(el));

    act(() => result.current.handleWheel({ deltaY: 10, target: el } as unknown as WheelEvent));
    expect(result.current.userScrolled()).toBe(false);
  });

  it("re-pins when the user returns within the bottom threshold", () => {
    const { result } = renderHook(() => useAutoScroll({ working: false }));
    const el = makeElement();
    setScrollTop(el, 400);
    act(() => result.current.scrollRef(el));

    act(() => result.current.handleScroll());
    expect(result.current.userScrolled()).toBe(false);

    setScrollTop(el, 100);
    act(() => result.current.handleScroll());
    expect(result.current.userScrolled()).toBe(true);

    setScrollTop(el, 395);
    act(() => result.current.handleScroll());
    expect(result.current.userScrolled()).toBe(false);

    setScrollTop(el, 300);
    act(() => result.current.handleScroll());
    expect(result.current.userScrolled()).toBe(true);
  });

  it("keeps following a same-frame resize while pinned, never unpinning", () => {
    const { result } = renderHook(() => useAutoScroll({ working: false }));
    const el = makeElement();
    setScrollTop(el, 400);
    act(() => result.current.scrollRef(el));
    act(() => result.current.contentRef(document.createElement("div")));

    growContentTo(700);
    fireContentResize();
    expect(el.scrollTop).toBe(700);
    expect(result.current.userScrolled()).toBe(false);
  });

  it("preserves the reading position when content grows while unpinned", () => {
    const { result } = renderHook(() => useAutoScroll({ working: false }));
    const el = makeElement();
    setScrollTop(el, 100);
    act(() => result.current.scrollRef(el));
    act(() => result.current.contentRef(document.createElement("div")));

    act(() => result.current.handleScroll());
    expect(result.current.userScrolled()).toBe(true);

    growContentTo(700);
    fireContentResize();
    expect(el.scrollTop).toBe(100);
    expect(result.current.userScrolled()).toBe(true);
  });

  it("un-pins on text selection inside the transcript while working", () => {
    const { result } = renderHook(() => useAutoScroll({ working: true }));
    const el = makeElement();
    setScrollTop(el, 400);
    act(() => result.current.scrollRef(el));
    selectionText = "selected copy";
    act(() => result.current.handleInteraction());
    expect(result.current.userScrolled()).toBe(true);
  });

  it("does not un-pin from selection while not working (after settling)", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useAutoScroll({ working: false }));
    const el = makeElement();
    setScrollTop(el, 400);
    act(() => result.current.scrollRef(el));
    act(() => vi.advanceTimersByTime(400));
    selectionText = "selected copy";
    act(() => result.current.handleInteraction());
    expect(result.current.userScrolled()).toBe(false);
  });

  it("forces to bottom when working begins", () => {
    const { result, rerender } = renderHook(({ active }: { active: boolean }) => useAutoScroll({ working: active }), {
      initialProps: { active: false },
    });
    const el = makeElement();
    setScrollTop(el, 200);
    act(() => result.current.scrollRef(el));

    act(() => rerender({ active: true }));
    expect(el.scrollTop).toBe(400);
  });

  it("keeps active during the settling window after work ends", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ active }: { active: boolean }) => useAutoScroll({ working: active }), {
      initialProps: { active: true },
    });
    const el = makeElement();
    setScrollTop(el, 400);
    act(() => result.current.scrollRef(el));

    act(() => rerender({ active: false }));
    // settling window still allows a forced follow
    act(() => result.current.forceScrollToBottom());
    expect(result.current.userScrolled()).toBe(false);

    act(() => vi.advanceTimersByTime(400));
    setScrollTop(el, 200);
    act(() => result.current.forceScrollToBottom());
    expect(el.scrollTop).toBe(400);
  });

  it("switches overflowAnchor to auto once the user scrolls away (dynamic mode)", () => {
    const { result } = renderHook(() => useAutoScroll({ working: false, overflowAnchor: "dynamic" }));
    const el = makeElement();
    setScrollTop(el, 400);
    act(() => result.current.scrollRef(el));
    expect(el.style.overflowAnchor).toBe("none");

    setScrollTop(el, 100);
    act(() => result.current.handleScroll());
    expect(el.style.overflowAnchor).toBe("auto");
  });

  it("sets a manual overflowAnchor mode when configured", () => {
    const { result } = renderHook(() => useAutoScroll({ working: false, overflowAnchor: "none" }));
    const el = makeElement();
    act(() => result.current.scrollRef(el));
    expect(el.style.overflowAnchor).toBe("none");
  });

  it("disconnects the content observer on unmount", () => {
    const { result, unmount } = renderHook(() => useAutoScroll({ working: false }));
    act(() => result.current.contentRef(document.createElement("div")));
    const observer = resizeObserver;
    unmount();
    expect(observer.disconnect).toHaveBeenCalledOnce();
  });
});
