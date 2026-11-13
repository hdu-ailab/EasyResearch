#!/usr/bin/env bun
/** Focused acceptance against a controller-built native executable, never a build.
 * Actual isolated Pi JSONL, models/settings, compiled HTTP/assets and streaming SSE.
 * TMPDIR=/tmp/opencode bun scripts/smoke-modern-web.ts /absolute/path/to/easyresearch
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { chromium, expect, type Browser, type BrowserContext, type JSHandle, type Locator, type Page, type Request } from "@playwright/test";
import type { importPi } from "../src/runtime/pi-import";
import type { SessionSnapshotDto, StatusDto } from "../src/web/contracts";
import { messages, type MessageKey } from "../src/webui/src/i18n/messages";
import { createSmokeDaemonCustody } from "./smoke-release-support";
// This module's runner is guarded by import.meta.main; importing it never builds,
// starts a daemon/browser, seeds Pi, or reads a user's configuration.
import { recordingBridge } from "./smoke-session-tabs";

type Pi = Awaited<ReturnType<typeof importPi>>;
type Bridge = Awaited<ReturnType<typeof recordingBridge>>;
type Wire = Bridge["records"][number];
type Labels = (key: MessageKey) => string;
type Json = <T>(path: string, init?: RequestInit) => Promise<T>;
const providerId = "modern-web-smoke";
const modelRef = (index: number) => `${providerId}/model-${String(index).padStart(3, "0")}`;
const preferenceKey = "easyresearch.webui.preferences";
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const surface = (page: Page, id?: string) => page.locator(id
  ? `[data-session-surface=${JSON.stringify(id)}]`
  : '[data-session-surface][data-session-active="true"]');
const topbar = (page: Page) => page.getByRole("banner");
const tab = (page: Page, id: string) => topbar(page).locator(`[role="tab"][data-session-tab-id=${JSON.stringify(id)}]`);
const composer = (page: Page) => surface(page).locator("[data-chat-composer] textarea");
const files = (page: Page) => surface(page).locator('[data-work-pane="files"]');
const workHash = (root: Root) => `#/work/${root.id}?cwd=${encodeURIComponent(root.cwd)}`;
const frames = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

interface CaseReport {
  label: string;
  width: number;
  theme: "light" | "dark";
  language: "en" | "zh-CN";
  fallback: boolean;
  checks: string[];
  measurements: Record<string, unknown>;
  errors: string[];
  failedRequests: Array<{ url: string; error: string | null }>;
  passed: boolean;
  failure?: string;
}

/** Only a locally bound tripwire provider. No test in this helper arms an LLM turn. */
function providerFixture() {
  const requests: Array<{ method: string; path: string }> = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: 2 * 1024 * 1024,
    fetch(request) {
      requests.push({ method: request.method, path: new URL(request.url).pathname });
      return new Response("This acceptance has not armed a model request", { status: 409 });
    },
  });
  return { origin: `http://127.0.0.1:${server.port}/v1`, requests,
    async close() { await server.stop(true); assert.equal(server.pendingRequests, 0); } };
}

