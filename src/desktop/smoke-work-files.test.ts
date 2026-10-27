import type { DownloadItem, Session } from "electron";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyDesktopSmokeBlockedDownload, verifyDesktopSmokeDownload } from "./smoke-work-files";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "desktop-work-files-test-"));
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

function harness() {
  const events = new EventEmitter();
  const session = events as unknown as Pick<Session, "on" | "removeListener">;
  const contents = {};
  const bytes = Uint8Array.from([0, 255, 128, 13, 10]);
  const url = "http://127.0.0.1:1234/api/file/raw?path=fixture&download=1";
  const savePath = join(root, "download.bin");
  const itemEvents = new EventEmitter();
  const cancel = vi.fn(() => itemEvents.emit("done", {}, "cancelled"));
  const setSavePath = vi.fn();
  const item = Object.assign(itemEvents, {
    getURL: () => url,
    getFilename: () => "结果-β.bin",
    getContentDisposition: () => "attachment; filename*=UTF-8''fixture.bin",
    getReceivedBytes: () => bytes.byteLength,
    cancel,
    setSavePath,
  }) as unknown as DownloadItem;
  const event = { preventDefault: vi.fn() };
  const emit = (source = contents, next = item) => events.emit("will-download", event, next, source);
  const options = { session, webContents: contents, url, savePath, filename: "结果-β.bin", expected: bytes, timeoutMs: 1000 };
  return { events, session, contents, bytes, url, savePath, itemEvents, item, event, emit, options, cancel, setSavePath };
}

