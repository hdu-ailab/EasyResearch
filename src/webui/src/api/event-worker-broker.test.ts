import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventListener } from "./event-connection";
import { createEventWorkerBroker, type EventPort } from "./event-worker-broker";

const brokers: ReturnType<typeof createEventWorkerBroker>[] = [];
afterEach(() => {
  brokers.splice(0).forEach((b) => {
    b.close();
  });
  vi.useRealTimers();
});
function port() {
  const output: Record<string, unknown>[] = [];
  const value: EventPort = {
    onmessage: null,
    onmessageerror: null,
    start() {},
    close: vi.fn(),
    postMessage: (message) => {
      output.push(message as Record<string, unknown>);
    },
  };
  return { value, output, send: (data: unknown) => value.onmessage?.({ data } as MessageEvent) };
}
function fixture(maxPending?: number) {
  const subscriptions = new Map<string, EventListener>();
  const closed: string[] = [];
  const broker = createEventWorkerBroker({
    maxPending,
    connection: {
      subscribe(id, _path, listener) {
        subscriptions.set(id, listener);
        return () => {
          closed.push(id);
          subscriptions.delete(id);
        };
      },
      close() {},
      reconnect() {},
    },
  });
  brokers.push(broker);
  return { broker, subscriptions, closed };
}
describe("SharedWorker port ownership", () => {
  it("namespaces identical page-local ids and releases only the departing view", () => {
    const f = fixture();
    const a = port();
    const b = port();
    f.broker.attach(a.value);
    f.broker.attach(b.value);
    for (const p of [a, b]) p.send({ type: "subscribe", id: "1", path: "/api/config/events" });
    expect(f.subscriptions.size).toBe(2);
    [...f.subscriptions.values()][0]!.onEvent("only a");
    expect(a.output.at(-1)).toMatchObject({ type: "batch", items: [{ id: "1", event: "only a" }] });
    expect(b.output).toEqual([{ type: "ready" }]);
    a.send({ type: "bye" });
    expect(f.subscriptions.size).toBe(1);
    expect(b.value.close).not.toHaveBeenCalled();
  });
  it("bounds a suspended peer without stalling a healthy peer", () => {
    const f = fixture(2);
    const a = port();
    const b = port();
    f.broker.attach(a.value);
    f.broker.attach(b.value);
    for (const p of [a, b]) p.send({ type: "subscribe", id: "1", path: "/api/config/events" });
    const [slow, healthy] = [...f.subscriptions.values()];
    for (let i = 0; i < 4; i++) slow!.onEvent(i);
    expect(a.value.close).toHaveBeenCalledOnce();
    healthy!.onEvent("healthy");
    expect(b.output.at(-1)).toMatchObject({ type: "batch", items: [{ event: "healthy" }] });
    b.send({ type: "ack", sequence: b.output.at(-1)?.sequence });
    healthy!.onEvent("next");
    expect(b.output.at(-1)).toMatchObject({ items: [{ event: "next" }] });
  });
  it("releases a vanished port after its liveness deadline", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const a = port();
    f.broker.attach(a.value);
    a.send({ type: "subscribe", id: "1", path: "/api/config/events" });
    await vi.advanceTimersByTimeAsync(106_000);
    expect(a.value.close).toHaveBeenCalledOnce();
    expect(f.subscriptions.size).toBe(0);
  });
});