function fixtures(pi: Pi, directory: string) {
  const cwd = join(directory, "workspace-研究");
  mkdirSync(cwd, { recursive: true });
  for (let index = 0; index < 40; index++) {
    const name = `evidence-${String(index).padStart(2, "0")}.md`;
    writeFileSync(join(cwd, name), `# ${name}\n\nISOLATED_FILE_${index}\n`);
  }
  let timestamp = Date.now() - 100_000;
  return ["A", "B"].map((label) => {
    const manager = pi.SessionManager.create(cwd);
    manager.appendModelChange(providerId, "model-179");
    manager.appendThinkingLevelChange("off");
    for (let row = 0; row < 3; row++) {
      manager.appendMessage({ role: "user", content: `ROOT_${label}_USER_${row}`, timestamp: ++timestamp });
      const answer: AssistantMessage = { role: "assistant", content: [{ type: "text", text: `ROOT_${label}_ANSWER_${row}` }],
        api: "openai-completions", provider: providerId, model: "model-179", stopReason: "stop", timestamp: ++timestamp,
        usage: { input: 5, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 8,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      manager.appendMessage(answer);
    }
    manager.appendSessionInfo(`Modern web ${label} · 浏览器验收`);
    const path = manager.getSessionFile()!;
    assert(existsSync(path));
    return { id: manager.getSessionId(), name: manager.getSessionName()!, cwd, path, label, original: readFileSync(path) };
  }) as [Root, Root];
}
interface Root { id: string; name: string; cwd: string; path: string; label: string; original: Buffer }

function noAgentControls(records: Wire[]) {
  assert.deepEqual(records.filter((record) => (/^\/api\/sessions\/.*\/(abort|stop|disconnect|restart|messages)$/.test(record.path)
    && record.method !== "GET") || (record.method === "DELETE" && /^\/api\/sessions\/[^/?]+$/.test(record.path))), [],
  "View/poll/focus/sizing checks cannot submit work, stop/disconnect Agents, or delete history");
}
const subscriptions = (bridge: Bridge) => bridge.subscriptions().map((item) => `${item.channelId}:${item.id}:${item.path}`).sort();
async function activate(page: Page, root: Root) {
  await tab(page, root.id).click();
  await expect.poll(() => new URL(page.url()).hash).toBe(workHash(root));
  await expect(surface(page, root.id)).toHaveAttribute("data-session-active", "true");
  await expect(surface(page).locator("[data-work-session]")).toHaveAttribute("data-work-session", root.id);
}
async function home(page: Page, t: Labels) {
  await topbar(page).getByRole("button", { name: t("topbar.backToHome"), exact: true }).click();
  await expect.poll(() => new URL(page.url()).hash).toBe("#/");
}
async function pane(page: Page, t: Labels, value: "chat" | "files" | "agents") {
  if (page.viewportSize()!.width < 820) {
    await surface(page).getByRole("tab", { name: t(`work.${value}Tab`), exact: true }).click();
  } else if (value !== "chat") {
    const button = topbar(page).getByRole("button", { name: t(value === "files" ? "work.filesBrowser" : "work.agentList"), exact: true });
    if (await button.getAttribute("aria-pressed") !== "true") await button.click();
  } else {
    const pressed = topbar(page).locator('button[aria-pressed="true"]');
    for (const button of await pressed.all()) {
      const label = await button.getAttribute("aria-label");
      if (label === t("work.filesBrowser") || label === t("work.agentList")) await button.click();
    }
    await expect(surface(page).locator("[data-work-layout]")).toHaveAttribute("data-panel-open", "false");
    // The pane has its own width transition even in the reduced-motion context.
    // Screenshots and subsequent measurements must observe the settled closure.
    await expect.poll(() => surface(page).locator("[data-work-layout] > section:last-child")
      .evaluate((element) => element.getBoundingClientRect().width), { timeout: 2500, intervals: [30, 50] }).toBeLessThan(1);
  }
}
async function showTree(page: Page, t: Labels) {
  await pane(page, t, "files");
  const toggle = files(page).getByRole("button", { name: t("tabs.toggleTree"), exact: true });
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
}

/** Hold only one real status body, after Playwright positively receives headers.
 * The observer reads the browser's response; it does not fulfill or change it. */
async function heldStatus(page: Page, bridge: Bridge, enter: () => Promise<void>) {
  let wire: Wire | undefined;
  let admittedAt = 0;
  const gate = bridge.delay((record) => {
    if (record.method !== "GET" || record.path !== "/api/status") return false;
    wire = record;
    admittedAt = performance.now();
    return true;
  }, { bodyOnly: true });
  const received = page.waitForResponse((response) => response.request().method() === "GET"
    && new URL(response.url()).pathname === "/api/status", { timeout: 8000 });
  try {
    const [response] = await Promise.all([received, enter()]);
    assert(wire && gate.hit);
    assert.equal(response.status(), 200);
    assert.match(response.headers()["content-type"] ?? "", /application\/json/);
    const observation: { headersReceivedAt: number; contentType: string; body: "pending" | "completed" | "failed"; requestFailure?: string; bodyError?: string } = {
      headersReceivedAt: performance.now(), contentType: response.headers()["content-type"]!, body: "pending",
    };
    const failed = (request: Request) => {
      if (request === response.request()) observation.requestFailure = request.failure()?.errorText ?? "Unknown request failure";
    };
    page.on("requestfailed", failed);
    const body = response.json().then((value: StatusDto) => {
      observation.body = "completed";
      return value;
    }, (error: unknown) => {
      observation.body = "failed";
      observation.bodyError = String(error);
      return undefined;
    });
    return { wire, gate, admittedAt, observation, body,
      async dispose() {
        gate.release();
        page.off("requestfailed", failed);
        await expect.poll(() => observation.body, { timeout: 5000 }).not.toBe("pending");
        await body;
      },
    };
  } catch (error) { gate.release(); await received.catch(() => {}); throw error; }
}

async function assertStatusAborted(held: Awaited<ReturnType<typeof heldStatus>>) {
  await expect.poll(() => held.observation.requestFailure, { timeout: 5000 }).toBe("net::ERR_ABORTED");
  await expect.poll(() => held.wire.live, { timeout: 5000 }).toBe(false);
  assert.equal(held.wire.complete, false, "The exact held response must close without completing its body");
  await expect.poll(() => held.observation.body, { timeout: 5000 }).toBe("failed");
}

async function homeChecks(page: Page, t: Labels, roots: [Root, Root], bridge: Bridge, json: Json, result: CaseReport) {
  const [a, b] = roots;
  await activate(page, b); // Both roots are visited before testing Home -> Work.
  await activate(page, a);
  await expect.poll(() => bridge.subscriptions().filter((item) => item.path.includes("/sessions/")).length).toBe(2);
  const leaseIdentities = subscriptions(bridge);
  const start = bridge.records.length;
  const reads = () => bridge.records.slice(start).filter((record) => record.method === "GET" && record.path === "/api/status");
  const held = await heldStatus(page, bridge, () => home(page, t));
  try {
    assert.equal(held.observation.body, "pending");
    assert(held.wire.live && !held.wire.complete);
    const headersBeforeHold = { ...held.observation };
    // Actual upstream headers have reached the browser. JSON/body completion is
    // held beyond the real timer interval, without a fake response or clock.
    await wait(5_350);
    const heldMs = performance.now() - held.observation.headersReceivedAt;
    assert(heldMs > 5000);
    assert.equal(reads().length, 1, "A slow Home status response cannot overlap another read");
    assert.equal(held.observation.body, "pending", "Browser headers cannot release Home's still-unfinished body owner");
    assert(held.wire.live && !held.wire.complete, "The original slow read must still own its response");
    await expect(surface(page, "home").locator(".er-session-title")).toHaveCount(0);
    const released = performance.now();
    held.gate.release();
    await expect.poll(() => held.observation.body).toBe("completed");
    const status = await held.body;
    assert(status);
    for (const root of roots) {
      assert(status.activeSessions.some((session) => session.id === root.id));
      await expect(surface(page, "home").locator(`.er-session-title[title=${JSON.stringify(root.name)}]`)).toBeVisible({ timeout: 2500 });
    }
    const publishedMs = performance.now() - released;
    assert(publishedMs < 5000, "Release must publish the accepted response before a successor poll");
    await wait(Math.max(0, 4500 - (performance.now() - released)));
    assert.equal(reads().length, 1, "The five-second delay starts after response completion");
    await expect.poll(() => reads().length, { timeout: 2500, intervals: [100] }).toBe(2);
    const successorMs = performance.now() - released;
    await expect.poll(() => reads()[1]?.complete).toBe(true);
    await activate(page, a);
    const cancelRead = await heldStatus(page, bridge, () => home(page, t));
    try {
      assert.equal(cancelRead.observation.body, "pending");
      assert(cancelRead.wire.live && !cancelRead.wire.complete);
      const cachedTitles = await surface(page, "home").locator(".er-session-title").allTextContents();
      const cancellationHeaders = { ...cancelRead.observation };
      await activate(page, a); // Hide while the real JSON body is still pending.
      await assertStatusAborted(cancelRead); // Must happen BEFORE releasing the gate.
      const cancelledBeforeRelease = { ...cancelRead.observation, wire: { ...cancelRead.wire } };
      const pausedCount = reads().length;
      cancelRead.gate.release();
      await wait(5_350);
      assert.equal(cancelRead.observation.body, "failed");
      assert.equal(cancelRead.wire.complete, false);
      assert.deepEqual(await surface(page, "home").locator(".er-session-title").allTextContents(), cachedTitles);
      assert.equal(reads().length, pausedCount, "Releasing an aborted body cannot restore Home's timer/read owner while Work is selected");
      assert.deepEqual(subscriptions(bridge), leaseIdentities, "Home cancellation cannot recreate peer event owners");
      const returning = performance.now();
      await home(page, t);
      await expect.poll(() => reads().length, { timeout: 2500, intervals: [50] }).toBe(pausedCount + 1);
      await expect.poll(() => reads().at(-1)?.complete).toBe(true);
      const returnRefreshMs = performance.now() - returning;
      assert.notEqual(reads().at(-1), cancelRead.wire, "Foreground refresh must own a distinct new request");
      assert.deepEqual(subscriptions(bridge), leaseIdentities);
      result.measurements.home = { headersBeforeHold, heldMs, publishedMs, successorMs, pausedCount, returnRefreshMs,
        cancellationHeaders, cancelledBeforeRelease, requests: reads(), subscriptionsBefore: leaseIdentities, subscriptionsAfter: subscriptions(bridge),
        limits: ["Competing-request HTTP slot admission is separate transport coverage", "Non-cooperative late Promise callbacks are covered by Home polling unit tests"],
        sourceRuntime: "Two idle, connected native runtimes; live-work continuation belongs to the separate session-tabs regression" };
    } finally { await cancelRead.dispose(); }
    for (const root of roots) {
      const snapshot = await json<SessionSnapshotDto>(`/api/sessions/${root.id}/snapshot`);
      assert.equal(snapshot.session.id, root.id);
      assert.equal(snapshot.session.isStreaming, false);
    }
    noAgentControls(bridge.records.slice(start));
    result.checks.push("Home: browser receives real headers before a slow body; no overlap; completion delay; hiding cancels the exact pending request before gate release; stale release stays inert; return owns a fresh read and retains event/runtime owners");
  } finally { await held.dispose(); }

  // Native browser-window visibility only. Never override document.hidden or
  // dispatch a synthetic visibilitychange and call it browser evidence.
  const cdp = await page.context().newCDPSession(page);
  const visibility: Record<string, unknown> = { unitCoverage: "src/webui/src/pages/HomePage.polling.test.tsx", attempted: true };
  let windowId: number | undefined;
  await activate(page, a);
  const hiddenRead = await heldStatus(page, bridge, () => home(page, t));
  try {
    assert.equal(hiddenRead.observation.body, "pending");
    visibility.pendingHeaders = { ...hiddenRead.observation };
    try {
      ({ windowId } = await cdp.send("Browser.getWindowForTarget"));
      await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "minimized" } });
      await wait(250);
      visibility.state = await page.evaluate(() => document.visibilityState);
    } catch (error) { visibility.nativeAttemptError = String(error); }
    if (visibility.state === "hidden") {
      await assertStatusAborted(hiddenRead);
      visibility.cancelledBeforeRelease = { ...hiddenRead.observation, wire: { ...hiddenRead.wire } };
      const baseline = bridge.records.filter((record) => record.path === "/api/status").length;
      hiddenRead.gate.release();
      await wait(5_350);
      assert.equal(bridge.records.filter((record) => record.path === "/api/status").length, baseline);
      assert.equal(hiddenRead.wire.complete, false);
      assert.deepEqual(subscriptions(bridge), leaseIdentities);
      await cdp.send("Browser.setWindowBounds", { windowId: windowId!, bounds: { windowState: "normal" } });
      await page.bringToFront();
      await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe("visible");
      await expect.poll(() => bridge.records.filter((record) => record.path === "/api/status").length, { timeout: 2500 }).toBe(baseline + 1);
      await expect.poll(() => bridge.records.filter((record) => record.path === "/api/status").at(-1)?.complete).toBe(true);
      assert.deepEqual(subscriptions(bridge), leaseIdentities);
      visibility.result = "Native minimized window changed document.visibilityState; exact pending-body cancellation, hidden pause and fresh foreground refresh passed";
    } else {
      visibility.result = "Not browser-covered: native headless window minimization did not produce a hidden document; covered by focused unit tests";
    }
  } finally {
    await hiddenRead.dispose();
    if (windowId !== undefined) await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } })
      .catch((error) => { visibility.restoreError = String(error); });
    await page.bringToFront();
    await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe("visible");
    await cdp.detach();
    result.measurements.documentVisibility = visibility;
  }
  noAgentControls(bridge.records.slice(start));
  await activate(page, a);
}