describe("packaged smoke native download ownership", () => {
  it("waits for completed native bytes and retains unrelated session listeners", async () => {
    const h = harness();
    const otherListener = vi.fn();
    h.events.on("will-download", otherListener);
    let completeTrigger!: () => void;
    const pendingTrigger = new Promise<void>((resolve) => { completeTrigger = resolve; });
    let accepted = false;
    const result = verifyDesktopSmokeDownload({ ...h.options, trigger: async () => {
      h.emit({ foreign: true });
      expect(h.setSavePath).not.toHaveBeenCalled();
      h.emit();
      writeFileSync(h.savePath, h.bytes);
      h.itemEvents.emit("done", {}, "completed");
      await pendingTrigger;
    } }).then(() => { accepted = true; });
    await vi.advanceTimersByTimeAsync(20);
    expect(accepted).toBe(false);
    expect(h.setSavePath).toHaveBeenCalledExactlyOnceWith(h.savePath);
    completeTrigger();
    await result;
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.events.listeners("will-download")).toEqual([otherListener]);
    expect(h.itemEvents.listenerCount("done")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a separately initiated owned item and awaits its cancelled terminal state", async () => {
    const h = harness();
    await verifyDesktopSmokeDownload({ ...h.options, cancel: true, trigger: async () => { h.emit(); } });
    expect(h.cancel).toHaveBeenCalledOnce();
    expect(h.setSavePath).toHaveBeenCalledExactlyOnceWith(h.savePath);
    expect(h.events.listenerCount("will-download")).toBe(0);
    expect(h.itemEvents.listenerCount("done")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["no item", "stalled item", "stalled trigger", "cancel without terminal event"])("bounds %s and removes owned listeners", async (scenario) => {
    const h = harness();
    if (scenario === "cancel without terminal event") h.cancel.mockImplementation(() => true);
    const task = verifyDesktopSmokeDownload({
      ...h.options, cancel: scenario === "cancel without terminal event",
      trigger: async () => {
        if (scenario !== "no item") h.emit();
        if (scenario === "stalled trigger") {
          writeFileSync(h.savePath, h.bytes);
          h.itemEvents.emit("done", {}, "completed");
          await new Promise(() => {});
        }
      },
    });
    const rejection = expect(task).rejects.toThrow(/deadline/i);
    await vi.advanceTimersByTimeAsync(1000);
    await rejection;
    expect(h.events.listenerCount("will-download")).toBe(0);
    expect(h.itemEvents.listenerCount("done")).toBe(0);
    if (scenario === "stalled item") expect(h.cancel).toHaveBeenCalledOnce();
    if (scenario === "no item" || scenario === "stalled trigger") expect(h.cancel).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["bytes", "length", "interrupted", "completed instead of cancelled"])("rejects invalid %s evidence", async (scenario) => {
    const h = harness();
    if (scenario === "length") h.item.getReceivedBytes = () => h.bytes.byteLength - 1;
    if (scenario === "completed instead of cancelled") h.cancel.mockImplementation(() => true);
    await expect(verifyDesktopSmokeDownload({
      ...h.options, cancel: scenario === "completed instead of cancelled",
      trigger: async () => {
        h.emit();
        writeFileSync(h.savePath, scenario === "bytes" ? Uint8Array.from([1, 2, 3, 4, 5]) : h.bytes);
        h.itemEvents.emit("done", {}, scenario === "interrupted" ? "interrupted" : "completed");
      },
    })).rejects.toThrow(/terminal state or bytes/i);
    expect(h.events.listenerCount("will-download")).toBe(0);
    expect(h.itemEvents.listenerCount("done")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["wrong URL", "duplicate item", "filename", "disposition", "save failure", "URL getter failure"])("fails safely on %s", async (scenario) => {
    const h = harness();
    if (scenario === "wrong URL") h.item.getURL = () => "blob:null/forbidden";
    if (scenario === "URL getter failure") h.item.getURL = () => { throw new Error("private detail"); };
    if (scenario === "filename") h.item.getFilename = () => "wrong.bin";
    if (scenario === "disposition") h.item.getContentDisposition = () => "inline";
    if (scenario === "save failure") h.setSavePath.mockImplementation(() => { throw new Error("private detail"); });
    await expect(verifyDesktopSmokeDownload({ ...h.options, trigger: async () => {
      h.emit();
      if (scenario === "duplicate item") h.emit();
    } })).rejects.toThrow(/unexpected renderer download|metadata or save setup/i);
    if (scenario === "wrong URL" || scenario === "URL getter failure" || scenario === "duplicate item") {
      expect(h.event.preventDefault).toHaveBeenCalledOnce();
    }
    expect(h.events.listenerCount("will-download")).toBe(0);
    expect(h.itemEvents.listenerCount("done")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels an owned item if parent trigger fails and reports no raw renderer error", async () => {
    const h = harness();
    await expect(verifyDesktopSmokeDownload({ ...h.options, trigger: async () => {
      h.emit();
      throw new Error("secret from unrelated renderer state");
    } })).rejects.toThrow("Desktop Work Files parent download trigger failed.");
    expect(h.cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, -1, NaN, 0.5])("rejects invalid deadline %s before installing listeners", (timeoutMs) => {
    const h = harness();
    const trigger = vi.fn();
    expect(() => verifyDesktopSmokeDownload({ ...h.options, trigger, timeoutMs })).toThrow(/positive integer/i);
    expect(trigger).not.toHaveBeenCalled();
    expect(h.events.listenerCount("will-download")).toBe(0);
  });
});

describe("packaged smoke iframe download rejection", () => {
  it("observes the full post-attempt quiet window, ignoring downloads owned by other contents", async () => {
    const h = harness();
    let completed = false;
    const task = verifyDesktopSmokeBlockedDownload({
      ...h.options, observationMs: 100,
      trigger: async () => { h.emit({ foreign: true }); return "attempt acknowledged"; },
    }).then((value) => { completed = true; return value; });
    await vi.advanceTimersByTimeAsync(99);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(task).resolves.toBe("attempt acknowledged");
    expect(h.event.preventDefault).not.toHaveBeenCalled();
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.events.listenerCount("will-download")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails if Chromium admits a sandbox download, even after the trigger acknowledged", async () => {
    const h = harness();
    const task = verifyDesktopSmokeBlockedDownload({ ...h.options, observationMs: 100, trigger: async () => true });
    const rejection = expect(task).rejects.toThrow(/sandbox allowed/i);
    await vi.advanceTimersByTimeAsync(50);
    h.emit();
    await rejection;
    expect(h.event.preventDefault).toHaveBeenCalledOnce();
    expect(h.setSavePath).not.toHaveBeenCalled();
    expect(h.events.listenerCount("will-download")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds an unresponsive frame without waiting forever or leaving session listeners", async () => {
    const h = harness();
    const task = verifyDesktopSmokeBlockedDownload({ ...h.options, trigger: () => new Promise(() => {}) });
    const rejection = expect(task).rejects.toThrow(/iframe deadline/i);
    await vi.advanceTimersByTimeAsync(1000);
    await rejection;
    expect(h.events.listenerCount("will-download")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails immediately on renderer rejection and sanitizes its message", async () => {
    const h = harness();
    await expect(verifyDesktopSmokeBlockedDownload({ ...h.options, trigger: async () => {
      throw new Error("private renderer contents");
    } })).rejects.toThrow("Desktop Work Files interactive iframe verification failed.");
    expect(h.events.listenerCount("will-download")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

it("runs the packaged smoke admission probe through the real Desktop server's outer admission and renderer auth", async () => {
  vi.useRealTimers();
  const agent = join(root, "agent");
  mkdirSync(agent);
  const modulePath = (name: string) => JSON.stringify(fileURLToPath(new URL(name, import.meta.url)));
  const { stdout } = await promisify(execFile)("bun", ["-e", `
    import assert from "node:assert/strict";
    import { writeFileSync } from "node:fs";
    import { join } from "node:path";
    const { startServer } = await import(${modulePath("../web/server.ts")});
    const { resolveNetworkPolicy, parseNetworkProxySettings, captureInheritedProxyEnvironment } =
      await import(${modulePath("../runtime/network-policy.ts")});
    const { verifyDesktopSmokeAdmissionNegatives } = await import(${modulePath("./smoke-work-files.ts")});
    const { DESKTOP_ACCESS_HEADER } = await import(${modulePath("./contracts.ts")});
    const htmlPath = join(${JSON.stringify(root)}, "report.html");
    const html = "<!doctype html><p>desktop admission fixture</p>";
    writeFileSync(htmlPath, html);
    const token = "isolated-desktop-admission-fixture";
    const observed = [];
    const serve = Bun.serve;
    // Observe real wire requests/results without substituting a route, admission
    // function or response. The production startServer handler remains in charge.
    Bun.serve = (options) => serve({ ...options, fetch: async (request, server) => {
      const response = await options.fetch(request, server);
      observed.push({
        path: new URL(request.url).pathname,
        origin: request.headers.get("origin"),
        authenticated: request.headers.get(DESKTOP_ACCESS_HEADER) === token,
        status: response.status,
        cors: response.headers.get("access-control-allow-origin"),
      });
      return response;
    } });
    const server = await startServer({ host: "127.0.0.1", port: 0,
      desktopAccess: { token },
      networkPolicy: resolveNetworkPolicy(parseNetworkProxySettings({}), captureInheritedProxyEnvironment({})),
    });
    try {
      const origin = "http://127.0.0.1:" + server.port;
      const created = await fetch(origin + "/api/file/preview", { method: "POST", proxy: null,
        headers: { [DESKTOP_ACCESS_HEADER]: token, Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ path: htmlPath }),
      });
      assert.equal(created.status, 200);
      const scope = await created.json();
      const allowed = await fetch(origin + scope.url, { proxy: null,
        headers: { [DESKTOP_ACCESS_HEADER]: token, Origin: "null" },
      });
      assert.equal(allowed.status, 200);
      assert.equal(allowed.headers.get("access-control-allow-origin"), "*");
      assert.equal(allowed.headers.get("access-control-allow-credentials"), null);
      assert.equal(await allowed.text(), html);
      observed.length = 0;
      await verifyDesktopSmokeAdmissionNegatives(origin, token, scope, htmlPath);
      const missingCredentials = observed.filter((entry) => entry.path === scope.url && !entry.authenticated);
      assert.deepEqual(missingCredentials.map(({ origin, status, cors }) => ({ origin, status, cors })), [
        { origin: "null", status: 403, cors: null },
        { origin: null, status: 401, cors: null },
      ]);
      assert.equal(observed.every((entry) => entry.status >= 400 && entry.cors === null), true);
      console.log("DESKTOP_ADMISSION:" + JSON.stringify({ allowed: allowed.status, missingCredentials }));
    } finally {
      await server.stop();
      Bun.serve = serve;
    }
  `], {
    cwd: root, timeout: 25_000, maxBuffer: 1024 * 1024,
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: join(root, ".config"),
      XDG_CACHE_HOME: join(root, ".cache"), EASYRESEARCH_CODING_AGENT_DIR: agent, PI_OFFLINE: "1",
    },
  });
  const report = stdout.split("\n").find((line) => line.startsWith("DESKTOP_ADMISSION:"));
  expect(report, stdout).toBeDefined();
  const result = JSON.parse(report!.slice("DESKTOP_ADMISSION:".length)) as { allowed: number; missingCredentials: unknown[] };
  expect(result.allowed).toBe(200);
  expect(result.missingCredentials).toEqual([
    expect.objectContaining({ origin: "null", authenticated: false, status: 403, cors: null }),
    expect.objectContaining({ origin: null, authenticated: false, status: 401, cors: null }),
  ]);
}, 30_000);
