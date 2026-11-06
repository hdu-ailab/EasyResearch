#!/usr/bin/env bun
/** Isolated real Pi JSONL -> accepted compiled HTTP/SSE -> temporary Chromium.
 * Does not build a candidate. API bodies and SSE are forwarded byte-for-byte.
 * bun scripts/smoke-session-tabs.ts [controller-built-native-executable]
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import type { Socket } from "node:net";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { chromium, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { importPi } from "../src/runtime/pi-import";
import type { SessionSnapshotDto } from "../src/web/contracts";
import { messages, type MessageKey } from "../src/webui/src/i18n/messages";
import { createSmokeDaemonCustody } from "./smoke-release-support";

type Pi = Awaited<ReturnType<typeof importPi>>;
type Labels = (key: MessageKey) => string;
type Json = <T>(path: string) => Promise<T>;
const preferenceKey = "easyresearch.webui.preferences";
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const surface = (page: Page, id?: string) => page.locator(id
  ? `[data-session-surface=${JSON.stringify(id)}]`
  : '[data-session-surface][data-session-active="true"]');
const topbar = (page: Page) => page.getByRole("banner");
const tab = (page: Page, id: string) => topbar(page).locator(`[role="tab"][data-session-tab-id=${JSON.stringify(id)}]`);
const input = (page: Page) => surface(page).locator("[data-chat-composer] textarea");
const transcript = (page: Page) => surface(page).getByTestId("transcript-viewport").locator("section[data-scrollable]");
const files = (page: Page) => surface(page).locator('[data-work-pane="files"]');
const workHash = (seed: { id: string; cwd: string }) => `#/work/${seed.id}?cwd=${encodeURIComponent(seed.cwd)}`;
const frames = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
const order = (page: Page) => topbar(page).locator("[data-session-tab-id]").evaluateAll((elements) => elements.map((element) => element.getAttribute("data-session-tab-id")));

interface Wire {
  method: string;
  path: string;
  body?: Record<string, unknown>;
  status?: number;
  live: boolean;
  complete: boolean;
  channelId?: string;
}
interface FileDelivery {
  channelId: string;
  subscriptionId: string;
  file: string;
  kind: string;
}

/** Real streaming transport recorder, also sees SharedWorker-owned requests.
 * Gates delay delivery of one real upstream response; they never replace it.
 */
async function recordingBridge(target: string) {
  const records: Wire[] = [];
  const fileDeliveries: FileDelivery[] = [];
  const observationErrors: string[] = [];
  const sockets = new Set<Socket>();
  const gates: Array<{ match(record: Wire): boolean; promise: Promise<void>; release(): void; hit: boolean }> = [];
  const hop = new Set(["connection", "keep-alive", "transfer-encoding", "proxy-connection", "upgrade"]);
  const server = createServer((incoming, outgoing) => {
    const record: Wire = { method: incoming.method ?? "GET", path: incoming.url ?? "/", live: true, complete: false };
    records.push(record);
    const gate = gates.find((gate) => !gate.hit && gate.match(record));
    if (gate) gate.hit = true;
    const upstream = httpRequest(new URL(record.path, target), { method: record.method, agent: false,
      headers: Object.fromEntries(Object.entries(incoming.headers).filter(([key]) => !hop.has(key))) });
    const chunks: Buffer[] = [];
    let bytes = 0;
    incoming.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes <= 64 * 1024) chunks.push(chunk); });
    incoming.on("end", () => {
      if (bytes && bytes <= 64 * 1024 && incoming.headers["content-type"]?.includes("application/json")) {
        try { record.body = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* Report malformed transport without changing it. */ }
      }
    });
    incoming.on("aborted", () => upstream.destroy());
    outgoing.on("close", () => { record.live = false; upstream.destroy(); });
    outgoing.on("finish", () => { record.complete = true; record.live = false; });
    upstream.on("error", () => outgoing.destroy());
    upstream.on("response", (response) => {
      record.status = response.statusCode;
      if (record.path === "/api/events") {
        const decoder = new StringDecoder("utf8");
        let pending = "";
        const observe = (chunk: Buffer) => {
          pending += decoder.write(chunk);
          let end: number;
          while ((end = pending.indexOf("\n")) !== -1) {
            const line = pending.slice(0, end);
            pending = pending.slice(end + 1);
            if (!line.startsWith("data:")) continue;
            try {
              const frame = JSON.parse(line.slice(5));
              if (frame.type === "connected" && typeof frame.id === "string") record.channelId = frame.id;
              if (frame.type === "event" && frame.event?.type === "file.watcher.updated" && record.channelId) {
                assert(typeof frame.id === "string" && typeof frame.event.properties?.file === "string");
                fileDeliveries.push({ channelId: record.channelId, subscriptionId: frame.id,
                  file: frame.event.properties.file, kind: frame.event.properties.event });
              }
            } catch (error) { observationErrors.push(`Malformed complete SSE data line: ${String(error)}`); }
          }
          if (pending.length > 2 * 1024 * 1024 || fileDeliveries.length > 10_000) {
            observationErrors.push("SSE observation exceeded its bounded acceptance budget");
            response.off("data", observe);
          }
        };
        response.on("data", observe);
      }
      response.on("error", () => outgoing.destroy());
      const forward = async () => {
        if (gate) await gate.promise;
        if (outgoing.destroyed) { response.destroy(); return; }
        const headers: string[] = [];
        for (let i = 0; i < response.rawHeaders.length; i += 2) {
          if (!hop.has(response.rawHeaders[i]!.toLowerCase())) headers.push(response.rawHeaders[i]!, response.rawHeaders[i + 1]!);
        }
        outgoing.writeHead(response.statusCode!, headers);
        outgoing.flushHeaders();
        response.pipe(outgoing);
      };
      void forward().catch(() => outgoing.destroy());
    });
    incoming.pipe(upstream);
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const address = server.address();
  assert(address && typeof address !== "string");
  let closing: Promise<void> | undefined;
  return { origin: `http://127.0.0.1:${address.port}`, records, fileDeliveries, observationErrors,
    delay(match: (record: Wire) => boolean) {
      const pending = Promise.withResolvers<void>();
      const gate = { match, promise: pending.promise, release: () => pending.resolve(), hit: false };
      gates.push(gate);
      return gate;
    },
    subscriptions() {
      const live = new Set(records.filter((record) => record.path === "/api/events" && record.live).map((record) => `/api/events/${record.channelId}`));
      const channels = new Map<string, Array<{ id: string; path: string }>>();
      for (const record of records) if (record.method === "PUT" && live.has(record.path) && record.status === 200)
        channels.set(record.path, record.body?.subscriptions as Array<{ id: string; path: string }> ?? []);
      return [...channels].flatMap(([path, subscriptions]) => subscriptions.map((item) => ({ ...item, channelId: path.slice("/api/events/".length) })));
    },
    close() {
      if (closing) return closing;
      for (const gate of gates) gate.release();
      for (const socket of sockets) socket.destroy();
      closing = new Promise<void>((done, reject) => {
        const timeout = setTimeout(() => reject(new Error("Recording bridge cleanup deadline")), 5000);
        server.close((error) => { clearTimeout(timeout); error ? reject(error) : done(); });
      });
      return closing;
    },
  };
}
type Bridge = Awaited<ReturnType<typeof recordingBridge>>;

/** No request is allowed until explicitly armed by the live-work acceptance. */
function providerFixture() {
  const pending: Array<{ marker: string; tokens: number; promise: Promise<void>; release(): void }> = [];
  const releases: Array<() => void> = [];
  const requests: Array<{ marker: string; body: string; completed: boolean; cancelled: boolean }> = [];
  const failures: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, maxRequestBodySize: 2 * 1024 * 1024,
    async fetch(request) {
      const body = await request.text();
      const gate = pending.shift();
      if (!gate || request.method !== "POST" || new URL(request.url).pathname !== "/v1/chat/completions") {
        failures.push(`Unarmed provider request: ${request.method} ${new URL(request.url).pathname}`);
        return new Response("Unarmed request", { status: 409 });
      }
      const record = { marker: gate.marker, body, completed: false, cancelled: false };
      requests.push(record);
      const chunk = (content: string, final = false) => new TextEncoder().encode(`data: ${JSON.stringify({
        id: gate.marker, object: "chat.completion.chunk", created: 1, model: "fixture",
        choices: [{ index: 0, delta: final ? {} : { role: "assistant", content }, finish_reason: final ? "stop" : null }],
        ...(final ? { usage: { prompt_tokens: gate.tokens, completion_tokens: 7, total_tokens: gate.tokens + 7 } } : {}),
      })}\n\n`);
      return new Response(new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            controller.enqueue(chunk(`${gate.marker}_START `));
            await gate.promise;
            controller.enqueue(chunk(`${gate.marker}_DONE`));
            controller.enqueue(chunk("", true));
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            controller.close();
            record.completed = true;
          } catch { record.cancelled = true; }
        },
        cancel() { record.cancelled = true; },
      }), { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  let closed = false;
  return { origin: `http://127.0.0.1:${server.port}/v1`, requests, failures,
    arm(marker: string, tokens: number) {
      const gate = Promise.withResolvers<void>();
      const release = () => gate.resolve();
      releases.push(release);
      pending.push({ marker, tokens, promise: gate.promise, release });
      return release;
    },
    async close() {
      if (closed) return;
      for (const release of releases) release();
      await server.stop(true);
      assert.equal(server.pendingRequests, 0);
      closed = true;
    },
  };
}