async function retainedChecks(page: Page, t: Labels, roots: [Root, Root], bridge: Bridge, result: CaseReport, artifacts: string) {
  const [a, b] = roots;
  const viewport = page.viewportSize()!;
  assert(viewport.width >= 820);
  await activate(page, a);
  await composer(page).fill("Retained A draft · 保留草稿");
  await showTree(page, t);
  const panel = surface(page).getByRole("separator", { name: t("work.resizePanel"), exact: true });
  await panel.press("End");
  await panel.press("ArrowRight");
  const treeResize = files(page).getByRole("separator", { name: t("files.resizeTree"), exact: true });
  await treeResize.press("Home");
  await treeResize.press("ArrowRight");
  await files(page).getByRole("treeitem", { name: "evidence-05.md", exact: true }).click();
  await files(page).getByRole("textbox", { name: t("files.filter"), exact: true }).fill("evidence-0");
  await expect(files(page).getByRole("treeitem")).toHaveCount(10);
  const before = { panel: await panel.getAttribute("aria-valuenow"), tree: await treeResize.getAttribute("aria-valuenow"),
    draft: await composer(page).inputValue() };
  const owner = await surface(page, a.id).elementHandle();
  const textarea = await composer(page).elementHandle();
  const preview = await files(page).getByRole("tab", { name: "evidence-05.md", exact: true }).elementHandle();
  assert(owner && textarea && preview);
  const start = bridge.records.length;
  try {
    await activate(page, b);
    await page.setViewportSize({ width: 819, height: viewport.height });
    await frames(page);
    await page.setViewportSize(viewport);
    await frames(page);
    await activate(page, a);
    await expect(surface(page).locator("[data-work-layout]")).toHaveAttribute("data-panel-open", "true");
    await expect(files(page)).toBeVisible();
    await expect(files(page).getByRole("tab", { name: "evidence-05.md", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(files(page).getByText("ISOLATED_FILE_5", { exact: true })).toBeVisible();
    await expect(files(page).getByRole("textbox", { name: t("files.filter"), exact: true })).toHaveValue("evidence-0");
    await expect(composer(page)).toHaveValue(before.draft);
    await expect(panel).toHaveAttribute("aria-valuenow", before.panel!);
    await expect(treeResize).toHaveAttribute("aria-valuenow", before.tree!);
    for (const node of [owner, textarea, preview]) assert(await node.evaluate((element) => element.isConnected), "Retained DOM owners cannot be replaced");
    assert(await textarea.evaluate((element) => element === document.querySelector('[data-session-active="true"] [data-chat-composer] textarea')));
    await expect.poll(() => surface(page).locator("[data-work-layout] > section:last-child")
      .evaluate((element, expected) => Math.abs(element.getBoundingClientRect().width - Number(expected)), before.panel), { timeout: 2500 }).toBeLessThan(1);
    await page.screenshot({ path: join(artifacts, `retained-files-${result.label}.png`) });
    await activate(page, b);
    await page.setViewportSize({ width: 819, height: viewport.height });
    await activate(page, a); // Real activation while narrow reconciles Chat once.
    await expect(surface(page).getByRole("tab", { name: t("work.chatTab"), exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(composer(page)).toBeVisible();
    await expect(files(page)).not.toBeVisible();
    await pane(page, t, "files");
    await page.setViewportSize({ width: 800, height: viewport.height });
    await expect(surface(page).getByRole("tab", { name: t("work.filesTab"), exact: true })).toHaveAttribute("aria-selected", "true");
    await page.setViewportSize(viewport);
    await showTree(page, t);
    await expect(panel).toHaveAttribute("aria-valuenow", before.panel!);
    await expect(treeResize).toHaveAttribute("aria-valuenow", before.tree!);
    await expect(composer(page)).toHaveValue(before.draft);
    noAgentControls(bridge.records.slice(start));
    result.measurements.retained = before;
    result.checks.push("Inactive A retains exact DOM, Files selection/preview/filter/draft/splitter preferences through B's 819px round trip; narrow activation selects Chat once");
  } finally { await Promise.all([owner.dispose(), textarea.dispose(), preview.dispose()]); }
  await files(page).getByRole("textbox", { name: t("files.filter"), exact: true }).fill("");
  await pane(page, t, "chat");
}

interface SizingAudit {
  enabled: boolean;
  reads: Array<{ property: string; stack?: string }>;
  events: Array<{ kind: string; id: number }>;
  observers: Map<number, Set<Element>>;
  constructors: number;
  nativeSupport: boolean;
}
declare global { interface Window { __modernWebSizing: SizingAudit } }

/** Forward native primitives; collect only the typing window, never our geometry
 * assertions. The unsupported case changes only field-sizing feature detection. */
function installSizingProbe(fallback: boolean) {
  const supports = CSS.supports.bind(CSS);
  const audit: SizingAudit = { enabled: false, reads: [], events: [], observers: new Map(), constructors: 0,
    nativeSupport: supports("field-sizing", "content") };
  window.__modernWebSizing = audit;
  if (fallback) CSS.supports = ((property: string, value?: string) => {
    if (property === "field-sizing" || /^\(?\s*field-sizing\s*:/.test(property)) return false;
    return value === undefined ? supports(property) : supports(property, value);
  }) as typeof CSS.supports;
  const isComposer = (element: unknown): element is HTMLTextAreaElement => element instanceof HTMLTextAreaElement && !!element.closest("[data-chat-composer]");
  const read = (element: unknown, property: string) => {
    if (audit.enabled && isComposer(element)) {
      if (audit.reads.length >= 2000) throw new Error("Sizing probe exceeded bounded read budget");
      audit.reads.push({ property, ...(audit.reads.length < 16 ? { stack: new Error().stack } : {}) });
    }
  };
  for (const [prototype, properties] of [[Element.prototype, ["clientWidth", "clientHeight", "scrollHeight", "scrollWidth"]],
    [HTMLElement.prototype, ["offsetWidth", "offsetHeight"]]] as const) {
    for (const property of properties) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
      if (!descriptor?.get) throw new Error(`Missing native geometry getter ${property}`);
      Object.defineProperty(prototype, property, { ...descriptor, get() { read(this, property); return descriptor.get!.call(this); } });
    }
  }
  const rect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function () { read(this, "getBoundingClientRect"); return rect.call(this); };
  const rects = Element.prototype.getClientRects;
  Element.prototype.getClientRects = function () { read(this, "getClientRects"); return rects.call(this); };
  const NativeObserver = ResizeObserver;
  window.ResizeObserver = class extends NativeObserver {
    readonly smokeId = ++audit.constructors;
    override observe(target: Element, options?: ResizeObserverOptions) {
      if (isComposer(target)) {
        const targets = audit.observers.get(this.smokeId) ?? new Set<Element>();
        targets.add(target);
        audit.observers.set(this.smokeId, targets);
        if (audit.enabled) audit.events.push({ kind: "observe", id: this.smokeId });
      }
      super.observe(target, options);
    }
    override unobserve(target: Element) {
      if (audit.observers.get(this.smokeId)?.delete(target) && audit.enabled) audit.events.push({ kind: "unobserve", id: this.smokeId });
      super.unobserve(target);
    }
    override disconnect() {
      if (audit.observers.has(this.smokeId) && audit.enabled) audit.events.push({ kind: "disconnect", id: this.smokeId });
      audit.observers.delete(this.smokeId);
      super.disconnect();
    }
  };
}

async function geometry(textarea: Locator) {
  return textarea.evaluate((element: HTMLTextAreaElement) => {
    assertProbeInactive();
    function assertProbeInactive() { if (window.__modernWebSizing.enabled) throw new Error("Test geometry contaminated the product typing sample"); }
    const style = getComputedStyle(element);
    return { height: element.getBoundingClientRect().height, width: element.clientWidth, client: element.clientHeight,
      scroll: element.scrollHeight, font: Number.parseFloat(style.fontSize), max: Number.parseFloat(style.maxHeight),
      fontPreference: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--v2-chat-font-size")),
      sizing: style.getPropertyValue("field-sizing"), inline: element.style.height, value: element.value };
  });
}
async function openSettings(page: Page, t: Labels, category: "general" | "agents") {
  await topbar(page).getByRole("button", { name: t("home.settings"), exact: true }).click();
  const settings = page.getByRole("dialog", { name: t("settings.title"), exact: true });
  await expect(settings).toBeVisible();
  const name = t(category === "general" ? "studio.appearanceLanguage" : "settings.category.agents");
  await settings.getByRole(page.viewportSize()!.width < 820 ? "button" : "tab", { name, exact: true }).click();
  return settings;
}
async function font(page: Page, t: Labels, direction: "increaseChat" | "decreaseChat") {
  const settings = await openSettings(page, t, "general");
  for (let step = 0; step < 7; step++) await settings.getByRole("button", { name: t(`settings.appearance.${direction}`), exact: true }).click();
  await settings.getByRole("button", { name: t("settings.close"), exact: true }).click();
  await expect(settings).toHaveCount(0);
  await frames(page);
}
async function paste(page: Page, text: string) {
  await composer(page).focus();
  await page.evaluate((text) => navigator.clipboard.writeText(text), text);
  await page.keyboard.press("Control+KeyA");
  await page.keyboard.press("Control+KeyV");
  await expect(composer(page)).toHaveValue(text);
  await frames(page);
}

async function composerChecks(page: Page, t: Labels, roots: [Root, Root], result: CaseReport) {
  await pane(page, t, "chat");
  const pasteViewport = page.viewportSize();
  const textarea = composer(page);
  await expect(textarea).toHaveAttribute("data-composer-sizing", result.fallback ? "fallback" : "native");
  assert(await page.evaluate(() => window.__modernWebSizing.nativeSupport), "This matrix requires the installed Chrome's real native field-sizing implementation");
  await textarea.fill("");
  await frames(page);
  const empty = await geometry(textarea);
  await paste(page, Array.from({ length: 30 }, (_, row) => `Pasted line ${row} · 自动增长`).join("\n"));
  const capped = await geometry(textarea);
  assert(capped.height > empty.height && Math.abs(capped.height - capped.max) <= 1 && capped.max === 160);
  assert(capped.scroll > capped.client, "Capped long paste must retain real textarea scrolling");
  await textarea.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  assert(await textarea.evaluate((element) => element.scrollTop > 0));
  await textarea.focus();
  await page.keyboard.press("Control+KeyA");
  await page.keyboard.press("Backspace");
  await frames(page);
  const deleted = await geometry(textarea);
  assert.equal(deleted.value, "");
  assert(Math.abs(deleted.height - empty.height) <= 1, "Deleting a long paste must shrink to the original empty baseline");

  // Match the audit's wrapping draft and desktop width. The second context also
  // exercises a genuine 390px/coarse-pointer layout before this desktop probe.
  if (page.viewportSize()!.width < 820) await page.setViewportSize({ width: 1024, height: 900 });
  await textarea.fill("Measured draft text should wrap and resize. ".repeat(6));
  await frames(page);
  const small = await geometry(textarea);
  assert.equal(small.fontPreference, 13);
  await font(page, t, "increaseChat");
  const large = await geometry(textarea);
  assert.equal(large.value, small.value);
  assert.equal(large.width, small.width);
  assert.equal(large.font, 20);
  assert.equal(large.fontPreference, 20);
  assert(large.height > small.height && large.height < large.max && large.scroll <= large.client + 1,
    "Unedited wrapping draft must fit after Settings font growth, below the cap");
  await font(page, t, "decreaseChat");
  const restored = await geometry(textarea);
  assert.equal(restored.value, small.value);
  assert.equal(restored.font, small.font);
  assert.equal(restored.fontPreference, 13);
  assert(Math.abs(restored.height - small.height) <= 1, "Settings font shrink must remove surplus height without a keystroke");
  const node = await textarea.elementHandle();
  assert(node);
  try {
    await activate(page, roots[1]);
    await activate(page, roots[0]);
    assert(await node.evaluate((element) => element.isConnected));
    await expect(textarea).toHaveValue(small.value);
    await frames(page);
    const returned = await geometry(textarea);
    assert(Math.abs(returned.height - restored.height) <= 1);
  } finally { await node.dispose(); }

  await textarea.fill("Stable typing sample\nsecond line\nthird line\nfourth line ");
  await textarea.focus();
  await textarea.press("Control+End");
  await frames(page);
  const before = await page.evaluate(() => {
    const audit = window.__modernWebSizing;
    const textarea = document.querySelector('[data-session-active="true"] [data-chat-composer] textarea')!;
    const ids = [...audit.observers].filter(([, targets]) => targets.has(textarea)).map(([id]) => id);
    audit.reads = []; audit.events = []; audit.enabled = true;
    return { ids, constructors: audit.constructors };
  });
  let sample: { reads: SizingAudit["reads"]; events: SizingAudit["events"]; ids: number[]; constructors: number };
  try {
    // No locators, focus calls or acceptance geometry reads while recording.
    await page.keyboard.type("abcdefghijklmnopqrst", { delay: 15 });
    await frames(page);
  } finally {
    sample = await page.evaluate(() => {
      const audit = window.__modernWebSizing;
      audit.enabled = false;
      const textarea = document.querySelector('[data-session-active="true"] [data-chat-composer] textarea')!;
      return { reads: audit.reads, events: audit.events, constructors: audit.constructors,
        ids: [...audit.observers].filter(([, targets]) => targets.has(textarea)).map(([id]) => id) };
    });
  }
  const after = await geometry(textarea);
  assert.deepEqual(sample.events, [], "Typing cannot attach, detach or replace the sizing observer");
  assert.equal(sample.constructors, before.constructors, "The settled typing sample cannot churn ResizeObserver constructors");
  assert.deepEqual(sample.ids, before.ids);
  assert.equal(before.ids.length, result.fallback ? 1 : 0);
  if (result.fallback) {
    assert(sample.reads.some((read) => read.property === "scrollHeight"), "Forced unsupported feature must exercise JS autogrow");
    assert.notEqual(after.inline, "");
    assert.notEqual(after.sizing, "content", "Forced fallback cannot be silently helped by native CSS field sizing");
  } else {
    assert.deepEqual(sample.reads, [], "Native typing autosizing must issue zero JS textarea geometry reads");
    assert.equal(after.inline, "");
    assert.equal(after.sizing, "content");
  }
  await textarea.fill("@evidence-05");
  await surface(page).getByRole("listbox", { name: t("composer.files"), exact: true })
    .getByRole("option", { name: "evidence-05.md", exact: true }).click();
  const referencePath = join(roots[0].cwd, "evidence-05.md");
  const reference = surface(page).locator("[data-composer-reference]");
  await expect(reference).toHaveAttribute("title", referencePath);
  const referenceDraft = await textarea.inputValue();
  assert(referenceDraft.includes(referencePath));
  await activate(page, roots[1]);
  await activate(page, roots[0]);
  await expect(reference).toHaveAttribute("title", referencePath);
  await expect(textarea).toHaveValue(referenceDraft);
  await reference.getByRole("button", { name: `${t("composer.removeReference")} ${referencePath}`, exact: true }).click();
  await expect(reference).toHaveCount(0);
  assert(!(await textarea.inputValue()).includes(referencePath));
  result.measurements.composer = { pasteViewport, fontAndTypingViewport: page.viewportSize(), empty, capped, deleted, small, large, restored, typing: { before, ...sample, after,
    note: "Getter/observer evidence only; no Layout-event timing, INP or improvement-percent claim. Source-component traces are separately documented by the layout owner.",
    baselineReceipt: "/tmp/opencode/modern-web-layout-evidence/typing-trace.json" }, reference: { path: referencePath, draft: referenceDraft, retainedAndRemoved: true } };
  result.checks.push(`${result.fallback ? "Forced unsupported" : "Native"} composer: clipboard paste/grow/cap/scroll/delete/shrink, unchanged Settings font 13→20→13, retained return, 20-key geometry/observer sample, file-reference chip insertion/retention/removal without sending`);
}

async function activeOption(search: Locator, expected?: string) {
  const sample = await search.evaluate((input: HTMLInputElement) => {
    const list = document.getElementById(input.getAttribute("aria-controls")!);
    const active = document.getElementById(input.getAttribute("aria-activedescendant")!);
    if (!list || !active || !list.contains(active)) throw new Error("Active option must be a real row inside its owning listbox");
    const row = active.getBoundingClientRect();
    const box = list.getBoundingClientRect();
    return { text: active.textContent, id: active.id, selected: active.getAttribute("aria-selected"),
      selectedIds: [...list.querySelectorAll('[aria-selected="true"]')].map((element) => element.id),
      focused: document.activeElement === input, row: { top: row.top, bottom: row.bottom },
      list: { top: box.top, bottom: box.bottom, scrollTop: list.scrollTop, height: list.clientHeight, scrollHeight: list.scrollHeight } };
  });
  assert(sample.focused, "Model search owns DOM focus during active-descendant navigation");
  assert.equal(sample.selected, "true");
  assert.deepEqual(sample.selectedIds, [sample.id]);
  assert(sample.row.top >= sample.list.top - 1 && sample.row.bottom <= sample.list.bottom + 1, "Keyboard-active row must be inside the options scroller, not merely attached to DOM");
  if (expected) assert.equal(sample.text, expected);
  return sample;
}
async function outerScroll(ancestors: JSHandle<HTMLElement[]>) {
  return ancestors.evaluate((elements) => {
    return { window: { x: scrollX, y: scrollY, width: innerWidth, height: innerHeight }, ancestors: elements.map((element) => {
      if (!element.isConnected) throw new Error("An outer scroll owner was replaced while the model picker stayed open");
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return { tag: element.tagName, id: element.id, role: element.getAttribute("role"), top: element.scrollTop, left: element.scrollLeft,
        client: { width: element.clientWidth, height: element.clientHeight }, scroll: { width: element.scrollWidth, height: element.scrollHeight },
        overflow: { x: style.overflowX, y: style.overflowY }, bounds: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right } };
    }) };
  });
}
function assertOuterScroll(before: Awaited<ReturnType<typeof outerScroll>>, after: Awaited<ReturnType<typeof outerScroll>>) {
  const positions = (value: typeof before) => ({ window: [value.window.x, value.window.y],
    ancestors: value.ancestors.map(({ top, left }) => [top, left]) });
  assert.deepEqual(positions(after), positions(before), "Opening/filtering/navigating the picker may scroll only its options list, never an outer owner");
}
const configWrites = (records: Wire[]) => records.filter((record) => ["PUT", "PATCH"].includes(record.method)
  && !/^\/api\/events\//.test(record.path) && !/\/(project-watches|file-watches)\//.test(record.path));

async function modelChecks(page: Page, t: Labels, bridge: Bridge, agentDir: string, result: CaseReport) {
  const modelWritesStart = bridge.records.length;
  let pointerWrites: Wire[] = [];
  const settings = await openSettings(page, t, "agents");
  await settings.getByRole("button", { name: t("settings.agents.configure").replace("{name}", t("agent.researchAssistant")), exact: true }).click();
  const dialog = page.getByRole("dialog", { name: t("settings.agents.title"), exact: true });
  await expect(dialog).toBeVisible();
  const trigger = dialog.locator('[role="combobox"][id="model-research-assistant"]');
  await expect(trigger).toBeEnabled();
  await trigger.focus();
  await expect(trigger).toBeFocused();
  await frames(page);
  // Capture stable outer owners BEFORE the popup/search/list exist. New popup
  // ancestors cannot enter the comparison or disguise initial reveal scrolling.
  const outer = await trigger.evaluateHandle((element) => {
    const ancestors: HTMLElement[] = [];
    for (let parent = element.parentElement; parent; parent = parent.parentElement) ancestors.push(parent);
    return ancestors;
  });
  const outerSamples: Record<string, Awaited<ReturnType<typeof outerScroll>>> = {};
  const observations: Awaited<ReturnType<typeof activeOption>>[] = [];
  const search = dialog.getByRole("searchbox", { name: "Search", exact: true });
  try {
    outerSamples.beforeOpen = await outerScroll(outer);
    await trigger.press("Enter");
    await expect(search).toBeFocused();
    const listId = await search.getAttribute("aria-controls");
    assert(listId, "Model search must identify its owning listbox");
    const list = dialog.locator(`[role="listbox"][id=${JSON.stringify(listId)}]`);
    await expect(list).toBeVisible();
    await expect(list.getByRole("option")).toHaveCount(180);
    await frames(page);
    observations.push(await activeOption(search, modelRef(179)));
    assert(observations[0]!.list.scrollTop > 0 && observations[0]!.list.scrollHeight > observations[0]!.list.height);
    outerSamples.afterOpen = await outerScroll(outer);
    assertOuterScroll(outerSamples.beforeOpen, outerSamples.afterOpen);
    for (const [key, expected] of [["Home", 0], ["End", 179], ["ArrowUp", 178], ["ArrowDown", 179]] as const) {
      await search.press(key);
      await frames(page);
      observations.push(await activeOption(search, modelRef(expected)));
      outerSamples[key] = await outerScroll(outer);
      assertOuterScroll(outerSamples.beforeOpen, outerSamples[key]!);
    }

    // A stationary cursor must not turn scroll-generated mouseover into new
    // pointer intent. Use real integer-coordinate mouse input, never hover()
    // (which can scroll a locator) or synthetic mouseover events.
    const settlePointer = async () => { await frames(page); await frames(page); await wait(150); };
    await page.keyboard.press("Home");
    await settlePointer();
    await activeOption(search, modelRef(0));
    const trace = await list.evaluateHandle((list) => {
      const moves: Array<{ x: number; y: number; trusted: boolean }> = [];
      const overs: Array<{ x: number; y: number; row: string | null }> = [];
      const move = (event: PointerEvent) => {
        if (moves.length < 200) moves.push({ x: event.clientX, y: event.clientY, trusted: event.isTrusted });
      };
      const over = (event: MouseEvent) => {
        const row = event.target instanceof Element ? event.target.closest('[role="option"]') : null;
        if (row && list.contains(row) && overs.length < 200) overs.push({ x: event.clientX, y: event.clientY, row: row.textContent });
      };
      document.addEventListener("pointermove", move, true);
      document.addEventListener("mouseover", over, true);
      return { read: () => ({ moves: [...moves], overs: [...overs] }), dispose() {
        document.removeEventListener("pointermove", move, true);
        document.removeEventListener("mouseover", over, true);
      } };
    });
    const pointerSteps: Array<Record<string, unknown>> = [];
    const pointerReceipt: Record<string, unknown> = { steps: pointerSteps, settle: "four animation frames plus 150ms after each key" };
    result.measurements.modelsMixedPointer = pointerReceipt;
    const pointerStart = bridge.records.length;
    const settingsBeforePointer = readFileSync(join(agentDir, "settings.json"));
    try {
      const box = await list.getByRole("option", { name: modelRef(2), exact: true }).boundingBox();
      assert(box);
      const point = { x: Math.floor(box.x + box.width / 2), y: Math.floor(box.y + box.height / 2) };
      pointerReceipt.point = point;
      await page.mouse.move(point.x, point.y);
      await settlePointer();
      pointerReceipt.initial = await activeOption(search, modelRef(2));
      const stationary = await trace.evaluate((value) => value.read().moves);
      assert.equal(stationary.length, 1, "One real move must establish the initial non-click hover");
      assert(stationary[0]!.trusted);
      let homeScroll = 0;
      let boundaryScroll = 0;
      for (const [key, expected] of [["End", 179], ["Home", 0], ...[1, 2, 3, 4, 5, 6].map((index) => ["ArrowDown", index] as const)] as const) {
        await page.keyboard.press(key);
        await settlePointer();
        const active = await activeOption(search);
        const inputTrace = await trace.evaluate((value) => value.read());
        const underPointer = await list.evaluate((list, point) => {
          const row = document.elementFromPoint(point.x, point.y)?.closest('[role="option"]');
          return { insideList: !!row && list.contains(row), row: row?.textContent ?? null };
        }, point);
        pointerSteps.push({ key, expected: modelRef(expected), ...active, underPointer, pointerMoves: inputTrace.moves.length });
        assert.deepEqual(inputTrace.moves, stationary, "Keyboard reveal must be tested with no pointer movement, including outside the list");
        assert(underPointer.insideList, "The stationary cursor must remain over a real option, not outside the popup");
        assert.equal(active.text, modelRef(expected), "Settled keyboard intent cannot be replaced by scroll-generated mouseover");
        assertOuterScroll(outerSamples.beforeOpen, await outerScroll(outer));
        if (key === "Home") homeScroll = active.list.scrollTop;
        if (key === "ArrowDown" && expected === 6) boundaryScroll = active.list.scrollTop;
      }
      assert(boundaryScroll > homeScroll, "Arrow navigation must actually cross the visible list boundary");
      assert.deepEqual(configWrites(bridge.records.slice(pointerStart)), [], "Hover and keyboard navigation must not select/save");
      assert.deepEqual(readFileSync(join(agentDir, "settings.json")), settingsBeforePointer);

      const target = list.getByRole("option", { name: modelRef(3), exact: true });
      const targetBox = await target.boundingBox();
      assert(targetBox);
      const moved = { x: Math.floor(targetBox.x + targetBox.width / 2), y: Math.floor(targetBox.y + targetBox.height / 2) };
      assert.notDeepEqual(moved, point);
      await page.mouse.move(moved.x, moved.y);
      await settlePointer();
      pointerReceipt.resumedHover = await activeOption(search, modelRef(3));
      assert((await trace.evaluate((value) => value.read().moves.length)) > stationary.length);
      assertOuterScroll(outerSamples.beforeOpen, await outerScroll(outer));
      assert.deepEqual(configWrites(bridge.records.slice(pointerStart)), []);
      // One authorized positive click selects model-003; the separate ordinary
      // Enter check below selects model-042. Both writes are counted exactly.
      await page.mouse.click(moved.x, moved.y);
      await expect(search).toHaveCount(0);
      await expect.poll(() => configWrites(bridge.records.slice(pointerStart)).filter((record) => record.complete).length).toBe(1);
      pointerWrites = configWrites(bridge.records.slice(pointerStart));
      assert.equal(pointerWrites.length, 1);
      assert.deepEqual({ method: pointerWrites[0]!.method, path: pointerWrites[0]!.path, body: pointerWrites[0]!.body, status: pointerWrites[0]!.status },
        { method: "PATCH", path: "/api/agents/research-assistant", body: { model: modelRef(3) }, status: 200 });
      assert.equal(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).easyresearch.agentDefaults["research-assistant"].model, modelRef(3));
      await expect(trigger).toContainText(modelRef(3));
      await expect(trigger).toBeEnabled();
      pointerReceipt.clickWrites = pointerWrites;
    } finally {
      pointerReceipt.inputTrace = await trace.evaluate((value) => value.read());
      await trace.evaluate((value) => value.dispose());
      await trace.dispose();
    }
    await trigger.press("Enter");
    await expect(search).toBeFocused();
    await settlePointer();
    await activeOption(search, modelRef(3));
    assertOuterScroll(outerSamples.beforeOpen, await outerScroll(outer));
    outerSamples.beforeFilter = await outerScroll(outer);
    await search.fill("model-042");
    await frames(page);
    observations.push(await activeOption(search, modelRef(42)));
    outerSamples.afterFilter = await outerScroll(outer);
    assertOuterScroll(outerSamples.beforeFilter, outerSamples.afterFilter);
    assertOuterScroll(outerSamples.beforeOpen, outerSamples.afterFilter);
  } finally { await outer.dispose(); }
  const before = bridge.records.length;
  const initialSettings = readFileSync(join(agentDir, "settings.json"));
  // Synthetic native KeyboardEvents explicitly exercise browser React handling;
  // this is not an OS CJK candidate-window/IME end-to-end test.
  for (const flags of [{ isComposing: true, keyCode: 13 }, { isComposing: false, keyCode: 229 }]) {
    await search.evaluate((element, flags) => element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true, ...flags })), flags);
    await frames(page);
    await expect(search).toBeFocused();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    assert.deepEqual(configWrites(bridge.records.slice(before)), []);
    assert.deepEqual(readFileSync(join(agentDir, "settings.json")), initialSettings);
  }
  await search.evaluate((element) => element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "模" })));
  for (const key of ["ArrowDown", "Escape"]) {
    await search.evaluate((element, key) => element.dispatchEvent(new KeyboardEvent("keydown", { key, isComposing: true, bubbles: true, cancelable: true })), key);
    await frames(page);
    await expect(search).toBeFocused();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
  }
  await search.evaluate((element) => element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "模型" })));
  assert.deepEqual(configWrites(bridge.records.slice(before)), []);
  await search.press("Enter");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect.poll(() => configWrites(bridge.records.slice(before)).filter((record) => record.complete).length).toBe(1);
  const writes = configWrites(bridge.records.slice(before));
  assert.equal(writes.length, 1);
  assert.equal(writes[0]!.method, "PATCH");
  assert.equal(writes[0]!.path, "/api/agents/research-assistant");
  assert.equal(writes[0]!.status, 200);
  assert.deepEqual(writes[0]!.body, { model: modelRef(42) });
  assert.equal(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).easyresearch.agentDefaults["research-assistant"].model, modelRef(42));
  await expect(trigger).toContainText(modelRef(42));
  await expect(trigger).toBeEnabled();
  const tabStart = bridge.records.length;
  const thinking = dialog.locator('select[id="thinking-research-assistant"]');
  await expect(thinking).toBeEnabled();
  for (const [key, target] of [["Tab", thinking], ["Shift+Tab", trigger]] as const) {
    await trigger.focus();
    await trigger.press("Enter");
    await expect(search).toBeFocused();
    await search.press(key);
    await expect(search).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(target).toBeFocused();
  }
  assert.deepEqual(configWrites(bridge.records.slice(tabStart)), [], "Tab dismissal is navigation, not a model mutation");
  await trigger.click();
  await search.press("Escape");
  await expect(search).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(trigger).toBeFocused();

  // Preserve the existing nested editor guard, including a vetoed Escape. The
  // private draft is discarded; no Agent definition or network setting is saved.
  const guardStart = bridge.records.length;
  await dialog.getByRole("button", { name: t("settings.agents.edit").replace("{name}", t("agent.researchAssistant")), exact: true }).click();
  const editor = page.getByRole("dialog", { name: "research-assistant", exact: true });
  const markdown = editor.getByRole("textbox", { name: t("settings.agents.agentMarkdown"), exact: true });
  const draft = `${await markdown.inputValue()}\nAcceptance-only unsaved draft.\n`;
  await markdown.fill(draft);
  for (const action of ["dismiss", "accept"] as const) {
    const confirmation = page.waitForEvent("dialog", { timeout: 5000 }).then(async (prompt) => {
      try { assert.equal(prompt.type(), "confirm"); assert.equal(prompt.message(), t("settings.editor.discardConfirm")); }
      finally { await prompt[action](); }
    });
    await Promise.all([confirmation, markdown.press("Escape")]);
    if (action === "dismiss") {
      await expect(editor).toBeVisible();
      await expect(markdown).toHaveValue(draft);
    }
  }
  await expect(editor).toHaveCount(0);
  await expect(dialog).toBeVisible();
  assert.deepEqual(configWrites(bridge.records.slice(guardStart)), [], "Discard-guard checks must never persist the editor draft");
  await dialog.getByRole("button", { name: t("settings.editor.close"), exact: true }).press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: t("settings.close"), exact: true }).click();
  await expect(settings).toHaveCount(0);
  const controlledPatches = configWrites(bridge.records.slice(modelWritesStart));
  assert.deepEqual(controlledPatches.map(({ method, path, body, status }) => ({ method, path, body, status })),
    [3, 42].map((index) => ({ method: "PATCH", path: "/api/agents/research-assistant", body: { model: modelRef(index) }, status: 200 })),
    "Only the explicit pointer click and ordinary Enter may save a model");
  result.measurements.models = { viewport: page.viewportSize(), observations, outerScroll: outerSamples,
    outerScrollLimit: "Actual ancestor/document scroll ranges recorded; no manufactured overflow. The source owner's scrolled outer/document fixture remains separate evidence.",
    tabDismissal: { Tab: "thinking-research-assistant", "Shift+Tab": "model-research-assistant" },
    writes, pointerWrites, controlledPatches, composition: "Synthetic native KeyboardEvent isComposing/229 and CompositionEvent; actual OS CJK IME unavailable",
    liveCatalogReplacement: "Focused SearchableSelect component tests; no browser/backend replacement claim" };
  result.checks.push("Actual 180-model listbox: stationary-pointer End/Home/arrows keep settled keyboard intent and visible row; real movement restores hover; one explicit click PATCH plus one ordinary-Enter PATCH; open/filter/navigation preserve outer scroll and search focus; IME/Tab/Escape/dirty-editor guards retain ownership");
}

