#!/usr/bin/env bun
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, request as requestHttp, type IncomingHttpHeaders } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { chromium, expect, type Browser, type BrowserContext, type Frame, type Locator, type Page } from "@playwright/test";
import type { importPi } from "../src/runtime/pi-import";
import { workFilesMp4, workFilesSvg } from "./work-files-media-fixture";

type Pi = Awaited<ReturnType<typeof importPi>>;
interface WireRecord {
  sequence: number;
  method: string;
  path: string;
  forwardedBytes: number;
  range?: string;
  contentRange?: string;
  status?: number;
  completed?: boolean;
  aborted?: boolean;
  cancellation?: { reason: string; incomingComplete: boolean; bufferedBytes: number; socketBytesRead: number };
  events?: string[];
  error?: string;
}
interface UploadGate {
  wait: Promise<void>;
  release(): void;
  forwarded: number;
  aborted: boolean;
}
interface CspRecord { directive: string; blocked: string; document: string }
interface CaseReport {
  width: number;
  theme: string;
  cwd: string;
  sessionId: string;
  checks: string[];
  measurements: Record<string, unknown>;
  csp: CspRecord[];
  pageErrors: string[];
  blockers?: string[];
  passed: boolean;
  error?: string;
}

/** Test-only forwarding: stream actual requests/responses, including SSE and ranges. */
export async function recordingProxy(target: string) {
  const records: WireRecord[] = [];
  const gates = new Map<string, UploadGate>();
  const sockets = new Set<Socket>();
  const active = new Set<AbortController>();
  const pumps = new Set<Promise<void>>();
  const hop = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "te", "trailer", "upgrade"]);
  const headers = (input: IncomingHttpHeaders) => Object.fromEntries(Object.entries(input).filter(([key]) => !hop.has(key.toLowerCase())));
  const server = createServer((incoming, outgoing) => {
    const path = incoming.url ?? "/";
    const url = new URL(path, target);
    const record: WireRecord = { sequence: records.length, method: incoming.method ?? "GET", path, forwardedBytes: 0,
      ...(typeof incoming.headers.range === "string" ? { range: incoming.headers.range } : {}) };
    records.push(record);
    const abort = new AbortController();
    active.add(abort);
    const gateKey = url.pathname === "/api/file/upload" ? url.searchParams.get("name") : null;
    const gate = gateKey ? gates.get(gateKey) : undefined;
    if (gateKey) gates.delete(gateKey); // A user retry uses the ordinary, unpaused real transport.
    const upstream = requestHttp(url, { method: incoming.method, headers: headers(incoming.headers), agent: false });
    const cancel = (reason: string) => {
      record.aborted = true;
      record.cancellation ??= { reason, incomingComplete: incoming.complete, bufferedBytes: incoming.readableLength,
        socketBytesRead: incoming.socket.bytesRead };
      if (gate) { gate.aborted = true; gate.release(); }
      abort.abort();
      upstream.destroy();
    };
    const event = (name: string) => { if (gate) (record.events ??= []).push(name); };
    incoming.on("end", () => event("incoming:end"));
    incoming.on("close", () => event("incoming:close"));
    incoming.on("aborted", () => { event("incoming:aborted"); cancel("incoming:aborted"); });
    outgoing.on("finish", () => event("response:finish"));
    outgoing.on("close", () => {
      event("response:close");
      if (!outgoing.writableFinished) cancel("response:close-before-finish");
      active.delete(abort);
    });
    abort.signal.addEventListener("abort", () => {
      gate?.release();
      upstream.destroy();
      outgoing.destroy();
    }, { once: true });
    upstream.on("error", (error) => {
      record.error = error.message;
      cancel("upstream:error");
    });
    upstream.on("response", (response) => {
      if (response.statusCode === undefined) {
        record.error = "Upstream response omitted its HTTP status";
        response.destroy();
        cancel("upstream:missing-status");
        return;
      }
      record.status = response.statusCode;
      if (typeof response.headers["content-range"] === "string") record.contentRange = response.headers["content-range"];
      // Keep duplicate CSP policies intact; never rewrite their source expressions.
      const rawHeaders: string[] = [];
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        if (!hop.has(response.rawHeaders[index]!.toLowerCase())) rawHeaders.push(response.rawHeaders[index]!, response.rawHeaders[index + 1]!);
      }
      outgoing.writeHead(response.statusCode, rawHeaders);
      outgoing.flushHeaders();
      response.on("end", () => { record.completed = true; });
      response.on("error", (error) => { record.error = error.message; cancel("upstream:response-error"); });
      response.pipe(outgoing);
    });
    const pump = (async () => {
      let paused = false;
      try {
        for await (const chunk of incoming) {
          abort.signal.throwIfAborted();
          if (!upstream.write(chunk)) await once(upstream, "drain", { signal: abort.signal });
          record.forwardedBytes += chunk.length;
          if (gate && !paused) {
            paused = true;
            gate.forwarded = record.forwardedBytes;
            await gate.wait;
            abort.signal.throwIfAborted();
          }
        }
        upstream.end();
      } catch (error) {
        if (!abort.signal.aborted) record.error = String(error);
        cancel("incoming:reader-error");
      }
    })();
    pumps.add(pump);
    void pump.finally(() => pumps.delete(pump));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const address = server.address();
  assert(address && typeof address !== "string");
  const trackUpload = (name: string, paused: boolean): UploadGate => {
    assert(!gates.has(name));
    let release!: () => void;
    const gate = { wait: new Promise<void>((done) => { release = done; }), release: () => release(), forwarded: 0, aborted: false };
    if (!paused) gate.release();
    gates.set(name, gate);
    return gate;
  };
  let closing: Promise<void> | undefined;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    records,
    pauseUpload(name: string): UploadGate {
      return trackUpload(name, true);
    },
    observeUpload(name: string): UploadGate {
      return trackUpload(name, false);
    },
    close(): Promise<void> {
      if (closing) return closing;
      for (const gate of gates.values()) gate.release();
      for (const controller of active) controller.abort();
      for (const socket of sockets) socket.destroy();
      closing = new Promise<void>((done, reject) => {
        const timer = setTimeout(() => reject(new Error("Recording proxy did not close within five seconds")), 5_000);
        server.close((error) => {
          if (error) { clearTimeout(timer); reject(error); return; }
          void Promise.allSettled([...pumps]).then(() => { clearTimeout(timer); done(); });
        });
      });
      return closing;
    },
  };
}

