import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { DESKTOP_ACCESS_HEADER } from "./desktop-access";

async function runFileServer<T>(scenario: string, desktopToken?: string): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "raw-file-server-"));
  const agent = join(root, "agent");
  mkdirSync(agent);
  const serverModule = fileURLToPath(new URL("./server.ts", import.meta.url));
  const policyModule = fileURLToPath(new URL("../runtime/network-policy.ts", import.meta.url));
  try {
    const output = await new Promise<string>((resolve, reject) => execFile("bun", ["-e", `
      import fs from "node:fs";
      import assert from "node:assert/strict";
      import { join } from "node:path";
      const { startServer } = await import(${JSON.stringify(serverModule)});
      const { resolveNetworkPolicy, parseNetworkProxySettings, captureInheritedProxyEnvironment } =
        await import(${JSON.stringify(policyModule)});
      const root = ${JSON.stringify(root)};
      const descriptors = (directory) => process.platform !== "linux" ? null : fs.readdirSync("/proc/self/fd").filter(fd => {
        try { return fs.readlinkSync("/proc/self/fd/" + fd).startsWith(directory + "/"); }
        catch { return false; }
      }).length;
      const drained = async (directory) => {
        for (let i = 0; i < 200 && descriptors(directory) > 0; i++) await Bun.sleep(10);
        if (process.platform === "linux") assert.equal(descriptors(directory), 0, "file descriptors must close without GC");
      };
      let afterResponse = () => {};
      const serve = Bun.serve;
      Bun.serve = (options) => serve({ ...options, fetch: async (request, server) => {
        const response = await options.fetch(request, server);
        await afterResponse(request, response);
        return response;
      } });
      const server = await startServer({ host: "127.0.0.1", port: 0,
        desktopAccess: ${JSON.stringify(desktopToken ? { token: desktopToken } : undefined)},
        networkPolicy: resolveNetworkPolicy(parseNetworkProxySettings({}), captureInheritedProxyEnvironment({})) });
      const origin = "http://127.0.0.1:" + server.port;
      const fileUrl = (path) => origin + "/api/file/raw?path=" + encodeURIComponent(path);
      let result;
      try { result = await (async () => { ${scenario} })(); }
      finally { await server.stop(); }
      console.log("B07_RESULT:" + JSON.stringify(result));
    `], {
      cwd: root, timeout: 25000, maxBuffer: 4 * 1024 * 1024,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: root, USERPROFILE: root,
        XDG_CONFIG_HOME: join(root, ".config"), XDG_CACHE_HOME: join(root, ".cache"),
        EASYRESEARCH_CODING_AGENT_DIR: agent, PI_OFFLINE: "1" },
    }, (error, stdout, stderr) => error ? reject(new Error(`Bun exit ${error.code}: ${stderr}\n${stdout.slice(-1500)}`)) : resolve(stdout)));
    const result = output.split("\n").find((line) => line.startsWith("B07_RESULT:"));
    if (!result) throw new Error(`Bun did not report a file-wire result: ${output}`);
    return JSON.parse(result.slice("B07_RESULT:".length)) as T;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it("maps filesystem failures during Blob creation and after the raw route returns through the real Bun server", async () => {
  const results = await runFileServer<Array<{
    mode: string; range: string | null; expected: number; status: number;
    contentType: string; body: string; length: string; bytes: number;
  }>>(`
    const output = [];
    const cases = [["unlink", 404], ["blob-unlink", 404], ["notdir", 404], ["directory", 400], ["empty-unlink", 404]];
    if (process.platform !== "win32" && process.getuid?.() !== 0) cases.push(["unreadable", 403]);
    for (const [mode, expected] of cases) {
      for (const range of mode === "empty-unlink" ? [null] : [null, "bytes=1-4"]) {
        const parent = join(root, "parent");
        const path = join(parent, "paper.pdf");
        fs.mkdirSync(parent);
        fs.writeFileSync(path, mode === "empty-unlink" ? "" : "original");
        const openAsBlob = fs.openAsBlob;
        if (mode === "blob-unlink") fs.openAsBlob = (target) => { fs.unlinkSync(target); return openAsBlob(target); };
        afterResponse = () => {
          if (mode === "blob-unlink") return;
          if (mode === "unreadable") fs.chmodSync(path, 0);
          else {
            fs.unlinkSync(path);
            if (mode === "directory") fs.mkdirSync(path);
            if (mode === "notdir") {
              fs.rmdirSync(parent);
              fs.writeFileSync(parent, "not a directory");
            }
          }
        };
        try {
          const response = await fetch(fileUrl(path), { headers: range ? { Range: range } : {}, proxy: null });
          const body = await response.text();
          assert.equal(response.status, expected, mode + " " + range + " must use typed file errors");
          output.push({ mode, range, expected, status: response.status,
            contentType: response.headers.get("content-type"), body: body.slice(0, 512),
            length: response.headers.get("content-length"), bytes: Buffer.byteLength(body) });
          await drained(parent);
        } finally {
          afterResponse = () => {};
          fs.openAsBlob = openAsBlob;
          if (mode === "unreadable") fs.chmodSync(path, 0o600);
          fs.rmSync(parent, { recursive: true, force: true });
        }
      }
    }
    return output;
  `);

  for (const result of results) {
    expect(result.status, `${result.mode} ${result.range}`).toBe(result.expected);
    expect(result.contentType).toContain("application/json");
    expect(JSON.parse(result.body)).toEqual({ error: expect.any(String) });
    expect(result.length).toBe(String(result.bytes));
    expect(result.bytes).toBeLessThan(1024);
  }
}, 30000);

