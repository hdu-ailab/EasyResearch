import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DirectoryService, DirectoryServiceError, FILE_PREVIEW_LIMIT } from "./directories";
import {
  HTML_PREVIEW_IDLE_MS, HTML_PREVIEW_PATH, HTML_PREVIEW_SCOPE_LIMIT,
  HtmlPreviewError, HtmlPreviewService,
} from "./html-preview";

const origin = "http://127.0.0.1:43123";
let home: string;
let root: string;
let entry: string;
let now: number;
let directories: DirectoryService;
let service: HtmlPreviewService;

beforeEach(() => {
  home = fs.mkdtempSync(join(tmpdir(), "html-preview-"));
  root = join(home, "report");
  fs.mkdirSync(root);
  entry = join(root, "报告 # 100%.HTML");
  fs.writeFileSync(entry, "<!doctype html><p>interactive report</p>");
  now = 1000;
  directories = new DirectoryService(home);
  service = new HtmlPreviewService(directories, { now: () => now });
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("EASYRESEARCH_CODING_AGENT_DIR", join(home, "agent"));
});

afterEach(() => {
  service.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

function request(path: string, init?: RequestInit): Request {
  return new Request(origin + path, init);
}

async function resource(path: string, init?: RequestInit): Promise<Response> {
  const response = await service.resource(request(path, init));
  expect(response).not.toBeNull();
  return response!;
}

function policyDirectives(value: string): Map<string, string[]> {
  return new Map(value.split(";").map((part) => {
    const [name, ...sources] = part.trim().split(/\s+/u);
    return [name!, sources];
  }));
}

describe("HTML preview capabilities", () => {
  it("uses independent boot-local capabilities and preserves encoded filenames and complete HTML", async () => {
    const content = "<script>window.answer=42</script>" + "x".repeat(FILE_PREVIEW_LIMIT) + "<!--complete-->";
    fs.writeFileSync(entry, content);
    const first = service.create(entry);
    const second = service.create(entry);
    expect(first.id).not.toBe(second.id);
    expect(first.url).toBe(`${HTML_PREVIEW_PATH}/${first.id}/${encodeURIComponent("报告 # 100%.HTML")}`);
    const response = await resource(first.url);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toBe(content);
    const anotherBoot = new HtmlPreviewService(directories);
    expect(anotherBoot.isValidResourceRequest(request(first.url))).toBe(false);
    anotherBoot.close();
    service.release(first.id);
    service.release(first.id);
    expect((await resource(first.url)).status).toBe(404);
    expect(service.isValidResourceRequest(request(second.url))).toBe(true);
  });

  it.each(["relative.html", "/report.txt", "/report.html\0", "/report\n.html"])(
    "rejects an invalid creation path %j without allocating a scope", (path) => {
      expect(() => service.create(path)).toThrow(HtmlPreviewError);
      try { service.create(path); } catch (error) { expect(error).toMatchObject({ status: 400 }); }
    },
  );

  it("keeps missing and directory targets typed", () => {
    expect(() => service.create(join(root, "missing.html"))).toThrow(expect.objectContaining({ status: 404 }));
    const directory = join(root, "folder.html");
    fs.mkdirSync(directory);
    expect(() => service.create(directory)).toThrow(expect.objectContaining({ status: 400 }));
  });

  it("rejects an escaping leaf symlink while allowing an in-scope entry alias", async () => {
    const outside = join(home, "outside.html");
    fs.writeFileSync(outside, "must not be served");
    const link = join(root, "escape.html");
    fs.symlinkSync(outside, link, "file");
    expect(() => service.create(link)).toThrow(expect.objectContaining({ status: 403 }));
    const inside = join(root, "alias.html");
    fs.symlinkSync(entry, inside, "file");
    const scope = service.create(inside);
    expect(await (await resource(scope.url)).text()).toBe(fs.readFileSync(entry, "utf8"));
  });

  it("freezes a symlink parent's canonical directory even when the alias is later retargeted", async () => {
    const alias = join(home, "alias");
    const outside = join(home, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(join(outside, "report.html"), "outside");
    fs.writeFileSync(join(root, "report.html"), "original directory");
    fs.symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");
    const scope = service.create(join(alias, "report.html"));
    fs.rmSync(alias);
    fs.symlinkSync(outside, alias, process.platform === "win32" ? "junction" : "dir");
    expect(await (await resource(scope.url)).text()).toBe("original directory");
  });

  it("rejects a canonical root replaced by an escaping directory symlink", async () => {
    const scope = service.create(entry);
    fs.renameSync(root, join(home, "original"));
    const outside = join(home, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(join(outside, "报告 # 100%.HTML"), "outside");
    fs.symlinkSync(outside, root, process.platform === "win32" ? "junction" : "dir");
    expect(service.isValidResourceRequest(request(scope.url))).toBe(false);
    const response = await resource(scope.url);
    expect(response.status).toBe(403);
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
  });

  it("bounds allocations without evicting live views, and recovers a released or expired slot", () => {
    const scopes = Array.from({ length: HTML_PREVIEW_SCOPE_LIMIT }, () => service.create(entry));
    expect(() => service.create(entry)).toThrow(expect.objectContaining({ status: 429 }));
    expect(scopes.every((scope) => service.isValidResourceRequest(request(scope.url)))).toBe(true);
    service.release(scopes[0]!.id);
    expect(service.create(entry).id).not.toBe(scopes[0]!.id);
    now += HTML_PREVIEW_IDLE_MS;
    const fresh = service.create(entry);
    expect(service.isValidResourceRequest(request(fresh.url))).toBe(true);
    expect(service.isValidResourceRequest(request(scopes[1]!.url))).toBe(false);
  });

  it("expires at the inactivity boundary without renewing on admission probes or failed resources", async () => {
    const scope = service.create(entry);
    now += HTML_PREVIEW_IDLE_MS - 1;
    expect(service.isValidResourceRequest(request(scope.url))).toBe(true);
    const missing = new URL("missing.js", origin + scope.url).pathname;
    expect((await resource(missing)).status).toBe(404);
    now++;
    expect(service.isValidResourceRequest(request(scope.url))).toBe(false);
    expect((await resource(scope.url)).status).toBe(404);
  });

  it("renews on a readable GET or HEAD access, then expires relative to that access", async () => {
    const scope = service.create(entry);
    now += HTML_PREVIEW_IDLE_MS - 1;
    expect((await resource(scope.url, { method: "HEAD" })).status).toBe(200);
    now += HTML_PREVIEW_IDLE_MS - 1;
    expect(service.isValidResourceRequest(request(scope.url))).toBe(true);
    expect((await resource(scope.url)).status).toBe(200);
    now += HTML_PREVIEW_IDLE_MS;
    expect((await resource(scope.url)).status).toBe(404);
  });

  it.each(["release", "close"])("does not publish an awaited resource after %s", async (action) => {
    const scope = service.create(entry);
    let finish!: (body: Blob) => void;
    vi.spyOn(directories, "readFileBody").mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const pending = service.resource(request(scope.url));
    if (action === "close") service.close();
    else service.release(scope.id);
    finish(new Blob(["must not escape disposal"]));
    const response = await pending;
    expect(response?.status).toBe(404);
    expect(response?.headers.has("access-control-allow-origin")).toBe(false);
    if (action === "close") expect(() => service.create(entry)).toThrow(expect.objectContaining({ status: 503 }));
  });
});

describe("HTML resource paths and response isolation", () => {
  it("serves native nested dependencies with MIME and ignores queries as filesystem authority", async () => {
    const scope = service.create(entry);
    const fixtures: Record<string, [string, string]> = {
      "assets/style.css": ["@import './nested.css'; body { color: green }", "text/css"],
      "assets/module.mjs": ["export const answer = 42", "text/javascript"],
      "assets/data.json": ["{\"answer\":42}", "application/json"],
      "assets/图 # %.svg": ["<svg xmlns=\"http://www.w3.org/2000/svg\"/>", "image/svg+xml"],
      "assets/%2e%2e": ["literal percent sequences are not a second traversal", "application/octet-stream"],
    };
    fs.mkdirSync(join(root, "assets"));
    for (const [path, [content, mime]] of Object.entries(fixtures)) {
      fs.writeFileSync(join(root, path), content);
      const encoded = path.split("/").map(encodeURIComponent).join("/");
      const url = `${HTML_PREVIEW_PATH}/${scope.id}/${encoded}?path=${encodeURIComponent(join(home, "secret"))}&v=1`;
      expect(service.isValidResourceRequest(request(url))).toBe(true);
      const response = await resource(url);
      expect(response.headers.get("content-type")).toContain(mime);
      expect(await response.text()).toBe(content);
    }
  });

  it.each(["%00", "%0a", "%", "%ff", "%2fsecret", "%5csecret", "C%3Asecret", "a//b", "assets/", "..%5coutside.html"])(
    "rejects malformed or non-relative components %s without CORS", async (suffix) => {
      const scope = service.create(entry);
      const url = `${HTML_PREVIEW_PATH}/${scope.id}/${suffix}`;
      expect(service.isValidResourceRequest(request(url))).toBe(false);
      const response = await resource(url);
      expect(response.status).toBe(400);
      expect(response.headers.has("access-control-allow-origin")).toBe(false);
      expect(response.headers.has("location")).toBe(false);
    },
  );

  it("does not turn URL-normalized traversal into a directory listing or application resource", async () => {
    const scope = service.create(entry);
    for (const suffix of ["../outside.html", "%2e%2e/outside.html", "../../../../api/status"]) {
      const attempted = request(`${HTML_PREVIEW_PATH}/${scope.id}/${suffix}`);
      expect(service.isValidResourceRequest(attempted)).toBe(false);
      const response = await service.resource(attempted);
      expect(response === null || response.status >= 400).toBe(true);
    }
    fs.mkdirSync(join(root, "assets"));
    expect((await resource(`${HTML_PREVIEW_PATH}/${scope.id}/assets`)).status).toBe(400);
  });

  it("rejects file and parent-directory symlink escapes on each access", async () => {
    const scope = service.create(entry);
    const outside = join(home, "report-sibling");
    fs.mkdirSync(outside);
    fs.writeFileSync(join(outside, "secret.js"), "sensitive bytes");
    fs.symlinkSync(join(outside, "secret.js"), join(root, "escape.js"), "file");
    fs.symlinkSync(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
    for (const suffix of ["escape.js", "escape/secret.js"]) {
      const url = `${HTML_PREVIEW_PATH}/${scope.id}/${suffix}`;
      expect(service.isValidResourceRequest(request(url))).toBe(false);
      const response = await resource(url);
      expect(response.status).toBe(403);
      expect(response.headers.has("access-control-allow-origin")).toBe(false);
      expect(await response.text()).not.toContain("sensitive bytes");
    }
    fs.unlinkSync(entry);
    fs.symlinkSync(join(outside, "secret.js"), entry, "file");
    expect((await resource(scope.url)).status).toBe(403);
  });

  it("leaves create/release and unrelated routes to the owning router", async () => {
    const scope = service.create(entry);
    for (const [path, method] of [[HTML_PREVIEW_PATH, "POST"], [`${HTML_PREVIEW_PATH}/${scope.id}`, "DELETE"], ["/api/status", "GET"]]) {
      const req = request(path!, { method });
      expect(service.isValidResourceRequest(req)).toBe(false);
      expect(await service.resource(req)).toBeNull();
    }
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])("rejects resource mutation/preflight %s", async (method) => {
    const scope = service.create(entry);
    const before = fs.readFileSync(entry);
    expect(service.isValidResourceRequest(request(scope.url, { method }))).toBe(false);
    const response = await resource(scope.url, { method });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
    expect(response.headers.has("access-control-allow-methods")).toBe(false);
    expect(fs.readFileSync(entry)).toEqual(before);
    expect(service.isValidResourceRequest(request(scope.url))).toBe(true);
  });

  it("intersects own-origin and capability-prefix policies without granting application endpoints", async () => {
    const scope = service.create(entry);
    const response = await resource(scope.url, { headers: { Origin: "null", Authorization: "renderer-secret" } });
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.has("access-control-allow-credentials")).toBe(false);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const policies = response.headers.get("content-security-policy")!.split(",").map(policyDirectives);
    const ownOrigin = policies.find((policy) => policy.get("connect-src")?.includes("'self'"))!;
    const prefix = policies.find((policy) => policy !== ownOrigin)!;
    expect(ownOrigin).toBeDefined();
    expect(prefix.get("connect-src")).toEqual([`*:*${HTML_PREVIEW_PATH}/${scope.id}/`]);
    for (const policy of policies) {
      expect(policy.get("sandbox")).toEqual(["allow-scripts"]);
      for (const directive of ["default-src", "worker-src", "frame-src", "object-src", "base-uri", "form-action"]) {
        expect(policy.get(directive)).toEqual(["'none'"]);
      }
      expect(policy.get("frame-ancestors")).toEqual(["'self'"]);
      const source = policy.get("connect-src")![0]!;
      expect(policy.get("script-src")).toEqual(expect.arrayContaining([source, "'unsafe-inline'", "'unsafe-eval'"]));
      expect(policy.get("style-src")).toEqual(expect.arrayContaining([source, "'unsafe-inline'"]));
      for (const directive of ["img-src", "media-src", "font-src"]) {
        expect(policy.get(directive)).toEqual(expect.arrayContaining([source, "data:", "blob:"]));
      }
    }
    for (const directive of ["script-src", "style-src", "img-src", "media-src", "font-src", "connect-src"]) {
      expect(prefix.get(directive)).not.toContain("'self'");
    }
    expect(JSON.stringify(Object.fromEntries(response.headers))).not.toContain("renderer-secret");
    const another = service.create(entry);
    const anotherResponse = await resource(another.url);
    expect(anotherResponse.headers.get("content-security-policy")).toContain(`/${another.id}/`);
    expect(anotherResponse.headers.get("content-security-policy")).not.toContain(`/${scope.id}/`);
  });

  it.each(["bytes=99999-", "bytes=0-1,3-4", "bytes=-0", "items=0-1"])("keeps invalid ranges typed: %s", async (range) => {
    const scope = service.create(entry);
    const read = vi.spyOn(directories, "readFileBody");
    const response = await resource(scope.url, { headers: { Range: range } });
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe(`bytes */${fs.statSync(entry).size}`);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(read).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({ error: "Invalid byte range" });
  });

  it("keeps a checked range's full body for Bun rather than creating an artificial partial response", async () => {
    const scope = service.create(entry);
    const response = await resource(scope.url, { headers: { Range: "bytes=2-8" } });
    expect(response.status).toBe(200);
    expect(response.headers.has("content-range")).toBe(false);
    expect(response.headers.has("content-length")).toBe(false);
    expect(await response.text()).toBe(fs.readFileSync(entry, "utf8"));
  });

  it("redacts unexpected and typed failures rather than reflecting credentials or request headers", async () => {
    const scope = service.create(entry);
    for (const error of [new Error("private-header-value"), new DirectoryServiceError(403, "private-header-value")]) {
      vi.spyOn(directories, "readFileBody").mockRejectedValueOnce(error);
      const response = await resource(scope.url, { headers: { Authorization: "private-header-value" } });
      expect(response.status).toBe(error instanceof DirectoryServiceError ? error.status : 500);
      expect(JSON.stringify(Object.fromEntries(response.headers))).not.toContain("private-header-value");
      expect(await response.text()).not.toContain("private-header-value");
      expect(response.headers.has("access-control-allow-origin")).toBe(false);
    }
  });
});