export function reportHtml(label: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Work report ${label}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="./assets/main.css"></head><body>
<main class="report-panel"><h1>Interactive report</h1><p id="tail">waiting</p>
<button id="inline-button" onclick="document.querySelector('#inline-count').textContent=String(++window.inlineCount)">Inline chart</button>
<output id="inline-count">0</output><button id="local-button">Local chart</button><output id="local-count">0</output>
<div id="chart" style="height:20px;width:20px;background:#2563eb"></div>
<p id="local-ready">waiting</p><p id="module-ready">waiting</p><p id="fetch-ready">waiting</p>
<img id="local-image" src="./assets/image.svg" width="120" height="90" alt="Scoped fixture image">
<div id="css-image" style="width:30px;height:30px"></div>
<button id="isolate">Check isolation</button><pre id="isolation">waiting</pre>
<nav>${["app", "raw", "data", "blob", "meta", "about"].map((kind) => `<button data-nav="${kind}">Navigate ${kind}</button>`).join("")}</nav>
<p id="navigation-error"></p><p id="fixture-error"></p></main>
<!--${"Full HTML transport fixture. ".repeat(42_000)}-->
<script>
window.inlineCount=0;
window.fixtureConfig=fetch('./attack-config.json').then(response=>{if(!response.ok)throw Error('config '+response.status);return response.json()});
document.querySelector('#tail').textContent='FULL_HTML_TAIL_${label}';
document.querySelector('#isolate').addEventListener('click',async()=>{
 try {
  const config=await window.fixtureConfig;
  const result={};
  for(const [name,probe] of [['parent',()=>parent.document.body],['storage',()=>localStorage.getItem('fixture')]]) {
   try { probe(); result[name]=false; } catch(error) { result[name]=error.name==='SecurityError'; }
  }
  for(const name of ['api','raw','foreign']) {
   try { await fetch(config[name],{signal:AbortSignal.timeout(3000)}); result[name]=false; }
   catch { result[name]=true; }
  }
  document.querySelector('#isolation').textContent=JSON.stringify(result);
  document.body.dataset.isolation='done';
 }catch(error){document.querySelector('#fixture-error').textContent=String(error)}
});
for(const button of document.querySelectorAll('[data-nav]'))button.addEventListener('click',async()=>{
 try {
  const config=await window.fixtureConfig;
  const kind=button.dataset.nav;
  document.body.dataset.navigation=kind;
  if(kind==='about'){location.assign('about:blank');return}
  let target=config.navigation[kind];
  if(kind==='data'||kind==='blob'){
   const payload='<script>fetch('+JSON.stringify(target)+').catch(()=>{});<'+ '/script><p>Escaped fixture</p>';
   target=kind==='data'?'data:text/html,'+encodeURIComponent(payload):URL.createObjectURL(new Blob([payload],{type:'text/html'}));
  }
  if(kind==='meta'){
   const meta=document.createElement('meta');meta.httpEquiv='refresh';meta.content='0;url='+target;document.head.append(meta);
  }else location.assign(target);
 }catch(error){document.querySelector('#navigation-error').textContent=String(error)}
});
</script><script src="./assets/local.js"></script><script type="module" src="./assets/module.js"></script>
</body></html>`;
}

function fixture(pi: Pi, runtime: string, label: string) {
  const cwd = join(runtime, `project-${label}`);
  const inputs = join(runtime, `inputs-${label}`);
  const reportDirectory = join(cwd, "reports");
  const foreignDirectory = join(runtime, `foreign-${label}`);
  for (const directory of [cwd, inputs, join(cwd, "incoming"), join(cwd, "cancelled"), join(reportDirectory, "assets", "nested"), foreignDirectory]) mkdirSync(directory, { recursive: true });
  const files = new Map<string, Buffer>([
    ["image.svg", Buffer.from(workFilesSvg)],
    ["broken.svg", Buffer.from("not an SVG image")],
    ["video.mp4", workFilesMp4()],
    ["existing.txt", Buffer.from("Existing file must survive conflicts")],
    ["raw-target.html", Buffer.from("<!doctype html><p>Raw target</p>")],
  ]);
  for (const [name, bytes] of files) writeFileSync(join(cwd, name), bytes);
  const html = reportHtml(label);
  assert(Buffer.byteLength(html) > 1024 * 1024);
  writeFileSync(join(reportDirectory, "report.html"), html);
  writeFileSync(join(reportDirectory, "assets", "image.svg"), workFilesSvg);
  writeFileSync(join(reportDirectory, "assets", "main.css"), '@import "./nested/colors.css"; body{margin:0;padding:12px;font:14px sans-serif} *{box-sizing:border-box} button{margin:4px;padding:6px} pre{white-space:pre-wrap;overflow-wrap:anywhere} .report-panel{max-width:100%;border-width:3px;border-style:solid} #css-image{background-image:url("./image.svg");background-size:contain}');
  writeFileSync(join(reportDirectory, "assets", "nested", "colors.css"), ".report-panel{border-color:rgb(23,91,137)}");
  writeFileSync(join(reportDirectory, "assets", "local.js"), "document.querySelector('#local-ready').textContent='classic-ready';let count=0;document.querySelector('#local-button').onclick=()=>{document.querySelector('#local-count').textContent=String(++count);document.querySelector('#chart').style.width=(20+count*20)+'px'};");
  writeFileSync(join(reportDirectory, "assets", "module-value.js"), 'export const marker="module-ready";');
  writeFileSync(join(reportDirectory, "assets", "module.js"), "import {marker} from './module-value.js';document.querySelector('#module-ready').textContent=marker;const response=await fetch(new URL('../data.json',import.meta.url));const data=await response.json();document.querySelector('#fetch-ready').textContent=data.value;");
  writeFileSync(join(reportDirectory, "data.json"), JSON.stringify({ value: "local-fetch-ready" }));
  const foreign = join(foreignDirectory, "foreign.html");
  writeFileSync(foreign, "<!doctype html><p>Foreign scope sentinel</p>");
  const binary = Buffer.alloc(4 * 1024 * 1024 + 17);
  for (let index = 0; index < binary.length; index++) binary[index] = (index * 71 + 19) & 255;
  const uploadFiles = new Map<string, Buffer>([
    ["研究 🐬 100% +.bin", binary],
    ["draft.txt", Buffer.from("# Rename proof\n\nExact Markdown after extension change.\n")],
    ["nested-one.txt", Buffer.from("Chosen directory upload")],
    ["nested-empty.bin", Buffer.alloc(0)],
    ["cancel-me.bin", Buffer.alloc(8 * 1024 * 1024, 0xc3)],
  ]);
  for (const [name, bytes] of uploadFiles) writeFileSync(join(inputs, name), bytes);
  const manager = pi.SessionManager.create(cwd);
  manager.appendMessage({ role: "user", content: `Work files fixture ${label}`, timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant", content: [{ type: "text", text: `Work files ready ${label}` }],
    api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "stop", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  manager.appendSessionInfo(`Work files ${label}`);
  assert(manager.getSessionFile() && existsSync(manager.getSessionFile()!));
  return { cwd, inputs, files, uploadFiles, html, reportDirectory, foreign, id: manager.getSessionId() };
}

async function showTree(page: Page): Promise<void> {
  if (page.viewportSize()!.width < 820) await page.getByRole("tab", { name: "Files", exact: true }).click();
  const toggle = page.getByRole("button", { name: "Toggle file tree", exact: true });
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  await expect(page.getByRole("tree", { name: "Workspace files tree", exact: true })).toBeVisible();
}

async function openFile(page: Page, path: string): Promise<void> {
  await showTree(page);
  const row = page.getByRole("treeitem").and(page.locator(`[title=${JSON.stringify(path)}]`));
  await row.focus();
  await row.press("Enter");
  await expect(page.getByRole("tablist", { name: "Open files", exact: true }).getByRole("tab", { name: basename(path), exact: true })).toHaveAttribute("aria-selected", "true");
}

async function fileMenu(page: Page, name: string): Promise<Locator> {
  await showTree(page);
  const trigger = page.getByRole("button", { name: `Actions for ${name}`, exact: true });
  await trigger.focus();
  await trigger.press("ArrowDown");
  const menu = page.getByRole("menu", { name: `Actions for ${name}`, exact: true });
  await expect(menu).toBeVisible();
  return menu;
}

async function chooseFiles(page: Page, files: string[], directoryName?: string): Promise<void> {
  await showTree(page);
  const trigger = directoryName
    ? (await fileMenu(page, directoryName)).getByRole("menuitem", { name: "Upload here", exact: true })
    : page.getByRole("button", { name: "Upload files", exact: true });
  const chooser = page.waitForEvent("filechooser");
  await trigger.click();
  await (await chooser).setFiles(files);
}

function uploadRow(page: Page, name: string): Locator {
  return page.getByRole("region", { name: "File uploads", exact: true }).getByRole("listitem", { name, exact: true });
}

async function dismissUploads(page: Page): Promise<void> {
  const buttons = page.getByRole("button", { name: /^Dismiss upload of / });
  while (await buttons.count()) await buttons.first().click();
}

async function htmlFrame(page: Page): Promise<Frame> {
  const iframe = page.locator('iframe[title="HTML preview"]');
  await expect(iframe).toBeVisible();
  const handle = await iframe.elementHandle();
  const frame = await handle?.contentFrame();
  await handle?.dispose();
  assert(frame, "HTML iframe must have an actual browser frame");
  return frame;
}

async function noOverflow(page: Page, label: string): Promise<void> {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label} overflows the viewport`);
}

