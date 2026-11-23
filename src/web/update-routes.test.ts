import { describe, expect, it, vi } from "vitest";
import { createRouteHandler, type RouteServices } from "./routes";
import { NpmUpdateController } from "../runtime/npm-update";
import { DESKTOP_ACCESS_HEADER } from "./desktop-access";

function fixture(desktop = false) {
  let checks = 0;
  const update = new NpmUpdateController({ owner: "cli", currentVersion: "1.0.0", capability: () => ({ available: true }), manualCommand: () => undefined,
    latest: async () => { checks++; return "2.0.0"; }, reserve: async () => { throw new Error("unexpected mutation"); },
    install: async () => {}, verify: async () => { throw new Error("unexpected verification"); }, discard: async () => {},
    busy: () => ({ code: "RUNTIME_BUSY", activeSessions: 0, authFlowActive: false }), beginShutdown() {}, activate() {},
  });
  const handler = createRouteHandler({ bootId: "boot", update,
    directories: {}, registry: { list: () => [] },
    ...(desktop ? { desktopAccess: { token: "renderer" } } : {}),
  } as unknown as RouteServices);
  const request = (path: string, body?: unknown) => handler(new Request(`http://localhost${path}`, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", ...(desktop ? { [DESKTOP_ACCESS_HEADER]: "renderer" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }));
  return { handler, update, request, checks: () => checks };
}
const event = async (reader: ReadableStreamDefaultReader<Uint8Array>) => JSON.parse(new TextDecoder().decode((await reader.read()).value).slice(6));
describe("typed updater API and logical events", () => {
  it("refuses npm control on desktop-owned servers regardless of the injected controller", async () => {
    const f = fixture(true);
    expect((await f.request("/api/update/action", { action: "check" })).status).toBe(409);
    expect(f.checks()).toBe(0); await f.handler.close?.();
  });
  it("closes new mutating HTTP admission synchronously while preserving authenticated Exit", async () => {
    const f = fixture(); f.handler.beginShutdown?.();
    expect((await f.request("/api/update/action", { action: "check" })).status).toBe(503);
    expect(f.checks()).toBe(0); await f.handler.close?.();
  });
  it("rejects an update whose JSON body completes after the shutdown fence", async () => {
    const f = fixture(); let finish!: () => void;
    const body = new ReadableStream<Uint8Array>({ start(controller) { finish = () => { controller.enqueue(new TextEncoder().encode('{"action":"check"}')); controller.close(); }; } });
    const request = f.handler(new Request("http://localhost/api/update/action", { method: "POST", headers: { "Content-Type": "application/json" }, body, duplex: "half" } as RequestInit));
    f.handler.beginShutdown?.(); finish();
    expect((await request).status).toBe(503);
    expect(f.checks()).toBe(0); await f.handler.close?.();
  });
  it("rejects browser commands, paths and versions before operation admission", async () => {
    const f = fixture();
    for (const field of ["version", "prefix", "command", "url", "executable"]) {
      const result = await f.request("/api/update/action", { action: "check", [field]: "unsafe" });
      expect(result.status).toBe(400);
    }
    expect(f.checks()).toBe(0);
    expect((await f.request("/api/update")).status).toBe(200);
    await f.handler.close?.();
  });
  it("streams current and subsequent snapshots through the multiplexed channel without tying work to a view", async () => {
    const f = fixture(); const physical = await f.request("/api/events");
    const reader = physical.body!.getReader(); const connected = await event(reader);
    const subscribed = await f.handler(new Request(`http://localhost/api/events/${connected.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: 1, subscriptions: [{ id: "update", path: "/api/update/events" }] }) }));
    expect(subscribed.status).toBe(200);
    expect(await event(reader)).toMatchObject({ type: "event", id: "update", event: { type: "update", snapshot: { phase: "idle" } } });
    expect((await f.request("/api/update/action", { action: "check" })).status).toBe(202);
    expect(await event(reader)).toMatchObject({ event: { snapshot: { phase: "checking" } } });
    await reader.cancel();
    await vi.waitFor(() => expect(f.update.snapshot().phase).toBe("available"));
    await f.handler.close?.();
  });
});
