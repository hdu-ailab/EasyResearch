import assert from "node:assert/strict";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { request as requestHttp } from "node:http";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import type { importPi } from "../src/runtime/pi-import";
import type { FileContentDto, FileEntryDto, FileRenameResultDto, FileUploadResultDto } from "../src/web/contracts";

type Pi = Awaited<ReturnType<typeof importPi>>;
type WireResponse = { status: number; headers: Headers; bytes: Buffer };

/** The timer owns both receiving headers and draining the body, including error bodies. */
async function requestBeforeDeadline(url: string, deadline: number, init: RequestInit = {}): Promise<WireResponse> {
  const remaining = deadline - Date.now();
  const label = `${init.method ?? "GET"} ${new URL(url).pathname}`;
  assert(remaining > 0, `${label}: work file smoke deadline exhausted`);
  const abort = new AbortController();
  let response: Response | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operation = async () => {
    response = await fetch(url, { ...init, signal: abort.signal, proxy: "" });
    const bytes = Buffer.from(await response.arrayBuffer());
    assert(Date.now() < deadline, `${label}: response body exceeded work file smoke deadline`);
    return { status: response.status, headers: response.headers, bytes };
  };
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      try {
        void response?.body?.cancel().catch(() => {});
      } catch {
        // arrayBuffer may already hold the reader; AbortSignal and this race still bound it.
      }
      reject(new Error(`${label}: response did not finish before work file smoke deadline`));
    }, remaining);
  });
  try {
    return await Promise.race([operation(), timeout]);
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}

function assertStatus(response: WireResponse, status: number, label: string): void {
  assert.equal(response.status, status, `${label}: ${response.bytes.toString("utf8", 0, 300)}`);
}

function jsonValue<T>(response: WireResponse, status: number, label: string): T {
  assertStatus(response, status, label);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/i, label);
  const value = JSON.parse(response.bytes.toString("utf8"));
  if (status >= 400) assert.equal(typeof value.error, "string", `${label}: typed error body`);
  return value as T;
}

function assertAttachment(headers: Headers, name: string): void {
  const disposition = headers.get("content-disposition") ?? "";
  assert.match(disposition, /^attachment\s*;/i);
  assert.match(disposition, /;\s*filename="[\x20-\x7e]+"(?:;|$)/i, "ASCII filename fallback is required");
  const encoded = disposition.match(/;\s*filename\*=UTF-8''([^;]+)/i)?.[1];
  assert(encoded, "UTF-8 attachment filename is required");
  assert.equal(decodeURIComponent(encoded), name);
  assert(!/[^\x20-\x7e]/.test(disposition), "Attachment header must be ASCII and contain no control bytes");
}

/** Abort only after disk evidence proves an unfinished real HTTP body reached staging. */
async function cancelStagedUpload(url: string, directory: string, name: string, deadline: number): Promise<void> {
  const stopAt = Math.min(deadline, Date.now() + 5_000);
  assert(stopAt > Date.now(), "Canceled upload smoke deadline exhausted");
  assert.deepEqual(readdirSync(directory), []);
  const prefix = Buffer.alloc(32 * 1024, 0xa7);
  let failure: Error | undefined;
  let closed = false;
  let cancelling = false;
  const request = requestHttp(url, {
    method: "PUT",
    agent: false,
    headers: { "Content-Type": "application/octet-stream", "Transfer-Encoding": "chunked" },
  });
  request.on("error", (error) => { if (!cancelling) failure = error; });
  request.on("close", () => { closed = true; });
  request.on("response", (response) => {
    failure = new Error(`Unfinished upload returned HTTP ${response.statusCode} before cancellation`);
    response.destroy();
  });
  const waitFor = async (condition: () => boolean, label: string) => {
    while (Date.now() < stopAt) {
      if (failure) throw failure;
      assert(!existsSync(join(directory, name)), "Incomplete upload must not publish its final name");
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, Math.min(20, Math.max(1, stopAt - Date.now()))));
    }
    throw new Error(`Canceled upload did not ${label} before its bounded deadline`);
  };
  try {
    // No end()/last chunk: the server cannot validly publish this request.
    request.write(prefix);
    await waitFor(() => {
      const staged = readdirSync(directory);
      if (staged.length !== 1) return false;
      const path = join(directory, staged[0]!);
      return statSync(path).size === prefix.length && readFileSync(path).equals(prefix);
    }, "write the controlled prefix to staging");
    cancelling = true;
    request.destroy();
    await waitFor(() => closed && readdirSync(directory).length === 0, "close and remove its staging file");
  } finally {
    cancelling = true;
    request.destroy();
  }
}

