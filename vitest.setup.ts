import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";

if (typeof window !== "undefined") {
  // TanStack virtual-core's offset observer schedules a debounced setTimeout
  // that is not cancelled on unmount. Once vitest tears the jsdom environment
  // down, that callback dereferences the destroyed `window` and surfaces as an
  // unhandled ReferenceError. Clear every pending jsdom timer after each test
  // so no callback can fire past its test.
  const nativeSetTimeout = window.setTimeout.bind(window);
  const nativeClearTimeout = window.clearTimeout.bind(window);
  const pending = new Set<number>();
  window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    const id = nativeSetTimeout(handler, timeout, ...args);
    pending.add(id);
    return id;
  }) as typeof window.setTimeout;
  window.clearTimeout = ((id?: number) => {
    if (id !== undefined) pending.delete(id);
    return nativeClearTimeout(id);
  }) as typeof window.clearTimeout;
  afterEach(() => {
    for (const id of pending) nativeClearTimeout(id);
    pending.clear();
  });
}

if (typeof globalThis.ResizeObserver === "undefined") {
  class FakeResizeObserver {
    static instances: FakeResizeObserver[] = [];
    private callback: ResizeObserverCallback;
    private observed: Element[] = [];
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
      FakeResizeObserver.instances.push(this);
    }
    observe(target: Element) {
      if (!this.observed.includes(target)) this.observed.push(target);
    }
    unobserve(target: Element) {
      this.observed = this.observed.filter((entry) => entry !== target);
    }
    disconnect() {}
    /** Legacy width-only fire used by panel-sizing tests. */
    __fire(width: number) {
      this.callback([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    /** Fire an arbitrary list of entries (e.g. with borderBoxSize for the virtualizer). */
    __fireEntries(entries: ResizeObserverEntry[]) {
      this.callback(entries, this as unknown as ResizeObserver);
    }
    /** Targets this observer is currently observing. */
    get __observed() {
      return this.observed;
    }
  }
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
  (globalThis as unknown as { FakeResizeObserver: typeof FakeResizeObserver }).FakeResizeObserver =
    FakeResizeObserver;
}