async function historyChecks(page: Page, t: Labels, result: CaseReport) {
  await pane(page, t, "chat");
  await composer(page).fill("/history");
  await composer(page).press("Enter");
  const dialog = page.getByRole("dialog", { name: t("history.title"), exact: true });
  const rows = dialog.getByRole("treeitem");
  await expect(rows).toHaveCount(3);
  await rows.first().focus();
  await rows.first().press("Home");
  await expect(rows.first()).toHaveAttribute("aria-selected", "true");
  await expect(rows.last()).toHaveAttribute("tabindex", "-1");
  for (const expected of [dialog.getByRole("combobox", { name: t("history.filter"), exact: true }),
    dialog.getByRole("searchbox", { name: t("history.search"), exact: true }),
    dialog.getByRole("button", { name: t("history.close"), exact: true }), rows.first()]) {
    await page.keyboard.press("Shift+Tab");
    await expect(expected).toBeFocused();
    await expect(rows.first()).toHaveAttribute("aria-selected", "true");
    await expect(rows.last()).toHaveAttribute("tabindex", "-1");
  }
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: t("history.close"), exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  result.measurements.history = { viewport: page.viewportSize(), userRows: 3, selectedRow: 0 };
  result.checks.push("Real three-user History: nonterminal roving selection survives Shift+Tab wrap and forward Tab boundary; last negative-tabindex row stays unselected");
}

