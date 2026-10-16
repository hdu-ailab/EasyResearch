import assert from "node:assert/strict";

/** Real compiled protocol acceptance; no browser mocks or model requests. */
export async function smokeEventChannel(base: string, sessionId: string, bootId: string): Promise<void> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 30_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(`${base}/api/events`, { signal: abort.signal, proxy: "" });
    assert.equal(response.status, 200);
    reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const next = async (): Promise<Record<string, any>> => {
      while (true) {
        const split = buffer.indexOf("\n\n");
        if (split >= 0) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          if (frame.startsWith("data: ")) return JSON.parse(frame.slice(6));
          continue;
        }
        const result = await reader!.read();
        assert(!result.done, "Unified event channel ended during acceptance");
        buffer += decoder.decode(result.value, { stream: true });
        assert(buffer.length <= 32 * 1024 * 1024);
      }
    };
    const connected = await next();
    assert.equal(connected.type, "connected");
    assert.equal(connected.bootId, bootId);
    assert.equal(typeof connected.id, "string");
    const subscriptions = [
      { id: "configuration", path: "/api/config/events" },
      { id: "view-a", path: `/api/sessions/${sessionId}/events` },
      { id: "view-b", path: `/api/sessions/${sessionId}/events` },
    ];
    const replace = (revision: number, desired: typeof subscriptions) =>
      fetch(`${base}/api/events/${connected.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        signal: abort.signal,
        proxy: "",
        body: JSON.stringify({ revision, subscriptions: desired }),
      });
    const subscribed = await replace(1, subscriptions);
    assert.equal(subscribed.status, 200);
    assert.equal((await subscribed.json()).applied, true);
    const initial = new Map<string, Record<string, any>>();
    while (initial.size < 3) {
      const frame = await next();
      assert.equal(frame.bootId, bootId);
      if (frame.type === "event") initial.set(frame.id, frame.event);
      else assert.equal(frame.type, "heartbeat");
    }
    assert.equal(initial.get("configuration")!.type, "config.updated");
    for (const id of ["view-a", "view-b"]) {
      assert.equal(initial.get(id)!.type, "snapshot");
      assert.equal(initial.get(id)!.session.id, sessionId);
      assert.equal(typeof initial.get(id)!.fileWatchLeaseId, "string");
    }
    assert.notEqual(initial.get("view-a")!.fileWatchLeaseId, initial.get("view-b")!.fileWatchLeaseId);
    const removed = await replace(
      2,
      subscriptions.filter((s) => s.id !== "view-a"),
    );
    assert.equal(removed.status, 200);
    assert.equal((await removed.json()).applied, true);
    const oldLease = await fetch(
      `${base}/api/sessions/${sessionId}/file-watches/${initial.get("view-a")!.fileWatchLeaseId}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        signal: abort.signal,
        proxy: "",
        body: JSON.stringify({ revision: 0, directories: [] }),
      },
    );
    assert.equal(
      oldLease.status,
      404,
      "Removed view must release only its lease before replacement acknowledges",
    );
    await oldLease.arrayBuffer();
    const stale = await replace(1, subscriptions);
    assert.equal((await stale.json()).applied, false);
    console.log(
      "[smoke] unified SSE: config + independent session views, snapshots, stale revisions and lease cleanup passed",
    );
  } finally {
    abort.abort();
    await reader?.cancel().catch(() => {});
    clearTimeout(timer);
  }
}