export function fixtures(pi: Pi, directory: string) {
  let time = Date.now() - 100_000;
  const answer = (text: string): AssistantMessage => ({ role: "assistant", content: [{ type: "text", text }],
    api: "openai-completions", provider: "session-tabs-smoke", model: "fixture", stopReason: "stop", timestamp: ++time,
    usage: { input: 17, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 24,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const sameName = "Same title · 独立研究 · " + "long research label ".repeat(8);
  const cwds = [join(directory, "workspace-alpha-研究"), join(directory, "workspace-beta-研究")];
  for (const cwd of cwds) {
    mkdirSync(join(cwd, "notes"), { recursive: true });
    writeFileSync(join(cwd, "keep.txt"), "Workspace deletion preserves this project file.\n");
    writeFileSync(join(cwd, "notes", "reference.md"), `# Reference\n\n${cwd}\n\nREFERENCE_OWNER_${cwd === cwds[0] ? "ALPHA" : "BETA"}\n`);
    writeFileSync(join(cwd, "notes", "late.txt"), "LATE_FILE_READ_COMPLETE\n");
    const name = cwd === cwds[0] ? "scope-alpha-only" : "scope-beta-only";
    const skill = join(cwd, ".easyresearch", "skills", name);
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), `---\nname: ${name}\ndescription: Exact-cwd acceptance marker\n---\nRead-only fixture; no actions.\n`);
  }
  const child = pi.SessionManager.create(cwds[0]!);
  child.appendModelChange("session-tabs-smoke", "fixture");
  child.appendThinkingLevelChange("off");
  child.appendMessage({ role: "user", content: "Read-only mapped child fixture", timestamp: ++time });
  child.appendMessage(answer("CHILD_ONLY_EVIDENCE\n\n$e^{i\\pi}+1=0$"));
  child.appendSessionInfo("easyresearch:search");
  const roots = ["A", "B", "C"].map((label, index) => {
    const cwd = cwds[index === 0 ? 0 : 1]!;
    const root = pi.SessionManager.create(cwd);
    root.appendModelChange("session-tabs-smoke", "fixture");
    root.appendThinkingLevelChange("off");
    const first = root.appendMessage({ role: "user", content: `ROOT_${label}_ONLY initial question`, timestamp: ++time });
    for (let row = 0; row < 36; row++) {
      root.appendMessage(answer(`ROOT_${label}_ONLY answer ${row}. ${"Evidence stays owned by this UUID. ".repeat(12)}`));
      root.appendMessage({ role: "user", content: `ROOT_${label}_ONLY question ${row}`, timestamp: ++time });
    }
    if (label === "A") {
      root.appendMessage({ ...answer(""), content: [{ type: "toolCall", id: "mapped-child", name: "subagent", arguments: { agent: "search", task: "Inspect fixture" } }], stopReason: "toolUse" });
      root.appendMessage({ role: "toolResult", toolCallId: "mapped-child", toolName: "subagent", isError: false,
        content: [{ type: "text", text: "search_0 is working." }], timestamp: ++time });
      root.appendCustomEntry("easyresearch:subagent_session", { toolCallId: "mapped-child", childSessionId: child.getSessionId(), agent: "search" });
    }
    const summary = root.appendCompaction(`SUMMARY_${label}_ONLY`, first, 500);
    const requestedName = label === "C" ? "Unvisited bookmark C" : sameName;
    root.appendSessionInfo(requestedName);
    const name = root.getSessionName();
    assert.equal(name, requestedName.trim(), "Fixture expectations must use Pi's normalized persisted name");
    assert(typeof name === "string");
    root.appendMessage(answer(`ROOT_${label}_TAIL\n\n[Reference](notes/reference.md) · [Late file](notes/late.txt)`));
    const path = root.getSessionFile()!;
    assert(existsSync(path));
    return { label, id: root.getSessionId(), cwd, name, path, summary,
      referenceOwner: `REFERENCE_OWNER_${index === 0 ? "ALPHA" : "BETA"}`, original: readFileSync(path) };
  });
  const childPath = child.getSessionFile()!;
  return { roots, childPath, childHash: hash(childPath) };
}
type Seed = ReturnType<typeof fixtures>["roots"][number];

/** Inspect the authoritative file through Pi's public parser and in-memory view.
 * This never opens a disk-backed writer or relies on an already-connected runtime.
 */
export function readFixtureHistory(pi: Pi, root: Pick<Seed, "id" | "cwd" | "path">) {
  const bytes = readFileSync(root.path);
  assert(bytes.length > 0 && bytes.at(-1) === 10, "Native JSONL must end with a complete record");
  const text = bytes.toString("utf8");
  const lines = text.slice(0, -1).split("\n");
  for (const line of lines) JSON.parse(line); // Reject malformed records instead of letting a tolerant parser skip them.
  const parsed = pi.parseSessionEntries(text);
  assert.equal(parsed.length, lines.length, "Pi must accept every persisted record");
  const header = parsed[0];
  assert(header?.type === "session");
  assert.equal(header.id, root.id, "The authoritative JSONL must retain the exact root UUID");
  assert.equal(header.cwd, root.cwd);
  const manager = pi.SessionManager.inMemory(root.cwd, { id: root.id }, parsed);
  const entries = manager.getEntries();
  assert.equal(entries.length, parsed.length - 1);
  const ids = new Set<string>();
  for (const entry of entries) {
    assert(!ids.has(entry.id), "Persisted entry identity must be unique");
    if (entry.parentId !== null) assert(ids.has(entry.parentId), "Persisted parent must refer to earlier history");
    ids.add(entry.id);
  }
  return { bytes, header, tail: bytes.subarray(bytes.indexOf(10) + 1), entries, branch: manager.getBranch(), name: manager.getSessionName() };
}
type NativeHistory = ReturnType<typeof readFixtureHistory>;
const textContent = (content: unknown): string => typeof content === "string" ? content : Array.isArray(content)
  ? content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("") : "";

export function verifyPersistedTurn(pi: Pi, root: Seed, turn: { prompt: string; own: string; foreign: string; tokens: number }) {
  const history = readFixtureHistory(pi, root);
  assert.deepEqual(history.bytes.subarray(0, root.original.length), root.original, "Native work must preserve every preexisting history byte");
  assert(history.bytes.length > root.original.length, "A completed native turn must append authoritative JSONL records");
  const priorIds = new Set(pi.parseSessionEntries(root.original.toString("utf8")).map((entry) => entry.id));
  const additions = history.entries.filter((entry) => !priorIds.has(entry.id));
  const users = additions.filter((entry) => entry.type === "message" && entry.message.role === "user"
    && textContent(entry.message.content) === turn.prompt);
  const answers = additions.filter((entry) => entry.type === "message" && entry.message.role === "assistant"
    && textContent(entry.message.content) === `${turn.own}_START ${turn.own}_DONE`);
  assert.equal(users.length, 1, "Exactly one new authorized user turn must be persisted");
  assert.equal(answers.length, 1, "Exactly one completed assistant response must be persisted");
  const answer = answers[0]!;
  assert(answer.type === "message" && answer.message.role === "assistant");
  assert.equal(answer.message.stopReason, "stop");
  assert.equal(answer.message.provider, "session-tabs-smoke");
  assert.equal(answer.message.model, "fixture");
  assert.equal(answer.message.usage.input, turn.tokens);
  assert.equal(answer.message.usage.output, 7);
  assert.equal(answer.message.usage.totalTokens, turn.tokens + 7);
  assert(!history.bytes.toString("utf8").includes(turn.foreign), "Another root's completion must not enter persisted history");
  const userIndex = history.branch.findIndex((entry) => entry.id === users[0]!.id);
  const answerIndex = history.branch.findIndex((entry) => entry.id === answer.id);
  assert(userIndex >= 0 && answerIndex > userIndex, "The completed turn must belong to the persisted active branch");
  return { history, evidence: { id: root.id, path: root.path, originalBytes: root.original.length, bytes: history.bytes.length,
    userEntryId: users[0]!.id, assistantEntryId: answer.id, inputTokens: answer.message.usage.input } };
}

export function verifyRelocatedHistory(before: NativeHistory, after: NativeHistory, cwd: string) {
  assert.equal(after.header.cwd, cwd);
  assert.deepEqual({ ...after.header, cwd: before.header.cwd }, before.header, "Relocation may change only cwd in the native header");
  assert.deepEqual(after.tail, before.tail, "Relocation must preserve every post-header byte, including completed work and rename records");
  assert.equal(after.name, before.name);
}
interface CaseReport {
  width: number;
  theme: string;
  language: "en" | "zh-CN";
  checks: string[];
  measurements: Record<string, unknown>;
  errors: string[];
  passed: boolean;
  failure?: string;
}

async function activate(page: Page, seed: Seed) {
  await tab(page, seed.id).click();
  await expect.poll(() => new URL(page.url()).hash).toBe(workHash(seed));
  await expect(surface(page, seed.id)).toHaveAttribute("data-session-active", "true");
}

async function pane(page: Page, t: Labels, value: "chat" | "files" | "agents") {
  if (page.viewportSize()!.width < 820) {
    await surface(page).getByRole("tab", { name: t(`work.${value}Tab`), exact: true }).click();
    return;
  }
  if (value === "chat") return;
  const button = topbar(page).getByRole("button", { name: t(value === "files" ? "work.filesBrowser" : "work.agentList"), exact: true });
  if (await button.getAttribute("aria-pressed") !== "true") await button.click();
}

async function showTree(page: Page, t: Labels) {
  await pane(page, t, "files");
  const toggle = surface(page).getByRole("button", { name: t("tabs.toggleTree"), exact: true });
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
}

async function assertReferencePreview(page: Page, own: Seed, foreign: Seed) {
  const selected = files(page).getByRole("tab", { name: "reference.md", exact: true });
  await expect(selected).toHaveAttribute("aria-selected", "true");
  await expect(selected).toHaveAttribute("title", join(own.cwd, "notes", "reference.md"));
  await expect(files(page).getByText(own.cwd, { exact: true })).toBeVisible();
  await expect(files(page).getByText(own.referenceOwner, { exact: true })).toBeVisible();
  await expect(files(page).getByText(foreign.cwd, { exact: true })).toHaveCount(0);
  await expect(files(page).getByText(foreign.referenceOwner, { exact: true })).toHaveCount(0);
}

async function home(page: Page, t: Labels) {
  // The plus is the existing Home chooser, never a model/session creation request.
  await topbar(page).getByRole("button", { name: t("sessionTabs.new"), exact: true }).click();
  await expect.poll(() => new URL(page.url()).hash).toBe("#/");
}

function homeRow(page: Page, seed: Seed) {
  return surface(page).locator(".er-session-row").filter({ has: page.locator(`.er-session-title[title=${JSON.stringify(seed.name)}]`) })
    .filter({ has: page.locator(`[title=${JSON.stringify(seed.cwd)}]`) });
}

async function openFromHome(page: Page, seed: Seed, t: Labels) {
  await home(page, t);
  await homeRow(page, seed).locator(".er-session-open").click();
  await expect.poll(() => new URL(page.url()).hash).toBe(workHash(seed));
  await expect(surface(page, seed.id)).toHaveAttribute("data-session-active", "true");
  await expect(tab(page, seed.id)).toHaveCount(1);
}

async function closeTab(page: Page, seed: Seed) {
  await tab(page, seed.id).locator("..").getByRole("button").click();
  await expect(tab(page, seed.id)).toHaveCount(0);
}

async function tooltip(page: Page, seed: Seed) {
  const button = tab(page, seed.id);
  await button.focus();
  if (page.viewportSize()!.width >= 820) await button.hover();
  const popup = page.getByRole("tooltip");
  await expect(popup.getByText(seed.name, { exact: true })).toBeVisible();
  await expect(popup.getByText(seed.cwd, { exact: true })).toBeVisible();
  const bounds = await popup.boundingBox();
  assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= page.viewportSize()!.width + 1);
  assert(await popup.evaluate((element) => !element.closest('[role="tablist"]')), "Tooltip must escape the clipped strip");
  await button.press("Escape");
}

