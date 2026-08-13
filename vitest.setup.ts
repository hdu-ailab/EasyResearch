import "@testing-library/jest-dom/vitest";

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