/** Actual Fullscreen API transitions, driven by trusted browser input rather than a shadow-DOM selector. */
export async function checkVideoFullscreen(page: Page, video: Locator, measurements: Record<string, unknown>): Promise<void> {
  const label = "Enter video fullscreen acceptance";
  await expect(page.getByRole("button", { name: label, exact: true })).toHaveCount(0);
  await expect(video).toHaveCount(1);
  assert(await page.evaluate(() => document.fullscreenElement === null), "Fullscreen acceptance must begin outside fullscreen");
  const readMedia = (element: Element) => {
    const media = element as HTMLVideoElement;
    return { source: media.currentSrc, time: media.currentTime, paused: media.paused,
      width: media.videoWidth, height: media.videoHeight, duration: media.duration };
  };
  const before = await video.evaluate(readMedia);
  assert(before.paused, "Fullscreen acceptance starts after the completed paused seek");
  const originalUrl = page.url();
  const evidence: Record<string, unknown> = { before, initiallyFullscreen: false };
  measurements.videoFullscreen = evidence;
  const probe = await video.evaluateHandle((element, text) => {
    const media = element as HTMLVideoElement;
    const state: {
      enter?: { trusted: boolean; active: boolean };
      exit?: { trusted: boolean; active: boolean };
      enterStatus?: "pending" | "complete" | "error";
      exitStatus?: "pending" | "complete" | "error";
      error?: string;
      disposed?: boolean;
    } = {};
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = text;
    button.style.cssText = "position:fixed;left:8px;top:8px;z-index:2147483647;width:230px;height:44px;font:14px sans-serif;background:white;color:black;border:1px solid black";
    const enter = (event: MouseEvent) => {
      state.enter = { trusted: event.isTrusted, active: navigator.userActivation.isActive };
      state.enterStatus = "pending";
      void media.requestFullscreen().then(() => { state.enterStatus = "complete"; }, (error: unknown) => {
        state.enterStatus = "error"; state.error = String(error);
      });
    };
    const exit = (event: KeyboardEvent) => {
      if (event.code !== "KeyF" || document.fullscreenElement !== media) return;
      event.preventDefault();
      event.stopPropagation();
      state.exit = { trusted: event.isTrusted, active: navigator.userActivation.isActive };
      state.exitStatus = "pending";
      void document.exitFullscreen().then(() => { state.exitStatus = "complete"; }, (error: unknown) => {
        state.exitStatus = "error"; state.error = String(error);
      });
    };
    button.addEventListener("click", enter);
    document.addEventListener("keydown", exit, true);
    document.body.append(button);
    return { state, media, button, dispose() {
      button.removeEventListener("click", enter);
      document.removeEventListener("keydown", exit, true);
      button.remove();
      state.disposed = true;
    } };
  }, label);
  try {
    // Playwright's click dispatches real trusted input, preserving transient activation.
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect.poll(() => probe.evaluate((value) => value.state.enterStatus)).toBe("complete");
    await expect.poll(() => video.evaluate((element) => document.fullscreenElement === element)).toBe(true);
    const entered = await probe.evaluate((value) => ({
      input: value.state.enter, fullscreenIsVideo: document.fullscreenElement === value.media,
      connected: value.media.isConnected, width: value.media.getBoundingClientRect().width,
      height: value.media.getBoundingClientRect().height,
    }));
    evidence.entered = entered;
    assert.deepEqual(entered.input, { trusted: true, active: true });
    assert(entered.fullscreenIsVideo && entered.connected, "The actual existing video must own fullscreen");
    // F is a trusted activating key; the temporary capture listener exits the
    // actual fullscreen element without depending on Chromium's native controls.
    await page.keyboard.press("f");
    await expect.poll(() => probe.evaluate((value) => value.state.exitStatus)).toBe("complete");
    await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
    const exited = await probe.evaluate((value) => ({ input: value.state.exit,
      fullscreenIsNull: document.fullscreenElement === null, connected: value.media.isConnected }));
    evidence.exited = exited;
    assert.deepEqual(exited.input, { trusted: true, active: true });
    assert(exited.fullscreenIsNull && exited.connected);
    await expect(video).toHaveCount(1);
    const after = await video.evaluate(readMedia);
    evidence.after = after;
    assert.equal(after.source, before.source);
    assert.equal(after.paused, before.paused);
    assert(Math.abs(after.time - before.time) < 0.15, "Fullscreen enter/exit must retain the completed seek");
    assert.deepEqual([after.width, after.height, after.duration], [before.width, before.height, before.duration]);
    assert.equal(page.url(), originalUrl);
  } finally {
    try {
      evidence.input = await probe.evaluate((value) => value.state);
    } finally {
      try {
        evidence.cleanup = await probe.evaluate(async (value) => {
          // Remove test DOM/listeners even if a denied/failed fullscreen request
          // aborts acceptance. A remaining fullscreen element is cleanup only.
          value.dispose();
          if (document.fullscreenElement === value.media) await document.exitFullscreen();
          return { removed: !value.button.isConnected, disposed: value.state.disposed };
        });
      } finally { await probe.dispose(); }
    }
  }
  await expect(page.getByRole("button", { name: label, exact: true })).toHaveCount(0);
  await noOverflow(page, "Video fullscreen exit");
}

async function checkUploadFilenameGeometry(
  page: Page,
  name: string,
  state: "pending" | "failed" | "cancelled",
  defaultTreeWidth: number,
  evidence: Array<Record<string, unknown>>,
): Promise<void> {
  const tree = page.locator("[data-files-tree]");
  const row = uploadRow(page, name);
  const filename = row.locator(`span[title=${JSON.stringify(name)}]`);
  const mobile = page.viewportSize()!.width < 820;
  const handle = page.getByRole("separator", { name: "Resize file tree", exact: true });
  const width = () => tree.evaluate((element) => element.getBoundingClientRect().width);
  const restoreDefault = async () => {
    if (mobile) return;
    const delta = defaultTreeWidth - await width();
    if (Math.abs(delta) < 1) return;
    const bounds = await handle.boundingBox();
    assert(bounds);
    const x = bounds.x + bounds.width / 2;
    const y = bounds.y + Math.min(40, bounds.height / 2);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + delta, y, { steps: 3 });
    await page.mouse.up();
    await expect.poll(async () => Math.abs(await width() - defaultTreeWidth)).toBeLessThan(1);
  };
  try {
    if (!mobile) {
      assert(defaultTreeWidth > 180, "The initial desktop tree must exercise a width distinct from its 180px minimum");
      await restoreDefault();
    }
    for (const layout of mobile ? ["mobile-full"] : ["default", "minimum-180"]) {
      if (layout === "minimum-180") {
        await handle.focus();
        await handle.press("Home");
        await expect.poll(async () => Math.abs(await width() - 180)).toBeLessThan(1);
      }
      await expect(filename).toHaveText(name);
      await filename.scrollIntoViewIfNeeded();
      await expect(filename).toBeVisible();
      const geometry = await row.evaluate((element, expectedName) => {
        const title = Array.from(element.querySelectorAll<HTMLSpanElement>("span[title]")).find((span) => span.title === expectedName)!;
        const section = element.closest("section")!;
        const tree = element.closest("[data-files-tree]")!;
        const box = (rect: DOMRect) => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom });
        const filename = title.getBoundingClientRect();
        const row = element.getBoundingClientRect();
        const viewport = section.getBoundingClientRect();
        const range = document.createRange();
        const text = title.firstChild!;
        range.setStart(text, 0);
        range.setEnd(text, Math.min(text.textContent?.length ?? 0, Array.from(expectedName).slice(0, 10).join("").length));
        const prefix = range.getBoundingClientRect();
        const visiblePrefixWidth = Math.max(0, Math.min(prefix.right, filename.right, row.right, viewport.right, innerWidth)
          - Math.max(prefix.left, filename.left, row.left, viewport.left, 0));
        const visiblePrefixHeight = Math.max(0, Math.min(prefix.bottom, filename.bottom, row.bottom, viewport.bottom, innerHeight)
          - Math.max(prefix.top, filename.top, row.top, viewport.top, 0));
        return {
          tree: box(tree.getBoundingClientRect()), row: box(row), filename: box(filename), prefix: box(prefix),
          title: title.title, text: title.textContent, fontSize: parseFloat(getComputedStyle(title).fontSize),
          status: element.querySelector('[role="status"], [role="alert"]')?.textContent,
          visiblePrefixWidth, visiblePrefixHeight,
          rowClientWidth: element.clientWidth, rowScrollWidth: element.scrollWidth,
          sectionClientWidth: section.clientWidth, sectionScrollWidth: section.scrollWidth,
          actions: Array.from(element.querySelectorAll("button")).map((button) => ({ label: button.getAttribute("aria-label"), ...box(button.getBoundingClientRect()) })),
        };
      }, name);
      evidence.push({ state, layout, name, ...geometry });
      assert.equal(geometry.title, name);
      assert.equal(geometry.text, name, "Measure the displayed filename, not only the upload row's accessible name");
      assert(geometry.filename.width >= Math.min(120, geometry.row.width * 0.75), `${state}/${layout}: filename has no meaningful reading width`);
      assert(geometry.filename.height >= geometry.fontSize, `${state}/${layout}: filename line is vertically collapsed`);
      assert(geometry.visiblePrefixWidth >= Math.min(80, geometry.prefix.width) - 1, `${state}/${layout}: filename prefix is clipped away`);
      assert(geometry.visiblePrefixHeight >= Math.min(geometry.fontSize, geometry.prefix.height) - 1, `${state}/${layout}: filename prefix is outside the visible upload area`);
      assert(geometry.rowScrollWidth <= geometry.rowClientWidth + 1 && geometry.sectionScrollWidth <= geometry.sectionClientWidth + 1,
        `${state}/${layout}: upload row/section overflows horizontally`);
      for (const action of geometry.actions) {
        assert(action.x >= geometry.row.x - 1 && action.right <= geometry.row.right + 1, `${state}/${layout}: action exceeds its row`);
        const overlapX = Math.min(action.right, geometry.filename.right) - Math.max(action.x, geometry.filename.x);
        const overlapY = Math.min(action.bottom, geometry.filename.bottom) - Math.max(action.y, geometry.filename.y);
        assert(overlapX <= 1 || overlapY <= 1, `${state}/${layout}: action overlaps the filename line`);
      }
      await noOverflow(page, `${state}/${layout} upload filename`);
    }
  } finally { await restoreDefault(); }
}

