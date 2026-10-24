#!/usr/bin/env bun
/** Compiled-served, real-Pi-history acceptance. Owns all fixture state and daemons. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { createSmokeDaemonCustody } from "./smoke-release-support";

assert(process.argv.length === 3, "Usage: bun scripts/smoke-transcript-history.ts <native-binary>");
const binary = resolve(process.argv[2]!);
const root = mkdtempSync(join(tmpdir(), "easyresearch-history-browser-"));
const home = join(root, "home");
const agentDir = join(root, "agent");
const project = join(root, "projects", "history");
const emptyPath = join(root, "empty-path");
for (const path of [home, agentDir, project, emptyPath]) mkdirSync(path, { recursive: true });
Object.assign(process.env, { HOME: home, USERPROFILE: home, EASYRESEARCH_CODING_AGENT_DIR: agentDir });
const env = { HOME: home, USERPROFILE: home, EASYRESEARCH_CODING_AGENT_DIR: agentDir, PATH: emptyPath, NO_PROXY: "localhost,127.0.0.1,::1", LANG: "C.UTF-8" };
const report: Record<string, unknown> = { binary, sha256: createHash("sha256").update(readFileSync(binary)).digest("hex"), root };
console.log(`HISTORY_SMOKE artifacts: ${root}`);

const gate = Promise.withResolvers<void>();
let modelRequests = 0;
const model = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: 256 * 1024 * 1024,
  async fetch(request) {
    await request.arrayBuffer();
    modelRequests++;
    const encode = (delta: unknown, finish: string | null = null) => new TextEncoder().encode(`data: ${JSON.stringify({
      id: "history-live", object: "chat.completion.chunk", created: 1, model: "history",
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`);
    return new Response(new ReadableStream<Uint8Array>({ async start(controller) {
      controller.enqueue(encode({ role: "assistant", content: "LIVE_HISTORY_START " }));
      await gate.promise;
      try {
        controller.enqueue(encode({ content: "LIVE_HISTORY_FINISHED" }));
        controller.enqueue(encode({}, "stop"));
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      } catch { /* owned smoke shutdown cancelled the request */ }
    } }), { headers: { "Content-Type": "text/event-stream" } });
  },
});
writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { "history-smoke": {
  baseUrl: `http://127.0.0.1:${model.port}/v1`, api: "openai-completions", apiKey: "isolated-fixture",
  compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
  models: [{ id: "history", name: "History Smoke", contextWindow: 100_000_000, maxTokens: 2048 }],
} } }));
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
  defaultProvider: "history-smoke", defaultModel: "history", compaction: { enabled: false },
  easyresearch: { web: { sessionIdleTimeoutMs: -1 }, agentDefaults: { "research-assistant": { model: "history-smoke/history", thinking: "off" } } },
}));
writeFileSync(join(project, "README.md"), "# History smoke\n");

const { importPi } = await import("../src/runtime/pi-import");
const pi = await importPi();
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
let timestamp = 10;
const assistant = (content: any[]) => ({ role: "assistant" as const, content, api: "openai-completions" as const,
  provider: "history-smoke", model: "history", usage, stopReason: "stop" as const, timestamp: ++timestamp });
