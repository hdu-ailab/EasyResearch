import { afterEach, describe, expect, it, vi } from "vitest";
import { EventConnection, type EventSourceLike } from "./event-connection";

afterEach(() => vi.useRealTimers());
function fixture() {
  const sources: EventSourceLike[] = [];
  const requests: { url: string; body: { revision: number; subscriptions: { id: string; path: string }[] } }[] = [];
  const connection = new EventConnection({
    source: () => {
      const source = { onmessage: null, onerror: null, close: vi.fn() };
      sources.push(source);
      return source;
    },
    fetch: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body as string) });
      return Response.json({ applied: true });
    },
  });
  const emit = (index: number, data: unknown) =>
    sources[index]!.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  return { connection, sources, requests, emit };
}
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

describe("one physical event connection", () => {
  it.each(["stream-error", "end"])(
    "recovers a logical %s while healthy peers and heartbeats keep the socket open",
    async (type) => {
      vi.useFakeTimers();
      const f = fixture();
      const received: unknown[] = [];
      let failures = 0;
      f.connection.subscribe("work", "/api/sessions/s/events", {
        onEvent: (event) => received.push(event),
        onError: () => failures++,
      });
      f.connection.subscribe("config", "/api/config/events", { onEvent() {}, onError() {} });
      f.emit(0, { type: "connected", id: "one", bootId: "boot" });
      await flush();
      f.emit(0, { type, id: "work", bootId: "boot" });
      f.emit(0, { type: "heartbeat", id: "one", bootId: "boot" });
      await vi.advanceTimersByTimeAsync(1100);
      expect(f.requests.length).toBeGreaterThan(1);
      expect(f.requests.at(-1)?.body.subscriptions).toContainEqual({ id: "work", path: "/api/sessions/s/events" });
      f.emit(0, { type: "event", id: "work", bootId: "boot", event: { type: "snapshot", lease: "fresh" } });
      expect(received).toEqual([{ type: "snapshot", lease: "fresh" }]);
      expect(failures).toBe(1);
      expect(f.sources).toHaveLength(1);
      f.connection.close();
    },
  );

  it("keeps completed streams terminal and cancels logical retries on unsubscribe", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.connection.subscribe("config", "/api/config/events", { onEvent() {}, onError() {} });
    const stop = f.connection.subscribe("work", "/api/sessions/s/events", { onEvent() {}, onError() {} });
    f.connection.subscribe("auth", "/api/auth/flows/login/events", { onEvent() {}, onError() {} });
    f.emit(0, { type: "connected", id: "one", bootId: "boot" });
    await flush();
    f.emit(0, { type: "end", id: "auth", bootId: "boot" });
    f.emit(0, { type: "stream-error", id: "work", bootId: "boot" });
    stop();
    await flush();
    const count = f.requests.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.requests).toHaveLength(count);
    expect(f.requests.at(-1)?.body.subscriptions).toEqual([{ id: "config", path: "/api/config/events" }]);
    f.connection.close();
  });

  it("routes distinct same-path subscriptions and removes one without closing its peer", async () => {
    const f = fixture();
    const a = { onEvent: vi.fn(), onError: vi.fn() };
    const b = { onEvent: vi.fn(), onError: vi.fn() };
    const stopA = f.connection.subscribe("a", "/api/config/events", a);
    const stopB = f.connection.subscribe("b", "/api/config/events", b);
    expect(f.sources).toHaveLength(1);
    f.emit(0, { type: "connected", id: "channel", bootId: "boot" });
    await flush();
    expect(f.requests[0]?.body.subscriptions.map((s) => s.id)).toEqual(["a", "b"]);
    f.emit(0, { type: "event", id: "b", bootId: "boot", event: { lease: "b" } });
    expect(a.onEvent).not.toHaveBeenCalled();
    expect(b.onEvent).toHaveBeenCalledWith({ lease: "b" });
    stopA();
    await flush();
    expect(f.requests.at(-1)?.body.subscriptions.map((s) => s.id)).toEqual(["b"]);
    expect(f.sources[0]!.close).not.toHaveBeenCalled();
    stopB();
    expect(f.sources[0]!.close).toHaveBeenCalledOnce();
  });
  it("reconnects from new channel identity and rejects old transport delivery", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const listener = { onEvent: vi.fn(), onError: vi.fn() };
    f.connection.subscribe("a", "/api/sessions/s/events", listener);
    f.emit(0, { type: "connected", id: "first", bootId: "old" });
    await flush();
    f.sources[0]!.onerror?.(new Event("error"));
    await vi.advanceTimersByTimeAsync(1000);
    f.emit(1, { type: "connected", id: "second", bootId: "new" });
    await flush();
    f.emit(0, { type: "event", id: "a", bootId: "old", event: "stale" });
    f.emit(1, { type: "event", id: "a", bootId: "new", event: "fresh snapshot" });
    expect(listener.onEvent).toHaveBeenCalledExactlyOnceWith("fresh snapshot");
    expect(f.requests.at(-1)?.url).toBe("/api/events/second");
    f.connection.close();
  });
  it("uses heartbeat data to distinguish a quiet healthy stream from a stalled connection", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const listener = { onEvent: vi.fn(), onError: vi.fn() };
    f.connection.subscribe("a", "/api/config/events", listener);
    f.emit(0, { type: "connected", id: "one", bootId: "boot" });
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
      f.emit(0, { type: "heartbeat", id: "one", bootId: "boot" });
    }
    expect(listener.onError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(46_000);
    expect(f.sources).toHaveLength(2);
    expect(listener.onError).toHaveBeenCalledOnce();
    f.connection.close();
  });
});