/** Uses the already-owned native daemon and isolated Pi store; never prompts a model. */
export async function smokeWorkFileOperations(base: string, pi: Pi, root: string, deadline: number): Promise<void> {
  const agentRelative = relative(root, pi.getAgentDir());
  assert(agentRelative && !isAbsolute(agentRelative) && agentRelative !== ".." && !agentRelative.startsWith(`..${sep}`),
    "Work file smoke requires the caller's isolated Pi agent directory below its root");
  assert(deadline > Date.now(), "Work file smoke deadline exhausted");
  const cwd = join(root, "work-files-native");
  const directory = join(cwd, "资料 uploads");
  const cancelledDirectory = join(cwd, "cancelled");
  mkdirSync(directory, { recursive: true });
  mkdirSync(cancelledDirectory);
  const history = pi.SessionManager.create(cwd);
  history.appendMessage({ role: "user", content: "Native work file fixture", timestamp: Date.now() });
  history.appendMessage({
    role: "assistant", content: [{ type: "text", text: "Native work file fixture ready" }],
    api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "stop", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  history.appendSessionInfo("Native work file operations");
  const sessionPath = history.getSessionFile();
  assert(sessionPath && existsSync(sessionPath), "Native SessionManager must persist the known workspace");
  const historyBytes = readFileSync(sessionPath);
  const url = (path: string, query: Record<string, string> = {}) => `${base}${path}?${new URLSearchParams(query)}`;
  const request = (path: string, query: Record<string, string> = {}, init?: RequestInit) =>
    requestBeforeDeadline(url(path, query), deadline, init);
  const uploadRequest = (workspace: string, target: string, name: string, bytes: Buffer) =>
    request("/api/file/upload", { cwd: workspace, directory: target, name }, {
      method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: new Uint8Array(bytes),
    });
  const renameRequest = (path: string, name: string) => request("/api/file/rename", {}, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd, path, name }),
  });
  const upload = async (target: string, name: string, bytes: Buffer) => {
    const result = jsonValue<FileUploadResultDto>(await uploadRequest(cwd, target, name, bytes), 201, `upload ${name}`);
    assert.deepEqual(result, { entry: { kind: "file", name, path: join(target, name) } });
    assert.deepEqual(readFileSync(result.entry.path), bytes, `upload ${name}: disk bytes`);
    return result.entry;
  };
  const fullRead = async (path: string, bytes: Buffer, download = false) => {
    const response = await request("/api/file/raw", download ? { path, download: "1" } : { path });
    assertStatus(response, 200, `read ${basename(path)}`);
    assert.deepEqual(response.bytes, bytes, `read ${basename(path)}: complete original bytes`);
    assert.equal(response.headers.get("content-length"), String(bytes.length));
    assert.equal(response.headers.get("content-range"), null);
    assert.equal(response.headers.get("transfer-encoding"), null);
    assert.equal(response.headers.get("accept-ranges"), "bytes");
    if (download) assertAttachment(response.headers, basename(path));
    else assert(!/^attachment\b/i.test(response.headers.get("content-disposition") ?? ""), "Inline raw reads must stay inline");
    return response;
  };

  const status = jsonValue<{ sessions: Array<{ id: string; path: string; cwd: string }> }>(
    await request("/api/status"), 200, "known workspace discovery",
  );
  assert(status.sessions.some((session) => session.id === history.getSessionId() && session.path === sessionPath && session.cwd === cwd),
    "Compiled daemon must discover the exact native fixture workspace");

  const empty = await upload(cwd, "empty.txt", Buffer.alloc(0));
  await fullRead(empty.path, Buffer.alloc(0), true);
  const binary = Buffer.alloc(2 * 1024 * 1024 + 17);
  for (let i = 0; i < binary.length; i++) binary[i] = (i * 73 + 29) & 0xff;
  const original = await upload(directory, "研究 🐬 100% +.bin", binary);
  await fullRead(original.path, binary, true);
  jsonValue(await uploadRequest(cwd, directory, original.name, Buffer.from("must not replace original")), 409, "duplicate upload");
  assert.deepEqual(readFileSync(original.path), binary, "Conflict must preserve the original on disk");
  await fullRead(original.path, binary);

  const text = Buffer.from("First line\r\n研究 🐬 — exact text bytes\n", "utf8");
  const opened = await upload(directory, "before.txt", text);
  const before = jsonValue<FileContentDto>(await request("/api/file", { path: opened.path }), 200, "open original file");
  assert.deepEqual(before, { path: opened.path, content: text.toString("utf8"), byteCount: text.length, truncated: false, binary: false });
  jsonValue(await renameRequest(opened.path, original.name), 409, "rename conflict");
  assert.deepEqual(readFileSync(opened.path), text);
  assert.deepEqual(readFileSync(original.path), binary);

  for (const name of ["../escape.bin", "..\\escape.bin"]) {
    jsonValue(await uploadRequest(cwd, directory, name, text), 400, "upload basename traversal");
    jsonValue(await renameRequest(opened.path, name), 400, "rename basename traversal");
  }
  jsonValue(await uploadRequest(cwd, root, "outside-upload.bin", text), 403, "upload outside workspace");
  jsonValue(await uploadRequest(root, root, "unknown-workspace.bin", text), 404, "upload into unknown workspace");
  const outside = join(root, "work-files-outside.txt");
  writeFileSync(outside, "outside workspace sentinel");
  jsonValue(await renameRequest(outside, "outside-renamed.txt"), 403, "rename outside workspace");
  assert.equal(readFileSync(outside, "utf8"), "outside workspace sentinel");
  for (const forbidden of [join(cwd, "escape.bin"), join(root, "outside-upload.bin"), join(root, "unknown-workspace.bin"), join(root, "outside-renamed.txt")]) {
    assert(!existsSync(forbidden), `Rejected mutation created ${forbidden}`);
  }
  assert.deepEqual(readFileSync(opened.path), text, "Rejected renames preserve the source");

  const renamedName = "重命名 🐬.md";
  const descriptor = openSync(opened.path, "r");
  let renamed: FileRenameResultDto;
  try {
    renamed = jsonValue<FileRenameResultDto>(await renameRequest(opened.path, renamedName), 200, "same-parent rename");
    assert.deepEqual(renamed, { oldPath: opened.path, entry: { kind: "file", name: renamedName, path: join(directory, renamedName) } });
    assert.equal(dirname(renamed.entry.path), dirname(opened.path));
    assert(!existsSync(renamed.oldPath));
    assert.deepEqual(readFileSync(descriptor), text, "An already-open file still reads the same bytes after rename");
    assert.deepEqual(readFileSync(renamed.entry.path), text);
  } finally {
    closeSync(descriptor);
  }
  const after = jsonValue<FileContentDto>(await request("/api/file", { path: renamed.entry.path }), 200, "read renamed file");
  assert.deepEqual(after, { ...before, path: renamed.entry.path }, "File reads must follow the accepted new identity");
  jsonValue(await request("/api/file", { path: opened.path }), 404, "old preview path removed");
  jsonValue(await request("/api/file/raw", { path: opened.path }), 404, "old raw path removed");
  const listing = jsonValue<{ path: string; entries: FileEntryDto[] }>(await request("/api/entries", { path: directory }), 200, "renamed directory entries");
  assert.equal(listing.path, directory);
  assert.deepEqual(listing.entries.filter((entry) => entry.path === renamed.entry.path), [renamed.entry]);
  assert(!listing.entries.some((entry) => entry.path === opened.path));
  await fullRead(renamed.entry.path, text, true);

  // Deterministic byte fixture for MIME/range transport; playback is a separate browser gate.
  const videoBytes = Buffer.from(binary.subarray(0, 64 * 1024 + 13));
  const video = await upload(directory, "range fixture.MP4", videoBytes);
  const fullVideo = await fullRead(video.path, videoBytes);
  assert.equal(fullVideo.headers.get("content-type"), "video/mp4");
  for (const range of [
    { value: "bytes=7-29", start: 7, end: 29 },
    { value: "bytes=-17", start: videoBytes.length - 17, end: videoBytes.length - 1 },
    { value: `bytes=${videoBytes.length - 31}-`, start: videoBytes.length - 31, end: videoBytes.length - 1 },
  ]) {
    const response = await request("/api/file/raw", { path: video.path }, { headers: { Range: range.value } });
    assertStatus(response, 206, range.value);
    assert.equal(response.headers.get("content-type"), "video/mp4");
    assert.equal(response.headers.get("content-range"), `bytes ${range.start}-${range.end}/${videoBytes.length}`);
    assert.equal(response.headers.get("content-length"), String(range.end - range.start + 1));
    assert.equal(response.headers.get("accept-ranges"), "bytes");
    assert.equal(response.headers.get("transfer-encoding"), null);
    assert.deepEqual(response.bytes, videoBytes.subarray(range.start, range.end + 1));
  }

  const cancelledName = "retry after cancel.bin";
  await cancelStagedUpload(url("/api/file/upload", { cwd, directory: cancelledDirectory, name: cancelledName }), cancelledDirectory, cancelledName, deadline);
  const retried = await upload(cancelledDirectory, cancelledName, text);
  await fullRead(retried.path, text);
  assert.deepEqual(readdirSync(cancelledDirectory), [cancelledName], "Retry must leave no upload staging files");

  const previewDirectory = join(cwd, "html-preview");
  mkdirSync(join(previewDirectory, "assets"), { recursive: true });
  const htmlPath = join(previewDirectory, "interactive report.html");
  const html = Buffer.from("<!doctype html><button id='count'>0</button><script>count.onclick=()=>count.textContent=Number(count.textContent)+1</script>");
  const data = Buffer.from('{"label":"本地预览资源","value":7}');
  writeFileSync(htmlPath, html);
  writeFileSync(join(previewDirectory, "assets", "data.json"), data);
  const preview = jsonValue<{ id: string; url: string }>(await request("/api/file/preview", {}, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: htmlPath }),
  }), 200, "create scoped HTML preview");
  assert.equal(typeof preview.id, "string");
  assert(preview.id.length >= 24 && preview.url.startsWith(`/api/file/preview/${preview.id}/`), "HTML preview URL must bind its opaque scope");
  const scoped = await requestBeforeDeadline(`${base}${preview.url}`, deadline);
  assertStatus(scoped, 200, "scoped HTML document");
  assert.deepEqual(scoped.bytes, html, "HTML document must retain complete original bytes");
  assert.match(scoped.headers.get("content-type") ?? "", /^text\/html\b/i);
  assert.match(scoped.headers.get("content-security-policy") ?? "", /sandbox allow-scripts/);
  assert((scoped.headers.get("content-security-policy") ?? "").includes(`/api/file/preview/${preview.id}/`));
  assert.equal(scoped.headers.get("x-content-type-options"), "nosniff");
  assert.equal(scoped.headers.get("cache-control"), "no-store");
  const resourcePath = `/api/file/preview/${preview.id}/assets/data.json`;
  const resource = await request(resourcePath, {}, { headers: { Origin: "null" } });
  assertStatus(resource, 200, "opaque-origin local HTML data");
  assert.deepEqual(resource.bytes, data);
  assert.equal(resource.headers.get("access-control-allow-origin"), "*");
  assert.equal(resource.headers.get("access-control-allow-credentials"), null);
  const metadata = await request(resourcePath, {}, { method: "HEAD", headers: { Origin: "null" } });
  assertStatus(metadata, 200, "scoped resource HEAD");
  assert.equal(metadata.bytes.length, 0);
  assert.equal(metadata.headers.get("content-length"), String(data.length));
  const escaped = await request(`/api/file/preview/${preview.id}/..%2Fempty.txt`);
  assert([400, 403, 404].includes(escaped.status), "Encoded separators must not escape the granted HTML directory");
  const released = await request(`/api/file/preview/${preview.id}`, {}, { method: "DELETE" });
  assertStatus(released, 204, "release scoped HTML preview");
  assert.equal(released.bytes.length, 0);
  assertStatus(await request(resourcePath), 404, "released scope cannot read resources");

  assert.deepEqual(readdirSync(directory).sort(), [original.name, renamedName, video.name].sort(), "Success and rejection must remove owned staging");
  assert.deepEqual(readdirSync(cwd).sort(), [basename(directory), basename(cancelledDirectory), basename(previewDirectory), empty.name].sort());
  assert.deepEqual(readFileSync(sessionPath), historyBytes, "File operations must not mutate native session history");
  assert(deadline > Date.now(), "Work file smoke exceeded its overall deadline");
  console.log("[smoke] work files: binary/empty/Unicode upload, no-clobber rename/read identity, attachment bytes, MP4 ranges, canceled-upload cleanup and scoped HTML resources passed");
}
