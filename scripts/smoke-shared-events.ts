#!/usr/bin/env bun
/** Real, isolated compiled-browser acceptance. Never intercepts event/API traffic.
 * bun scripts/smoke-shared-events.ts <origin> <isolated-preview/session-index.json>
 */
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium, expect } from "@playwright/test";

const origin = new URL(process.argv[2]!).origin;
const fixtureFile = resolve(process.argv[3]!);
const root = dirname(fixtureFile);
const sessions = JSON.parse(readFileSync(fixtureFile, "utf8")) as { id: string; cwd: string; path: string }[];
const status = await fetch(`${origin}/api/status`).then((response) => response.json());
assert.equal(
  status.agentDir,
  join(root, "agent"),
  "Only an explicitly isolated preview may be restarted by this smoke",
);
assert(root.startsWith(tmpdir() + "/"), "Fixture state must be under the system temporary directory");
assert(
  sessions.length >= 2 &&
    sessions.every((session) => session.path.startsWith(join(root, "agent", "sessions"))),
);
assert(sessions.every((session) => session.cwd.startsWith(join(root, "projects") + "/")));
const watchedFile = join(sessions[0]!.cwd, "README.md");
const originalFile = readFileSync(watchedFile);
const artifacts = mkdtempSync(join(tmpdir(), "easyresearch-shared-events-"));
const portProbe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") });
const debugPort = portProbe.port;
portProbe.stop(true);
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.COMPARE_CHROMIUM_PATH,
  args: [`--remote-debugging-port=${debugPort}`],
});
let debugSocket: WebSocket | undefined;
const deadline = setTimeout(() => {
  void browser.close();
}, 180_000);
const report: Record<string, unknown> = { origin, artifacts };
try {
  const debug = await fetch(`http://127.0.0.1:${debugPort}/json/version`, { proxy: "" }).then((response) =>
    response.json(),
  );
  const socket = new WebSocket(debug.webSocketDebuggerUrl);
  debugSocket = socket;
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("CDP connection failed"));
  });
  const live = new Map<string, { path: string; protocol?: string }>();
  const workers = new Set<string>();
  let command = 0;
  const commands = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const send = (method: string, params: unknown = {}, sessionId?: string) =>
    new Promise((resolve, reject) => {
      const id = ++command;
      commands.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const observe = (target: string, message: { method: string; params?: any }) => {
    const params = message.params;
    if (message.method === "Network.requestWillBeSent" && params.type === "EventSource") {
      live.set(`${target}:${params.requestId}`, { path: new URL(params.request.url).pathname });
    }
    if (message.method === "Network.responseReceived") {
      const stream = live.get(`${target}:${params.requestId}`);
      if (stream) stream.protocol = params.response.protocol;
    }
    if (message.method === "Network.loadingFinished" || message.method === "Network.loadingFailed")
      live.delete(`${target}:${params.requestId}`);
  };
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id) {
      const pending = commands.get(message.id);
      commands.delete(message.id);
      if (message.error) pending?.reject(new Error(message.error.message));
      else pending?.resolve(message.result);
      return;
    }
    if (message.method === "Target.attachedToTarget" && message.params.targetInfo.type === "shared_worker") {
      const { sessionId, targetInfo } = message.params;
      workers.add(targetInfo.targetId);
      void send("Network.enable", {}, sessionId).then(() =>
        send("Runtime.runIfWaitingForDebugger", {}, sessionId),
      );
    } else if (message.method === "Target.detachedFromTarget") {
      for (const key of live.keys()) if (key.startsWith(`${message.params.sessionId}:`)) live.delete(key);
    } else if (message.sessionId) observe(message.sessionId, message);
  };
  await send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
    filter: [{ type: "shared_worker", exclude: false }, { exclude: true }],
  });

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
  await context.addInitScript(() =>
    localStorage.setItem("easyresearch.webui.preferences", JSON.stringify({ language: "en" })),
  );
  const pages: Awaited<ReturnType<typeof context.newPage>>[] = [];
  const leases = new Map<number, { session: string; lease: string }>();
  const configurationLeases = new Map<number, string>();
  const hashes = new Map<number, string>();
  for (let i = 0; i < 8; i++) {
    const page = await context.newPage();
    pages.push(page);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    for (const method of [
      "Network.requestWillBeSent",
      "Network.responseReceived",
      "Network.loadingFailed",
      "Network.loadingFinished",
    ] as const) {
      cdp.on(method, (params) => observe(`page-${i}`, { method, params }));
    }
    page.on("request", (request) => {
      const match = new URL(request.url()).pathname.match(
        /^\/api\/sessions\/([^/]+)\/file-watches\/([^/]+)$/,
      );
      if (match) leases.set(i, { session: match[1]!, lease: match[2]! });
      const configuration = new URL(request.url()).pathname.match(
        /^\/api\/config\/project-watches\/([^/]+)$/,
      );
      if (configuration) configurationLeases.set(i, configuration[1]!);
    });
    const session = sessions[i % sessions.length]!;
    const hash = `#/work/${session.id}?cwd=${encodeURIComponent(session.cwd)}`;
    hashes.set(i, hash);
    await page.goto(`${origin}/${hash}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("treeitem", { name: "README.md", exact: true })).toBeVisible();
  }
  await expect.poll(() => live.size).toBe(1);
  assert.equal([...live.values()][0]?.path, "/api/events");
  assert.equal(workers.size, 1);
  await expect.poll(() => leases.size).toBe(pages.length);
  assert.equal(new Set([...leases.values()].map((value) => value.lease)).size, pages.length);
  await expect.poll(() => configurationLeases.size).toBe(pages.length);
  assert.equal(new Set(configurationLeases.values()).size, pages.length);
  const latency = await Promise.all(
    pages.map((page, i) =>
      page.evaluate(
        async (cwd) => {
          const started = performance.now();
          const response = await fetch(`/api/entries?path=${encodeURIComponent(cwd)}`, {
            signal: AbortSignal.timeout(5000),
          });
          await response.json();
          return { status: response.status, ms: Math.round(performance.now() - started) };
        },
        sessions[i % sessions.length]!.cwd,
      ),
    ),
  );
  assert(latency.every((result) => result.status === 200 && result.ms < 5000));
  report.eightTabs = {
    streams: [...live.values()],
    workers: workers.size,
    independentLeases: leases.size,
    independentConfigurationLeases: configurationLeases.size,
    fileRequests: latency,
  };
  const sameSessionViews = pages.filter((_page, index) => index % sessions.length === 0);
  assert(sameSessionViews.length >= 2);
  for (const page of sameSessionViews)
    await page.getByRole("treeitem", { name: "README.md", exact: true }).click();
  const marker = `Shared watcher update ${Date.now()}`;
  writeFileSync(watchedFile, Buffer.concat([originalFile, Buffer.from(`\n\n${marker}\n`)]));
  for (const page of sameSessionViews) await expect(page.getByText(marker, { exact: true })).toBeVisible();
  report.sharedFileUpdates = sameSessionViews.length;
  await pages[0]!.screenshot({ path: join(artifacts, "eight-tabs.png") });

  for (let i = 0; i < 3; i++) await pages[i]!.close();
  for (let i = 0; i < 3; i++) {
    const lease = leases.get(i)!;
    await expect
      .poll(async () => {
        const response = await fetch(`${origin}/api/sessions/${lease.session}/file-watches/${lease.lease}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ revision: 999, directories: [] }),
        });
        await response.arrayBuffer();
        return response.status;
      })
      .toBe(404);
    await expect
      .poll(async () => {
        const response = await fetch(`${origin}/api/config/project-watches/${configurationLeases.get(i)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ revision: 999, cwds: [] }),
        });
        await response.arrayBuffer();
        return response.status;
      })
      .toBe(404);
  }
  await expect.poll(() => live.size).toBe(1);
  report.closedViewsReleased = 3;
  const remaining = pages.slice(3);
  const bootId = (await fetch(`${origin}/api/status`).then((response) => response.json())).bootId;
  const navigations = new Map(remaining.map((page) => [page, 0]));
  for (const page of remaining)
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations.set(page, (navigations.get(page) ?? 0) + 1);
    });
  const restart = await fetch(`${origin}/api/runtime/restart`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ force: false }),
  });
  assert.equal(restart.status, 202);
  await restart.json();
  for (const [index, page] of remaining.entries()) {
    await expect.poll(() => navigations.get(page), { timeout: 30_000 }).toBe(1);
    await expect(page.getByRole("treeitem", { name: "README.md", exact: true })).toBeVisible();
    assert.equal(new URL(page.url()).hash, hashes.get(index + 3));
  }
  await expect.poll(() => live.size).toBe(1);
  assert.notEqual((await fetch(`${origin}/api/status`).then((response) => response.json())).bootId, bootId);
  report.restart = {
    documentReloads: [...navigations.values()],
    streams: live.size,
    canonicalRoutesPreserved: true,
  };
  await context.close();

  const fallback = await browser.newContext({ locale: "en-US" });
  await fallback.addInitScript(() => Object.defineProperty(window, "SharedWorker", { value: undefined }));
  const page = await fallback.newPage();
  const cdp = await fallback.newCDPSession(page);
  await cdp.send("Network.enable");
  const fallbackStreams = new Set<string>();
  cdp.on("Network.requestWillBeSent", (event) => {
    if (event.type === "EventSource") fallbackStreams.add(event.request.url);
  });
  await page.goto(`${origin}/${hashes.get(0)}`);
  await expect(page.getByRole("treeitem", { name: "README.md", exact: true })).toBeVisible();
  assert.deepEqual([...fallbackStreams], [`${origin}/api/events`]);
  report.fallback = "one page-owned channel; file tree loaded";
  await fallback.close();
  writeFileSync(join(artifacts, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  writeFileSync(watchedFile, originalFile);
  clearTimeout(deadline);
  debugSocket?.close();
  await browser.close();
}