function assertReadonly(seed: ReturnType<typeof fixtures>) {
  for (const root of seed.roots) assert.deepEqual(readFileSync(root.path), root.original, "Navigation/files/disclosures must not append or rewrite root JSONL");
  assert.equal(hash(seed.childPath), seed.childHash, "Mapped child must remain byte-identical");
}

function noAgentControls(records: Wire[]) {
  assert.deepEqual(records.filter((record) => /^\/api\/sessions\/.*\/(abort|stop|disconnect|restart)$/.test(record.path)
    || record.method === "DELETE" && /^\/api\/sessions\/[^/?]+$/.test(record.path)), [], "Closing/switching UI tabs must never own Agent control/history deletion");
}

async function scopedCommands(page: Page, own: string, foreign: string) {
  await input(page).fill("/scope-");
  const menu = surface(page).getByRole("listbox");
  await expect(menu.getByRole("option", { name: new RegExp(own) })).toBeVisible();
  await expect(menu.getByRole("option", { name: new RegExp(foreign) })).toHaveCount(0);
  await input(page).fill("");
}

async function selectedInterest(bridge: Bridge, cwd: string) {
  await expect.poll(() => bridge.records.filter((record) => /^\/api\/config\/project-watches\//.test(record.path)
    && record.method === "PUT" && record.status === 200).at(-1)?.body?.cwds).toEqual([cwd]);
  const records = bridge.records.filter((record) => /^\/api\/config\/project-watches\//.test(record.path) && record.method === "PUT");
  for (const record of records) assert((record.body?.cwds as string[] | undefined)?.length! <= 1, "App config interest must not union retained Work cwds");
}

async function stateChecks(page: Page, t: Labels, seed: ReturnType<typeof fixtures>, bridge: Bridge, result: CaseReport) {
  const [a, b, c] = seed.roots as [Seed, Seed, Seed];
  await expect(surface(page).getByText("ROOT_A_TAIL", { exact: true })).toBeVisible();
  assert.equal(bridge.records.filter((record) => record.path === "/api/sessions/open" && record.body?.path === a.path).length, 1,
    "Initial deep link must open its root exactly once");
  for (const root of [b, c]) assert(!bridge.records.some((record) => record.path.includes(root.id)
    || record.path === "/api/sessions/open" && record.body?.path === root.path), "Startup bookmarks are lazy");
  await expect(surface(page).locator("[data-work-layout]")).toHaveAttribute("data-panel-open", "false");
  await expect(topbar(page)).toHaveCount(1);
  await expect(topbar(page).getByRole("button", { name: t("home.settings"), exact: true })).toHaveCount(1);
  await tooltip(page, a);
  const baseline = bridge.records.length;
  await tab(page, a.id).focus();
  await tab(page, a.id).press("End");
  await expect(tab(page, c.id)).toBeFocused();
  assert.equal(new URL(page.url()).hash, workHash(a), "Roving focus is not activation");
  await tab(page, c.id).press("Home");
  await expect(tab(page, a.id)).toBeFocused();
  assert(!bridge.records.slice(baseline).some((record) => record.path.includes(b.id) || record.path.includes(c.id)), "Unvisited focus must not hydrate a runtime");
  const strip = topbar(page).getByRole("tablist");
  result.measurements.strip = await strip.evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }));
  if (result.width < 820) assert(await strip.evaluate((element) => element.scrollWidth > element.clientWidth), "Mobile must exercise actual strip overflow");
  result.checks.push("one shell; full name/cwd tooltip; roving Home/End focus; mobile strip overflow without activation");

  await scopedCommands(page, "scope-alpha-only", "scope-beta-only");
  await input(page).fill("Draft A @notes/");
  await surface(page).getByRole("listbox", { name: t("composer.files"), exact: true }).getByRole("option", { name: "reference.md", exact: true }).click();
  const draft = await input(page).inputValue();
  await expect(surface(page).locator("[data-composer-reference]")).toHaveAttribute("title", join(a.cwd, "notes", "reference.md"));
  const summary = transcript(page).locator(`[data-summary-kind="compaction"]`);
  await summary.getByRole("button").first().click();
  await expect(summary.getByText("SUMMARY_A_ONLY", { exact: true })).toBeVisible();
  await surface(page).getByRole("button", { name: "Reference", exact: true }).click();
  await assertReferencePreview(page, a, b);
  await showTree(page, t);
  const notes = surface(page).locator(`[role="treeitem"][title=${JSON.stringify(join(a.cwd, "notes"))}]`);
  if (await notes.getAttribute("aria-expanded") !== "true") await notes.getByRole("button").first().click();
  await expect(surface(page).getByRole("treeitem", { name: "reference.md", exact: true })).toBeVisible();
  if (result.width < 820) {
    // Mobile's explicit tree surface intentionally projects no selected file.
    // Close that surface without reselecting a tab, and establish the exact
    // preview ownership that the later root switch must retain.
    await surface(page).getByRole("button", { name: t("tabs.toggleTree"), exact: true }).click();
    await assertReferencePreview(page, a, b);
  }
  await pane(page, t, "chat");
  await transcript(page).focus();
  const scrolling = await transcript(page).evaluateHandle((element) => {
    const started = performance.now();
    const state = { ended: false, samples: [] as Array<{ type: string; ms: number; top: number }> };
    const record = (event: Event) => {
      if (state.samples.length < 80) state.samples.push({ type: event.type, ms: performance.now() - started, top: element.scrollTop });
      if (event.type === "scrollend") state.ended = true;
    };
    element.addEventListener("scroll", record);
    element.addEventListener("scrollend", record);
    return { state, dispose() { element.removeEventListener("scroll", record); element.removeEventListener("scrollend", record); } };
  });
  try {
    await transcript(page).press("PageUp");
    await frames(page);
    result.measurements.scrollEarlyCapture = await transcript(page).evaluate((element) => element.scrollTop);
    // PageUp intentionally uses native smooth scrolling. Two animation frames
    // capture an in-flight gesture, not the position a switch must preserve.
    await expect.poll(() => scrolling.evaluate((value) => value.state.ended), { timeout: 3000 }).toBe(true);
    result.measurements.scrollGesture = await scrolling.evaluate((value) => value.state.samples);
  } finally { await scrolling.evaluate((value) => value.dispose()); await scrolling.dispose(); }
  const scrolled = await transcript(page).evaluate((element) => ({ top: element.scrollTop, bottom: element.scrollHeight - element.clientHeight - element.scrollTop }));
  result.measurements.unpinnedScroll = scrolled;
  assert(scrolled.bottom > 30, "Exercise genuinely unpinned transcript scroll");
  const geometry = await surface(page, a.id).boundingBox();
  const retained = await surface(page, a.id).elementHandle();
  assert(geometry && retained);
  try {
    await activate(page, b);
    await expect(surface(page).getByText("ROOT_B_TAIL", { exact: true })).toBeVisible();
    await expect(input(page)).toHaveValue("");
    await expect(surface(page).locator("[data-composer-reference]")).toHaveCount(0);
    await expect(surface(page).locator("[data-work-layout]")).toHaveAttribute("data-panel-open", "false");
    assert.equal(await surface(page).getByText("ROOT_A_TAIL", { exact: true }).count(), 0);
    const hidden = await surface(page, a.id).evaluate((element) => ({ inert: (element as HTMLElement).inert,
      aria: element.getAttribute("aria-hidden"), visibility: getComputedStyle(element).visibility,
      width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height }));
    assert(hidden.inert && hidden.aria === "true" && hidden.visibility === "hidden");
    assert(Math.abs(hidden.width - geometry.width) < 1 && Math.abs(hidden.height - geometry.height) < 1, "Inactive view retains layout geometry");
    await scopedCommands(page, "scope-beta-only", "scope-alpha-only");
    await input(page).fill("Draft B remains independent");
    await surface(page).getByRole("button", { name: "Reference", exact: true }).click();
    await assertReferencePreview(page, b, a);
    await pane(page, t, "agents");
    await activate(page, a);
    assert(await retained.evaluate((element) => element.isConnected), "Switching must retain the exact Work DOM owner");
    await expect(input(page)).toHaveValue(draft);
    await expect(surface(page).locator("[data-composer-reference]")).toHaveAttribute("title", join(a.cwd, "notes", "reference.md"));
    result.measurements.scrollOnReturn = await transcript(page).evaluate((element) => element.scrollTop);
    await expect.poll(async () => Math.abs(await transcript(page).evaluate((element) => element.scrollTop) - scrolled.top)).toBeLessThan(2);
    await pane(page, t, "files");
    await assertReferencePreview(page, a, b);
    await pane(page, t, "chat");
    await transcript(page).press("End");
    await expect(summary.getByRole("button").first()).toHaveAttribute("aria-expanded", "true");
    await activate(page, b);
    if (result.width < 820) await expect(surface(page).getByRole("tab", { name: t("work.agentsTab"), exact: true })).toHaveAttribute("aria-selected", "true");
    else await expect(topbar(page).getByRole("button", { name: t("work.agentList"), exact: true })).toHaveAttribute("aria-pressed", "true");
    await pane(page, t, "files");
    await assertReferencePreview(page, b, a);
    await pane(page, t, "chat");
    await expect(input(page)).toHaveValue("Draft B remains independent");
  } finally { await retained.dispose(); }
  result.measurements.unpinnedScroll = scrolled;
  result.checks.push("same-title UUID isolation; retained DOM/geometry; drafts/reference ranges/file tabs/disclosures/panel choice/unpinned scroll survive switches");

  await selectedInterest(bridge, b.cwd);
  assert.equal(new Set(bridge.records.filter((record) => record.method === "PUT" && record.path.startsWith("/api/config/project-watches/")).map((record) => record.path)).size, 1,
    "A document owns one App configuration lease across retained roots");
  await expect.poll(() => bridge.subscriptions().map((item) => item.path).sort()).toEqual([
    "/api/config/events", `/api/sessions/${a.id}/events`, `/api/sessions/${b.id}/events`,
  ].sort());
  await expect.poll(() => bridge.records.some((record) => record.method === "PUT" && record.path.startsWith(`/api/sessions/${a.id}/file-watches/`)
    && record.status === 200 && (record.body?.directories as string[] | undefined)?.includes(join(a.cwd, "notes")))).toBe(true);
  const leasePaths = bridge.records.filter((record) => record.method === "PUT" && /\/file-watches\//.test(record.path)).map((record) => record.path);
  assert(leasePaths.some((path) => path.includes(a.id)) && leasePaths.some((path) => path.includes(b.id)), "Visited roots keep independent file-watch leases");
  const watchStart = bridge.records.length;
  writeFileSync(join(a.cwd, "root-inactive.txt"), "Root watcher changed while inactive\n");
  writeFileSync(join(a.cwd, "notes", "nested-inactive.txt"), "Expanded directory changed while inactive\n");
  await expect.poll(() => [...new Set(bridge.records.slice(watchStart).filter((record) => {
    const url = new URL(record.path, bridge.origin);
    return url.pathname === "/api/entries" && [a.cwd, join(a.cwd, "notes")].includes(url.searchParams.get("path") ?? "") && record.complete;
  }).map((record) => new URL(record.path, bridge.origin).searchParams.get("path")))].sort()).toEqual([a.cwd, join(a.cwd, "notes")].sort());
  // Hidden data inspection uses CSS, not accessibility queries which correctly exclude inert trees.
  await expect(surface(page, a.id).locator('[role="treeitem"]').filter({ hasText: "root-inactive.txt" })).toHaveCount(1);
  await expect(surface(page, a.id).locator('[role="treeitem"]').filter({ hasText: "nested-inactive.txt" })).toHaveCount(1);
  assert(!bridge.records.slice(watchStart).some((record) => record.path.startsWith(`/api/sessions/${a.id}/history`)),
    "Hidden layout/file invalidations must not trigger transcript pagination");
  await input(page).focus();
  await frames(page);
  await expect(input(page)).toBeFocused();
  assert.equal(new URL(page.url()).hash, workHash(b));
  await activate(page, a);
  await pane(page, t, "chat");
  await transcript(page).focus();
  await transcript(page).press("End");
  const group = transcript(page).locator(".er-chat-activity-group").filter({ hasText: "subagent" });
  await group.locator(":scope > button").click();
  const details = group.getByRole("button", { name: t("transcript.viewDetails"), exact: true });
  await expect(details).toBeAttached();
  await details.click();
  await expect(surface(page).getByText("CHILD_ONLY_EVIDENCE", { exact: true })).toBeVisible();
  await expect(input(page)).toBeDisabled();
  await activate(page, b);
  await expect(input(page)).toBeEnabled();
  await activate(page, a);
  await expect(surface(page).getByText("CHILD_ONLY_EVIDENCE", { exact: true })).toBeVisible();
  await expect(input(page)).toBeDisabled();
  await surface(page).getByTestId("agent-tab-group").getByRole("button").first().click();
  await expect(input(page)).toHaveValue(draft);
  result.checks.push("root+expanded-directory watchers update inactive data; mapped read-only inner Agent selection stays per root");

  const gate = bridge.delay((record) => {
    const url = new URL(record.path, bridge.origin);
    return url.pathname === "/api/file" && url.searchParams.get("path") === join(a.cwd, "notes", "late.txt");
  });
  try {
    await surface(page).getByRole("button", { name: "Late file", exact: true }).click();
    await expect.poll(() => gate.hit).toBe(true);
    await activate(page, b);
    await input(page).focus();
    gate.release();
    await expect.poll(() => bridge.records.some((record) => record.path.includes("late.txt") && record.complete)).toBe(true);
    await frames(page);
    await expect(input(page)).toBeFocused();
    await expect(input(page)).toHaveValue("Draft B remains independent");
    assert.equal(new URL(page.url()).hash, workHash(b));
    await pane(page, t, "files");
    await assertReferencePreview(page, b, a);
    await expect(files(page).getByText("LATE_FILE_READ_COMPLETE", { exact: true })).toHaveCount(0);
    await pane(page, t, "chat");
  } finally { gate.release(); }
  await openFromHome(page, a, t);
  await pane(page, t, "files");
  const lateTab = files(page).getByRole("tab", { name: "late.txt", exact: true });
  await expect(lateTab).toHaveAttribute("aria-selected", "true");
  await expect(lateTab).toHaveAttribute("title", join(a.cwd, "notes", "late.txt"));
  await expect(files(page).getByText("LATE_FILE_READ_COMPLETE", { exact: true })).toBeVisible();
  await expect(files(page).getByText(b.referenceOwner, { exact: true })).toHaveCount(0);
  await pane(page, t, "chat");
  await expect(input(page)).toHaveValue(draft);
  await expect(tab(page, a.id)).toHaveCount(1);
  await selectedInterest(bridge, a.cwd);
  // Use the canonical hash like an address-bar navigation while the root-owned
  // statistics modal is open. Its portal must suspend outside its selected view.
  await input(page).fill("/statistics");
  await input(page).press("Enter");
  const modal = page.getByRole("dialog", { name: t("usage.statisticsTitle"), exact: true });
  await expect(modal).toBeVisible();
  await page.evaluate((hash) => { location.hash = hash; }, workHash(b));
  await expect(surface(page, b.id)).toHaveAttribute("data-session-active", "true");
  await expect(modal).toHaveCount(0);
  await input(page).focus();
  await expect(input(page)).toBeFocused();
  await page.evaluate((hash) => { location.hash = hash; }, workHash(a));
  await expect(modal).toBeVisible();
  await modal.getByRole("button", { name: t("dialog.close"), exact: true }).click();
  await scopedCommands(page, "scope-alpha-only", "scope-beta-only");
  await input(page).fill(draft);
  await page.goBack();
  await expect.poll(() => new URL(page.url()).hash).toBe(workHash(b));
  await expect(input(page)).toHaveValue("Draft B remains independent");
  await page.goForward();
  await expect.poll(() => new URL(page.url()).hash).toBe(workHash(a));
  await expect(input(page)).toHaveValue(draft);
  noAgentControls(bridge.records);
  assertReadonly(seed);
  result.checks.push("delayed real file response cannot steal active composer focus; Home opens deduplicate; modal portals suspend/resume; hidden pagination stays idle; Back/Forward preserve state; exact-cwd Skill catalogs remain isolated");
}

