import { afterEach, describe, expect, it, vi } from "vitest";
import { createOfficeClient, type OfficeWorkerPort } from "./office-client";
import type { OfficeFrame, OfficeReply } from "./office-protocol";

function fakeWorker() {
  const worker: OfficeWorkerPort = {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage: vi.fn(),
    terminate: vi.fn(),
  };
  return { worker, reply: (data: OfficeReply) => worker.onmessage?.({ data } as MessageEvent<OfficeReply>) };
}
const frame: OfficeFrame = {
  kind: "presentation",
  list: { contractVersion: 2, width: 960, height: 540, primitives: [] },
  text: "slide",
  notes: "",
  fonts: [],
  images: [],
  omittedImages: false,
  truncated: false,
};
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Office file Worker ownership", () => {
  it.each(["timeout", "error", "messageerror"])(
    "preserves terminal %s for later live callers while genuine abort stays AbortError",
    async (event) => {
      vi.useFakeTimers();
      const { worker } = fakeWorker();
      const client = createOfficeClient(worker, 100);
      const first = client.frame({ index: 0, row: 0, column: 0 }, new AbortController().signal);
      const observed = first.catch((error: unknown) => error);
      if (event === "timeout") await vi.advanceTimersByTimeAsync(100);
      else if (event === "error") worker.onerror?.({} as ErrorEvent);
      else worker.onmessageerror?.({} as MessageEvent);
      const fatal = await observed;
      expect(fatal).toMatchObject({ message: event === "timeout" ? "timeout" : "worker" });
      await expect(client.frame({ index: 1, row: 0, column: 0 }, new AbortController().signal)).rejects.toBe(fatal);
      const cancelled = new AbortController();
      cancelled.abort();
      await expect(client.frame({ index: 1, row: 0, column: 0 }, cancelled.signal)).rejects.toMatchObject({
        name: "AbortError",
      });
      client.dispose();
      await expect(client.frame({ index: 1, row: 0, column: 0 }, new AbortController().signal)).rejects.toBe(fatal);
      expect(worker.postMessage).toHaveBeenCalledOnce();
      expect(worker.terminate).toHaveBeenCalledOnce();
    },
  );
  it("allocates distinct font owners when randomUUID is absent on an HTTP origin", async () => {
    vi.stubGlobal("crypto", {});
    const ports = [fakeWorker(), fakeWorker()];
    const clients = ports.map(({ worker }) => createOfficeClient(worker));
    const opened = clients.map((client) =>
      client.open("presentation", new ArrayBuffer(1), new AbortController().signal),
    );
    const prefixes = ports.map(({ worker, reply }) => {
      const request = vi.mocked(worker.postMessage).mock.calls[0]?.[0];
      expect(request?.type).toBe("open");
      reply({ id: 1, type: "opened", document: { kind: "presentation", items: [] } });
      return request?.type === "open" ? request.fontPrefix : undefined;
    });
    expect(prefixes[0]).not.toBe(prefixes[1]);
    await Promise.all(opened);
    for (const client of clients) client.dispose();
  });
  it("transfers input once and ignores unmatched replies", async () => {
    const { worker, reply } = fakeWorker();
    const client = createOfficeClient(worker);
    const bytes = new ArrayBuffer(20);
    const opened = client.open("presentation", bytes, new AbortController().signal);
    const observe = vi.fn();
    void opened.then(observe);
    reply({ id: 123, type: "opened", document: { kind: "presentation", items: [] } });
    await Promise.resolve();
    expect(observe).not.toHaveBeenCalled();
    expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({ bytes }), [bytes]);
    reply({ id: 1, type: "opened", document: { kind: "presentation", items: [] } });
    await expect(opened).resolves.toMatchObject({ kind: "presentation" });
    client.dispose();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it("keeps only the latest waiting view and fences aborted replies", async () => {
    const { worker, reply } = fakeWorker();
    const client = createOfficeClient(worker);
    const old = new AbortController();
    const first = client.frame({ index: 0, row: 0, column: 0 }, old.signal);
    const firstRejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
    old.abort();
    const replaced = client.frame({ index: 1, row: 0, column: 0 }, new AbortController().signal);
    const replacedRejected = expect(replaced).rejects.toMatchObject({ name: "AbortError" });
    const latest = client.frame({ index: 2, row: 0, column: 0 }, new AbortController().signal);
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    reply({ id: 1, type: "frame", frame });
    expect(worker.postMessage).toHaveBeenCalledTimes(2);
    expect(worker.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 3, view: { index: 2, row: 0, column: 0 } }),
      [],
    );
    reply({ id: 3, type: "frame", frame: { ...frame, text: "newest" } });
    await firstRejected;
    await replacedRejected;
    await expect(latest).resolves.toMatchObject({ text: "newest" });
    client.dispose();
  });
  it("terminates a timed-out parse even when its consumer aborted, rejecting the pending view", async () => {
    vi.useFakeTimers();
    const { worker } = fakeWorker();
    const client = createOfficeClient(worker, 100);
    const old = new AbortController();
    const first = client.frame({ index: 0, row: 0, column: 0 }, old.signal);
    const firstRejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
    old.abort();
    const pending = client.frame({ index: 1, row: 0, column: 0 }, new AbortController().signal);
    const pendingRejected = expect(pending).rejects.toThrow("timeout");
    await vi.advanceTimersByTimeAsync(100);
    await firstRejected;
    await pendingRejected;
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(worker.onmessage).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["error", "messageerror", "close"])("settles every owned operation after %s", async (event) => {
    const { worker } = fakeWorker();
    const client = createOfficeClient(worker);
    const first = client.frame({ index: 0, row: 0, column: 0 }, new AbortController().signal);
    const pending = client.frame({ index: 1, row: 0, column: 0 }, new AbortController().signal);
    const results = Promise.allSettled([first, pending]);
    if (event === "close") client.dispose();
    else if (event === "error") worker.onerror?.({} as ErrorEvent);
    else worker.onmessageerror?.({} as MessageEvent);
    expect((await results).every((result) => result.status === "rejected")).toBe(true);
    client.dispose();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