it("keeps unexpected server errors at 500 rather than reclassifying them as file failures", async () => {
  const responses = await runFileServer<Array<{ status: number; body: unknown }>>(`
    const path = join(root, "paper.pdf");
    fs.writeFileSync(path, "original");
    const output = [];
    for (const properties of [
      {}, { code: "EIO", syscall: "read", path }, { code: "EBADF", syscall: "open", path },
      { code: "ENOENT" }, { code: "ENOENT", syscall: "unlink", path },
    ]) {
      afterResponse = () => { throw Object.assign(new Error("private internal failure"), properties); };
      const response = await fetch(fileUrl(path), { proxy: null });
      output.push({ status: response.status, body: await response.json() });
    }
    return output;
  `);
  for (const response of responses) {
    expect(response).toEqual({ status: 500, body: { error: "Internal server error" } });
  }
}, 30000);

it.each(["bytes=-4", "bytes=1-4", null])("keeps %s metadata and bytes on one opened version when the path is replaced before native send", async (range) => {
  const result = await runFileServer<{ status: number; length: string; contentRange: string | null; bytes: number; version: string; uniform: boolean }>(`
    const path = join(root, "replace.pdf");
    fs.writeFileSync(path, "A".repeat(8192));
    const retained = [];
    afterResponse = (_request, response) => {
      retained.push(response);
      fs.writeFileSync(path + ".new", "B".repeat(32));
      fs.renameSync(path + ".new", path);
    };
    const range = ${JSON.stringify(range)};
    const response = await fetch(fileUrl(path), { headers: range ? { Range: range } : {}, proxy: null });
    const body = await response.text();
    await drained(root);
    assert.equal(retained.length, 1);
    return { status: response.status, length: response.headers.get("content-length"),
      contentRange: response.headers.get("content-range"), bytes: body.length,
      version: body[0] ?? "", uniform: body === (body[0] ?? "").repeat(body.length) };
  `);
  expect(["A", "B"]).toContain(result.version);
  const size = result.version === "A" ? 8192 : 32;
  expect(result.uniform).toBe(true);
  expect(result.status).toBe(range ? 206 : 200);
  expect(result.bytes).toBe(range ? 4 : size);
  expect(result.length).toBe(String(result.bytes));
  expect(result.contentRange).toBe(range === "bytes=-4" ? `bytes ${size - 4}-${size - 1}/${size}` : range ? `bytes 1-4/${size}` : null);
}, 30000);

it("uses the opened file size for a range made unsatisfiable by late replacement", async () => {
  const result = await runFileServer<{ status: number; range: string; length: string; bytes: number }>(`
    const path = join(root, "shrink.pdf");
    fs.writeFileSync(path, "A".repeat(8192));
    afterResponse = () => {
      fs.writeFileSync(path + ".new", "B".repeat(32));
      fs.renameSync(path + ".new", path);
    };
    const response = await fetch(fileUrl(path), { headers: { Range: "bytes=4000-" }, proxy: null });
    const bytes = (await response.arrayBuffer()).byteLength;
    await drained(root);
    return { status: response.status, range: response.headers.get("content-range"),
      length: response.headers.get("content-length"), bytes };
  `);
  expect(result).toEqual({ status: 416, range: "bytes */32", length: "0", bytes: 0 });
}, 30000);

