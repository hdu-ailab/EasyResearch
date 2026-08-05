import "@testing-library/jest-dom/vitest";

if (typeof globalThis.ResizeObserver === "undefined") {
  class FakeResizeObserver {
    static instances: FakeResizeObserver[] = [];
    private callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
      FakeResizeObserver.instances.push(this);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
    __fire(width: number) {
      this.callback([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
  }
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
  (globalThis as unknown as { FakeResizeObserver: typeof FakeResizeObserver }).FakeResizeObserver =
    FakeResizeObserver;
}