async function lifecycleChecks(page: Page, context: BrowserContext, t: Labels, seed: ReturnType<typeof fixtures>,
  bridge: Bridge, json: Json, pi: Pi, provider: ReturnType<typeof providerFixture>, result: CaseReport) {
  const [a, b, c] = seed.roots as [Seed, Seed, Seed];
  // C is still an unvisited startup descriptor. Hold its actual open response.
  const gate = bridge.delay((record) => record.method === "POST" && record.path === "/api/sessions/open");
  const lateStart = bridge.records.length;
  try {
    await tab(page, c.id).click();
    await expect.poll(() => gate.hit).toBe(true);
    await expect(tab(page, c.id)).toHaveAttribute("data-loading", "true");
    await tab(page, c.id).press("Delete");
    await expect(tab(page, c.id)).toHaveCount(0);
    await expect.poll(() => new URL(page.url()).hash).toBe(workHash(b));
    gate.release();
    await expect.poll(() => bridge.records.slice(lateStart).some((record) => record.path === "/api/sessions/open" && record.status === 200 && !record.live)).toBe(true);
    await frames(page);
    await expect(tab(page, c.id)).toHaveCount(0);
    assert.equal(new URL(page.url()).hash, workHash(b));
  } finally { gate.release(); }
  await openFromHome(page, c, t);
  await activate(page, a);
  await expect.poll(() => bridge.subscriptions().map((item) => item.path).sort()).toEqual([
    "/api/config/events", ...[a, b, c].map((root) => `/api/sessions/${root.id}/events`),
  ].sort());
  const firstSubscriptions = bridge.subscriptions();
  const firstIds = new Set(firstSubscriptions.map((item) => item.id));
  assert.equal(firstIds.size, firstSubscriptions.length);
  const survivingFirst = firstSubscriptions.filter((item) => item.path !== `/api/sessions/${c.id}/events`);
  const signatures = (items: ReturnType<Bridge["subscriptions"]>) => items.map((item) => `${item.channelId}:${item.id}:${item.path}`).sort();
  const second = await context.newPage();
  try {
    await second.goto(`${bridge.origin}/${workHash(b)}`, { waitUntil: "domcontentloaded" });
    await expect(surface(second).getByText("ROOT_B_TAIL", { exact: true })).toBeVisible();
    await expect.poll(() => bridge.subscriptions().map((item) => item.path).sort()).toEqual([
      ...firstSubscriptions.map((item) => item.path), "/api/config/events", `/api/sessions/${b.id}/events`,
    ].sort());
    const bothSubscriptions = bridge.subscriptions();
    assert.equal(new Set(bothSubscriptions.map((item) => item.id)).size, bothSubscriptions.length,
      "Each document's App and root view must have independent logical subscription IDs");
    const secondSubscriptions = bothSubscriptions.filter((item) => !firstIds.has(item.id));
    assert.deepEqual(secondSubscriptions.map((item) => item.path).sort(), ["/api/config/events", `/api/sessions/${b.id}/events`].sort());
    assert.equal(new Set(bothSubscriptions.map((item) => item.channelId)).size, 1, "Both documents must subscribe on the same physical channel");
    const secondOrder = await order(second);
    assert.deepEqual(secondOrder, await order(page));
    const before = await order(page);
    const from = await tab(page, a.id).boundingBox();
    const to = await tab(page, b.id).boundingBox();
    assert(from && to);
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 6 });
    await page.mouse.up();
    await expect.poll(() => order(page)).not.toEqual(before);
    assert.equal(new URL(page.url()).hash, workHash(a));
    const unchanged = new URL(page.url()).hash;
    await tab(page, c.id).click({ button: "middle" });
    await expect(tab(page, c.id)).toHaveCount(0);
    assert.equal(new URL(page.url()).hash, unchanged, "Background middle-close cannot navigate");
    await topbar(page).getByRole("button", { name: t("home.settings"), exact: true }).click();
    const settings = page.getByRole("dialog", { name: t("settings.title"), exact: true });
    await settings.getByRole("tab", { name: t("studio.appearanceLanguage"), exact: true }).click();
    await settings.getByRole("button", { name: t("studio.dark"), exact: true }).click();
    await settings.getByRole("button", { name: t("settings.close"), exact: true }).click();
    await expect(second.locator("html")).toHaveAttribute("data-ui-theme", "dark");
    assert.deepEqual(await order(second), secondOrder, "Storage events must not live-sync another document's tab order/close");
    assert.equal(new URL(second.url()).hash, workHash(b));
    await expect.poll(() => bridge.records.filter((record) => record.path === "/api/events" && record.live).length).toBe(1);
    assert(await page.evaluate(() => typeof SharedWorker !== "undefined"));
    await expect.poll(() => signatures(bridge.subscriptions())).toEqual(signatures([...survivingFirst, ...secondSubscriptions]));

    // A fresh filesystem mutation must reach both independently leased B views
    // through their actual logical SSE deliveries, not snapshot or storage data.
    await activate(page, b);
    await pane(page, t, "files");
    await assertReferencePreview(page, b, a);
    await surface(second).getByRole("button", { name: "Reference", exact: true }).click();
    await assertReferencePreview(second, b, a);
    for (const view of [page, second]) {
      await showTree(view, t);
      const notes = surface(view).locator(`[role="treeitem"][title=${JSON.stringify(join(b.cwd, "notes"))}]`);
      if (await notes.getAttribute("aria-expanded") !== "true") await notes.getByRole("button").first().click();
    }
    await expect.poll(() => {
      const leases = new Map<string, string[]>();
      for (const record of bridge.records) if (record.method === "PUT" && record.path.startsWith(`/api/sessions/${b.id}/file-watches/`) && record.status === 200)
        leases.set(record.path, record.body?.directories as string[] ?? []);
      return [...leases.values()].filter((directories) => directories.includes(join(b.cwd, "notes"))).length;
    }).toBe(2);
    const marker = `CROSS_DOCUMENT_FILE_${randomUUID()}`;
    const reference = join(b.cwd, "notes", "reference.md");
    for (const view of [page, second]) await expect(files(view).getByText(marker, { exact: true })).toHaveCount(0);
    const deliveryStart = bridge.fileDeliveries.length;
    const wireStart = bridge.records.length;
    writeFileSync(reference, Buffer.concat([readFileSync(reference), Buffer.from(`\n${marker}\n`)]));
    for (const view of [page, second]) await expect(files(view).getByText(marker, { exact: true })).toBeVisible();
    const bSubscriptions = bothSubscriptions.filter((item) => item.path === `/api/sessions/${b.id}/events`);
    const deliveries = () => bridge.fileDeliveries.slice(deliveryStart).filter((item) => item.file === reference && item.kind === "change");
    await expect.poll(() => [...new Set(deliveries().map((item) => `${item.channelId}:${item.subscriptionId}`))].sort())
      .toEqual(bSubscriptions.map((item) => `${item.channelId}:${item.id}`).sort());
    assert(!bridge.records.slice(wireStart).some((record) => record.path.startsWith(`/api/sessions/${b.id}/snapshot`)
      || record.path.startsWith(`/api/sessions/${b.id}/history`)), "Fresh delivery cannot be credited to a snapshot/history fallback");
    assert.deepEqual(bridge.observationErrors, []);
    result.measurements.crossDocument = { order: secondOrder, route: new URL(second.url()).hash, physicalChannels: 1,
      firstSubscriptions: survivingFirst, secondSubscriptions, marker, fileDeliveries: deliveries() };
  } finally { await second.close(); }
  await expect.poll(() => signatures(bridge.subscriptions())).toEqual(signatures(survivingFirst));
  await expect.poll(() => bridge.records.filter((record) => record.path === "/api/events" && record.live).length).toBe(1);
  assertReadonly(seed);
  noAgentControls(bridge.records);
  result.checks.push("late open fenced after close; reorder/middle-close; document-local tabs with appearance sync; distinct App/B subscriptions and fresh file SSE delivery to both documents over one channel; closing document two releases only its subscriptions");

  await activate(page, a);
  await pane(page, t, "chat");
  const turns = [
    { root: a, tokens: 101, own: "STREAM_A_ONLY", foreign: "STREAM_B_ONLY", prompt: "Authorized deterministic acceptance turn A; return the fixture text only." },
    { root: b, tokens: 307, own: "STREAM_B_ONLY", foreign: "STREAM_A_ONLY", prompt: "Authorized deterministic acceptance turn B; return the fixture text only." },
  ] as const;
  const calls = provider.requests.length;
  let releaseB: (() => void) | undefined;
  const releaseA = provider.arm(turns[0].own, turns[0].tokens);
  try {
    await input(page).fill(turns[0].prompt);
    await surface(page).getByRole("button", { name: t("composer.send"), exact: true }).click();
    await expect(surface(page).getByText("STREAM_A_ONLY_START", { exact: false })).toBeVisible();
    releaseB = provider.arm(turns[1].own, turns[1].tokens);
    await activate(page, b);
    await pane(page, t, "chat");
    await input(page).fill(turns[1].prompt);
    await surface(page).getByRole("button", { name: t("composer.send"), exact: true }).click();
    await expect(surface(page).getByText("STREAM_B_ONLY_START", { exact: false })).toBeVisible();
    const closeStart = bridge.records.length;
    await closeTab(page, a);
    assert.equal(new URL(page.url()).hash, workHash(b));
    assert((await json<SessionSnapshotDto>(`/api/sessions/${a.id}/snapshot`)).session.isStreaming, "Busy root must continue after its UI closes");
    await input(page).fill("Other root is still usable");
    releaseB();
    await expect(surface(page).getByText("STREAM_B_ONLY_DONE", { exact: false })).toBeVisible();
    await expect(input(page)).toHaveValue("Other root is still usable");
    assert((await json<SessionSnapshotDto>(`/api/sessions/${a.id}/snapshot`)).session.isStreaming);
    releaseA();
    await expect.poll(async () => (await json<SessionSnapshotDto>(`/api/sessions/${a.id}/snapshot`)).session.isStreaming).toBe(false);
    noAgentControls(bridge.records.slice(closeStart));
    // A is still closed here. Completion must already exist on disk before a
    // reopening view or live snapshot can be credited with the result.
    for (const turn of turns) await expect(() => { verifyPersistedTurn(pi, turn.root, turn); }).toPass({ timeout: 12_000 });
    const persistedBeforeReopen = turns.map((turn) => verifyPersistedTurn(pi, turn.root, turn));
    await openFromHome(page, a, t);
    await expect(surface(page).getByText("STREAM_A_ONLY_DONE", { exact: false })).toBeVisible();
    await expect(surface(page).getByText("STREAM_B_ONLY_DONE", { exact: false })).toHaveCount(0);
    assert.equal(provider.requests.length, calls + 2, "Reopening completed work must not prompt again");
    const native = provider.requests.slice(calls);
    assert(native.every((request) => request.completed && !request.cancelled));
    assert(native[0]!.body.includes("ROOT_A_ONLY") && !native[0]!.body.includes("ROOT_B_ONLY"));
    assert(native[1]!.body.includes("ROOT_B_ONLY") && !native[1]!.body.includes("ROOT_A_ONLY"));
    for (const [index, turn] of turns.entries()) {
      const { root, tokens, own, foreign } = turn;
      const snapshot = await json<SessionSnapshotDto>(`/api/sessions/${root.id}/snapshot`);
      const last = snapshot.timeline.filter((entry) => entry.kind === "message" && entry.message.role === "assistant").at(-1);
      assert(last?.kind === "message" && last.message.role === "assistant");
      assert(JSON.stringify(last.message.content).includes(`${own}_DONE`) && !JSON.stringify(snapshot).includes(foreign));
      assert.equal(last.message.usage?.input, tokens, "Provider usage stays with its owning root");
      const persisted = verifyPersistedTurn(pi, root, turn);
      assert.deepEqual(persisted.history.bytes, persistedBeforeReopen[index]!.history.bytes,
        "Reopening completed work must leave its complete authoritative history unchanged");
    }
    result.measurements.persistedTurns = persistedBeforeReopen.map((item) => item.evidence);
    assert.equal(hash(seed.childPath), seed.childHash);
  } finally { releaseA(); releaseB?.(); }
  result.checks.push("two real concurrent Pi streams; busy close preserves work and peer usability; exact user/completed assistant/usage records persist before reopen; same UUID and full history remain unchanged after reopen without new model requests or cross-root content");
}

