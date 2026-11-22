import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextManagementError } from "./context-management";
import { SessionLifecycleConflictError, UnknownSessionError } from "./active-sessions";
import { createRouteHandler, type RouteHandler, type RouteServices } from "./routes";

let handler: RouteHandler;
afterEach(async () => { await handler?.close?.(); });

function fixture() {
  const registry = {
    getContext: vi.fn(async () => ({ revision: "accepted" })),
    getContextItem: vi.fn(async (_id: string, revision: string, itemId: string, view: string, offset: number) => ({ revision, itemId, view, offset, text: "page", totalChars: offset + 4, nextOffset: null })),
    previewContext: vi.fn(async () => ({ revision: "accepted", changes: [] })),
    applyContext: vi.fn(async () => ({ revision: "next" })),
  };
  handler = createRouteHandler({ registry } as unknown as RouteServices);
  const request = (path: string, body?: unknown) => handler(new Request(`http://localhost/api/sessions/root/context${path}`, body === undefined ? undefined
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  return { registry, request };
}

describe("explicit root context HTTP routes", () => {
  it("routes metadata, bounded item reads, previews and applies through the root registry", async () => {
    const { registry, request } = fixture();
    expect(await (await request("")).json()).toEqual({ revision: "accepted" });
    expect(registry.getContext).toHaveBeenCalledWith("root");
    const raw = await request("/item?revision=accepted&itemId=entry%3A0%3Awhole&view=original&offset=16000");
    expect(await raw.json()).toMatchObject({ revision: "accepted", offset: 16000, itemId: "entry:0:whole" });
    expect(registry.getContextItem).toHaveBeenCalledWith("root", "accepted", "entry:0:whole", "original", 16000);
    const body = { revision: "accepted", edits: [{ target: "item", id: "entry:0:whole", action: "fold" }] };
    expect(await (await request("/preview", body)).json()).toEqual({ revision: "accepted", changes: [] });
    expect(registry.previewContext).toHaveBeenCalledWith("root", body);
    expect(await (await request("/apply", body)).json()).toEqual({ revision: "next" });
    expect(registry.applyContext).toHaveBeenCalledWith("root", body);
  });

  it("rejects malformed mutations and page offsets before touching the runtime", async () => {
    const { registry, request } = fixture();
    for (const body of [null, {}, { revision: "accepted", edits: [], path: "/private" },
      { revision: "accepted", edits: [{ target: "item", id: "a", action: "replace" }] }]) {
      const response = await request("/apply", body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "CONTEXT_INVALID" });
    }
    for (const query of ["offset=-1", "offset=1e2", "offset=", "offset=99999999999999999", "view=staged"]) {
      const response = await request(`/item?revision=accepted&itemId=a&${query.startsWith("view") ? "" : "view=current&"}${query}`);
      expect(response.status).toBe(400);
    }
    expect(registry.applyContext).not.toHaveBeenCalled();
    expect(registry.getContextItem).not.toHaveBeenCalled();
  });

  it.each([
    ["CONTEXT_BUSY", 409], ["CONTEXT_STALE", 409], ["CONTEXT_INVALID", 400], ["CONTEXT_TOO_LARGE", 413], ["CONTEXT_UNAVAILABLE", 503],
  ] as const)("returns safe %s errors", async (code, status) => {
    const { registry, request } = fixture();
    registry.applyContext.mockRejectedValueOnce(new ContextManagementError(code));
    const response = await request("/apply", { revision: "accepted", edits: [] });
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code });
  });

  it("maps missing roots and lifecycle conflicts to recoverable context errors", async () => {
    const { registry, request } = fixture();
    registry.getContext.mockRejectedValueOnce(new UnknownSessionError("private path"));
    const missing = await request("");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "CONTEXT_UNAVAILABLE" });
    registry.getContext.mockRejectedValueOnce(new SessionLifecycleConflictError());
    const conflict = await request("");
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "CONTEXT_BUSY" });
  });
});