const createHistory = (name: string) => {
  const manager = pi.SessionManager.create(project);
  manager.appendMessage({ role: "user", content: name, timestamp: ++timestamp });
  for (let index = 0; index < 400; index++) {
    const toolCallId = `history-tool-${index}`;
    manager.appendMessage(assistant([{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: `fixture-${index}.md` } }]));
    manager.appendMessage({ role: "toolResult", toolCallId, toolName: "read", content: [{ type: "text", text: `HISTORY_ROW_${index} ` + "x".repeat(96_000) }], isError: false, timestamp: ++timestamp });
  }
  manager.appendSessionInfo(name);
  return manager;
};
const child = createHistory("easyresearch:search");
child.appendMessage(assistant([{ type: "text", text: "CHILD_HISTORY_TAIL" }]));
const parent = createHistory("Large history acceptance");
const bigText = "OVERSIZED_ENTRY_START " + "汉😀 ".repeat(160_000) + " OVERSIZED_ENTRY_END";
const largeEntry = parent.appendMessage({ role: "user", content: bigText, timestamp: ++timestamp });
parent.appendMessage(assistant([{ type: "toolCall", id: "historical-child", name: "subagent", arguments: { agent: "search", task: "fixture" } }]));
parent.appendMessage({ role: "toolResult", toolCallId: "historical-child", toolName: "subagent", content: [{ type: "text", text: "Saved child" }], isError: false, timestamp: ++timestamp });
parent.appendCustomEntry("easyresearch:subagent_session", { toolCallId: "historical-child", childSessionId: child.getSessionId(), agent: "search" });
parent.appendMessage(assistant([{ type: "text", text: "ROOT_HISTORY_TAIL" }]));
const sessionId = parent.getSessionId();
const childId = child.getSessionId();
const sessionPath = parent.getSessionFile()!;
const childPath = child.getSessionFile()!;
assert(statSync(sessionPath).size > 32 * 1024 * 1024);
assert(statSync(childPath).size > 32 * 1024 * 1024);
const childHash = createHash("sha256").update(readFileSync(childPath)).digest("hex");
report.fixture = { rootBytes: statSync(sessionPath).size, childBytes: statSync(childPath).size, rootEntries: parent.getBranch().length };

const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = probe.port!;
probe.stop(true);
const origin = `http://127.0.0.1:${port}`;
const custody = createSmokeDaemonCustody({ agentDir, host: "127.0.0.1", port });
const cli = async (args: string[], label: string) => {
  const process = Bun.spawn([binary, ...args], { cwd: project, env, stdin: "ignore",
    stdout: Bun.file(join(root, `${label}.stdout`)), stderr: Bun.file(join(root, `${label}.stderr`)) });
  const timeout = setTimeout(() => process.kill(), 60_000);
  try { assert.equal(await process.exited, 0, `${label} failed; see ${root}`); }
  finally { clearTimeout(timeout); }
};
const json = async (path: string) => {
  const response = await fetch(`${origin}${path}`, { proxy: "", signal: AbortSignal.timeout(30_000) });
  assert.equal(response.status, 200, path);
  return response.json() as Promise<any>;
};