async function reloadAndMutations(page: Page, t: Labels, seed: ReturnType<typeof fixtures>, bridge: Bridge, pi: Pi, result: CaseReport) {
  const [a, b, c] = seed.roots as [Seed, Seed, Seed];
  await openFromHome(page, c, t);
  await activate(page, a);
  const start = bridge.records.length;
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(surface(page, a.id)).toHaveAttribute("data-session-active", "true");
  await expect(input(page)).toBeEnabled();
  await expect.poll(() => bridge.subscriptions().filter((item) => /\/sessions\/[^/]+\/events$/.test(item.path)).map((item) => item.path)).toEqual([`/api/sessions/${a.id}/events`]);
  for (const root of [b, c]) {
    await expect(tab(page, root.id)).toHaveCount(1);
    await expect(surface(page, root.id)).toHaveCount(0);
    assert(!bridge.records.slice(start).some((record) => record.path.includes(root.id)
      || record.path === "/api/sessions/open" && record.body?.path === root.path), "Reload must not hydrate/lease inactive bookmarks");
  }
  await selectedInterest(bridge, a.cwd);
  const bookmarks = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).sessionTabs, preferenceKey) as Array<Record<string, unknown>>;
  assert(bookmarks.length <= 32 && Buffer.byteLength(JSON.stringify(bookmarks)) <= 8192);
  assert(bookmarks.every((item) => Object.keys(item).every((key) => ["id", "cwd", "name"].includes(key))));
  await home(page, t);
  const homeStart = bridge.records.length;
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(surface(page, "home")).toHaveAttribute("data-session-active", "true");
  await expect(topbar(page).locator('[data-session-tab-id][aria-selected="true"]')).toHaveCount(0);
  assert(!bridge.records.slice(homeStart).some((record) => /\/api\/sessions\/[^/]+\/(snapshot|history|file-watches)/.test(record.path)
    || record.path === "/api/sessions/open"), "Canonical Home takes precedence over all bookmarks");
  result.checks.push("reload opens only active bookmarked runtime; other bookmarks have no transcript/view lease; canonical Home takes precedence; descriptor-only bounded persistence");

  const homeBefore = new URL(page.url()).hash;
  const beforeRename = readFixtureHistory(pi, c);
  assert.deepEqual(beforeRename.bytes, c.original);
  await homeRow(page, c).getByRole("button", { name: `${t("home.rename")}: ${c.name}`, exact: true }).click();
  const rename = page.getByRole("dialog", { name: t("home.renameDialogTitle"), exact: true });
  c.name = "Renamed unvisited bookmark C";
  await rename.getByRole("textbox").fill(c.name);
  await rename.getByRole("button", { name: t("home.renameDialogSave"), exact: true }).click();
  await expect(tab(page, c.id)).toHaveAttribute("aria-label", c.name);
  await expect(() => {
    const renamed = readFixtureHistory(pi, c);
    assert.deepEqual(renamed.bytes.subarray(0, beforeRename.bytes.length), beforeRename.bytes, "Rename must append, never rewrite existing history");
    const appended = renamed.entries.slice(beforeRename.entries.length);
    assert.equal(appended.length, 1, "An explicit rename appends one native session-info record");
    assert(appended[0]?.type === "session_info");
    assert.equal(appended[0].name, c.name);
    assert.equal(renamed.name, c.name, "The native reader must resolve the renamed session from disk");
  }).toPass({ timeout: 12_000 });
  assert.equal(new URL(page.url()).hash, homeBefore);
  await expect(surface(page, c.id)).toHaveCount(0);
  await tooltip(page, c);

  // Missing-folder recovery is intentionally invoked through Home's real rename
  // flow, which retains the existing backend confirmation/relocation contract.
  const oldCwd = b.cwd;
  const moved = `${oldCwd}-relocated`;
  renameSync(oldCwd, moved);
  if (result.width < 820) await surface(page).getByRole("combobox", { name: t("home.projects"), exact: true }).selectOption(oldCwd);
  await surface(page).getByLabel(`${t("workspace.actions")}: ${oldCwd}`, { exact: true }).click();
  await page.getByRole("button", { name: t("workspace.rename"), exact: true }).click();
  const workspaceRename = page.getByRole("dialog", { name: t("workspace.rename"), exact: true });
  await workspaceRename.getByRole("textbox").fill("requested-name-after-external-move");
  await workspaceRename.getByRole("button", { name: t("workspace.rename"), exact: true }).click();
  const recovery = page.getByRole("dialog", { name: t("workspace.missing"), exact: true });
  await expect(recovery).toBeVisible();
  await recovery.getByRole("button", { name: t("workspace.chooseFolder"), exact: true }).click();
  const picker = page.getByRole("dialog", { name: t("workspace.chooseFolder"), exact: true });
  await picker.getByRole("combobox").fill(moved);
  await picker.getByRole("combobox").press("Enter");
  // Capture the final authoritative tails immediately before authorizing rebind,
  // including B's completed turn and C's just-persisted rename.
  const beforeRelocation = new Map([b, c].map((root) => [root.id, readFixtureHistory(pi, root)]));
  for (const root of [b, c]) assert.deepEqual(beforeRelocation.get(root.id)!.bytes.subarray(0, root.original.length), root.original);
  const unrelatedRoot = readFixtureHistory(pi, a).bytes;
  const unrelatedChild = readFileSync(seed.childPath);
  await picker.getByRole("button", { name: t("workspace.migrate"), exact: true }).click();
  await expect(recovery).toHaveCount(0);
  for (const root of [b, c]) {
    root.cwd = moved;
    await tooltip(page, root);
    await expect(surface(page, root.id)).toHaveCount(0);
    const relocated = readFixtureHistory(pi, root);
    verifyRelocatedHistory(beforeRelocation.get(root.id)!, relocated, moved);
    const originalTail = root.original.subarray(root.original.indexOf(10) + 1);
    assert.deepEqual(relocated.tail.subarray(0, originalTail.length), originalTail, "All preexisting history must survive the header-only relocation");
  }
  assert.deepEqual(readFileSync(a.path), unrelatedRoot, "Relocating another workspace must preserve A's complete root history");
  assert.deepEqual(readFileSync(seed.childPath), unrelatedChild);
  assert.equal(new URL(page.url()).hash, homeBefore, "Background workspace recovery cannot select a bookmarked root");
  await surface(page).getByLabel(`${t("workspace.actions")}: ${moved}`, { exact: true }).click();
  await page.getByRole("button", { name: t("workspace.delete"), exact: true }).click();
  const deletion = page.getByRole("dialog", { name: t("workspace.delete"), exact: true });
  await expect(deletion).toContainText(t("workspace.deleteDescription"));
  await deletion.getByRole("button", { name: t("workspace.delete"), exact: true }).click();
  await expect(deletion).toHaveCount(0);
  for (const root of [b, c]) { await expect(tab(page, root.id)).toHaveCount(0); assert(!existsSync(root.path)); }
  assert.equal(readFileSync(join(moved, "keep.txt"), "utf8"), "Workspace deletion preserves this project file.\n");
  assert.deepEqual(readFileSync(a.path), unrelatedRoot, "Deleting B/C must preserve A's complete root history, including its completed work");
  assert.deepEqual(readFileSync(seed.childPath), unrelatedChild);
  assert.equal(hash(seed.childPath), seed.childHash);
  assert.equal(new URL(page.url()).hash, homeBefore);
  await activate(page, a);
  await closeTab(page, a);
  await expect.poll(() => new URL(page.url()).hash).toBe("#/");
  assert.deepEqual(readFileSync(a.path), unrelatedRoot, "Final view close must also preserve all of A's history");
  result.measurements.historyMutations = { renamedId: c.id, relocated: [...beforeRelocation].map(([id, value]) => ({ id, postHeaderBytes: value.tail.length })),
    preservedRootId: a.id, preservedRootBytes: unrelatedRoot.length, preservedChildBytes: unrelatedChild.length };
  result.checks.push("Home rename persists native session-info; relocation changes only cwd/header and preserves exact post-header bytes; history-only deletion updates unvisited bookmarks and preserves all unrelated root/child history; final close returns Home");
}