async function checkSplitters(page: Page, checks: string[], measurements: Record<string, unknown>): Promise<void> {
  if (page.viewportSize()!.width < 820) {
    await expect(page.getByRole("separator", { name: "Resize file tree", exact: true })).toHaveCount(0);
    return;
  }
  const iframe = page.locator('iframe[title="HTML preview"]');
  const originalSource = await iframe.getAttribute("src");
  const child = await htmlFrame(page);
  const observe = () => {
    const events: unknown[] = [];
    const types = ["pointerdown", "pointermove", "pointerup", "pointercancel", "gotpointercapture", "lostpointercapture"];
    const listener = (event: Event) => {
      const pointer = event as PointerEvent;
      if (events.length < 80) events.push({ type: event.type, x: pointer.clientX, y: pointer.clientY,
        buttons: pointer.buttons, id: pointer.pointerId, target: (event.target as Element)?.getAttribute?.("aria-label") });
    };
    for (const type of types) document.addEventListener(type, listener, true);
    (window as unknown as { __resizeEvidence: () => unknown }).__resizeEvidence = () => {
      for (const type of types) document.removeEventListener(type, listener, true);
      return events;
    };
  };
  await page.evaluate(observe);
  await child.evaluate(observe);
  const evidence: Array<Record<string, unknown>> = [];
  const failures: unknown[] = [];
  measurements.splitters = evidence;
  const bodyStyles = () => ({
    userSelect: document.body.style.userSelect,
    userSelectPriority: document.body.style.getPropertyPriority("user-select"),
    overflow: document.body.style.overflow,
    overflowPriority: document.body.style.getPropertyPriority("overflow"),
  });
  const pointInside = (point: { x: number; y: number }, rect: { x: number; y: number; width: number; height: number } | null) =>
    !!rect && point.x > rect.x && point.x < rect.x + rect.width && point.y > rect.y && point.y < rect.y + rect.height;
  try {
    for (const name of ["Resize panel", "Resize file tree"]) {
      const handle = page.getByRole("separator", { name, exact: true });
      const observation: Record<string, unknown> = { name };
      evidence.push(observation);
      const originalBodyStyles = await page.evaluate(bodyStyles);
      const originalPointerEvents = await iframe.evaluate((element) => getComputedStyle(element).pointerEvents);
      const paneState = () => handle.evaluate((element, tree) => {
        const pane = tree ? element.previousElementSibling : element.parentElement;
        return {
          actual: pane!.getBoundingClientRect().width,
          value: Number(element.getAttribute("aria-valuenow")),
          min: Number(element.getAttribute("aria-valuemin")),
          max: Number(element.getAttribute("aria-valuemax")),
          captured: element.hasPointerCapture(1),
        };
      }, name === "Resize file tree");
      const settled = async () => {
        const state = await paneState();
        return Math.abs(state.actual - state.value) < 1 && state.value >= state.min && state.value <= state.max;
      };
      try {
        assert.notEqual(originalPointerEvents, "none", "HTML must accept pointer input before a resize gesture");
        await expect(handle).toBeVisible();
        await handle.focus();
        await handle.press("Home");
        const minimum = Number(await handle.getAttribute("aria-valuenow"));
        await handle.press("End");
        await expect.poll(async () => Number(await handle.getAttribute("aria-valuenow"))).toBeGreaterThan(minimum);
        await handle.press("Home");
        await expect.poll(settled).toBe(true);
        const start = await handle.boundingBox();
        const frame = await iframe.boundingBox();
        assert(start && frame);
        // The far interior remains inside the LIVE frame after the inner tree
        // reaches its maximum. Hit-testing is deliberately disabled by the shield.
        const releasePoint = { x: frame.x + frame.width - Math.min(40, frame.width / 4), y: frame.y + Math.min(120, frame.height / 2) };
        observation.before = { body: originalBodyStyles, pointerEvents: originalPointerEvents, pane: await paneState(), frame };
        await page.mouse.move(start.x + start.width / 2, releasePoint.y);
        await page.mouse.down();
        await expect.poll(() => iframe.evaluate((element) => getComputedStyle(element).pointerEvents), { message: `${name}: active resize must shield the iframe` }).toBe("none");
        await page.mouse.move(releasePoint.x, releasePoint.y, { steps: 5 });
        await expect.poll(settled).toBe(true);
        await expect.poll(async () => pointInside(releasePoint, await iframe.boundingBox()), { message: `${name}: release coordinates must be inside the live iframe bounds` }).toBe(true);
        assert.equal(await iframe.evaluate((element) => getComputedStyle(element).pointerEvents), "none", "The iframe shield must remain active through the release point");
        observation.beforeRelease = { point: releasePoint, liveFrame: await iframe.boundingBox(), pane: await paneState(),
          body: await page.evaluate(bodyStyles), pointerEvents: await iframe.evaluate((element) => getComputedStyle(element).pointerEvents) };
        if (name === "Resize file tree") assert(await handle.evaluate((element) => element.hasPointerCapture(1)), "Tree splitter must retain its pointer during the shielded drag");
        await page.mouse.up();
        await expect.poll(() => handle.evaluate((element) => element.hasPointerCapture(1)), { message: `${name}: pointer ownership must release after mouse up` }).toBe(false);
        await expect.poll(() => page.evaluate(bodyStyles)).toEqual(originalBodyStyles);
        await expect.poll(() => iframe.evaluate((element) => getComputedStyle(element).pointerEvents), { message: `${name}: iframe interaction must be restored` }).toBe(originalPointerEvents);
        await expect.poll(settled).toBe(true);
        const committed = await paneState();
        assert(pointInside(releasePoint, await iframe.boundingBox()), "The terminal release coordinate must remain inside the settled live iframe");
        if (name === "Resize file tree") assert(committed.value > minimum, "The shielded pointer drag must actually resize the tree");
        else assert.equal(committed.value, minimum, "Dragging past the outer minimum must stay clamped");
        observation.afterRelease = { point: releasePoint, liveFrame: await iframe.boundingBox(), pane: committed,
          body: await page.evaluate(bodyStyles), pointerEvents: await iframe.evaluate((element) => getComputedStyle(element).pointerEvents) };
        await page.mouse.move(start.x - 30, releasePoint.y);
        await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
        const idle = await paneState();
        assert.equal(idle.value, committed.value, "Idle pointer movement must not continue a settled resize");
        assert(Math.abs(idle.actual - committed.actual) < 1, "Pane geometry must stay settled after pending resize frames");
        assert.deepEqual(await page.evaluate(bodyStyles), originalBodyStyles);
        assert.equal(await iframe.evaluate((element) => getComputedStyle(element).pointerEvents), originalPointerEvents);
        assert.equal(await iframe.getAttribute("src"), originalSource, "Resizing must retain the same HTML scope");
        observation.passed = true;
      } catch (error) {
        observation.error = String(error);
        failures.push(new Error(`${name}: ${String(error)}`));
        // Preserve the failed gate, then recover with real parent input.
        await page.mouse.move(50, 400);
        await page.mouse.up();
        await page.mouse.click(50, 400);
        await expect.poll(() => page.evaluate(bodyStyles)).toEqual(originalBodyStyles);
        await expect.poll(() => handle.evaluate((element) => element.hasPointerCapture(1))).toBe(false);
      }
    }
    assert.equal(await iframe.getAttribute("src"), originalSource, "Resizing must not replace the HTML capability/frame");
    if (failures.length) throw new AggregateError(failures, failures.map(String).join("\n"));
    checks.push("both splitters shield iframe input, release at live iframe coordinates and restore settled geometry/styles/scope");
  } finally {
    const collected = () => (window as unknown as { __resizeEvidence: () => unknown }).__resizeEvidence();
    measurements.splitterEvents = { parent: await page.evaluate(collected), iframe: await child.evaluate(collected) };
  }
}

