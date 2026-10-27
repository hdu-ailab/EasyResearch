import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRouteHandler, type RouteHandler, type RouteServices } from "./routes";
import { DirectoryService } from "./directories";
import { DESKTOP_ACCESS_HEADER } from "./desktop-access";
import { FILE_UPLOAD_LIMIT } from "./contracts";
import { DAEMON_CONTROL_PATH, DAEMON_TOKEN_HEADER } from "../cli/server-process";
import type { HtmlPreviewDescriptor } from "./html-preview";

describe("Work file HTTP contract", () => {
  let root: string;
  let cwd: string;
  let services: RouteServices;
  let handler: RouteHandler;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "file-http-")));
    cwd = join(root, "project");
    fs.mkdirSync(cwd);
    services = {
      bootId: "file-test",
      webuiDist: join(root, "webui-dist"),
      directories: new DirectoryService(root),
      registry: { list: vi.fn(() => [{ cwd }]), create: vi.fn(() => { throw new Error("Must not open a session"); }) },
      listAllSessions: vi.fn(async () => []),
      workspaces: {
        rename: vi.fn(async () => ({ cwd, sessionIds: [] })),
        relocate: vi.fn(async () => ({ cwd, sessionIds: [] })),
        delete: vi.fn(async () => ({ cwd, sessionIds: [] })),
      },
    } as unknown as RouteServices;
    handler = createRouteHandler(services);
  });
  afterEach(async () => {
    await handler.close?.();
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const url = (name = "论文.bin", directory = cwd) => `http://localhost/api/file/upload?${new URLSearchParams({ cwd, directory, name })}`;
  const put = (target = url(), body: BodyInit = Uint8Array.of(0, 255, 128), headers: HeadersInit = { "Content-Type": "application/octet-stream" }) =>
    handler(new Request(target, { method: "PUT", headers, body, duplex: "half" } as RequestInit));
  const rename = (body: unknown, query = "") => handler(new Request(`http://localhost/api/file/rename${query}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }));

  it("uploads and renames original bytes through the exact DTOs without Agent work", async () => {
    const response = await put();
    expect(response.status).toBe(201);
    const before = join(cwd, "论文.bin");
    expect(await response.json()).toEqual({ entry: { kind: "file", name: "论文.bin", path: before } });
    const changed = await rename({ cwd, path: before, name: "研究.mp4" });
    expect(changed.status).toBe(200);
    const after = join(cwd, "研究.mp4");
    expect(await changed.json()).toEqual({ oldPath: before, entry: { kind: "file", name: "研究.mp4", path: after } });
    expect(fs.readFileSync(after)).toEqual(Buffer.from([0, 255, 128]));
    expect(fs.existsSync(before)).toBe(false);
    expect(services.registry.create).not.toHaveBeenCalled();
    expect(services.listAllSessions).not.toHaveBeenCalled();
  });

  it("accepts persisted exact cwd identities and rejects unknown workspaces", async () => {
    vi.mocked(services.registry.list).mockReturnValue([]);
    expect((await put()).status).toBe(404);
    vi.mocked(services.listAllSessions).mockResolvedValue([{ cwd } as Awaited<ReturnType<RouteServices["listAllSessions"]>>[number]]);
    expect((await put()).status).toBe(201);
    expect(services.registry.create).not.toHaveBeenCalled();
  });

  it("rejects excess/duplicate/missing query fields, wrong media types and malformed rename bodies", async () => {
    for (const target of [url() + "&extra=1", url() + "&cwd=" + encodeURIComponent(cwd), "http://localhost/api/file/upload?name=file"]) {
      expect((await put(target)).status).toBe(400);
    }
    for (const contentType of ["text/plain", "application/json", "multipart/form-data"]) {
      expect((await put(url(), "bytes", { "Content-Type": contentType })).status).toBe(415);
    }
    for (const body of [{ cwd, path: join(cwd, "x"), name: "y", overwrite: true }, [], { cwd, path: 1, name: "y" }, { cwd, path: join(cwd, "x"), name: false }]) {
      expect((await rename(body)).status).toBe(400);
    }
    expect((await rename({ cwd, path: join(cwd, "x"), name: "y" }, "?extra=1")).status).toBe(400);
    expect(fs.readdirSync(cwd)).toEqual([]);
  });

  it("returns typed oversize, conflict, non-file and missing errors", async () => {
    const large = await put(url(), "", { "Content-Type": "application/octet-stream", "Content-Length": String(FILE_UPLOAD_LIMIT + 1) });
    expect(large.status).toBe(413);
    expect(await large.json()).toMatchObject({ code: "FILE_TOO_LARGE" });
    expect((await put()).status).toBe(201);
    const conflict = await put();
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "FILE_EXISTS" });
    const missing = await rename({ cwd, path: join(cwd, "missing"), name: "new" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "FILE_NOT_FOUND" });
    fs.mkdirSync(join(cwd, "folder"));
    expect((await rename({ cwd, path: join(cwd, "folder"), name: "new" })).status).toBe(400);
  });

  it("keeps upload and download behind Desktop renderer authentication", async () => {
    services.desktopAccess = { token: "renderer" };
    expect((await put()).status).toBe(401);
    const headers = { "Content-Type": "application/octet-stream", [DESKTOP_ACCESS_HEADER]: "renderer" };
    expect((await put(url(), "bytes", headers)).status).toBe(201);
    const target = `http://localhost/api/file/raw?${new URLSearchParams({ path: join(cwd, "论文.bin"), download: "1" })}`;
    expect((await handler(new Request(target))).status).toBe(401);
    const allowed = await handler(new Request(target, { headers }));
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("content-disposition")).toContain("filename*=UTF-8''");
    expect(await allowed.text()).toBe("bytes");
  });

  it("rejects workspace rename/relocate/delete while uploading and drains the upload on route close", async () => {
    const cancel = vi.fn();
    const pending = put(url(), new ReadableStream({ start(controller) { controller.enqueue(Uint8Array.of(1)); }, cancel }));
    await vi.waitFor(() => expect(fs.readdirSync(cwd)).toHaveLength(1));
    for (const [action, body] of [["rename", { cwd, name: "new" }], ["relocate", { cwd, directory: root }], ["", { cwd }]] as const) {
      const response = await handler(new Request(`http://localhost/api/workspaces${action ? "/" + action : ""}`, {
        method: action ? "POST" : "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, force: true }),
      }));
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "FILE_OPERATION_CONFLICT" });
    }
    expect(services.workspaces!.rename).not.toHaveBeenCalled();
    expect(services.workspaces!.relocate).not.toHaveBeenCalled();
    expect(services.workspaces!.delete).not.toHaveBeenCalled();
    await handler.close?.();
    const response = await pending;
    expect(response.status).toBe(499);
    expect(await response.json()).toMatchObject({ code: "FILE_CANCELLED" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fs.readdirSync(cwd)).toEqual([]);
    expect((await put()).status).toBe(503);
  });

  it("reserves a root before awaiting the existing workspace mutation and releases on rejection", async () => {
    let reject!: (error: Error) => void;
    vi.mocked(services.workspaces!.rename).mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    const pending = handler(new Request("http://localhost/api/workspaces/rename", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd, name: "new" }),
    }));
    await vi.waitFor(() => expect(reject).toBeTypeOf("function"));
    expect((await put()).status).toBe(409);
    reject(new Error("move failed"));
    expect((await pending).status).toBe(500);
    expect((await put()).status).toBe(201);
  });

  describe("HTML preview production router", () => {
    const create = (body: unknown, init: { headers?: HeadersInit; query?: string; text?: string } = {}) =>
      handler(new Request(`http://localhost/api/file/preview${init.query ?? ""}`, {
        method: "POST", headers: init.headers ?? { "Content-Type": "application/json" },
        body: init.text ?? JSON.stringify(body),
      }));
    const read = (url: string, init?: RequestInit) => handler(new Request(`http://localhost${url}`, init));
    const entry = () => {
      const path = join(cwd, "报告.html");
      fs.writeFileSync(path, "<script>window.answer=42</script>" + "x".repeat(1024 * 1024 + 19));
      return path;
    };

    it("creates exactly a 200 descriptor, streams complete scoped content, and releases idempotently", async () => {
      const path = entry();
      const response = await create({ path });
      expect(response.status).toBe(200);
      expect(response.headers.has("access-control-allow-origin")).toBe(false);
      const scope = await response.json() as HtmlPreviewDescriptor;
      expect(Object.keys(scope).sort()).toEqual(["id", "url"]);
      expect(scope.id).toMatch(/^[a-f0-9]{64}$/u);
      expect(scope.url).toBe(`/api/file/preview/${scope.id}/${encodeURIComponent("报告.html")}`);
      const content = await read(scope.url);
      expect(content.status).toBe(200);
      expect(content.headers.get("access-control-allow-origin")).toBe("*");
      expect(content.headers.get("content-security-policy")).toContain(`/${scope.id}/`);
      expect(await content.text()).toBe(fs.readFileSync(path, "utf8"));
      expect((await read(scope.url, { method: "HEAD" })).status).toBe(200);
      for (let i = 0; i < 2; i++) {
        const released = await read(`/api/file/preview/${scope.id}`, { method: "DELETE" });
        expect(released.status).toBe(204);
        expect(await released.text()).toBe("");
        expect(released.headers.has("access-control-allow-origin")).toBe(false);
      }
      const missing = await read(scope.url);
      expect(missing.status).toBe(404);
      expect(missing.headers.has("access-control-allow-origin")).toBe(false);
      expect(services.registry.create).not.toHaveBeenCalled();
      expect(services.listAllSessions).not.toHaveBeenCalled();
    });

    it("requires exact JSON path input and rejects query overrides, wrong media types and malformed JSON", async () => {
      const path = entry();
      for (const body of [{}, [], null, "path", { path: 1 }, { path: false }, { path, cwd }, { path, root: cwd }]) {
        const response = await create(body);
        expect(response.status).toBe(400);
        expect(response.headers.has("access-control-allow-origin")).toBe(false);
      }
      for (const query of ["?path=override", "?cwd=elsewhere", "?path=a&path=b"]) {
        expect((await create({ path }, { query })).status).toBe(400);
      }
      expect((await create({ path }, { text: "{" })).status).toBe(400);
      for (const contentType of ["text/plain", "application/octet-stream", ""]) {
        expect((await create({ path }, { headers: { "Content-Type": contentType } })).status).toBe(415);
      }
      const accepted = await create({ path }, { headers: { "Content-Type": "application/json; charset=utf-8" } });
      expect(accepted.status).toBe(200);
    });

    it("rejects unknown or malformed capabilities and resource mutations without granting CORS", async () => {
      const path = entry();
      const scope = await (await create({ path })).json() as HtmlPreviewDescriptor;
      for (const [url, status] of [
        [`/api/file/preview/${"0".repeat(64)}/report.html`, 404],
        ["/api/file/preview/not-a-capability/report.html", 400],
        [`/api/file/preview/${scope.id}/%2Foutside`, 400],
        [`/api/file/preview/${scope.id}`, 404],
      ] as const) {
        const response = await read(url);
        expect(response.status).toBe(status);
        expect(response.headers.has("access-control-allow-origin")).toBe(false);
      }
      for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
        const response = await read(scope.url, { method });
        expect(response.status).toBe(405);
        expect(response.headers.has("access-control-allow-origin")).toBe(false);
      }
      expect((await read(`/api/file/preview/${scope.id}?all=true`, { method: "DELETE" })).status).toBe(400);
      expect((await read("/api/file/preview/invalid", { method: "DELETE" })).status).toBe(404);
      expect((await read(scope.url)).status).toBe(200);
    });

    it("checks the renderer token before any capability/filesystem probing and shares the routed scope", async () => {
      services.desktopAccess = { token: "renderer-secret" };
      const headers = { "Content-Type": "application/json", [DESKTOP_ACCESS_HEADER]: "renderer-secret" };
      const path = entry();
      expect((await create({ path })).status).toBe(401);
      const scope = await (await create({ path }, { headers })).json() as HtmlPreviewDescriptor;
      const describe = vi.spyOn(services.directories, "describeFile");
      const requireCwd = vi.spyOn(services.directories, "requireCwd");
      for (const token of [undefined, "", "wrong-secret"]) {
        const request = new Request(`http://localhost${scope.url}`, {
          headers: { Origin: "null", ...(token === undefined ? {} : { [DESKTOP_ACCESS_HEADER]: token }) },
        });
        expect(handler.allowsOpaquePreviewOrigin?.(request)).toBe(false);
        expect((await handler(request)).status).toBe(401);
      }
      expect(describe).not.toHaveBeenCalled();
      expect(requireCwd).not.toHaveBeenCalled();
      const opaque = { ...headers, Origin: "null" };
      const request = new Request(`http://localhost${scope.url}`, { headers: opaque });
      expect(handler.allowsOpaquePreviewOrigin?.(request)).toBe(true);
      expect((await handler(request)).status).toBe(200);
      for (const [url, method] of [["/api/status", "GET"], ["/api/file/raw", "GET"], ["/api/file/preview", "POST"], [`/api/file/preview/${scope.id}`, "DELETE"], [scope.url, "POST"]]) {
        expect(handler.allowsOpaquePreviewOrigin?.(new Request(`http://localhost${url}`, { method, headers: opaque }))).toBe(false);
      }
      await read(`/api/file/preview/${scope.id}`, { method: "DELETE", headers });
      expect(handler.allowsOpaquePreviewOrigin?.(request)).toBe(false);
    });

    it("keeps lifecycle-token controls ahead of renderer authentication", async () => {
      services.desktopAccess = { token: "renderer" };
      services.daemonControl = { token: "lifecycle", runtimeId: "test-runtime", requestShutdown: vi.fn() };
      const headers = { [DAEMON_TOKEN_HEADER]: "lifecycle" };
      const info = await read(DAEMON_CONTROL_PATH, { headers });
      expect(info.status).toBe(200);
      expect(await info.json()).toEqual({ runtimeId: "test-runtime" });
      expect((await read(DAEMON_CONTROL_PATH, { method: "POST", headers })).status).toBe(200);
      expect(services.daemonControl.requestShutdown).toHaveBeenCalledOnce();
    });

    it("closes preview scopes alongside the existing route-owned file operations", async () => {
      const path = entry();
      const scope = await (await create({ path })).json() as HtmlPreviewDescriptor;
      await handler.close?.();
      expect((await read(scope.url)).status).toBe(404);
      expect((await create({ path })).status).toBe(503);
      expect((await put()).status).toBe(503);
    });
  });

  it("isolates raw active documents while preserving original source bytes and inline passive downloads", async () => {
    for (const [name, content, active, attachment] of [
      ["report.HTML", "<script>window.attacker=true</script>", true, true],
      ["report.htm", "<html>source</html>", true, true],
      ["figure.SVG", "<svg xmlns=\"http://www.w3.org/2000/svg\"><style>rect{fill:red}</style><rect width=\"4\" height=\"4\"/></svg>", true, false],
      ["document.xml", "<?xml version=\"1.0\"?><root/>", true, false],
      ["paper.pdf", "%PDF-fixture", false, false],
      ["paper.docx", "PK-fixture", false, false],
      ["image.png", "PNG-fixture", false, false],
      ["clip.mp4", "MP4-fixture", false, false],
    ] as const) {
      const path = join(cwd, name);
      fs.writeFileSync(path, content);
      const target = `http://localhost/api/file/raw?${new URLSearchParams({ path, revision: "1" })}`;
      const response = await handler(new Request(target));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(content);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.has("access-control-allow-origin")).toBe(false);
      expect(response.headers.has("content-disposition")).toBe(attachment);
      expect(response.headers.has("content-security-policy")).toBe(active);
      if (active) {
        const csp = response.headers.get("content-security-policy")!;
        expect(csp.split(";").map((directive) => directive.trim())).toContain("sandbox");
        expect(csp).toContain("script-src 'none'");
        expect(csp).not.toContain("allow-scripts");
        expect(csp).not.toContain("allow-same-origin");
      }
      const download = await handler(new Request(`${target}&download=1`));
      expect(download.headers.get("content-disposition")).toContain("attachment;");
      expect(await download.text()).toBe(content);
    }
  });
});