async function fileMenuChecks(page: Page, t: Labels, roots: [Root, Root], result: CaseReport) {
  await showTree(page, t);
  await files(page).getByRole("textbox", { name: t("files.filter"), exact: true }).fill("");
  const tree = files(page).getByRole("tree", { name: t("files.tree"), exact: true });
  await expect(tree.getByRole("treeitem")).toHaveCount(40);
  const actionName = t("files.actions").replace("{name}", "evidence-05.md");
  const trigger = tree.getByRole("button", { name: actionName, exact: true });
  const menu = page.getByRole("menu", { name: actionName, exact: true });
  const open = async () => {
    await trigger.focus();
    await trigger.press("Enter");
    await expect(menu.getByRole("menuitem", { name: t("files.download"), exact: true })).toBeFocused();
  };
  await tree.evaluate((element) => { element.scrollTop = 0; });
  assert(await tree.evaluate((element) => element.scrollHeight > element.clientHeight + 30), "Fixture must really overflow its file pane");
  await open();
  const oldScroll = await tree.evaluate((element) => element.scrollTop);
  await tree.evaluate((element) => { element.scrollTop += 24; });
  await expect.poll(() => tree.evaluate((element) => element.scrollTop)).toBeGreaterThan(oldScroll);
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  const viewport = page.viewportSize()!;
  assert(viewport.width >= 880);
  await open();
  await page.setViewportSize({ ...viewport, width: viewport.width - 40 });
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.setViewportSize(viewport);

  // Establish the native next Tab target with the menu closed, then compare the
  // menu's Tab dismissal to that actual target rather than guessing tree order.
  await trigger.focus();
  await page.keyboard.press("Tab");
  const next = await page.evaluateHandle(() => document.activeElement);
  try {
    assert(await next.evaluate((element) => element !== document.body && element !== null));
    await open();
    await page.keyboard.press("Tab");
    await expect(menu).toHaveCount(0);
    assert(await next.evaluate((element) => element === document.activeElement), "Menu Tab must preserve the ordinary sequential destination");
  } finally { await next.dispose(); }
  await open();
  const filter = files(page).getByRole("textbox", { name: t("files.filter"), exact: true });
  await filter.click();
  await expect(menu).toHaveCount(0);
  await expect(filter).toBeFocused();
  await open();
  await activate(page, roots[1]);
  await expect(menu).toHaveCount(0);
  assert(await surface(page, roots[0].id).evaluate((element) => !element.contains(document.activeElement)), "Deactivation cannot restore focus into the hidden old owner");
  await activate(page, roots[0]);
  result.measurements.fileMenu = { viewport, scrollBefore: oldScroll, dismissalScrollDelta: 24, sameDesktopResizeDelta: -40 };
  result.checks.push("Actual file menu: keyboard-open then real pane scroll/same-desktop resize restore trigger; Tab and outside click retain destination; switching root never focuses hidden owner");
}

