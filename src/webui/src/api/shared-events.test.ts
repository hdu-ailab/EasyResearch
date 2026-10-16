import { afterEach, expect, it, vi } from "vitest";
import { subscribeSharedEvents } from "./shared-events";

const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((fn) => {
    fn();
  });
  vi.unstubAllGlobals();
});
function fixture() {
  const output: Array<{ type: string; id?: string; path?: string; sequence?: number }> = [];
  const port = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    onmessageerror: null,
    postMessage: (message: (typeof output)[number]) => output.push(message),
    start() {},
    close: vi.fn(),
  };
  const Worker = vi.fn(function MockSharedWorker() {
    return { port, onerror: null };
  });
  vi.stubGlobal("SharedWorker", Worker);
  return { output, port, Worker, send: (data: unknown) => port.onmessage?.({ data } as MessageEvent) };
}

it("uses one port for page listeners and acknowledges isolated delivery", () => {
  const f = fixture();
  const a = { onEvent: vi.fn(), onError: vi.fn() };
  const b = { onEvent: vi.fn(), onError: vi.fn() };
  cleanup.push(subscribeSharedEvents("/api/config/events", a));
  cleanup.push(subscribeSharedEvents("/api/sessions/s/events", b));
  expect(f.Worker).toHaveBeenCalledOnce();
  f.send({ type: "ready" });
  expect(f.output.map((value) => value.path)).toEqual(["/api/config/events", "/api/sessions/s/events"]);
  f.send({ type: "batch", sequence: 4, items: [{ type: "event", id: f.output[1]!.id, event: "session" }] });
  expect(a.onEvent).not.toHaveBeenCalled();
  expect(b.onEvent).toHaveBeenCalledWith("session");
  expect(f.output.at(-1)).toEqual({ type: "ack", sequence: 4 });
  cleanup.shift()!();
  expect(f.port.close).not.toHaveBeenCalled();
  cleanup.shift()!();
  expect(f.port.close).toHaveBeenCalledOnce();
});

it("restores subscriptions after pagehide/pageshow without recreating view state", () => {
  const f = fixture();
  cleanup.push(subscribeSharedEvents("/api/config/events", { onEvent() {}, onError() {} }));
  f.send({ type: "ready" });
  window.dispatchEvent(new Event("pagehide"));
  expect(f.port.close).toHaveBeenCalledOnce();
  window.dispatchEvent(new Event("pageshow"));
  expect(f.Worker).toHaveBeenCalledTimes(2);
  f.send({ type: "ready" });
  expect(f.output.filter((item) => item.type === "subscribe")).toHaveLength(2);
});

it("falls back to one page channel when SharedWorker construction fails", () => {
  vi.stubGlobal(
    "SharedWorker",
    class {
      constructor() {
        throw new Error("unavailable");
      }
    },
  );
  const sources: { url: string; close: ReturnType<typeof vi.fn> }[] = [];
  vi.stubGlobal(
    "EventSource",
    class {
      onmessage = null;
      onerror = null;
      close = vi.fn();
      constructor(readonly url: string) {
        sources.push(this);
      }
    },
  );
  cleanup.push(subscribeSharedEvents("/api/config/events", { onEvent() {}, onError() {} }));
  cleanup.push(subscribeSharedEvents("/api/sessions/s/events", { onEvent() {}, onError() {} }));
  expect(sources.map((source) => source.url)).toEqual(["/api/events"]);
});
