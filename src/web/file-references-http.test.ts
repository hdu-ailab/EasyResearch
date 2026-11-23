import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UnknownSessionError } from "./active-sessions";
import { DirectoryService } from "./directories";
import { createRouteHandler, type RouteHandler, type RouteServices } from "./routes";

describe("session-scoped file reference HTTP contract", () => {
  let root: string; let handler: RouteHandler;
  const getCwd = vi.fn();
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "file-reference-http-")));
    mkdirSync(join(root, "nested")); writeFileSync(join(root, "nested", "README"), "no bytes in metadata");
    getCwd.mockReset().mockImplementation(async (id: string) => {
      if (id !== "known") throw new UnknownSessionError("Unknown session");
      return root;
    });
    handler = createRouteHandler({ bootId: "reference-test", webuiDist: join(root, "webui"), directories: new DirectoryService(root),
      registry: { getCwd }, listAllSessions: vi.fn(async () => { throw new Error("No history scan"); }) } as unknown as RouteServices);
  });
  afterEach(async () => { await handler.close?.(); rmSync(root, { recursive: true, force: true }); });
  const post = (body: unknown, id = "known", type = "application/json") => handler(new Request(`http://localhost/api/sessions/${id}/file-references/resolve`, {
    method: "POST", headers: { "Content-Type": type }, body: JSON.stringify(body),
  }));
  it("resolves a known exact cwd without content reads or Agent session acquisition", async () => {
    const response = await post({ references: ["README", "README"] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ references: [{ reference: "README", paths: [join(root, "nested", "README")], truncated: false }] });
    expect(getCwd).toHaveBeenCalledExactlyOnceWith("known");
  });
  it("rejects unknown roots, malformed bodies and inappropriate media types", async () => {
    expect((await post({ references: ["README"] }, "missing")).status).toBe(404);
    expect((await post({ references: ["README"] }, "known", "text/plain")).status).toBe(415);
    for (const body of [{ references: Array(65).fill("a") }, { references: ["a"], cwd: root }, { references: ["\0"] }, {}]) {
      expect((await post(body)).status).toBe(400);
    }
  });
});