async function main() {
  assert.equal(process.argv.length, 3, "Usage: bun scripts/smoke-modern-web.ts /absolute/controller-built-executable");
  const requestedBinary = resolve(process.argv[2]!);
  const requestedChromium = process.env.COMPARE_CHROMIUM_PATH ?? chromium.executablePath();
  assert(existsSync(requestedBinary), `Compiled candidate missing: ${requestedBinary}. Supply the parent's accepted executable.`);
  assert(existsSync(requestedChromium), `Browser executable missing: ${requestedChromium}. Set COMPARE_CHROMIUM_PATH=/absolute/path/to/an/installed/Chrome with native field-sizing support. This helper does not download browsers.`);
  const binary = realpathSync(requestedBinary);
  const chromiumPath = realpathSync(requestedChromium);
  const artifacts = realpathSync(mkdtempSync("/tmp/opencode/easyresearch-modern-web-"));
  const homeDir = join(artifacts, "home");
  const agentDir = join(artifacts, "agent");
  const emptyPath = join(artifacts, "empty-path");
  for (const path of [homeDir, agentDir, emptyPath]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const env = { HOME: homeDir, USERPROFILE: homeDir, EASYRESEARCH_CODING_AGENT_DIR: agentDir, PATH: emptyPath,
    XDG_CONFIG_HOME: join(homeDir, ".config"), XDG_CACHE_HOME: join(homeDir, ".cache"), XDG_DATA_HOME: join(homeDir, ".local/share"),
    TMPDIR: "/tmp/opencode", NO_PROXY: "localhost,127.0.0.1,::1", LANG: "C.UTF-8", PI_OFFLINE: "1" };
  Object.assign(process.env, env);
  for (const key of ["EASYRESEARCH_BUNDLED_ROOT", "EASYRESEARCH_SKIP_SETUP", "EASYRESEARCH_VENV", "PI_PACKAGE_DIR"]) delete process.env[key];
  process.chdir(homeDir); // Isolate cwd as well as HOME before the first Pi value.
  const report = { binary, sha256: sha256(binary), chromiumPath, browser: "", artifacts,
    transport: "Actual compiled assets + real compiled HTTP/SSE; no API/SSE fulfillment or production DOM test hooks",
    limits: ["Not native/package release acceptance; first-run Python installation is intentionally unavailable in this browser helper",
      "No actual OS IME; synthetic native composition flags are labeled per case", "No INP-percent claim"],
    cases: [] as CaseReport[], cleanup: [] as string[], errors: [] as string[], providerRequests: [] as unknown[], passed: false };
  const failures: unknown[] = [];
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let bridge: Bridge | undefined;
  let provider: ReturnType<typeof providerFixture> | undefined;
  let custody: ReturnType<typeof createSmokeDaemonCustody> | undefined;
  let watchdogTask: Promise<unknown> | undefined;
  const watchdog = setTimeout(() => {
    failures.push(new Error("Modern web acceptance exceeded its six-minute deadline"));
    watchdogTask = Promise.allSettled([browser?.close(), bridge?.close(), provider?.close(), custody?.stopAndVerify()]);
  }, 6 * 60_000);
  console.log(`MODERN_WEB_SMOKE artifacts: ${artifacts}`);
  try {
    provider = providerFixture();
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { [providerId]: {
      baseUrl: provider.origin, api: "openai-completions", apiKey: "isolated-fixture",
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
      models: Array.from({ length: 180 }, (_, index) => ({ id: modelRef(index).split("/")[1], name: `Model ${index}`,
        contextWindow: 1_000_000, maxTokens: 2048 })),
    } } }));
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: providerId, defaultModel: "model-179",
      compaction: { enabled: false }, retry: { enabled: false }, easyresearch: { web: { sessionIdleTimeoutMs: -1 },
        agentDefaults: { "research-assistant": { model: modelRef(179), thinking: "off" } } } }));
    const { importPi } = await import("../src/runtime/pi-import");
    const pi = await importPi();
    assert.equal(pi.getAgentDir(), agentDir);
    const roots = fixtures(pi, artifacts);
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = probe.port!;
    await probe.stop(true);
    const origin = `http://127.0.0.1:${port}`;
    custody = createSmokeDaemonCustody({ agentDir, host: "127.0.0.1", port });
    const launcher = Bun.spawn([binary, "--no-open", "--port", String(port)], { cwd: homeDir, env, stdin: "ignore",
      stdout: Bun.file(join(artifacts, "startup.stdout")), stderr: Bun.file(join(artifacts, "startup.stderr")) });
    const launchTimeout = setTimeout(() => launcher.kill("SIGKILL"), 90_000);
    try { assert.equal(await launcher.exited, 0, `Compiled startup failed; inspect ${artifacts}/startup.stderr`); }
    finally { clearTimeout(launchTimeout); }
    assert(await custody.capture(), "Authenticate the isolated compiled daemon before browser access");
    const json: Json = async <T>(path: string, init?: RequestInit) => {
      const response = await fetch(`${origin}${path}`, { ...init, proxy: "", signal: AbortSignal.timeout(15_000) });
      assert.equal(response.status, 200, `${path}: ${response.status}`);
      return await response.json() as T;
    };
    assert.equal((await json<StatusDto>("/api/status")).agentDir, agentDir);
    browser = await chromium.launch({ executablePath: chromiumPath, env, headless: true, timeout: 30_000, args: ["--no-proxy-server"] });
    report.browser = browser.version();
    for (const item of [{ width: 1440, theme: "light", language: "en", fallback: false },
      { width: 390, theme: "dark", language: "zh-CN", fallback: true }] as const) {
      const result: CaseReport = { ...item, label: `${item.width}-${item.theme}-${item.fallback ? "fallback" : "native"}`,
        checks: [], measurements: {}, errors: [], failedRequests: [], passed: false };
      report.cases.push(result);
      // Reset only this private fixture's global model between contexts through
      // the real typed endpoint, outside the per-interaction write count.
      await json("/api/agents/research-assistant", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: modelRef(179) }) });
      bridge = await recordingBridge(origin);
      context = await browser.newContext({ viewport: { width: item.width, height: item.width < 820 ? 844 : 900 }, locale: item.language,
        colorScheme: item.theme, reducedMotion: "reduce", hasTouch: item.width < 820, permissions: ["clipboard-read", "clipboard-write"] });
      await context.addInitScript(({ origin, preferences, key }) => {
        if (location.origin === origin && !localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(preferences));
      }, { origin: bridge.origin, key: preferenceKey, preferences: { language: item.language, studioTheme: item.theme, chatFontSize: 13,
        sessionTabs: roots.map(({ id, cwd, name }) => ({ id, cwd, name })) } });
      await context.addInitScript(installSizingProbe, item.fallback);
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      page.setDefaultNavigationTimeout(25_000);
      page.on("pageerror", (error) => result.errors.push(error.stack ?? error.message));
      page.on("console", (message) => { if (message.type() === "error") result.errors.push(`console: ${message.text()}`); });
      page.on("requestfailed", (request) => result.failedRequests.push({ url: request.url(), error: request.failure()?.errorText ?? null }));
      page.on("response", (response) => { if (response.status() >= 400) result.errors.push(`HTTP ${response.status()}: ${response.url()}`); });
      const t: Labels = (key) => {
        const value = (messages[item.language] as Record<string, string>)[key];
        assert(value, `Missing integrated label: ${key}`);
        return value;
      };
      try {
        await page.goto(`${bridge.origin}/${workHash(roots[0])}`, { waitUntil: "domcontentloaded" });
        await expect(page.locator("html")).toHaveAttribute("data-ui-theme", item.theme);
        await expect(composer(page)).toBeEnabled();
        if (!item.fallback) {
          await homeChecks(page, t, roots, bridge, json, result);
          await retainedChecks(page, t, roots, bridge, result, artifacts);
          await page.screenshot({ path: join(artifacts, `retained-${result.label}.png`) });
        }
        await composerChecks(page, t, roots, result);
        await page.screenshot({ path: join(artifacts, `composer-${result.label}.png`) });
        await modelChecks(page, t, bridge, agentDir, result);
        await historyChecks(page, t, result);
        await fileMenuChecks(page, t, roots, result);
        await pane(page, t, "chat");
        await page.setViewportSize({ width: item.width, height: item.width < 820 ? 844 : 900 });
        await frames(page);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Representative viewport cannot overflow the page horizontally");
        noAgentControls(bridge.records);
        assert.deepEqual(provider.requests, [], "Every LLM request is forbidden in this read-only UI acceptance");
        assert.deepEqual(result.errors, []);
        assert.deepEqual(bridge.observationErrors, []);
        assert.deepEqual(bridge.records.filter((record) => record.status !== undefined && record.status >= 400), [], "All real HTTP/SSE responses must be successful");
        assert.deepEqual(result.failedRequests.filter((request) => request.error !== "net::ERR_ABORTED"), [], "Only owner-cancelled requests may fail transport");
        for (const root of roots) {
          const bytes = readFileSync(root.path);
          assert.deepEqual(bytes.subarray(0, root.original.length), root.original, "Model changes may append native metadata, never rewrite existing history");
          const history = pi.SessionManager.inMemory(root.cwd, { id: root.id }, pi.parseSessionEntries(bytes.toString("utf8")));
          assert.equal(history.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "user").length, 3);
          assert.equal(history.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "assistant").length, 3);
        }
        await page.screenshot({ path: join(artifacts, `complete-${result.label}.png`) });
        result.passed = true;
      } catch (error) {
        result.failure = error instanceof Error ? error.stack : String(error);
        failures.push(error);
        await page.screenshot({ path: join(artifacts, `failure-${result.label}.png`), timeout: 5000 }).catch((error) => result.errors.push(`Failure screenshot: ${String(error)}`));
        await page.locator("body").ariaSnapshot({ timeout: 5000 }).then((text) => writeFileSync(join(artifacts, `failure-${result.label}.yml`), text))
          .catch((error) => result.errors.push(`Failure accessibility snapshot: ${String(error)}`));
      } finally {
        writeFileSync(join(artifacts, `wire-${result.label}.json`), JSON.stringify({ requests: bridge.records, observationErrors: bridge.observationErrors }, null, 2));
        await context.close();
        context = undefined;
        await bridge.close();
        bridge = undefined;
        report.cleanup.push(`${result.label}: temporary context and streaming bridge closed`);
        if (result.passed && result.errors.length) {
          result.passed = false;
          failures.push(new Error(`Late browser errors in ${result.label}: ${result.errors.join("\n")}`));
        }
      }
    }
  } catch (error) { failures.push(error); }
  finally {
    clearTimeout(watchdog);
    await watchdogTask;
    const cleanup = async (label: string, stop: () => Promise<unknown>) => {
      try { await stop(); report.cleanup.push(`${label}: verified`); }
      catch (error) { failures.push(new Error(`${label}: ${String(error)}`)); }
    };
    await Promise.allSettled([
      ...(browser || context ? [cleanup("temporary context/browser", async () => { await context?.close(); await browser?.close(); if (browser) assert(!browser.isConnected()); })] : []),
      ...(bridge ? [cleanup("recording bridge", async () => { await bridge?.close(); })] : []),
      ...(provider ? [cleanup("local provider", async () => { await provider?.close(); })] : []),
      ...(custody ? [cleanup("authenticated daemon/record/lease", async () => { await custody?.stopAndVerify(); })] : []),
    ]);
    report.providerRequests = provider?.requests ?? [];
    if (report.providerRequests.length) failures.push(new Error("Unexpected model/provider request"));
    if (sha256(binary) !== report.sha256) failures.push(new Error("Candidate bytes changed during acceptance"));
    report.errors = failures.map((error) => error instanceof Error ? error.stack ?? error.message : String(error));
    report.passed = failures.length === 0 && report.cases.length === 2 && report.cases.every((item) => item.passed);
    writeFileSync(join(artifacts, "report.json"), JSON.stringify(report, null, 2));
    console.log(`MODERN_WEB_SMOKE ${report.passed ? "PASS" : "FAIL"}: ${join(artifacts, "report.json")}`);
  }
  if (!report.passed) throw new AggregateError(failures, `Modern web acceptance failed: ${artifacts}`);
}

if (import.meta.main) await main();
