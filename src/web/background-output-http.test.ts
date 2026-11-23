import { afterEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRouteHandler, type RouteHandler, type RouteServices } from "./routes";
import { BackgroundOutputService } from "./background-output";
import { createNoopFileWatcherFactory } from "./file-watcher";
import { UnknownSessionError } from "./active-sessions";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const agentDir = await mkdtemp(join(tmpdir(), "output-http-"));
  cleanups.push(() => rm(agentDir, { recursive: true, force: true }));
  const root = "native-root";
  const id = `shell_${randomUUID()}`;
  const directory = join(agentDir, "background", "shell", createHash("sha256").update(root).digest("hex"));
  await mkdir(directory, { recursive: true });
  const file = join(directory, `${id}.out`);
  await writeFile(file, "first\n");
  await writeFile(join(directory, `${id}.json`), JSON.stringify({ version: 1, id, rootSessionID: root, sessionID: "child-native-id", file,
    command: "build", started: 100, owner: { rootSessionID: root }, worker: { token: "private-token" }, cwd: "/private/cwd" }));
  const listeners = new Set<(event: unknown) => void>();
  const watcher = createNoopFileWatcherFactory().create({ cwd: agentDir, onEvent() {} });
  let connected = true;
  const registry = {
    subscribe(id: string, listener: (event: unknown) => void) { if (!connected || id !== root) throw new UnknownSessionError(); listeners.add(listener); return () => { listeners.delete(listener); }; },
    acquireFileWatchLease(id: string) { if (id !== root) throw new UnknownSessionError(); return watcher.acquireLease(); },
    releaseFileWatchLease(_root: string, lease: string) { watcher.releaseLease(lease); },
    replaceFileWatchLease(_root: string, lease: string, revision: number, paths: string[]) { return watcher.replaceLease(lease, revision, paths); },
    async snapshot(_root: string, barrier?: () => void) { barrier?.(); return { messages: [], timeline: [], state: {}, session: { id: root, cwd: agentDir } }; },
    retrySummaries(_root: string, summaries: unknown) { return summaries; },
  };
  const service = new BackgroundOutputService({ agentDir, isKnownRoot: async (id) => id === root,
    publish: (_root, event) => { for (const listener of listeners) listener(event); },
  });
  const handler: RouteHandler = createRouteHandler({ bootId: "boot", registry,
    backgroundOutput: service,
    subagentSessions: { summaries: async () => [], statistics: async () => ({}) },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  } as unknown as RouteServices);
  cleanups.push(async () => { await handler.close?.(); await watcher.close(); });
  const request = (path: string, method = "GET", body?: unknown) => handler(new Request(`http://localhost${path}`, {
    method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  }));
  return { root, id, file, handler, service, request, disconnectRuntime() { connected = false; } };
}
async function event(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const chunk = await reader.read();
  return JSON.parse(new TextDecoder().decode(chunk.value).replace(/^data: /, "").trim());
}

describe("root-authorized shell output HTTP and view lease", () => {
  it("reads durable output without a connected runtime and refuses arbitrary paths or query coercion", async () => {
    const f = await fixture();
    f.disconnectRuntime();
    const path = `/api/sessions/${f.root}/background/${f.id}/output`;
    const response = await f.request(path);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sessionID: "child-native-id", output: "first\n", cursor: 6 });
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect((await f.request(path.replace(f.root, "foreign"))).status).toBe(404);
    expect((await f.request(`${path}?path=/private/cwd`)).status).toBe(400);
    expect((await f.request(`${path}?cursor=-1`)).status).toBe(400);
    expect((await f.request(`${path}?cursor=0&cursor=1`)).status).toBe(400);
    expect((await f.request(`${path}?limit=0`)).status).toBe(400);
    await rm(f.file);
    const missing = await f.request(path);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "SHELL_OUTPUT_UNAVAILABLE" });
  });

  it("uses the existing SSE lease with independent revisions and releases output custody on view disconnect", async () => {
    const f = await fixture();
    const stream = await f.request(`/api/sessions/${f.root}/events`);
    const reader = stream.body!.getReader();
    try {
      const snapshot = await event(reader);
      const lease = snapshot.fileWatchLeaseId;
      expect(typeof lease).toBe("string");
      const path = `/api/sessions/${f.root}/background-output-watches/${lease}`;
      expect((await f.request(`/api/sessions/${f.root}/file-watches/${lease}`, "PUT", { revision: 100, directories: [] })).status).toBe(200);
      expect(await (await f.request(path, "PUT", { revision: 1, taskIds: [f.id] })).json()).toEqual({ applied: true, revision: 1 });
      expect(await (await f.request(path, "PUT", { revision: 0, taskIds: [] })).json()).toEqual({ applied: false, revision: 1 });
      expect((await f.request(path, "PUT", { revision: 2, taskIds: Array(17).fill(f.id) })).status).toBe(400);
      expect((await f.request(path, "PUT", { revision: 2, taskIds: [f.id], path: f.file })).status).toBe(400);
      expect((await f.request(path.replace(f.root, "foreign"), "PUT", { revision: 2, taskIds: [f.id] })).status).toBe(404);
      await appendFile(f.file, "live\n");
      expect(await event(reader)).toEqual({ type: "background_output_changed", taskId: f.id });
      await reader.cancel();
      expect((await f.request(path, "PUT", { revision: 3, taskIds: [f.id] })).status).toBe(404);
      expect(await (await f.request(`/api/sessions/${f.root}/background/${f.id}/output?cursor=6`)).json()).toMatchObject({ output: "live\n", cursor: 11 });
    } finally { await reader.cancel(); }
  });

  it("multiplexes output invalidations through the existing channel and releases its view lease", async () => {
    const f = await fixture();
    const channel = await f.request("/api/events");
    const reader = channel.body!.getReader();
    try {
      const connected = await event(reader);
      expect((await f.request(`/api/events/${connected.id}`, "PUT", { revision: 1,
        subscriptions: [{ id: "work", path: `/api/sessions/${f.root}/events` }],
      })).status).toBe(200);
      const frame = await event(reader);
      const lease = frame.event.fileWatchLeaseId;
      const path = `/api/sessions/${f.root}/background-output-watches/${lease}`;
      expect((await f.request(path, "PUT", { revision: 0, taskIds: [f.id] })).status).toBe(200);
      await appendFile(f.file, "channel progress");
      expect(await event(reader)).toMatchObject({ type: "event", id: "work", event: { type: "background_output_changed", taskId: f.id } });
      await reader.cancel();
      expect((await f.request(path, "PUT", { revision: 1, taskIds: [f.id] })).status).toBe(404);
    } finally { await reader.cancel(); }
  });
});