let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let proxy: ReturnType<typeof Bun.serve> | undefined;
let primary: unknown;
try {
  await cli(["--no-open", "--port", String(port)], "start");
  assert(await custody.capture());
  assert.equal((await json("/api/status")).agentDir, agentDir);
  const open = await fetch(`${origin}/api/sessions/open`, { method: "POST", proxy: "",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: sessionPath }) });
  assert.equal(open.status, 200);
  await open.json();
  const snapshot = await json(`/api/sessions/${sessionId}/snapshot`);
  assert(Buffer.byteLength(JSON.stringify(snapshot)) < 2 * 1024 * 1024);
  const all = [...snapshot.timeline];
  let cursor = snapshot.history?.cursor;
  let pages = 1;
  while (cursor) {
    const page = await json(`/api/sessions/${sessionId}/history?cursor=${cursor}`);
    assert(Buffer.byteLength(JSON.stringify(page)) <= 1024 * 1024);
    all.unshift(...page.timeline);
    cursor = page.history?.cursor;
    pages++;
  }
  const expected = parent.getBranch().filter((entry) => entry.type === "message").map((entry) => entry.id);
  assert.deepEqual(all.map((entry) => entry.entryId), expected);
  assert.equal((await json(`/api/sessions/${sessionId}/history/${largeEntry}`)).message.content, bigText);
  const childSnapshot = await json(`/api/sessions/${sessionId}/subagents/${childId}/snapshot`);
  assert(childSnapshot.history?.cursor);
  assert(Buffer.byteLength(JSON.stringify(childSnapshot)) < 2 * 1024 * 1024);
  report.protocol = { pages, initialBytes: Buffer.byteLength(JSON.stringify(snapshot)), completeHistory: true, oversizedEntryExact: true };

  let injected = false;
  let recovered = false;
  let streamOpens = 0;
  // One transient failed logical source, through the real compiled channel. All
  // assets, events and API responses still come from the accepted executable.
  proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(request) {
    const url = new URL(request.url);
    let body: string | undefined;
    if (request.method === "PUT" && /^\/api\/events\/[^/]+$/.test(url.pathname)) {
      const replacement = await request.json() as { subscriptions: Array<{ id: string; path: string }> };
      const work = replacement.subscriptions.find((subscription) => subscription.path === `/api/sessions/${sessionId}/events`);
      if (work && !injected) { work.path = "/api/sessions/transient-unavailable/events"; injected = true; }
      else if (work && injected) recovered = true;
      body = JSON.stringify(replacement);
    } else if (request.method !== "GET" && request.method !== "HEAD") body = await request.text();
    if (url.pathname === "/api/events") streamOpens++;
    const headers = new Headers(request.headers);
    headers.delete("host"); headers.delete("content-length");
    return fetch(`${origin}${url.pathname}${url.search}`, { method: request.method, headers, body, proxy: "", signal: request.signal });
  } });
  const browserOrigin = `http://127.0.0.1:${proxy.port}`;
  browser = await chromium.launch({ channel: process.env.COMPARE_CHROMIUM_PATH ? undefined : "chrome", executablePath: process.env.COMPARE_CHROMIUM_PATH, headless: true, args: ["--no-proxy-server"],
    env: { ...process.env, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache") } });
  const deadline = setTimeout(() => void browser?.close(), 180_000);
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
    await context.addInitScript(() => localStorage.setItem("easyresearch.webui.preferences", JSON.stringify({ language: "en" })));
    const views = await Promise.all(Array.from({ length: 8 }, () => context.newPage()));
    const errors: string[] = [];
    const historyRequests: string[] = [];
    const leases = new Set<string>();
    for (const view of views) {
      view.on("pageerror", (error) => errors.push(error.message));
      view.on("request", (request) => {
        const url = new URL(request.url());
        if (url.pathname.endsWith("/history")) historyRequests.push(request.url());
        const lease = url.pathname.match(/\/file-watches\/([^/]+)$/)?.[1];
        if (lease) leases.add(lease);
      });
      await view.goto(`${browserOrigin}/#/work/${sessionId}?cwd=${encodeURIComponent(project)}`, { waitUntil: "domcontentloaded" });
      await expect(view.getByText("ROOT_HISTORY_TAIL", { exact: true })).toBeVisible({ timeout: 20_000 });
      await expect(view.getByRole("treeitem", { name: "README.md", exact: true })).toBeVisible();
    }
    await expect.poll(() => recovered).toBe(true);
    assert(injected);
    assert.equal(streamOpens, 1, "Healthy shared physical stream must survive a logical subscription failure");
    await expect.poll(() => leases.size).toBe(8);
    const page = views[0]!;
    await page.bringToFront();
    const conversation = page.getByLabel("Conversation", { exact: true });
    await conversation.evaluate((element) => { element.scrollTop = 0; });
    const anchor = await conversation.locator("[data-row-key]").evaluateAll((elements) => {
      const root = elements[0]?.closest("[data-scrollable]")?.getBoundingClientRect();
      const row = elements.find((el) => el.getBoundingClientRect().bottom > (root?.top ?? 0));
      return row ? { key: row.getAttribute("data-row-key"), top: row.getBoundingClientRect().top } : undefined;
    });
    assert(anchor?.key);
    const count = historyRequests.length;
    const olderResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/sessions/${sessionId}/history`);
    await page.getByRole("button", { name: "Load earlier messages", exact: true }).click();
    assert.equal((await olderResponse).status(), 200);
    await (await olderResponse).json();
    await expect(page.getByRole("button", { name: "Load earlier messages", exact: true })).toBeEnabled();
    await expect.poll(() => historyRequests.length).toBeGreaterThan(count);
    await expect.poll(async () => conversation.locator("[data-row-key]").evaluateAll((elements, wanted) => {
      const row = elements.find((element) => element.getAttribute("data-row-key") === wanted.key);
      return row ? Math.abs(row.getBoundingClientRect().top - wanted.top) : Infinity;
    }, anchor), { timeout: 10_000 }).toBeLessThan(5);

    // Start a real provider response and publish older history while it is live.
    const composer = page.getByRole("textbox", { name: "Message", exact: true });
    await composer.fill("Continue the isolated history acceptance.");
    await composer.press("Enter");
    await expect(page.getByText("LIVE_HISTORY_START", { exact: false })).toBeVisible({ timeout: 30_000 });
    await conversation.evaluate((element) => { element.scrollTop = 0; });
    const duringLive = historyRequests.length;
    const liveHistoryResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/sessions/${sessionId}/history`);
    await page.getByRole("button", { name: "Load earlier messages", exact: true }).click();
    assert.equal((await liveHistoryResponse).status(), 200);
    await (await liveHistoryResponse).json();
    await expect(page.getByRole("button", { name: "Load earlier messages", exact: true })).toBeEnabled();
    await expect.poll(() => historyRequests.length).toBeGreaterThan(duringLive);
    gate.resolve();
    await page.getByRole("button", { name: "Jump to latest", exact: true }).click();
    await expect(page.getByText("LIVE_HISTORY_START LIVE_HISTORY_FINISHED", { exact: true })).toBeVisible();
    await expect(views[1]!.getByText("LIVE_HISTORY_START LIVE_HISTORY_FINISHED", { exact: true })).toBeVisible();
    assert.equal(modelRequests, 1);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByText("LIVE_HISTORY_START LIVE_HISTORY_FINISHED", { exact: true })).toBeVisible();
    await expect(page.getByText("Connection lost", { exact: false })).toHaveCount(0);
    await conversation.evaluate((element) => { element.scrollTop = 0; });
    await page.getByRole("button", { name: "Full entry", exact: true }).first().click();
    const detail = page.getByRole("textbox", { name: "Full entry", exact: true });
    await expect.poll(() => detail.inputValue()).toContain("OVERSIZED_ENTRY_END");
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: "View details", exact: true }).click();
    await expect(page.getByText("CHILD_HISTORY_TAIL", { exact: true })).toBeVisible();
    await conversation.evaluate((element) => { element.scrollTop = 0; });
    const childHistoryResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/sessions/${sessionId}/subagents/${childId}/history`);
    await page.getByRole("button", { name: "Load earlier messages", exact: true }).click();
    assert.equal((await childHistoryResponse).status(), 200);
    await (await childHistoryResponse).json();
    await expect(page.getByRole("button", { name: "Load earlier messages", exact: true })).toBeEnabled();
    await expect(conversation.locator('[data-row-key="history-tool-380"]')).toHaveCount(1);
    await expect.poll(() => historyRequests.some((url) => url.includes(`/subagents/${childId}/history`))).toBe(true);
    await expect(composer).toBeDisabled();
    await page.screenshot({ path: join(root, "child-history.png") });
    report.browser = { tabs: 8, physicalStreams: streamOpens, logicalRecovery: recovered, independentLeases: leases.size, rootAndChildPaging: true, anchorPreserved: true, liveOutputPreserved: true, pageErrors: errors };
    assert.deepEqual(errors, []);
    await context.close();

    const fallback = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "en-US" });
    await fallback.addInitScript(() => {
      Object.defineProperty(window, "SharedWorker", { value: undefined });
      localStorage.setItem("easyresearch.webui.preferences", JSON.stringify({ language: "en" }));
    });
    const mobile = await fallback.newPage();
    await mobile.goto(`${browserOrigin}/#/work/${sessionId}?cwd=${encodeURIComponent(project)}`);
    await expect(mobile.getByText("LIVE_HISTORY_START LIVE_HISTORY_FINISHED", { exact: true })).toBeVisible();
    await expect(mobile.getByText("Connection lost", { exact: false })).toHaveCount(0);
    assert(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await mobile.screenshot({ path: join(root, "fallback-mobile.png") });
    report.fallback = { width: 390, loaded: true };
    await fallback.close();
    assert.equal(createHash("sha256").update(readFileSync(childPath)).digest("hex"), childHash, "Read-only child paging altered JSONL");
  } finally { clearTimeout(deadline); }
} catch (error) {
  primary = error;
  report.error = String(error);
  for (const [index, page] of (browser?.contexts()[0]?.pages().slice(0, 2) ?? []).entries()) {
    await page.screenshot({ path: join(root, `failure-${index}.png`) }).catch(() => {});
  }
} finally {
  gate.resolve();
  await browser?.close();
  proxy?.stop(true);
  model.stop(true);
  try { await custody.stopAndVerify(); } catch (error) { primary = primary ? new AggregateError([primary, error]) : error; }
  writeFileSync(join(root, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
if (primary) throw primary;