it("keeps native range handling behind desktop renderer authentication", async () => {
  const responses = await runFileServer<Array<{ status: number; range: string | null; length: string; body: string }>>(`
    const path = join(root, "desktop.pdf");
    fs.writeFileSync(path, "A".repeat(8192));
    afterResponse = (_request, response) => {
      if (response.status !== 200) return;
      fs.writeFileSync(path + ".new", "B".repeat(32));
      fs.renameSync(path + ".new", path);
    };
    const output = [];
    for (const token of [null, "wrong-token", "fixture-token"]) {
      const response = await fetch(fileUrl(path), { proxy: null, headers: {
        Range: "bytes=-4", ...(token ? { [${JSON.stringify(DESKTOP_ACCESS_HEADER)}]: token } : {}) } });
      output.push({ status: response.status, range: response.headers.get("content-range"),
        length: response.headers.get("content-length"), body: await response.text() });
      await drained(root);
    }
    return output;
  `, "fixture-token");
  expect(responses.map((response) => response.status)).toEqual([401, 401, 206]);
  expect(responses[2]).toEqual({ status: 206, range: "bytes 28-31/32", length: "4", body: "BBBB" });
}, 30000);

it("retains typed rejection of malformed, multiple, and initially unsatisfiable ranges", async () => {
  const results = await runFileServer<Array<{ status: number; range: string; body: unknown }>>(`
    const path = join(root, "ranges.pdf");
    fs.writeFileSync(path, "original");
    const output = [];
    for (const range of ["bytes=0-1,4-5", "items=1-4", "bytes=-0", "bytes=8-9", "bytes=4-1"]) {
      const response = await fetch(fileUrl(path), { headers: { Range: range }, proxy: null });
      output.push({ status: response.status, range: response.headers.get("content-range"), body: await response.json() });
    }
    return output;
  `);
  for (const result of results) expect(result).toEqual({ status: 416, range: "bytes */8", body: { error: "Invalid byte range" } });
}, 30000);

it("keeps mixed preview/full/range reads typed during a bounded concurrent unlink and replacement race", async () => {
  const result = await runFileServer<{ requests: number; mutations: number; anomalies: unknown[] }>(`
    const { Worker } = await import("node:worker_threads");
    const path = join(root, "racing.pdf");
    fs.writeFileSync(path, "A".repeat(65536));
    const writerPath = join(root, "writer.mjs");
    fs.writeFileSync(writerPath, ${JSON.stringify(`
      import fs from "node:fs";
      import { parentPort, workerData } from "node:worker_threads";
      let n = 0;
      const path = workerData;
      const timer = setInterval(() => {
        if (++n % 3 === 0) fs.rmSync(path, { force: true });
        else {
          fs.writeFileSync(path + ".new", (n % 2 ? "B" : "A").repeat(n % 2 ? 8192 : 65536));
          fs.renameSync(path + ".new", path);
        }
        parentPort.postMessage(n);
        if (n >= 2000) clearInterval(timer);
      }, 1);
    `)});
    const writer = new Worker(writerPath, { workerData: path });
    let mutations = 0;
    writer.on("message", (count) => { mutations = count; });
    const anomalies = [];
    let requests = 0;
    try {
      await new Promise((resolve, reject) => { writer.once("message", resolve); writer.once("error", reject); });
      for (let batch = 0; batch < 30; batch++) {
        await Promise.all(Array.from({ length: 12 }, async (_, index) => {
          const text = index % 3 === 0;
          const range = index % 3 === 2;
          const rangeHeader = range ? ["bytes=0-4095", "bytes=-4", "bytes=4096-12000"][Math.floor(index / 3) % 3] : null;
          const url = text ? origin + "/api/file?path=" + encodeURIComponent(path) : fileUrl(path);
          const response = await fetch(url, { headers: range ? { Range: rangeHeader } : {}, proxy: null });
          const body = await response.text();
          requests++;
          if (![200, 206, 404, 416].includes(response.status)) {
            anomalies.push({ status: response.status, body: body.slice(0, 200) });
          } else if (response.status >= 400) {
            assert.ok(response.headers.get("content-type").includes("application/json"));
            assert.equal(typeof JSON.parse(body).error, "string");
          } else if (text) {
            const preview = JSON.parse(body);
            assert.equal(preview.binary, false);
            assert.equal(preview.byteCount, Buffer.byteLength(preview.content));
            assert.match(preview.content, /^(A+|B+)$/);
          } else {
            assert.equal(response.status, range ? 206 : 200);
            assert.equal(response.headers.get("content-length"), String(Buffer.byteLength(body)));
            assert.equal(response.headers.get("transfer-encoding"), null);
            assert.equal(response.headers.get("accept-ranges"), "bytes");
            assert.match(body, /^(A+|B+)$/);
            const size = body[0] === "A" ? 65536 : 8192;
            if (range) {
              const start = rangeHeader === "bytes=-4" ? size - 4 : rangeHeader === "bytes=4096-12000" ? 4096 : 0;
              const end = rangeHeader === "bytes=-4" ? size - 1 : rangeHeader === "bytes=4096-12000" ? Math.min(12000, size - 1) : 4095;
              assert.equal(body.length, end - start + 1);
              assert.equal(response.headers.get("content-range"), "bytes " + start + "-" + end + "/" + size);
            } else {
              assert.equal(body.length, size);
              assert.equal(response.headers.get("content-range"), null);
            }
          }
        }));
      }
    } finally { await writer.terminate(); }
    return { requests, mutations, anomalies };
  `);
  expect(result.requests).toBe(360);
  expect(result.mutations).toBeGreaterThan(3);
  expect(result.anomalies).toEqual([]);
}, 30000);

