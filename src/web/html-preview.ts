import { randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { DirectoryServiceError, fileServiceError, type DirectoryService } from "./directories";
import { parseByteRange, RawFileRangeError, type RawFileDescriptor } from "./raw-file";

export const HTML_PREVIEW_PATH = "/api/file/preview";
export const HTML_PREVIEW_SCOPE_LIMIT = 128;
export const HTML_PREVIEW_IDLE_MS = 30 * 60 * 1000;

export interface HtmlPreviewDescriptor {
  id: string;
  url: string;
}

interface PreviewScope {
  root: string;
  accessedAt: number;
}

interface PreviewResource {
  id: string;
  scope: PreviewScope;
  file: RawFileDescriptor;
}

type PreviewDirectories = Pick<DirectoryService, "requireCwd" | "describeFile" | "readFileBody">;

/** Expected errors remain compatible with the router's DirectoryServiceError handling. */
export class HtmlPreviewError extends DirectoryServiceError {}

/**
 * Boot-local, read-only capabilities. The router owns authentication and JSON
 * creation/release routes; this service owns no listener, timer or Agent state.
 */
export class HtmlPreviewService {
  private readonly scopes = new Map<string, PreviewScope>();
  private readonly now: () => number;
  private closed = false;

  constructor(private readonly directories: PreviewDirectories, options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  create(path: string): HtmlPreviewDescriptor {
    const now = this.now();
    this.prune(now);
    if (this.closed) throw new HtmlPreviewError(503, "HTML previews are unavailable.");
    if (typeof path !== "string" || !isAbsolute(path) || /[\x00-\x1f\x7f]/u.test(path)
      || !/\.html?$/iu.test(path)) {
      throw new HtmlPreviewError(400, "Choose an absolute HTML or HTM file path.");
    }
    try {
      // Resolve the selected parent first: a leaf symlink must not grant its
      // target's parent directory, even though ordinary raw reads can follow it.
      const root = this.directories.requireCwd(dirname(path));
      const file = this.directories.describeFile(path);
      assertContained(root, file.path);
      const name = basename(path);
      validateSegments([name]);
      if (this.scopes.size >= HTML_PREVIEW_SCOPE_LIMIT) {
        throw new HtmlPreviewError(429, "Too many HTML previews. Close a preview and retry.");
      }
      let id: string;
      do { id = randomBytes(32).toString("hex"); } while (this.scopes.has(id));
      this.scopes.set(id, { root, accessedAt: now });
      return { id, url: `${HTML_PREVIEW_PATH}/${id}/${encodeURIComponent(name)}` };
    } catch (error) {
      throw previewError(error);
    }
  }

  /** Idempotent; releasing one view never releases another view of the same file. */
  release(id: string): void {
    this.prune(this.now());
    this.scopes.delete(id);
  }

  close(): void {
    this.closed = true;
    this.scopes.clear();
  }

  /**
   * Synchronous outer-admission gate, including canonical file containment.
   * Call only after renderer authentication. A probe never renews the idle lease;
   * resource() validates again and renews it only when serving a readable file.
   */
  isValidResourceRequest(request: Request): boolean {
    this.prune(this.now());
    if (!isRead(request) || !isResourcePath(new URL(request.url).pathname)) return false;
    try {
      this.resolveResource(request);
      return true;
    } catch {
      return false;
    }
  }

  /** Returns null for other routes, including the JSON create/release endpoints. */
  async resource(request: Request): Promise<Response | null> {
    const now = this.now();
    this.prune(now);
    if (!isResourcePath(new URL(request.url).pathname)) return null;
    if (!isRead(request)) {
      return failureResponse(new HtmlPreviewError(405, "HTML preview resources are read-only."), {
        Allow: "GET, HEAD",
      });
    }
    let resource: PreviewResource;
    try {
      resource = this.resolveResource(request);
    } catch (error) {
      return failureResponse(previewError(error));
    }

    const { id, scope, file } = resource;
    const headers = resourceHeaders(id);
    const range = request.headers.get("range");
    try {
      parseByteRange(range, file.size);
      scope.accessedAt = now;
      // Do not slice or freeze Content-Length/Content-Range from the earlier
      // descriptor. Bun opens this full file body and owns GET/HEAD/range bytes.
      const body = await this.directories.readFileBody(file.path, null);
      this.prune(this.now());
      if (this.scopes.get(id) !== scope) return failureResponse(unavailableScope());
      headers.set("Content-Type", file.mimeType);
      if (range === null) headers.set("Accept-Ranges", "bytes");
      return new Response(body, { headers });
    } catch (error) {
      if (error instanceof RawFileRangeError) {
        headers.set("Content-Range", `bytes */${file.size}`);
        return failureResponse(new HtmlPreviewError(416, "Invalid byte range"), headers);
      }
      // Blob preparation errors are typed here; native late-open errors still
      // belong to Bun.serve's existing rawFileErrorResponse boundary.
      return failureResponse(previewError(error));
    }
  }

  private prune(now: number): void {
    for (const [id, scope] of this.scopes) {
      if (now - scope.accessedAt >= HTML_PREVIEW_IDLE_MS) this.scopes.delete(id);
    }
  }

  private resolveResource(request: Request): PreviewResource {
    const path = new URL(request.url).pathname;
    const match = /^\/api\/file\/preview\/([a-f0-9]{64})\/(.+)$/u.exec(path);
    if (!match) throw new HtmlPreviewError(400, "Invalid HTML preview resource path.");
    const id = match[1]!;
    const scope = this.scopes.get(id);
    if (this.closed || !scope) throw unavailableScope();
    let segments: string[];
    try {
      // A URL is decoded once per component. A literal percent sequence in a
      // filename remains literal; it is never decoded again by a filesystem API.
      segments = match[2]!.split("/").map((part) => decodeURIComponent(part));
    } catch {
      throw new HtmlPreviewError(400, "Invalid HTML preview resource path.");
    }
    validateSegments(segments);
    const root = this.directories.requireCwd(scope.root);
    if (root !== scope.root) throw outsideScope();
    const target = resolve(root, ...segments);
    assertContained(root, target);
    const file = this.directories.describeFile(target);
    assertContained(root, file.path);
    return { id, scope, file };
  }
}

function isRead(request: Request): boolean {
  return request.method === "GET" || request.method === "HEAD";
}

function isResourcePath(path: string): boolean {
  return path.startsWith(`${HTML_PREVIEW_PATH}/`) && path.slice(HTML_PREVIEW_PATH.length + 1).includes("/");
}

function validateSegments(segments: string[]): void {
  if (segments.some((part) => !part || part === "." || part === ".." || /[\\/:\x00-\x1f\x7f]/u.test(part))) {
    throw new HtmlPreviewError(400, "Invalid HTML preview resource path.");
  }
}

function assertContained(root: string, path: string): void {
  const suffix = relative(root, path);
  if (isAbsolute(suffix) || suffix === ".." || suffix.startsWith(`..${sep}`)) throw outsideScope();
}

function outsideScope(): HtmlPreviewError {
  return new HtmlPreviewError(403, "HTML preview resource is outside its directory.");
}

function unavailableScope(): HtmlPreviewError {
  return new HtmlPreviewError(404, "HTML preview expired or was closed. Reload the preview.");
}

function previewError(error: unknown): HtmlPreviewError {
  if (error instanceof HtmlPreviewError) return error;
  const fileError = error instanceof DirectoryServiceError ? error : fileServiceError(error, "");
  switch (fileError?.status) {
    case 400: return new HtmlPreviewError(400, "Preview target is not a regular file.");
    case 403: return new HtmlPreviewError(403, "Preview file is not readable.");
    case 404: return new HtmlPreviewError(404, "Preview file or directory no longer exists.");
    default: return new HtmlPreviewError(500, "Unable to load HTML preview resource.");
  }
}

function scopePolicy(source: string): string {
  return [
    "sandbox allow-scripts", "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' ${source}`,
    `style-src 'unsafe-inline' ${source}`,
    `img-src ${source} data: blob:`, `media-src ${source} data: blob:`, `font-src ${source} data: blob:`,
    `connect-src ${source}`, "worker-src 'none'", "frame-src 'none'", "object-src 'none'",
    "base-uri 'none'", "form-action 'none'", "frame-ancestors 'self'",
  ].join("; ");
}

function resourceHeaders(id: string): Headers {
  return new Headers({
    // Separate policies intersect. Putting both sources in ONE directive would
    // instead allow all same-origin APIs. No browser-facing authority is guessed.
    "Content-Security-Policy": `${scopePolicy("'self'")}, ${scopePolicy(`*:*${HTML_PREVIEW_PATH}/${id}/`)}`,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
}

function failureResponse(error: HtmlPreviewError, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  if (!headers.has("Content-Security-Policy")) {
    headers.set("Content-Security-Policy", "sandbox; default-src 'none'; frame-ancestors 'self'");
  }
  return new Response(JSON.stringify({ error: error.message }), { status: error.status, headers });
}