async function main(): Promise<void> {
  assert(process.argv.length <= 3, "Usage: bun scripts/smoke-work-files.ts [compiled-binary]");
  const binary = resolve(process.argv[2] ?? "release/easyresearch-linux-x64/bin/easyresearch");
  assert(existsSync(binary), `Build the integrated compiled candidate first: ${binary}`);
  const artifacts = realpathSync(mkdtempSync(join(existsSync("/tmp/opencode") ? "/tmp/opencode" : tmpdir(), "easyresearch-work-files-browser-")));
  const runtime = join(artifacts, "runtime");
  const home = join(runtime, "home");
  const agentDir = join(runtime, "agent");
  const emptyPath = join(runtime, "empty-path");
  const downloads = join(artifacts, "downloads");
  for (const directory of [home, agentDir, emptyPath, downloads]) mkdirSync(directory, { recursive: true });
  const chromiumPath = process.env.COMPARE_CHROMIUM_PATH;
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: home, USERPROFILE: home, EASYRESEARCH_CODING_AGENT_DIR: agentDir,
    XDG_CONFIG_HOME: join(runtime, "config"), XDG_CACHE_HOME: join(runtime, "cache"), PATH: emptyPath, PI_OFFLINE: "1",
  };
  for (const key of ["EASYRESEARCH_SKIP_SETUP", "EASYRESEARCH_BUNDLED_ROOT", "EASYRESEARCH_VENV", "PI_PACKAGE_DIR"]) delete env[key];
  for (const key of ["HOME", "USERPROFILE", "EASYRESEARCH_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "PI_OFFLINE"]) process.env[key] = env[key];
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(binary)) hash.update(chunk);
  const report = { binary, sha256: hash.digest("hex"), artifacts, daemonOrigin: "", browserOrigin: "", cases: [] as CaseReport[], errors: [] as string[], passed: false };
  let browser: Browser | undefined;
  let proxy: Awaited<ReturnType<typeof recordingProxy>> | undefined;
  let attemptedStart = false;
  let stopped = false;
  const failures: unknown[] = [];
  const deadline = Date.now() + 8 * 60_000;
  let watchdogTask: Promise<unknown> | undefined;
  const watchdog = setTimeout(() => {
    failures.push(new Error("Work files browser smoke exceeded its eight-minute deadline"));
    watchdogTask = Promise.allSettled([browser?.close(), proxy?.close()]);
  }, Math.max(1, deadline - Date.now()));
  try {
    const { importPi } = await import("../src/runtime/pi-import");
    const pi = await importPi();
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("port reservation") });
    const port = probe.port!;
    await probe.stop(true);
    report.daemonOrigin = `http://127.0.0.1:${port}`;
    attemptedStart = true;
    const start = spawnSync(binary, ["--no-open", "--port", String(port)], { env, cwd: home, encoding: "utf8", timeout: 90_000 });
    writeFileSync(join(artifacts, "startup.log"), `${start.stdout ?? ""}\n${start.stderr ?? ""}`);
    assert.equal(start.status, 0, start.error?.message ?? start.stderr);
    proxy = await recordingProxy(report.daemonOrigin);
    const wire = proxy;
    const origin = wire.origin;
    report.browserOrigin = origin;
    assert.notEqual(origin, report.daemonOrigin, "CSP acceptance must exercise a real forwarding port");
    const api = async (path: string, init: RequestInit = {}) => {
      assert(Date.now() < deadline, "Browser API deadline exhausted");
      const response = await fetch(`${origin}${path}`, { ...init, proxy: "", signal: AbortSignal.timeout(Math.max(1, Math.min(15_000, deadline - Date.now()))) });
      const bytes = Buffer.from(await response.arrayBuffer());
      assert(Date.now() < deadline, "Browser API body exceeded its deadline");
      return { status: response.status, headers: response.headers, bytes };
    };
    const json = async <T>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST", status = 200): Promise<T> => {
      const response = await api(path, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      assert.equal(response.status, status, `${method} ${path}: ${response.bytes.toString("utf8", 0, 400)}`);
      return response.bytes.length ? JSON.parse(response.bytes.toString("utf8")) as T : undefined as T;
    };
    assert.equal((await json<{ agentDir: string }>("/api/status")).agentDir, agentDir);
    browser = await chromium.launch({ ...(chromiumPath ? { executablePath: chromiumPath } : { channel: "chrome" }), headless: true, timeout: 30_000 });
    for (const [width, theme] of [[1440, "light"], [1440, "dark"], [390, "light"], [390, "dark"]] as const) {
      const label = `${width}-${theme}`;
      const project = fixture(pi, runtime, label);
      const caseReport: CaseReport = { width, theme, cwd: project.cwd, sessionId: project.id, checks: [], measurements: {}, csp: [], pageErrors: [], passed: false };
      report.cases.push(caseReport);
      const firstRecord = wire.records.length;
      const context: BrowserContext = await browser.newContext({ viewport: { width, height: 900 }, locale: "en-US", hasTouch: width < 820, acceptDownloads: true });
      const page: Page = await context.newPage();
      page.setDefaultTimeout(12_000);
      page.setDefaultNavigationTimeout(20_000);
      page.on("pageerror", (error) => caseReport.pageErrors.push(error.message));
      await context.exposeBinding("__workFilesCsp", (_source, value: CspRecord) => { caseReport.csp.push(value); });
      await context.addInitScript((selectedTheme) => {
        if (window.top === window) localStorage.setItem("easyresearch.webui.preferences", JSON.stringify({ language: "en", studioTheme: selectedTheme }));
        document.addEventListener("securitypolicyviolation", (event) => {
          void (window as unknown as { __workFilesCsp(value: unknown): Promise<void> }).__workFilesCsp({ directive: event.effectiveDirective, blocked: event.blockedURI, document: document.URL });
        });
      }, theme);
      let foreignScope: { id: string; url: string } | undefined;
      try {
        foreignScope = await json("/api/file/preview", { path: project.foreign });
        assert(foreignScope && typeof foreignScope.id === "string" && typeof foreignScope.url === "string");
        const foreignControl = await api(new URL(foreignScope.url, origin).pathname);
        assert.equal(foreignControl.status, 200, "Foreign capability must be live before challenging its access boundary");
        assert.match(foreignControl.bytes.toString("utf8"), /Foreign scope sentinel/);
        const marker = `wf-${label}`;
        const forbidden = (kind: string, path = "/api/status") => `${origin}${path}${path.includes("?") ? "&" : "?"}forbidden=${marker}-${kind}`;
        const rawPath = `/api/file/raw?path=${encodeURIComponent(join(project.cwd, "raw-target.html"))}`;
        writeFileSync(join(project.reportDirectory, "attack-config.json"), JSON.stringify({
          api: forbidden("api"), raw: forbidden("raw", rawPath), foreign: forbidden("foreign", new URL(foreignScope.url, origin).pathname),
          navigation: { app: forbidden("nav-app", "/"), raw: forbidden("nav-raw", rawPath), data: forbidden("nav-data"), blob: forbidden("nav-blob"), meta: forbidden("nav-meta") },
        }));
        const workUrl = `${origin}/#/work/${project.id}?cwd=${encodeURIComponent(project.cwd)}`;
        await page.goto(workUrl);
        await expect(page.getByText(`Work files ready ${label}`, { exact: true })).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute("data-ui-theme", theme);
        assert.equal(await page.evaluate(() => document.documentElement.style.colorScheme), theme);
        await showTree(page);
        await expect(page.getByRole("button", { name: "Upload files", exact: true }), "Compiled candidate must include the integrated file controls").toBeEnabled();
        await noOverflow(page, "Initial file tree");
        const defaultTreeWidth = await page.locator("[data-files-tree]").evaluate((element) => element.getBoundingClientRect().width);
        const uploadFilenameGeometry: Array<Record<string, unknown>> = [];
        caseReport.measurements.initialTreeWidth = defaultTreeWidth;
        caseReport.measurements.uploadFilenameGeometry = uploadFilenameGeometry;

        const binaryName = "研究 🐬 100% +.bin";
        const progressGate = wire.pauseUpload(binaryName);
        try {
          await chooseFiles(page, [join(project.inputs, binaryName), join(project.inputs, "draft.txt")]);
          await expect.poll(() => progressGate.forwarded).toBeGreaterThan(0);
          await expect(uploadRow(page, "draft.txt").getByRole("status")).toHaveText("Uploaded");
          const progress = uploadRow(page, binaryName).getByRole("progressbar", { name: `Upload progress for ${binaryName}`, exact: true });
          await expect.poll(async () => Number(await progress.getAttribute("value"))).toBeGreaterThan(0);
          caseReport.measurements.uploadProgressWhilePaused = Number(await progress.getAttribute("value"));
          assert(!existsSync(join(project.cwd, binaryName)), "Paused real request must not be published early");
          await expect(uploadRow(page, binaryName).getByRole("status")).not.toHaveText("Uploaded");
          await noOverflow(page, "Upload progress controls");
          await checkUploadFilenameGeometry(page, binaryName, "pending", defaultTreeWidth, uploadFilenameGeometry);
          await page.screenshot({ path: join(artifacts, `upload-${label}.png`), fullPage: true });
        } finally { progressGate.release(); }
        for (const name of [binaryName, "draft.txt"]) {
          await expect(uploadRow(page, name).getByRole("status")).toHaveText("Uploaded");
          assert.deepEqual(readFileSync(join(project.cwd, name)), project.uploadFiles.get(name));
        }
        caseReport.checks.push("real multi-upload progress, pending server publication and exact root bytes");
        await dismissUploads(page);
        writeFileSync(join(project.inputs, binaryName), "conflicting replacement bytes");
        await chooseFiles(page, [join(project.inputs, binaryName)]);
        await expect(uploadRow(page, binaryName).getByRole("alert")).toContainText("existing file was not replaced");
        assert.deepEqual(readFileSync(join(project.cwd, binaryName)), project.uploadFiles.get(binaryName));
        await checkUploadFilenameGeometry(page, binaryName, "failed", defaultTreeWidth, uploadFilenameGeometry);
        await dismissUploads(page);
        caseReport.checks.push("duplicate upload conflict preserves original bytes");

        await chooseFiles(page, [join(project.inputs, "nested-one.txt"), join(project.inputs, "nested-empty.bin")], "incoming");
        for (const name of ["nested-one.txt", "nested-empty.bin"]) {
          await expect(uploadRow(page, name).getByRole("status")).toHaveText("Uploaded");
          await expect(uploadRow(page, name)).toContainText(join(project.cwd, "incoming"));
          assert.deepEqual(readFileSync(join(project.cwd, "incoming", name)), project.uploadFiles.get(name));
          assert(!existsSync(join(project.cwd, name)));
        }
        await dismissUploads(page);
        caseReport.checks.push("real multi-upload into the selected existing directory, including empty bytes");

        const cancelTransfer = wire.observeUpload("cancel-me.bin");
        const cancelDirectory = join(project.cwd, "cancelled");
        const cancellationNetwork = await context.newCDPSession(page);
        const failedUploads: string[] = [];
        const failedUpload = (request: import("@playwright/test").Request) => {
          const url = new URL(request.url());
          if (request.method() === "PUT" && url.pathname === "/api/file/upload" && url.searchParams.get("name") === "cancel-me.bin") {
            failedUploads.push(request.failure()?.errorText ?? "unknown failure");
          }
        };
        page.on("requestfailed", failedUpload);
        try {
          // Keep actual browser bytes mostly unsent, while the forwarding reader
          // remains live. Holding that reader can hide disconnect behind buffered
          // bytes in Bun's node:http compatibility layer, even at this low rate.
          await cancellationNetwork.send("Network.enable");
          await cancellationNetwork.send("Network.emulateNetworkConditions", {
            offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: 256 * 1024,
          });
          await chooseFiles(page, [join(project.inputs, "cancel-me.bin")], "cancelled");
          await expect.poll(() => cancelTransfer.forwarded).toBeGreaterThan(0);
          await expect.poll(() => readdirSync(cancelDirectory).some((name) => statSync(join(cancelDirectory, name)).size > 0)).toBe(true);
          assert(!existsSync(join(cancelDirectory, "cancel-me.bin")));
          const cancelProgress = uploadRow(page, "cancel-me.bin").getByRole("progressbar");
          await expect.poll(async () => Number(await cancelProgress.getAttribute("value"))).toBeGreaterThan(0);
          const sentPercent = Number(await cancelProgress.getAttribute("value"));
          assert(sentPercent < 100, "Cancel must occur before the browser has sent the complete file");
          caseReport.measurements.cancellation = { sentPercent, stagedBytes: readdirSync(cancelDirectory).map((name) => statSync(join(cancelDirectory, name)).size), forwardedPrefix: cancelTransfer.forwarded, browserFailures: failedUploads };
          await uploadRow(page, "cancel-me.bin").getByRole("button", { name: "Cancel upload of cancel-me.bin", exact: true }).click();
          await expect(uploadRow(page, "cancel-me.bin").getByRole("status")).toHaveText("Cancelled");
          await expect.poll(() => failedUploads.some((error) => error.includes("ERR_ABORTED"))).toBe(true);
          await expect.poll(() => cancelTransfer.aborted).toBe(true);
          await expect.poll(() => readdirSync(cancelDirectory)).toEqual([]);
        } finally {
          page.off("requestfailed", failedUpload);
          await cancellationNetwork.send("Network.emulateNetworkConditions", {
            offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
          }).finally(() => cancellationNetwork.detach());
        }
        await checkUploadFilenameGeometry(page, "cancel-me.bin", "cancelled", defaultTreeWidth, uploadFilenameGeometry);
        await uploadRow(page, "cancel-me.bin").getByRole("button", { name: "Retry cancel-me.bin", exact: true }).click();
        await expect(uploadRow(page, "cancel-me.bin").getByRole("status")).toHaveText("Uploaded");
        assert.deepEqual(readFileSync(join(cancelDirectory, "cancel-me.bin")), project.uploadFiles.get("cancel-me.bin"));
        await dismissUploads(page);
        caseReport.checks.push("user Cancel aborts a real partially forwarded/staged body; retry succeeds without leftovers");
        caseReport.checks.push("displayed upload filenames have meaningful visible text geometry without overlap/overflow in pending, failed and cancelled rows");

        await openFile(page, join(project.cwd, "draft.txt"));
        await expect(page.locator("#work-panel-files pre")).toContainText("# Rename proof");
        await showTree(page);
        await page.getByRole("textbox", { name: "Filter files", exact: true }).fill("draft");
        await (await fileMenu(page, "draft.txt")).getByRole("menuitem", { name: "Rename file", exact: true }).click();
        const rename = page.getByRole("dialog", { name: "Rename file", exact: true });
        const renamedName = "改名 🐬.md";
        await rename.getByRole("textbox", { name: "File name", exact: true }).fill(renamedName);
        await rename.getByRole("button", { name: "Rename file", exact: true }).click();
        await expect(rename).toBeHidden();
        await page.getByRole("textbox", { name: "Filter files", exact: true }).fill("");
        const tabs = page.getByRole("tablist", { name: "Open files", exact: true });
        await expect(tabs.getByRole("tab", { name: "draft.txt", exact: true })).toHaveCount(0);
        await expect(tabs.getByRole("tab", { name: renamedName, exact: true })).toHaveCount(1);
        await tabs.getByRole("tab", { name: renamedName, exact: true }).click();
        await expect(tabs.getByRole("tab", { name: renamedName, exact: true })).toHaveAttribute("aria-selected", "true");
        await expect(page.locator("#work-panel-files").getByRole("heading", { name: "Rename proof", exact: true })).toBeVisible();
        await noOverflow(page, "Renamed Markdown preview");
        assert(!existsSync(join(project.cwd, "draft.txt")));
        assert.deepEqual(readFileSync(join(project.cwd, renamedName)), project.uploadFiles.get("draft.txt"));
        caseReport.checks.push("filtered-row keyboard actions rekey the open tab and reclassify .txt to Markdown");

        const downloadMenu = await fileMenu(page, binaryName);
        const downloadEvent = page.waitForEvent("download");
        await downloadMenu.getByRole("menuitem", { name: "Download", exact: true }).click();
        const download = await downloadEvent;
        assert.equal(download.suggestedFilename(), binaryName);
        const downloadedPath = join(downloads, `${label}.bin`);
        await download.saveAs(downloadedPath);
        assert.deepEqual(readFileSync(downloadedPath), project.uploadFiles.get(binaryName));
        caseReport.checks.push("browser attachment download preserves complete binary bytes and Unicode filename");

        await openFile(page, join(project.cwd, "image.svg"));
        const image = page.getByRole("img", { name: "image.svg", exact: true });
        await expect(image).toBeVisible();
        await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(640);
        const fittedWidth = (await image.boundingBox())!.width;
        await page.getByRole("button", { name: "Zoom in", exact: true }).click();
        await expect.poll(async () => (await image.boundingBox())!.width).toBeGreaterThan(fittedWidth);
        await noOverflow(page, "Zoomed image preview");
        await page.getByRole("button", { name: "Fit image", exact: true }).click();
        await expect.poll(async () => Math.abs((await image.boundingBox())!.width - fittedWidth)).toBeLessThan(1);
        await page.screenshot({ path: join(artifacts, `image-${label}.png`), fullPage: true });
        await openFile(page, join(project.cwd, "broken.svg"));
        await expect(page.locator("#work-panel-files").getByRole("alert")).toContainText("Could not display this image");
        const retryBefore = wire.records.length;
        await page.getByRole("button", { name: "Retry image", exact: true }).click();
        await expect.poll(() => wire.records.slice(retryBefore).some((record) => new URL(record.path, origin).searchParams.get("path") === join(project.cwd, "broken.svg") && record.status === 200)).toBe(true);
        await expect(page.locator("#work-panel-files").getByRole("alert")).toContainText("Could not display this image");
        writeFileSync(join(project.cwd, "broken.svg"), workFilesSvg);
        await page.getByRole("button", { name: "Retry image", exact: true }).click();
        await expect(page.getByRole("img", { name: "broken.svg", exact: true })).toBeVisible();
        caseReport.checks.push("image decode, visible zoom/fit, real corrupt-file error, retry request and restored-file recovery");

        await openFile(page, join(project.cwd, "video.mp4"));
        const video = page.locator('video[aria-label="Video preview"]');
        await expect(video).toBeVisible();
        await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
        const metadata = await video.evaluate((element) => {
          const media = element as HTMLVideoElement;
          return { width: media.videoWidth, height: media.videoHeight, duration: media.duration, controls: media.controls, inline: media.playsInline };
        });
        assert.deepEqual(metadata, { width: 64, height: 48, duration: 2, controls: true, inline: true });
        await video.evaluate(async (element) => { const media = element as HTMLVideoElement; media.muted = true; await media.play(); });
        await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(0.2);
        await video.evaluate((element) => { const media = element as HTMLVideoElement; media.pause(); media.currentTime = 1.4; });
        await expect.poll(() => video.evaluate((element) => { const media = element as HTMLVideoElement; return !media.seeking && Math.abs(media.currentTime - 1.4) < 0.15; })).toBe(true);
        const videoTab = tabs.getByRole("tab", { name: "video.mp4", exact: true });
        await expect(videoTab).toHaveAttribute("aria-selected", "true");
        const videoTabPath = await videoTab.getAttribute("title");
        assert.equal(videoTabPath, join(project.cwd, "video.mp4"));
        await checkVideoFullscreen(page, video, caseReport.measurements);
        await expect(videoTab).toHaveCount(1);
        await expect(videoTab).toHaveAttribute("aria-selected", "true");
        assert.equal(await videoTab.getAttribute("title"), videoTabPath, "Fullscreen must retain the active file-tab identity");
        caseReport.measurements.fullscreenTab = { path: videoTabPath, retained: true, selected: true };
        caseReport.measurements.video = metadata;
        assert(wire.records.slice(firstRecord).some((record) => new URL(record.path, origin).searchParams.get("path") === join(project.cwd, "video.mp4") && record.range && record.status === 206 && record.contentRange),
          "Native video must issue an actual ranged HTTP request through the forwarding proxy");
        await noOverflow(page, "Playing/seeked video preview");
        await page.screenshot({ path: join(artifacts, `video-${label}.png`), fullPage: true });
        caseReport.checks.push("actual H.264 playback/seek plus trusted-input fullscreen enter/exit with retained media/tab state and no overflow");

        await showTree(page);
        await page.getByRole("button", { name: "Expand reports", exact: true }).click();
        const htmlPath = join(project.reportDirectory, "report.html");
        await openFile(page, htmlPath);
        const iframe = page.locator('iframe[title="HTML preview"]');
        const readyHtml = async () => {
          const frame = await htmlFrame(page);
          await expect(frame.locator("#tail")).toHaveText(`FULL_HTML_TAIL_${label}`);
          await expect(frame.locator("#local-ready")).toHaveText("classic-ready");
          await expect(frame.locator("#module-ready")).toHaveText("module-ready");
          await expect(frame.locator("#fetch-ready")).toHaveText("local-fetch-ready");
          return frame;
        };
        const scopePath = async () => new URL((await iframe.getAttribute("src"))!, origin).pathname;
        const released = async (path: string) => {
          await expect.poll(async () => (await api(path)).status).toBe(404);
          const id = path.split("/")[4]!;
          assert(wire.records.some((record) => record.method === "DELETE" && record.path.split("?")[0] === `/api/file/preview/${id}` && record.status === 204), "The view must release its exact previous scope");
        };
        const retryHtml = async () => {
          const previous = await scopePath();
          await page.getByRole("button", { name: "Retry HTML", exact: true }).click();
          await expect.poll(scopePath).not.toBe(previous);
          const frame = await readyHtml();
          await released(previous);
          return frame;
        };
        let frame = await readyHtml();
        assert.equal(await iframe.getAttribute("sandbox"), "allow-scripts");
        await frame.locator("#inline-button").click();
        await expect(frame.locator("#inline-count")).toHaveText("1");
        await frame.locator("#local-button").click();
        await expect(frame.locator("#local-count")).toHaveText("1");
        await expect(frame.locator("#chart")).toHaveCSS("width", "40px");
        await expect(frame.locator(".report-panel")).toHaveCSS("border-top-color", "rgb(23, 91, 137)");
        await expect.poll(() => frame.locator("#local-image").evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(640);
        await expect(frame.locator("#css-image")).not.toHaveCSS("background-image", "none");
        for (const asset of ["assets/local.js", "assets/module.js", "assets/module-value.js", "assets/nested/colors.css", "assets/image.svg", "data.json"]) {
          assert(wire.records.some((record) => record.path.split("?")[0]!.endsWith(`/${asset}`) && record.status === 200), `Scoped asset must cross the actual forwarding wire: ${asset}`);
        }
        caseReport.measurements.htmlBytes = Buffer.byteLength(project.html);
        caseReport.checks.push("complete >1MiB HTML, inline/classic chart interaction, local modules/fetch/CSS imports/images through forwarded origin");
        await noOverflow(page, "Interactive HTML preview");
        await page.screenshot({ path: join(artifacts, `html-${label}.png`), fullPage: true });
        const previousScope = await scopePath();
        await page.getByRole("button", { name: "Source", exact: true }).click();
        await expect(iframe).toHaveCount(0);
        await expect.poll(() => page.locator("#work-panel-files pre").evaluate((element) => element.textContent?.length)).toBe(project.html.length);
        assert(await page.locator("#work-panel-files pre").evaluate((element, tail) => element.textContent?.includes(tail), `FULL_HTML_TAIL_${label}`));
        await noOverflow(page, "Complete HTML source preview");
        await released(previousScope);
        await page.getByRole("button", { name: "Preview", exact: true }).click();
        frame = await readyHtml();
        const expiredPath = await scopePath();
        const expiredId = expiredPath.split("/")[4]!;
        await json(`/api/file/preview/${expiredId}`, undefined, "DELETE", 204);
        const expired = await frame.goto(`${origin}${expiredPath}`);
        assert.equal(expired?.status(), 404, "Released scope must produce a real error document");
        frame = await retryHtml();
        caseReport.checks.push("full source toggle, scope disposal, genuine released-scope 404 and toolbar retry with a fresh scope");

        await page.evaluate(async (url) => { const response = await fetch(url); if (!response.ok) throw Error("wire control failed"); await response.arrayBuffer(); }, `${origin}/api/status?wireControl=${marker}`);
        assert(wire.records.some((record) => record.path.includes(`wireControl=${marker}`)), "Positive control must prove API traffic reaches the recording proxy");
        await frame.locator("#isolate").click();
        await expect(frame.locator("body")).toHaveAttribute("data-isolation", "done");
        assert.deepEqual(JSON.parse(await frame.locator("#isolation").innerText()), { parent: true, storage: true, api: true, raw: true, foreign: true });
        const noForbiddenRequests = () => assert.deepEqual(wire.records.filter((record) => new URL(record.path, origin).searchParams.get("forbidden")?.startsWith(marker)), [], "Forbidden iframe requests must never reach the actual forwarding wire");
        noForbiddenRequests();
        for (const kind of ["app", "raw", "data", "blob", "meta", "about"]) {
          const baseline = caseReport.csp.length;
          await frame.locator(`[data-nav="${kind}"]`).click({ noWaitAfter: true });
          if (kind === "about") {
            await expect.poll(async () => (await htmlFrame(page)).url()).toBe("about:blank");
            const blank = await htmlFrame(page);
            // An allowed blank document must retain its inherited sandbox/CSP even if
            // malicious code is evaluated there; automation supplies that challenge.
            const isolation = await blank.evaluate(async (url) => {
              const result = { parent: false, storage: false, api: false };
              try { void parent.document.body; } catch { result.parent = true; }
              try { localStorage.getItem("fixture"); } catch { result.storage = true; }
              try { await fetch(url, { signal: AbortSignal.timeout(3_000) }); } catch { result.api = true; }
              return result;
            }, forbidden("nav-about"));
            assert.deepEqual(isolation, { parent: true, storage: true, api: true });
          } else {
            await expect.poll(() => caseReport.csp.slice(baseline).some((entry) => entry.directive === "frame-src")).toBe(true);
          }
          noForbiddenRequests();
          assert.equal(page.url(), workUrl, "A report must not navigate its parent Work page");
          frame = await retryHtml();
        }
        caseReport.checks.push("opaque parent/storage isolation; zero API/raw/foreign-scope requests on wire; self/data/blob/meta navigation blocked; about:blank retains isolation");
        // Run gesture ownership last: a failed opaque-frame drag can poison later
        // pointer input. Its failure remains release-blocking, without masking
        // independent HTML capability/navigation evidence.
        try { await checkSplitters(page, caseReport.checks, caseReport.measurements); }
        catch (error) {
          caseReport.blockers = [String(error)];
          await page.screenshot({ path: join(artifacts, `splitter-blocker-${label}.png`), fullPage: true });
        }
        const lastScope = await scopePath();
        const htmlTab = tabs.getByRole("tab", { name: "report.html", exact: true });
        await htmlTab.focus();
        await htmlTab.press("Delete");
        await expect(iframe).toHaveCount(0);
        await released(lastScope);
        caseReport.checks.push("keyboard tab close releases the exact HTML scope");
        await showTree(page);
        if (width < 820) {
          await page.getByRole("tab", { name: "Chat", exact: true }).click();
          await expect(page.getByText(`Work files ready ${label}`, { exact: true })).toBeVisible();
          await page.getByRole("tab", { name: "Files", exact: true }).click();
          await expect(tabs.getByRole("tab", { name: renamedName, exact: true })).toHaveCount(1);
          caseReport.checks.push("mobile Chat/Files switching preserves open file-tab identity");
        }
        await noOverflow(page, "Final file controls");
        assert.deepEqual(caseReport.pageErrors, [], "Unexpected browser page errors");
        assert(!wire.records.slice(firstRecord).some((record) => record.method === "POST" && /\/api\/sessions\/[^/]+\/messages$/.test(record.path)), "Browser file work must never invoke a model");
        caseReport.measurements.requests = wire.records.length - firstRecord;
        caseReport.passed = !caseReport.blockers?.length;
        if (caseReport.blockers?.length) failures.push(new Error(`${label}: ${caseReport.blockers.join("\n")}`));
        console.log(`[work-files-browser] ${label}: file transfers, previews, HTML isolation/navigation and cleanup ${caseReport.passed ? "passed" : "finished with recorded splitter blockers"}`);
      } catch (error) {
        caseReport.error = String(error);
        await page.screenshot({ path: join(artifacts, `failure-${label}.png`), fullPage: true, timeout: 3_000 }).catch(() => {});
        throw error;
      } finally {
        try { if (foreignScope) await json(`/api/file/preview/${foreignScope.id}`, undefined, "DELETE", 204); }
        finally { await context.close(); }
      }
    }
  } catch (error) { failures.push(error); }
  finally {
    clearTimeout(watchdog);
    await watchdogTask;
    for (const cleanup of [() => browser?.close(), () => proxy?.close()]) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    if (attemptedStart) {
      try {
        const stop = spawnSync(binary, ["exit"], { env, cwd: home, encoding: "utf8", timeout: 30_000 });
        writeFileSync(join(artifacts, "shutdown.log"), `${stop.stdout ?? ""}\n${stop.stderr ?? ""}`);
        assert.equal(stop.status, 0, stop.error?.message ?? stop.stderr);
        stopped = true;
      } catch (error) { failures.push(error); }
    } else stopped = true;
    if (stopped) {
      try { rmSync(runtime, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    }
    report.errors = failures.map(String);
    report.passed = failures.length === 0 && report.cases.length === 4 && report.cases.every((entry) => entry.passed);
    writeFileSync(join(artifacts, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(join(artifacts, "requests.json"), `${JSON.stringify(proxy?.records ?? [], null, 2)}\n`);
    console.log(`[work-files-browser] evidence: ${artifacts}`);
  }
  if (failures.length) throw new AggregateError(failures, "Work files compiled browser acceptance failed");
}

if (import.meta.main) await main();