it("preserves native opened-file transfers and releases file descriptors on drain, truncation, and cancel without GC", async () => {
  const result = await runFileServer<{ cancellations: number; retained: number; descriptors: number | null }>(`
    const http = await import("node:http");
    const { createHash } = await import("node:crypto");
    const transferRoot = join(root, "transfers");
    fs.mkdirSync(transferRoot);
    const path = join(transferRoot, "paper.pdf");
    const size = 32 * 1024 * 1024 + 17;
    const retained = [];
    afterResponse = (_request, response) => { retained.push(response); };
    const reset = () => {
      const fd = fs.openSync(path, "w");
      try {
        fs.ftruncateSync(fd, size);
        fs.writeSync(fd, Buffer.from("original"), 0, 8, 0);
        fs.writeSync(fd, Buffer.from("last"), 0, 4, size - 4);
      } finally { fs.closeSync(fd); }
    };
    const request = (range, onStart = () => {}, cancel = false) => new Promise((resolve, reject) => {
      let response;
      let bytes = 0;
      let settled = false;
      let started = false;
      const hash = createHash("sha256");
      const finish = (terminal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ terminal, bytes, hash: hash.digest("hex"), status: response?.statusCode, headers: response?.headers });
      };
      const client = http.get(fileUrl(path), { agent: false, headers: range ? { Range: range } : {} }, incoming => {
        response = incoming;
        incoming.on("data", chunk => {
          bytes += chunk.length;
          hash.update(chunk);
          if (!started) {
            started = true;
            try {
              if (process.platform === "linux") assert.ok(descriptors(transferRoot) > 0, "native file must still be open during transfer");
              onStart();
            } catch (error) { client.destroy(); clearTimeout(timer); reject(error); return; }
            if (cancel) { client.destroy(); finish("cancel"); }
          }
        });
        incoming.on("end", () => finish("end"));
        incoming.on("aborted", () => finish("aborted"));
        incoming.on("error", () => finish("error"));
      });
      client.on("error", () => finish("error"));
      const timer = setTimeout(() => { client.destroy(); finish("deadline"); }, 8000);
    });
    reset();
    for (const range of [null, "bytes=1-" ]) {
      const expectedBytes = range ? size - 1 : size;
      const baseline = await request(range);
      assert.equal(baseline.terminal, "end");
      assert.equal(baseline.bytes, expectedBytes);
      await drained(transferRoot);
      for (const mode of ["append", "replace", "unlink", "truncate"]) {
        reset();
        const result = await request(range, () => {
          if (mode === "append") fs.appendFileSync(path, "new bytes");
          if (mode === "replace") {
            fs.writeFileSync(path + ".new", "replacement");
            fs.renameSync(path + ".new", path);
          }
          if (mode === "unlink") fs.unlinkSync(path);
          if (mode === "truncate") fs.truncateSync(path, 0);
        });
        assert.equal(result.status, range ? 206 : 200);
        assert.equal(result.headers["content-length"], String(expectedBytes));
        assert.equal(result.headers["transfer-encoding"], undefined);
        assert.equal(result.headers["accept-ranges"], "bytes");
        assert.equal(result.headers["content-range"], range ? "bytes 1-" + (size - 1) + "/" + size : undefined);
        if (mode === "truncate") {
          assert.ok(["aborted", "error"].includes(result.terminal), "truncation must abort, not hang or finish: " + result.terminal);
          assert.ok(result.bytes < expectedBytes);
        } else {
          assert.equal(result.terminal, "end", mode);
          assert.equal(result.bytes, expectedBytes, mode);
          assert.equal(result.hash, baseline.hash, mode + " must deliver the opened version");
        }
        await drained(transferRoot);
      }
      reset();
    }
    let cancellations = 0;
    for (let round = 0; round < 4; round++) {
      const results = await Promise.all(Array.from({ length: 24 }, (_, i) => request(i % 2 ? "bytes=1-" : null, undefined, true)));
      for (const result of results) { assert.equal(result.terminal, "cancel"); cancellations++; }
      await drained(transferRoot);
    }
    fs.truncateSync(path, 0);
    const empty = await fetch(fileUrl(path), { proxy: null });
    assert.equal(empty.status, 200);
    assert.equal(empty.headers.get("content-length"), "0");
    assert.equal(empty.headers.get("transfer-encoding"), null);
    assert.equal((await empty.arrayBuffer()).byteLength, 0);
    const invalid = await fetch(fileUrl(path), { headers: { Range: "bytes=0-1" }, proxy: null });
    assert.equal(invalid.status, 416);
    assert.equal(invalid.headers.get("content-range"), "bytes */0");
    await invalid.arrayBuffer();
    await drained(transferRoot);
    return { cancellations, retained: retained.length, descriptors: descriptors(transferRoot) };
  `);
  expect(result.cancellations).toBe(96);
  expect(result.retained).toBeGreaterThan(result.cancellations);
  if (process.platform === "linux") expect(result.descriptors).toBe(0);
}, 30000);

