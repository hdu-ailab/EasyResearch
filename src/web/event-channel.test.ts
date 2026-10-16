import { afterEach, describe, expect, it, vi } from "vitest";
import { EventChannels } from "./event-channel";

const hubs: EventChannels[] = [];
afterEach(async () => {
  await Promise.all(hubs.splice(0).map((h) => h.close()));
});
function fixture(maxBytes?: number) {
  const sources: { path: string; send(event: unknown): void; cancel: ReturnType<typeof vi.fn> }[] = [];
  const hub = new EventChannels({
    bootId: "boot",
    maxBytes,
    open(path) {
      const cancel = vi.fn();
      return new Response(
        new ReadableStream({
          start(controller) {
            sources.push({
              path,
              cancel,
              send: (event) =>
                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)),
            });
          },
          cancel,
        }),
      );
    },
  });
  hubs.push(hub);
  const reader = hub.open().body!.getReader();
  const next = async () => JSON.parse(new TextDecoder().decode((await reader.read()).value).slice(6));
  return { hub, sources, reader, next };
}

describe("multiplexed event ownership", () => {
  it("keeps same-path views independent and releases only a removed subscription", async () => {
    const f = fixture();
    const connected = await f.next();
    const subscriptions = ["a", "b"].map((id) => ({ id, path: "/api/sessions/s/events" }));
    await f.hub.replace(connected.id, { revision: 1, subscriptions });
    expect(f.sources).toHaveLength(2);
    f.sources[0]!.send({ type: "snapshot", fileWatchLeaseId: "lease-a" });
    f.sources[1]!.send({ type: "snapshot", fileWatchLeaseId: "lease-b" });
    expect(await f.next()).toMatchObject({ id: "a", event: { fileWatchLeaseId: "lease-a" } });
    expect(await f.next()).toMatchObject({ id: "b", event: { fileWatchLeaseId: "lease-b" } });
    await f.hub.replace(connected.id, { revision: 2, subscriptions: [subscriptions[1]] });
    expect(f.sources[0]!.cancel).toHaveBeenCalledOnce();
    expect(f.sources[1]!.cancel).not.toHaveBeenCalled();
    expect(await f.hub.replace(connected.id, { revision: 1, subscriptions })).toMatchObject({
      applied: false,
    });
    await f.reader.cancel();
    expect(f.sources[1]!.cancel).toHaveBeenCalledOnce();
    expect(await f.hub.replace(connected.id, { revision: 3, subscriptions: [] })).toBeUndefined();
  });
  it("rejects arbitrary URLs and duplicate ids before changing accepted subscriptions", async () => {
    const f = fixture();
    const { id } = await f.next();
    await expect(
      f.hub.replace(id, { revision: 1, subscriptions: [{ id: "a", path: "https://example.com" }] }),
    ).rejects.toThrow();
    await expect(
      f.hub.replace(id, {
        revision: 1,
        subscriptions: [1, 2].map(() => ({ id: "a", path: "/api/config/events" })),
      }),
    ).rejects.toThrow();
    expect(f.sources).toHaveLength(0);
  });
  it("reports an oversized logical frame and releases its producer", async () => {
    const f = fixture(256);
    const { id } = await f.next();
    await f.hub.replace(id, { revision: 1, subscriptions: [{ id: "a", path: "/api/config/events" }] });
    f.sources[0]!.send({ text: "x".repeat(500) });
    // Producer-side overflow is an explicit logical error; accumulated physical output is bounded too.
    expect(await f.next()).toMatchObject({ type: "stream-error", id: "a" });
    await f.reader.cancel();
    expect(f.sources[0]!.cancel).toHaveBeenCalledOnce();
  });
  it("disconnects a slow physical reader instead of retaining unlimited output", async () => {
    const f = fixture(256);
    const { id } = await f.next();
    await f.hub.replace(id, { revision: 1, subscriptions: [{ id: "a", path: "/api/config/events" }] });
    for (let i = 0; i < 10; i++) f.sources[0]!.send({ index: i });
    await vi.waitFor(() => expect(f.sources[0]!.cancel).toHaveBeenCalledOnce());
    await expect(f.reader.read()).rejects.toThrow(/budget/);
    expect(await f.hub.replace(id, { revision: 2, subscriptions: [] })).toBeUndefined();
  });
});
