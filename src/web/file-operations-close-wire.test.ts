import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.each(["immediate", "next-turn"])("retries owned upload cleanup after one failed stop and disposes the real Bun listener (%s retry)", async (retry) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "file-close-retry-")));
  const agent = join(root, "agent");
  mkdirSync(agent);
  const serverModule = fileURLToPath(new URL("./server.ts", import.meta.url));
  const policyModule = fileURLToPath(new URL("../runtime/network-policy.ts", import.meta.url));
  const filesModule = fileURLToPath(new URL("./file-operations.ts", import.meta.url));
  try {
    const output = await new Promise<string>((resolve, reject) => execFile("bun", ["-e", `
      import fs from "node:fs";
      import http from "node:http";
      import assert from "node:assert/strict";
      import { join } from "node:path";
      const root = ${JSON.stringify(root)};
      const { startServer } = await import(${JSON.stringify(serverModule)});
      const { FileOperationService } = await import(${JSON.stringify(filesModule)});
      const closeFiles = FileOperationService.prototype.close;
      let fileCloseCalls = 0;
      FileOperationService.prototype.close = function () { fileCloseCalls++; return closeFiles.call(this); };
      const { resolveNetworkPolicy, parseNetworkProxySettings, captureInheritedProxyEnvironment } = await import(${JSON.stringify(policyModule)});
      const workspace = join(root, "workspace");
      fs.mkdirSync(workspace);
      const bucket = join(root, "agent", "sessions", "fixture");
      fs.mkdirSync(bucket, { recursive: true });
      fs.writeFileSync(join(bucket, "root.jsonl"), JSON.stringify({ type: "session", version: 3,
        id: crypto.randomUUID(), timestamp: new Date().toISOString(), cwd: workspace }) + "\\n"
        + JSON.stringify({ type: "message", id: "user", parentId: null, timestamp: new Date().toISOString(),
          message: { role: "user", content: "fixture", timestamp: Date.now() } }) + "\\n");
      const nativeServe = Bun.serve;
      let listener;
      let nativeStopCalls = 0;
      Bun.serve = (options) => {
        listener = nativeServe(options);
        const stop = listener.stop.bind(listener);
        listener.stop = (...args) => { nativeStopCalls++; return stop(...args); };
        return listener;
      };
      const server = await startServer({ host: "127.0.0.1", port: 0,
        networkPolicy: resolveNetworkPolicy(parseNetworkProxySettings({}), captureInheritedProxyEnvironment({})) });
      const origin = "http://127.0.0.1:" + server.port;
      const request = http.request(origin + "/api/file/upload?" + new URLSearchParams({ cwd: workspace, directory: workspace, name: "final.bin" }), {
        method: "PUT", agent: false, headers: { "Content-Type": "application/octet-stream", "Transfer-Encoding": "chunked" },
      });
      request.on("error", () => {});
      request.on("response", (response) => response.resume());
      const unlink = fs.unlinkSync;
      try {
        request.write(Buffer.from("partial bytes"));
        for (let i = 0; i < 300 && !fs.readdirSync(workspace).some(name => fs.statSync(join(workspace, name)).size > 0); i++) await Bun.sleep(10);
        const files = fs.readdirSync(workspace);
        assert.equal(files.length, 1, "upload must be active before stop");
        const staging = join(workspace, files[0]);
        let injected = 0;
        fs.unlinkSync = (path) => {
          if (path === staging && injected++ === 0) throw Object.assign(new Error("transient staging lock"), { code: "EACCES" });
          return unlink(path);
        };
        let firstFailure = "";
        try { await server.stop(); } catch (error) { firstFailure = error.message; }
        assert.equal(firstFailure, "Route cleanup failed");
        assert.equal(nativeStopCalls, 0, "failed cleanup must stay visible before listener disposal");
        assert.equal(fs.existsSync(staging), true, "failed unlink must remain owned for retry");
        fs.unlinkSync = unlink;
        if (${JSON.stringify(retry)} === "next-turn") await Bun.sleep(0);
        let secondFailure = "";
        try { await server.stop(); } catch (error) { secondFailure = error.message; }
        let listening = false;
        try {
          const response = await fetch(origin + "/api/directories/roots", { proxy: null, signal: AbortSignal.timeout(1000) });
          await response.arrayBuffer();
          listening = true;
        } catch {}
        const result = { firstFailure, secondFailure, injected, fileCloseCalls, nativeStopCalls, listening, remaining: fs.readdirSync(workspace) };
        console.log("CLOSE_RESULT:" + JSON.stringify(result));
      } finally {
        fs.unlinkSync = unlink;
        request.destroy();
        // A failing candidate must not strand its real daemon resources in this test process.
        try { await server.stop(); } catch {}
        await listener.stop(true);
      }
      process.exit(0);
    `], {
      cwd: root, timeout: 25000, maxBuffer: 4 * 1024 * 1024,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: root, USERPROFILE: root,
        XDG_CONFIG_HOME: join(root, ".config"), XDG_CACHE_HOME: join(root, ".cache"),
        EASYRESEARCH_CODING_AGENT_DIR: agent, PI_OFFLINE: "1" },
    }, (error, stdout, stderr) => error ? reject(new Error(`Bun exit ${error.code}: ${stderr}\n${stdout}`)) : resolve(stdout)));
    const line = output.split("\n").find((entry) => entry.startsWith("CLOSE_RESULT:"));
    expect(line, output).toBeDefined();
    expect(JSON.parse(line!.slice("CLOSE_RESULT:".length))).toEqual({
      firstFailure: "Route cleanup failed", secondFailure: "", injected: 1,
      fileCloseCalls: 2, nativeStopCalls: 1, listening: false, remaining: [],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