it("keeps exact full/range lengths on Bun's HTTP wire for range-capable file viewers", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-file-wire-"));
  const agent = join(root, "agent");
  mkdirSync(agent);
  const path = join(root, "paper.pdf");
  const size = 2 * 1024 * 1024 + 17;
  const content = Buffer.alloc(size, 0x61);
  content.set(Array.from({ length: 16 }, (_, index) => index));
  content.set([0xaa, 0xbb, 0xcc, 0xdd], size - 4);
  writeFileSync(path, content);
  const routes = fileURLToPath(new URL("./routes.ts", import.meta.url));
  const directories = fileURLToPath(new URL("./directories.ts", import.meta.url));
  try {
    const result = await new Promise<string>((resolve, reject) => execFile("bun", ["-e", `
      const { createRouteHandler } = await import(${JSON.stringify(routes)});
      const { DirectoryService } = await import(${JSON.stringify(directories)});
      const handler = createRouteHandler({ directories: new DirectoryService(${JSON.stringify(root)}) });
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
      try {
        const url = server.url.origin + "/api/file/raw?path=" + encodeURIComponent(${JSON.stringify(path)});
        const output = [];
        for (const range of [null, "bytes=5-13", "bytes=-4"]) {
          const response = await fetch(url, { headers: range ? { Range: range } : {}, proxy: null });
          const bytes = new Uint8Array(await response.arrayBuffer());
          output.push({ status: response.status, length: response.headers.get("content-length"),
            ranges: response.headers.get("accept-ranges"), contentRange: response.headers.get("content-range"),
            transfer: response.headers.get("transfer-encoding"), bytes: bytes.byteLength, sample: [...bytes.subarray(0, 16)] });
        }
        console.log(JSON.stringify(output));
      } finally { await server.stop(true); }
    `], {
      cwd: root, timeout: 15000,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: root, USERPROFILE: root,
        EASYRESEARCH_CODING_AGENT_DIR: agent, PI_OFFLINE: "1" },
    }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout)));

    expect(JSON.parse(result)).toEqual([
      { status: 200, length: String(size), ranges: "bytes", contentRange: null, transfer: null, bytes: size,
        sample: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] },
      { status: 206, length: "9", ranges: "bytes", contentRange: `bytes 5-13/${size}`, transfer: null, bytes: 9,
        sample: [5, 6, 7, 8, 9, 10, 11, 12, 13] },
      { status: 206, length: "4", ranges: "bytes", contentRange: `bytes ${size - 4}-${size - 1}/${size}`, transfer: null, bytes: 4,
        sample: [0xaa, 0xbb, 0xcc, 0xdd] },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