async function main() {
  assert(process.argv.length <= 3, "Usage: bun scripts/smoke-session-tabs.ts [compiled-binary]");
  const binary = resolve(process.argv[2] ?? "release/easyresearch-linux-x64/bin/easyresearch");
  assert(existsSync(binary), `Wait for the controller's compiled candidate: ${binary}`);
  const chromiumPath = process.env.COMPARE_CHROMIUM_PATH;
  if (chromiumPath) assert(existsSync(chromiumPath));
  const artifacts = realpathSync(mkdtempSync("/tmp/opencode/easyresearch-session-tabs-"));
  const homeDir = join(artifacts, "home");
  const agentDir = join(artifacts, "agent");
  const emptyPath = join(artifacts, "empty-path");
  const temporary = join(artifacts, "tmp");
  for (const path of [homeDir, agentDir, emptyPath, temporary]) mkdirSync(path, { recursive: true });
  const env = { HOME: homeDir, USERPROFILE: homeDir, EASYRESEARCH_CODING_AGENT_DIR: agentDir, PATH: emptyPath,
    XDG_CONFIG_HOME: join(homeDir, ".config"), XDG_CACHE_HOME: join(homeDir, ".cache"), XDG_DATA_HOME: join(homeDir, ".local/share"),
    TMPDIR: temporary, NO_PROXY: "localhost,127.0.0.1,::1", LANG: "C.UTF-8", PI_OFFLINE: "1" };
  Object.assign(process.env, env);
  for (const key of ["EASYRESEARCH_BUNDLED_ROOT", "EASYRESEARCH_SKIP_SETUP", "EASYRESEARCH_VENV", "PI_PACKAGE_DIR"]) delete process.env[key];
  const report = { binary, sha256: hash(binary), artifacts, cases: [] as CaseReport[], cleanup: [] as string[], errors: [] as string[], passed: false };
  const failures: unknown[] = [];
  let browser: Browser | undefined;
  let bridge: Bridge | undefined;
  let provider: ReturnType<typeof providerFixture> | undefined;
  let custody: ReturnType<typeof createSmokeDaemonCustody> | undefined;
  let watchdogTask: Promise<unknown> | undefined;
  const watchdog = setTimeout(() => {
    failures.push(new Error("Session tabs browser acceptance exceeded its ten-minute deadline"));
    watchdogTask = Promise.allSettled([browser?.close(), bridge?.close(), provider?.close(), custody?.stopAndVerify()]);
  }, 10 * 60_000);
  console.log(`SESSION_TABS_SMOKE artifacts: ${artifacts}`);
  try {
    provider = providerFixture();
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { "session-tabs-smoke": {
      baseUrl: provider.origin, api: "openai-completions", apiKey: "isolated-fixture",
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
      models: [{ id: "fixture", name: "Session tabs acceptance", contextWindow: 1_000_000, maxTokens: 2048 }],
    } } }));
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "session-tabs-smoke", defaultModel: "fixture",
      compaction: { enabled: false }, retry: { enabled: false }, easyresearch: { web: { sessionIdleTimeoutMs: -1 },
        agentDefaults: { "research-assistant": { model: "session-tabs-smoke/fixture", thinking: "off" } } } }));
    const { importPi } = await import("../src/runtime/pi-import");
    const pi = await importPi();
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = probe.port!;
    await probe.stop(true);
    const origin = `http://127.0.0.1:${port}`;
    custody = createSmokeDaemonCustody({ agentDir, host: "127.0.0.1", port });
    const launcher = Bun.spawn([binary, "--no-open", "--port", String(port)], { cwd: homeDir, env, stdin: "ignore",
      stdout: Bun.file(join(artifacts, "startup.stdout")), stderr: Bun.file(join(artifacts, "startup.stderr")) });
    const launchTimeout = setTimeout(() => launcher.kill("SIGKILL"), 90_000);
    try { assert.equal(await launcher.exited, 0, `Compiled startup failed: ${artifacts}`); }
    finally { clearTimeout(launchTimeout); }
    assert(await custody.capture(), "Authenticate exact isolated daemon before browser access");
    const json: Json = async <T>(path: string) => {
      const response = await fetch(`${origin}${path}`, { proxy: "", signal: AbortSignal.timeout(15_000) });
      assert.equal(response.status, 200, path);
      return await response.json() as T;
    };
    assert.equal((await json<{ agentDir: string }>("/api/status")).agentDir, agentDir);
    browser = await chromium.launch({ ...(chromiumPath ? { executablePath: chromiumPath } : { channel: "chrome" }), env,
      headless: true, timeout: 30_000, args: ["--no-proxy-server"] });
    for (const [width, theme, language] of [[1440, "light", "en"], [1440, "dark", "zh-CN"], [390, "light", "zh-CN"], [390, "dark", "en"]] as const) {
      const label = `${width}-${theme}`;
      const result: CaseReport = { width, theme, language, checks: [], measurements: {}, errors: [], passed: false };
      report.cases.push(result);
      const seed = fixtures(pi, join(artifacts, label));
      const t: Labels = (key) => {
        const value = (messages[language] as Record<string, string>)[key];
        assert(value, `Missing integrated i18n key: ${key}`);
        return value;
      };
      bridge = await recordingBridge(origin);
      const context: BrowserContext = await browser.newContext({ viewport: { width, height: width < 820 ? 844 : 900 }, locale: language,
        colorScheme: theme, reducedMotion: "reduce", hasTouch: width < 820 });
      await context.addInitScript(({ key, language, theme, tabs, origin }) => {
        // Context init scripts also run on a newly created opaque about:blank
        // document. Only initialize this test's actual application origin.
        if (location.origin !== origin) return;
        if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ language, studioTheme: theme, sessionTabs: tabs }));
      }, { key: preferenceKey, language, theme, tabs: seed.roots.map(({ id, cwd, name }) => ({ id, cwd, name })), origin: bridge.origin });
      const page: Page = await context.newPage();
      context.on("page", (page) => page.on("pageerror", (error) => result.errors.push(error.message)));
      page.on("pageerror", (error) => result.errors.push(error.message));
      page.setDefaultTimeout(12_000);
      page.setDefaultNavigationTimeout(25_000);
      const before: number = provider.requests.length;
      try {
        await page.goto(`${bridge.origin}/${workHash(seed.roots[0]!)}`, { waitUntil: "domcontentloaded" });
        await expect(page.locator("html")).toHaveAttribute("data-ui-theme", theme);
        await stateChecks(page, t, seed, bridge, result);
        assert.equal(provider.requests.length, before, "Read-only interactions must never call a model");
        await page.screenshot({ path: join(artifacts, `retained-${label}.png`) });
        if (width === 1440 && theme === "light") {
          await lifecycleChecks(page, context, t, seed, bridge, json, pi, provider, result);
          await reloadAndMutations(page, t, seed, bridge, pi, result);
        } else {
          const [a, b, c] = seed.roots as [Seed, Seed, Seed];
          await closeTab(page, c); // Background close leaves A selected.
          assert.equal(new URL(page.url()).hash, workHash(a));
          await closeTab(page, a); // Active close chooses right neighbor B.
          await expect.poll(() => new URL(page.url()).hash).toBe(workHash(b));
          await closeTab(page, b);
          await expect.poll(() => new URL(page.url()).hash).toBe("#/");
          noAgentControls(bridge.records);
          assertReadonly(seed);
          assert.equal(provider.requests.length, before);
          result.checks.push("background close preserves hash; active close selects right neighbor then Home; no model/Agent/history mutation");
        }
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        assert.deepEqual(result.errors, []);
        assert.deepEqual(bridge.observationErrors, []);
        await page.screenshot({ path: join(artifacts, `complete-${label}.png`) });
        result.passed = true;
      } catch (error) {
        result.failure = String(error);
        failures.push(error);
        await page.screenshot({ path: join(artifacts, `failure-${label}.png`), timeout: 5000 }).catch(() => {});
        await page.locator("body").ariaSnapshot({ timeout: 5000 }).then((value) => writeFileSync(join(artifacts, `failure-${label}.yml`), value)).catch(() => {});
      } finally {
        writeFileSync(join(artifacts, `wire-${label}.json`), JSON.stringify(bridge.records, null, 2));
        writeFileSync(join(artifacts, `file-deliveries-${label}.json`), JSON.stringify({ deliveries: bridge.fileDeliveries, errors: bridge.observationErrors }, null, 2));
        await context.close();
        await bridge.close();
        bridge = undefined;
      }
    }
    assert.deepEqual(provider.failures, []);
  } catch (error) { failures.push(error); }
  finally {
    clearTimeout(watchdog);
    await watchdogTask;
    const cleanup = async (label: string, stop: () => Promise<unknown>) => {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try { await stop(); report.cleanup.push(`${label}: verified`); return; }
        catch (error) { if (attempt === 2) failures.push(error); }
      }
    };
    await Promise.allSettled([
      cleanup("browser", async () => { await browser?.close(); if (browser) assert(!browser.isConnected()); }),
      cleanup("streaming bridge", async () => { await bridge?.close(); }),
      cleanup("provider", async () => { await provider?.close(); }),
      cleanup("owned daemon/record/lease", async () => { await custody?.stopAndVerify(); }),
    ]);
    report.errors = failures.map(String);
    report.passed = failures.length === 0 && report.cases.length === 4 && report.cases.every((item) => item.passed);
    writeFileSync(join(artifacts, "report.json"), JSON.stringify(report, null, 2));
    console.log(`SESSION_TABS_SMOKE ${report.passed ? "PASS" : "FAIL"}: ${join(artifacts, "report.json")}`);
  }
  if (failures.length) throw new AggregateError(failures, `Session tabs acceptance failed: ${artifacts}`);
}

if (import.meta.main) await main();
