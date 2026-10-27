import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("keeps scoped media on Bun's native full/HEAD/range wire behind authenticated opaque admission", async () => {
  const home = mkdtempSync(join(tmpdir(), "html-preview-wire-"));
  const modulePath = (name: string) => JSON.stringify(fileURLToPath(new URL(name, import.meta.url)));
  try {
    const { stdout } = await promisify(execFile)("bun", ["-e", `
      import fs from "node:fs";
      import assert from "node:assert/strict";
      import { join } from "node:path";
      const { HtmlPreviewService } = await import(${modulePath("./html-preview.ts")});
      const { DirectoryService, fileServiceError } = await import(${modulePath("./directories.ts")});
      const { rejectDisallowedWebRequest } = await import(${modulePath("./request-admission.ts")});
      const { DESKTOP_ACCESS_HEADER, rejectUnauthorizedDesktopRequest } = await import(${modulePath("./desktop-access.ts")});
      const home = ${JSON.stringify(home)};
      const root = join(home, "report");
      fs.mkdirSync(root);
      const html = "<!doctype html><body>" + "x".repeat(1024 * 1024 + 29) + "</body>";
      const path = join(root, "report.html");
      const media = join(root, "media.mp4");
      fs.writeFileSync(path, html);
      fs.writeFileSync(media, "0123456789");
      fs.writeFileSync(join(root, "empty.bin"), "");
      const service = new HtmlPreviewService(new DirectoryService(home));
      const scope = service.create(path);
      const token = "fixture-renderer-secret";
      let probes = 0;
      let ordinaryCalls = 0;
      let afterResponse = () => {};
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
        fetch: async (request) => {
          // Harness composition: the production router/server wiring is a
          // separate integration gate, not simulated by rewriting Origin.
          const denied = rejectUnauthorizedDesktopRequest(request, { token });
          if (denied) return denied;
          probes++;
          const admission = rejectDisallowedWebRequest(request, { host: "127.0.0.1", port: server.port }, {
            allowOpaquePreviewOrigin: service.isValidResourceRequest(request),
          });
          if (admission) return admission;
          const response = await service.resource(request);
          if (response) { afterResponse(); return response; }
          ordinaryCalls++;
          return Response.json({ ok: true });
        },
        error: (error) => {
          const failure = fileServiceError(error, "");
          return Response.json({ error: failure ? "Preview file is unavailable" : "Internal server error" }, {
            status: failure?.status ?? 500,
          });
        },
      });
      try {
        const base = server.url.origin;
        const url = base + scope.url;
        const mediaUrl = new URL("media.mp4", url).href;
        const headers = { [DESKTOP_ACCESS_HEADER]: token, Origin: "null" };
        const fetchResource = (target = url, options = {}) => fetch(target, {
          ...options, proxy: null, headers: { ...headers, ...options.headers },
        });
        const denied = await fetch(url, { proxy: null, headers: { Origin: "null" } });
        assert.equal(denied.status, 401);
        await denied.arrayBuffer();
        assert.equal(probes, 0, "unauthenticated traffic must not enter the capability gate");
        const whole = await fetchResource();
        assert.equal(whole.status, 200);
        assert.equal(whole.headers.get("content-length"), String(Buffer.byteLength(html)));
        assert.equal(whole.headers.get("access-control-allow-origin"), "*");
        assert.equal(whole.headers.get("access-control-allow-credentials"), null);
        assert.equal(whole.headers.get("x-content-type-options"), "nosniff");
        assert.equal(whole.headers.get("referrer-policy"), "no-referrer");
        assert.equal(whole.headers.get("cache-control"), "no-store");
        assert.equal(whole.headers.get("transfer-encoding"), null);
        assert.equal(await whole.text(), html);
        const head = await fetchResource(url, { method: "HEAD" });
        assert.equal(head.status, 200);
        assert.equal(head.headers.get("content-length"), String(Buffer.byteLength(html)));
        assert.equal((await head.arrayBuffer()).byteLength, 0);

        const ranges = [];
        for (const [range, content, description] of [
          ["bytes=2-5", "2345", "bytes 2-5/10"],
          ["bytes=-3", "789", "bytes 7-9/10"],
          ["bytes=8-", "89", "bytes 8-9/10"],
        ]) {
          const response = await fetchResource(mediaUrl, { headers: { Range: range } });
          assert.equal(response.status, 206);
          assert.equal(response.headers.get("content-type"), "video/mp4");
          assert.equal(response.headers.get("content-length"), String(content.length));
          assert.equal(response.headers.get("content-range"), description);
          assert.equal(response.headers.get("access-control-allow-origin"), "*");
          assert.equal(await response.text(), content);
          ranges.push(description);
        }
        const malformed = await fetchResource(mediaUrl, { headers: { Range: "bytes=0-1,3-4" } });
        assert.equal(malformed.status, 416);
        assert.equal(malformed.headers.get("content-range"), "bytes */10");
        assert.equal((await malformed.json()).error, "Invalid byte range");
        const empty = await fetchResource(new URL("empty.bin", url).href);
        assert.equal(empty.headers.get("content-length"), "0");
        assert.equal(await empty.text(), "");

        afterResponse = () => {
          afterResponse = () => {};
          fs.writeFileSync(join(root, "replacement"), "abcdef");
          fs.renameSync(join(root, "replacement"), media);
        };
        const replaced = await fetchResource(mediaUrl, { headers: { Range: "bytes=2-9" } });
        assert.equal(replaced.status, 206);
        assert.equal(replaced.headers.get("content-range"), "bytes 2-5/6");
        assert.equal(replaced.headers.get("content-length"), "4");
        assert.equal(await replaced.text(), "cdef");
        afterResponse = () => { afterResponse = () => {}; fs.unlinkSync(media); };
        const vanished = await fetchResource(mediaUrl);
        assert.equal(vanished.status, 404);
        assert.equal(typeof (await vanished.json()).error, "string");

        for (const [target, options, expected] of [
          [url, { headers: { Host: "attacker.example:" + server.port } }, 403],
          [url, { headers: { [DESKTOP_ACCESS_HEADER]: "wrong-secret" } }, 401],
          [url, { headers: { Origin: "https://attacker.example" } }, 403],
          [url, { method: "POST" }, 403],
          [url, { method: "OPTIONS" }, 403],
          [base + "/api/status", {}, 403],
          [base + "/api/file/raw?path=" + encodeURIComponent(path), {}, 403],
          [base + "/api/file/preview", { method: "POST" }, 403],
          [base + "/api/file/preview/" + scope.id, { method: "DELETE" }, 403],
        ]) {
          const response = await fetchResource(target, options);
          assert.equal(response.status, expected, target);
          assert.equal(response.headers.get("access-control-allow-origin"), null);
          assert.equal((await response.text()).includes(token), false);
        }
        assert.equal(ordinaryCalls, 0, "opaque previews must never reach ordinary application handlers");
        const status = await fetch(base + "/api/status", { proxy: null,
          headers: { [DESKTOP_ACCESS_HEADER]: token, Origin: base } });
        assert.equal(status.status, 200);
        await status.arrayBuffer();
        service.release(scope.id);
        const released = await fetchResource();
        assert.equal(released.status, 403);
        await released.arrayBuffer();
        console.log("HTML_WIRE:" + JSON.stringify({ htmlBytes: Buffer.byteLength(html), ranges,
          headBytes: 0, replacedRange: "bytes 2-5/6", lateOpen: vanished.status, ordinaryCalls }));
      } finally { service.close(); await server.stop(true); }
    `], {
      cwd: home, timeout: 25000, maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home,
        XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"),
        EASYRESEARCH_CODING_AGENT_DIR: join(home, "agent"), PI_OFFLINE: "1" },
    });
    const report = stdout.split("\n").find((line) => line.startsWith("HTML_WIRE:"));
    expect(report, stdout).toBeDefined();
    const result = JSON.parse(report!.slice("HTML_WIRE:".length)) as { htmlBytes: number; ranges: string[] };
    expect(result.htmlBytes).toBeGreaterThan(1024 * 1024);
    expect(result).toMatchObject({ headBytes: 0, replacedRange: "bytes 2-5/6", lateOpen: 404, ordinaryCalls: 1 });
    expect(result.ranges).toEqual(["bytes 2-5/10", "bytes 7-9/10", "bytes 8-9/10"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 30000);
