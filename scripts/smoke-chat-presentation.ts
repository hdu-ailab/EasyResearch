#!/usr/bin/env bun
/** Real Pi JSONL -> compiled HTTP/SSE -> temporary Chromium. Never builds the candidate. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { importPi } from "../src/runtime/pi-import";
import type { SessionSnapshotDto, SkillCommandDto, TranscriptPageDto, TranscriptTimelineEntryDto } from "../src/web/contracts";
import { messages, type MessageKey } from "../src/webui/src/i18n/messages";
import { createSmokeDaemonCustody } from "./smoke-release-support";

type Pi = Awaited<ReturnType<typeof importPi>>;
type Manager = ReturnType<Pi["SessionManager"]["create"]>;
type Json = <T>(path: string, body?: unknown) => Promise<T>;
type Category = "shell" | "edit" | "thinking" | "subagents" | "notices" | "tools";
const categories: Category[] = ["shell", "edit", "thinking", "subagents", "notices", "tools"];
const preferenceKey = "easyresearch.webui.preferences";
const KEEP_RECENT_TOKENS = 24; // Keeps the complete final user/assistant turn; verified by the native cut probe below.
const math = "Inline $a^2+b^2=c^2$.\n\n$$\n\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\n$$";
const oversizedSummary = `# Full summary\n\n${"Bounded synthetic evidence, 中文 and **Markdown**. ".repeat(3400)}\n\n**FULL_SUMMARY_END**\n\n${math}`;
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
let timestamp = Date.now() - 60_000;
const assistant = (content: AssistantMessage["content"]): AssistantMessage => ({ role: "assistant", content,
  api: "openai-completions", provider: "chat-smoke", model: "fixture", usage, stopReason: "stop", timestamp: ++timestamp });

export function fixture(pi: Pi, root: string, label: string) {
  const cwd = join(root, `project-${label}`);
  const skill = join(cwd, ".easyresearch", "skills", "chat-smoke-skill", "SKILL.md");
  mkdirSync(join(cwd, ".easyresearch", "skills", "chat-smoke-skill"), { recursive: true });
  mkdirSync(join(cwd, "notes"), { recursive: true });
  const selectedFile = join(cwd, "notes", "研究 100% +.md");
  const droppedFile = join(cwd, "compact"); // Slash-prefixed absolute path must remain a file, never /compact.
  writeFileSync(skill, "---\nname: chat-smoke-skill\ndescription: Isolated browser acceptance skill\n---\nUse only the supplied fixture.\n");
  writeFileSync(selectedFile, "# File reference fixture\n");
  writeFileSync(droppedFile, "Exact dropped file reference\n");
  const tool = (manager: Manager, id: string, name: string, args: Record<string, unknown>, text: string, isError = false) => {
    manager.appendMessage({ ...assistant([{ type: "toolCall", id, name, arguments: args }]), stopReason: "toolUse" });
    manager.appendMessage({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError, timestamp: ++timestamp });
  };
  const child = pi.SessionManager.create(cwd);
  child.appendModelChange("chat-smoke", "fixture");
  child.appendThinkingLevelChange("off");
  const childFirst = child.appendMessage({ role: "user", content: "Inspect the isolated evidence.", timestamp: ++timestamp });
  tool(child, "child-read", "read", { path: selectedFile }, "CHILD_READ_OUTPUT");
  const childSummary = child.appendCompaction("## Child summary\n\nCHILD_SUMMARY\n\n" + math, childFirst, 1234);
  child.appendMessage(assistant([{ type: "text", text: "CHILD_PRESENTATION_TAIL\n\n" + math }]));
  child.appendSessionInfo("easyresearch:search");

  const parent = pi.SessionManager.create(cwd);
  parent.appendModelChange("chat-smoke", "fixture");
  parent.appendThinkingLevelChange("off");
  const anchors = {} as Record<Category, string>;
  const anchor = (category: Category) => { anchors[category] = parent.appendMessage(assistant([{ type: "text", text: `CATEGORY_BOUNDARY_${category}` }])); };
  const first = parent.appendMessage({ role: "user", content: `Review chat presentation ${label}.`, timestamp: ++timestamp });
  // Enough ordinary rows to evict the activity disclosures from the virtual range,
  // while the entire synthetic history remains far below the transport budget.
  for (let index = 0; index < 44; index++) {
    parent.appendMessage(assistant([{ type: "text", text: `Earlier answer ${index}. ` + "Evidence remains available through real history pages. ".repeat(8) }]));
    parent.appendMessage({ role: "user", content: `Earlier question ${index}`, timestamp: ++timestamp });
  }
  anchors.thinking = parent.appendMessage(assistant([{ type: "thinking", thinking: "THINKING_PROOF: compare source evidence before answering." },
    { type: "text", text: "ANSWER_SURVIVES_HIDDEN_THINKING" }]));
  tool(parent, "smoke-bash", "bash", { command: "printf shell-proof" }, "BASH_OUTPUT_PROOF");
  tool(parent, "smoke-powershell", "powershell", { command: "Write-Output shell-proof" }, "POWERSHELL_OUTPUT_PROOF");
  tool(parent, "smoke-ssh", "ssh-bash", { operation: "run", command: "printf remote-proof" }, "SSH_OUTPUT_PROOF");
  anchor("shell");
  tool(parent, "smoke-edit", "edit", { path: selectedFile, oldText: "old", newText: "new" }, "EDIT_OUTPUT_PROOF");
  tool(parent, "smoke-write", "write", { path: "notes/output.md", content: "Fixture output" }, "WRITE_OUTPUT_PROOF");
  anchor("edit");
  tool(parent, "smoke-read", "read", { path: selectedFile }, "READ_OUTPUT_PROOF");
  tool(parent, "smoke-skill", "read", { path: skill }, "SKILL_READ_PROOF");
  tool(parent, "smoke-search", "web-search", { query: "fixture evidence", engines: ["bing"] }, "SEARCH_OUTPUT_PROOF");
  anchor("tools");
  tool(parent, "smoke-child", "subagent", { agent: "search", task: "Inspect fixture evidence" }, "search_0 is working.");
  parent.appendCustomEntry("easyresearch:subagent_session", { toolCallId: "smoke-child", childSessionId: child.getSessionId(), agent: "search" });
  anchor("subagents");
  parent.appendCustomMessageEntry("chat-smoke-notice", "NOTICE_OUTPUT_PROOF", true);
  anchor("notices");
  tool(parent, "smoke-failed-write", "write", { path: "notes/denied.md", content: "fixture" }, "WRITE_FAILURE_PROOF: permission denied", true);
  parent.appendMessage({ ...assistant([{ type: "text", text: "Partial answer retained." }]), stopReason: "error", errorMessage: "PROVIDER_ERROR_PROOF" });
  const compact = parent.appendCompaction("## Stored summary\n\nSTORED_SUMMARY_PROOF\n\n" + math, first, 4321);
  const branch = parent.branchWithSummary(parent.getLeafId(), "## Branch summary\n\nBRANCH_SUMMARY_PROOF");
  const oversized = parent.appendCompaction(oversizedSummary, first, 5432);
  // Metadata immediately before the later live user would be pulled across Pi's
  // cut and turn it into a split-turn summary. Leave an ordinary answer last.
  parent.appendSessionInfo(`Chat presentation ${label}`);
  parent.appendMessage(assistant([{ type: "text", text: "## Presentation ready\n\nROOT_PRESENTATION_TAIL\n\n" + math
    + "\n\n`pdflatex manuscript/main.tex` · `/skill:paper-search` · `notes/研究 100% +.md`" }]));
  const path = parent.getSessionFile()!;
  const childPath = child.getSessionFile()!;
  assert(existsSync(path) && existsSync(childPath), "Public Pi API must materialize both histories");
  assert(statSync(path).size < 1024 * 1024, "Keep browser acceptance fixtures bounded");
  return { cwd, path, id: parent.getSessionId(), childId: child.getSessionId(), childPath, childHash: sha256(childPath),
    compact, branch, oversized, childSummary, selectedFile, droppedFile, anchors, originalRoot: readFileSync(path) };
}

/** Public Pi cut-point API; replay the exact fixture and prospective live turn in memory only. */
export function verifySingleRequestCut(pi: Pi, seed: ReturnType<typeof fixture>, prompt: string) {
  const memory = pi.SessionManager.inMemory(seed.cwd, { id: seed.id }, pi.parseSessionEntries(readFileSync(seed.path, "utf8")));
  const userId = memory.appendMessage({ role: "user", content: prompt, timestamp: ++timestamp });
  memory.appendMessage(assistant([{ type: "text", text: "LIVE_CHAT_START LIVE_CHAT_FINISHED" }]));
  const branch = memory.getBranch();
  const last = branch.findLast((entry) => entry.type === "compaction");
  assert(last?.type === "compaction");
  const boundary = branch.findIndex((entry) => entry.id === last.firstKeptEntryId);
  const cut = pi.findCutPoint(branch, boundary, branch.length, KEEP_RECENT_TOKENS);
  assert(!cut.isSplitTurn, "Browser fixture must not silently require a second prefix-summary provider request");
  assert.equal(branch[cut.firstKeptEntryIndex]?.id, userId, "Keep the complete live turn at a native user boundary");
  assert(cut.firstKeptEntryIndex > boundary, "The cut must leave actual prior history to summarize");
  return { keepRecentTokens: KEEP_RECENT_TOKENS, ...cut, firstKeptRole: "user", expectedProviderRequests: 1 };
}

function verifyRootBytes(pi: Pi, seed: ReturnType<typeof fixture>, allowAppend = false) {
  const current = readFileSync(seed.path);
  assert.deepEqual(current.subarray(0, seed.originalRoot.length), seed.originalRoot, "Original root JSONL bytes were rewritten or truncated");
  if (!allowAppend) {
    assert.equal(current.length, seed.originalRoot.length, "Read-only history/settings/composer UI appended root records");
    return { originalBytes: current.length, appendedRecords: 0 };
  }
  const suffix = current.subarray(seed.originalRoot.length).toString("utf8");
  assert(suffix.endsWith("\n"), "Native work left an incomplete JSONL append");
  const before = pi.parseSessionEntries(seed.originalRoot.toString("utf8"));
  const additions = suffix.trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  const parsed = pi.parseSessionEntries(current.toString("utf8"));
  assert.equal(parsed.length, before.length + additions.length, "Pi rejected an appended JSONL record");
  const ids = new Set(before.map((entry) => entry.id));
  for (const entry of additions) {
    assert(typeof entry.id === "string" && !ids.has(entry.id), "Appended record replaced an existing identity");
    assert(typeof entry.parentId === "string" && ids.has(entry.parentId), "Appended record lost its existing parent");
    assert(typeof entry.timestamp === "string" && Number.isFinite(Date.parse(entry.timestamp)));
    assert(entry.type === "message" || entry.type === "compaction", "This text-only native run may append messages and compaction only");
    if (entry.type === "compaction") {
      assert(typeof entry.summary === "string" && typeof entry.firstKeptEntryId === "string" && ids.has(entry.firstKeptEntryId));
      assert(typeof entry.tokensBefore === "number" && Number.isFinite(entry.tokensBefore) && entry.tokensBefore >= 0);
    } else {
      const message = entry.message as { role?: string; content?: unknown; timestamp?: number } | undefined;
      assert(message && (message.role === "user" || message.role === "assistant"));
      assert(typeof message.timestamp === "number" && Number.isFinite(message.timestamp));
      assert(typeof message.content === "string" || Array.isArray(message.content) && message.content.every((part: unknown) =>
        part !== null && typeof part === "object" && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string"));
    }
    ids.add(entry.id);
  }
  assert(additions.some((entry) => entry.type === "compaction"), "Native compaction did not append its persisted record");
  return { originalBytes: seed.originalRoot.length, appendedRecords: additions.length, appendedBytes: Buffer.byteLength(suffix) };
}

/** Only explicitly armed requests are accepted. No public model, credentials or tool execution. */
function fakeProvider() {
  const pending: Array<{ kind: "live" | "compact"; promise: Promise<void>; release(): void }> = [];
  const releases: Array<() => void> = [];
  const requests: Array<{ kind: string; path: string }> = [];
  const failures: string[] = [];
  let closed = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, maxRequestBodySize: 2 * 1024 * 1024,
    async fetch(request) {
      await request.arrayBuffer();
      const gate = pending.shift();
      const path = new URL(request.url).pathname;
      requests.push({ kind: gate?.kind ?? "unexpected", path });
      if (!gate || request.method !== "POST" || path !== "/v1/chat/completions") {
        failures.push(`Unexpected provider request: ${request.method} ${path}`);
        return new Response("No request armed", { status: 409 });
      }
      const chunk = (delta: unknown, finish: string | null = null) => new TextEncoder().encode(`data: ${JSON.stringify({
        id: `chat-smoke-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "fixture",
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`);
      return new Response(new ReadableStream<Uint8Array>({ async start(controller) {
        try {
          controller.enqueue(chunk({ role: "assistant", ...(gate.kind === "live" ? { content: "LIVE_CHAT_START " } : {}) }));
          await gate.promise;
          controller.enqueue(chunk({ content: gate.kind === "live" ? "LIVE_CHAT_FINISHED" : "## Native summary\n\nNATIVE_COMPACTION_PROOF\n\n" + math }));
          controller.enqueue(chunk({}, "stop"));
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
        } catch { /* Browser/daemon cleanup may cancel this owned response. */ }
      } }), { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  return { origin: `http://127.0.0.1:${server.port}/v1`, requests, failures,
    arm(kind: "live" | "compact") {
      const gate = Promise.withResolvers<void>();
      const release = () => gate.resolve();
      pending.push({ kind, promise: gate.promise, release });
      releases.push(release);
      return release;
    },
    async close() {
      if (closed) return;
      for (const release of releases) release();
      await server.stop(true);
      assert.equal(server.pendingRequests, 0, "Fake provider still owns requests after shutdown");
      closed = true;
    },
  };
}

async function verifyHistory(json: Json, seed: ReturnType<typeof fixture>) {
  await json("/api/sessions/open", { path: seed.path });
  const snapshot = await json<SessionSnapshotDto>(`/api/sessions/${seed.id}/snapshot`);
  const entries = [...snapshot.timeline];
  let cursor = snapshot.history?.cursor;
  let pages = 1;
  while (cursor) {
    assert(pages++ < 8, "History pagination must terminate for a bounded fixture");
    const page = await json<TranscriptPageDto>(`/api/sessions/${seed.id}/history?cursor=${encodeURIComponent(cursor)}`);
    entries.unshift(...page.timeline);
    cursor = page.history?.cursor;
  }
  assert.equal(new Set(entries.map((entry) => entry.entryId)).size, entries.length, "HTTP pages must retain unique persisted identities");
  for (const id of [seed.compact, seed.branch, seed.oversized]) assert(entries.some((entry) => entry.entryId === id));
  assert(entries.find((entry) => entry.entryId === seed.oversized)?.deferred, "Oversized summary must use a bounded preview");
  const full = await json<TranscriptTimelineEntryDto>(`/api/sessions/${seed.id}/history/${seed.oversized}`);
  assert(full.kind === "compaction");
  assert.equal(full.summary, oversizedSummary, "Explicit full summary HTTP must be byte-exact");
  const child = await json<SessionSnapshotDto>(`/api/sessions/${seed.id}/subagents/${seed.childId}/snapshot`);
  assert(child.timeline.some((entry) => entry.entryId === seed.childSummary && entry.kind === "compaction"));
  const commands = await json<{ commands: SkillCommandDto[] }>(`/api/sessions/${seed.id}/commands`);
  assert(commands.commands.some((command) => command.name === "chat-smoke-skill" && command.source === "skill"));
  assert(commands.commands.some((command) => command.name === "statistics" && command.source !== "skill"));
  assert.equal(sha256(seed.childPath), seed.childHash, "HTTP history inspection mutated the read-only child");
  return { pages, entries: entries.length, initialBytes: Buffer.byteLength(JSON.stringify(snapshot)), oversizedBytes: Buffer.byteLength(oversizedSummary) };
}

// Browser checks below intentionally use production accessibility/data contracts;
// API and SSE responses are never mocked or replaced.
type Labels = (key: MessageKey) => string;
interface CaseReport {
  width: number;
  theme: string;
  language: "en" | "zh-CN";
  markdown: "worker" | "fallback";
  checks: string[];
  pageErrors: string[];
  consoleErrors: string[];
  workers: string[];
  measurements: Record<string, unknown>;
  passed: boolean;
  error?: string;
}
const work = (page: Page) => page.locator('[data-session-surface][data-session-active="true"]');
const conversation = (page: Page) => work(page).getByTestId("transcript-viewport").locator("section[data-scrollable]");
const composer = (page: Page) => work(page).locator("[data-chat-composer] textarea");
const row = (page: Page, key: string) => conversation(page).locator(`[data-row-key=${JSON.stringify(key)}]`);
const settingsControl = (page: Page) => page.locator('[data-component="timeline-detail-control"]');
const frames = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

async function reveal(page: Page, target: Locator) {
  const viewport = conversation(page);
  if (await target.count()) { await target.first().scrollIntoViewIfNeeded(); return; }
  // Real scroll gestures acquire the existing transcript's scroll ownership.
  await viewport.focus();
  await viewport.press("Home");
  await frames(page);
  for (let step = 0; step < 100; step++) {
    if (await target.count()) { await target.first().scrollIntoViewIfNeeded(); return; }
    const moved = await viewport.evaluate((element) => {
      const before = element.scrollTop;
      element.scrollTop += Math.max(160, element.clientHeight * 0.7);
      return element.scrollTop > before;
    });
    await frames(page);
    if (!moved) break;
  }
  await expect(target.first(), "Expected fixture row was not found in the bounded transcript").toBeVisible();
}

async function openChildDetails(page: Page, t: Labels, result: CaseReport) {
  const group = conversation(page).locator(".er-chat-activity-group").filter({ hasText: "subagent" });
  await reveal(page, group);
  const key = await group.evaluate((element) => element.closest("[data-row-key]")!.getAttribute("data-row-key"));
  assert(key);
  const owner = row(page, key).locator(".er-chat-activity-group");
  const trigger = owner.locator(":scope > button");
  const body = owner.locator(":scope > .er-chat-activity-body");
  const outerBefore = await conversation(page).evaluate((element) => element.scrollTop);
  if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click();
  const bodyAttachedAfterClick = await body.count() === 1;
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  // useExpandable mounts the body in an effect. A missing descendant here is
  // pending disclosure, not evidence that its known virtual parent is elsewhere.
  // Never send Home or scan the transcript while awaiting this owned body.
  await expect(body).toBeAttached();
  const details = body.getByRole("button", { name: t("transcript.viewDetails"), exact: true });
  await expect(details).toBeAttached();
  const nested = await details.evaluate((element) => {
    const container = element.closest(".er-chat-activity-group")!.querySelector<HTMLElement>(":scope > .er-chat-activity-body")!;
    const before = container.scrollTop;
    const target = element.getBoundingClientRect();
    const bounds = container.getBoundingClientRect();
    if (target.bottom > bounds.bottom) container.scrollTop += target.bottom - bounds.bottom;
    else if (target.top < bounds.top) container.scrollTop += target.top - bounds.top;
    return { before, after: container.scrollTop };
  });
  result.measurements.childDetails = { rowKey: key, bodyAttachedAfterClick, outerBefore,
    outerAfterAttachment: await conversation(page).evaluate((element) => element.scrollTop), nested };
  // Locator.click owns normal actionability/reattachment checks. No stale element
  // handle, forced click, outer-history scan, or API navigation replaces the UI.
  await details.click();
}

async function openSettings(page: Page, t: Labels) {
  await page.getByRole("banner").getByRole("button", { name: t("home.settings"), exact: true }).click();
  const modal = page.getByRole("dialog", { name: t("settings.title"), exact: true });
  await modal.getByRole(page.viewportSize()!.width < 820 ? "button" : "tab", { name: t("settings.category.conversation"), exact: true }).click();
  await expect(settingsControl(page)).toBeVisible();
  return modal;
}
async function closeSettings(page: Page, t: Labels) {
  await page.getByRole("dialog", { name: t("settings.title"), exact: true }).getByRole("button", { name: t("settings.close"), exact: true }).click();
  await expect(settingsControl(page)).toHaveCount(0);
}
async function preset(page: Page, t: Labels, position: number) {
  await openSettings(page, t);
  const slider = settingsControl(page).getByRole("slider");
  await slider.focus();
  await slider.press("Home");
  for (let index = 0; index < position; index++) await slider.press("ArrowRight");
  await expect(slider).toHaveValue(String(position));
  await closeSettings(page, t);
}
async function readDetail(page: Page) {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}").timelineDetail as
    Record<Category, { placement: string; details: string }> | undefined, preferenceKey);
}

async function advancedSettings(page: Page, t: Labels) {
  await openSettings(page, t);
  const advanced = settingsControl(page).getByRole("button", { name: t("settings.timeline.advanced"), exact: true });
  if (await advanced.getAttribute("aria-expanded") !== "true") await advanced.click();
}

async function checkCategoryProjection(page: Page, seed: ReturnType<typeof fixture>, category: Category,
  placement: "hidden" | "grouped" | "separate", details: "collapsed" | "expanded") {
  const selectors: Record<Category, string> = { shell: '[data-activity="bash"]', edit: '[data-activity="edit"]',
    thinking: '[data-activity="thinking"]', subagents: ".er-chat-subagent", notices: ".er-chat-activity", tools: '[data-activity="read"]' };
  let target = conversation(page).locator(selectors[category]);
  if (category === "notices") target = target.filter({ hasText: "NOTICE_OUTPUT_PROOF" });
  // The following message is an adjacent, visible virtual-row witness: absence
  // cannot pass merely because the entire category scrolled out of the range.
  await reveal(page, row(page, seed.anchors[category]));
  if (placement === "hidden") {
    await expect(target).toHaveCount(0);
    if (category === "thinking") await expect(work(page).getByText("ANSWER_SURVIVES_HIDDEN_THINKING", { exact: true })).toBeVisible();
    return;
  }
  await reveal(page, target);
  await expect(target).toBeVisible();
  assert.equal(await target.evaluate((element) => element.closest(".er-chat-activity-group") !== null), placement === "grouped",
    `${category}: rendered grouping must match the category control`);
  await expect(target.locator("button[aria-expanded]").first()).toHaveAttribute("aria-expanded", String(details === "expanded"));
  const body = target.locator(category === "subagents" ? ".er-chat-subagent-output" : ".er-chat-activity-body");
  if (details === "expanded") await expect(body).toBeVisible();
  else await expect(body).toHaveCount(0);
}

async function checkPreferences(page: Page, t: Labels, seed: ReturnType<typeof fixture>, result: CaseReport, artifacts: string) {
  // Exercise the five preset positions through the keyboard-operable real input.
  const names = ["text-only", "quiet", "compact", "detailed", "everything"] as const;
  for (const [position, name] of names.entries()) {
    await preset(page, t, position);
    const detail = await readDetail(page);
    assert(detail && categories.every((category) => detail[category]));
    await reveal(page, work(page).getByText("ANSWER_SURVIVES_HIDDEN_THINKING", { exact: true }));
    const shell = conversation(page).locator('[data-activity="bash"]');
    if (position < 2) await expect(shell).toHaveCount(0);
    else if (position >= 3) {
      await reveal(page, shell);
      await expect(shell.getByRole("button")).toHaveAttribute("aria-expanded", "true");
      assert.equal(await shell.evaluate((element) => element.closest(".er-chat-activity-group") === null), true);
      for (const name of ["powershell", "ssh-bash"]) {
        const native = conversation(page).locator(`[data-activity="${name}"]`);
        await reveal(page, native);
        await expect(native.getByRole("button")).toHaveAttribute("aria-expanded", "true");
      }
    } else {
      const group = conversation(page).locator(".er-chat-activity-group").filter({ hasText: "bash" });
      await reveal(page, group);
      await expect(group.locator(":scope > button")).toHaveAttribute("aria-expanded", "false");
    }
    await reveal(page, conversation(page).locator('[data-summary-kind="compaction"]').last());
    await expect(conversation(page).locator('[data-summary-kind="compaction"]').last().getByRole("button").first()).toHaveAttribute("aria-expanded", "false");
    result.checks.push(`preset ${name}: real control and projected transcript`);
    if (position === 0) {
      const failure = conversation(page).locator(".er-chat-tool-output").filter({ hasText: "WRITE_FAILURE_PROOF" });
      await reveal(page, failure);
      await expect(failure).toBeVisible();
      await expect(conversation(page).getByText("PROVIDER_ERROR_PROOF", { exact: false })).toBeVisible();
      result.checks.push("text-only keeps genuine write/provider failures and assistant answers legible");
    }
  }
  await advancedSettings(page, t);
  for (const category of categories) {
    const projected = async (placement: "hidden" | "grouped" | "separate", details: "collapsed" | "expanded" = "expanded") => {
      await closeSettings(page, t);
      await checkCategoryProjection(page, seed, category, placement, details);
      await advancedSettings(page, t);
    };
    const label = t(`settings.timeline.category.${category}`);
    const controls = settingsControl(page).getByRole("group", { name: label, exact: true });
    const visibility = controls.getByRole("button");
    await visibility.click();
    await expect(visibility).toHaveAttribute("aria-pressed", "false");
    await expect.poll(async () => (await readDetail(page))?.[category].placement).toBe("hidden");
    await projected("hidden");
    await visibility.click();
    await expect(visibility).toHaveAttribute("aria-pressed", "true");
    // Closing Settings intentionally discards its transient remembered visible
    // placement; showing a hidden category in the new control starts grouped.
    await expect.poll(async () => (await readDetail(page))?.[category].placement).toBe("grouped");
    await projected("grouped");
    const group = controls.getByRole("switch", { name: t("settings.timeline.grouped.label").replace("{activity}", label), exact: true });
    await expect(group).toHaveAttribute("aria-checked", "true");
    await group.click();
    await expect.poll(async () => (await readDetail(page))?.[category].placement).toBe("separate");
    await projected("separate");
    const collapse = controls.getByRole("switch", { name: t("settings.timeline.collapsed.label").replace("{activity}", label), exact: true });
    await collapse.click();
    await expect.poll(async () => (await readDetail(page))?.[category].details).toBe("collapsed");
    await projected("separate", "collapsed");
    result.checks.push(`${category}: real transcript hides/shows, groups/separates and applies expanded/collapsed defaults`);
  }
  const saved = await readDetail(page);
  await page.screenshot({ path: join(artifacts, `settings-${result.width}-${result.theme}.png`) });
  await closeSettings(page, t);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(work(page).getByText("ROOT_PRESENTATION_TAIL", { exact: true })).toBeVisible();
  assert.deepEqual(await readDetail(page), saved, "Reload must preserve all six category choices");
  await openSettings(page, t);
  await expect(settingsControl(page).getByRole("slider")).toHaveAttribute("aria-valuetext", t("settings.timeline.custom"));
  await closeSettings(page, t);
  result.checks.push("six categories: hide/show, grouping/separate, disclosure controls and reload persistence");
}

async function checkDisclosures(page: Page, t: Labels, result: CaseReport) {
  await preset(page, t, 2);
  const group = conversation(page).locator(".er-chat-activity-group").filter({ hasText: "bash" });
  await reveal(page, group);
  await group.locator(":scope > button").click();
  const bash = group.locator('[data-activity="bash"]');
  await bash.getByRole("button").click();
  await expect(bash.getByText("BASH_OUTPUT_PROOF", { exact: true })).toBeVisible();
  const groupKey = await group.evaluate((element) => element.closest("[data-row-key]")!.getAttribute("data-row-key"));
  assert(groupKey);
  await conversation(page).focus();
  await conversation(page).press("Home");
  // Explicitly load the older real HTTP page, then move far enough to unmount.
  const older = work(page).getByRole("button", { name: t("transcript.loadOlder"), exact: true });
  for (let count = 0; count < 4 && await older.count(); count++) {
    const response = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/history"));
    await older.click();
    await (await response).json();
    await frames(page);
    await conversation(page).press("Home");
    await frames(page);
  }
  await expect(row(page, groupKey)).toHaveCount(0);
  await conversation(page).press("End");
  await reveal(page, row(page, groupKey));
  await expect(group.locator(":scope > button")).toHaveAttribute("aria-expanded", "true");
  await expect(bash.getByRole("button")).toHaveAttribute("aria-expanded", "true");
  await expect(bash.getByText("BASH_OUTPUT_PROOF", { exact: true })).toBeVisible();
  result.checks.push("compound group and nested manual disclosure survive actual virtual unmount/remount");
}

async function checkSummaries(page: Page, t: Labels, seed: ReturnType<typeof fixture>, result: CaseReport) {
  const summaries = conversation(page).locator('[data-summary-kind="compaction"]');
  await reveal(page, summaries.first());
  const short = summaries.first();
  await expect(short.getByRole("button").first()).toHaveAttribute("aria-expanded", "false");
  assert.equal(await short.locator(".er-chat-divider-line").count(), 2);
  await short.getByRole("button").first().click();
  await expect(short.getByText("STORED_SUMMARY_PROOF", { exact: true })).toBeVisible();
  await expect(short.locator(".katex-display")).toHaveCount(1);
  await short.getByRole("button").first().click();
  await expect(short.getByText("STORED_SUMMARY_PROOF", { exact: true })).toHaveCount(0);
  const branch = conversation(page).locator('[data-summary-kind="branch-summary"]');
  await reveal(page, branch);
  await branch.getByRole("button").first().click();
  await expect(branch.getByText("BRANCH_SUMMARY_PROOF", { exact: true })).toBeVisible();
  await branch.getByRole("button").first().click();
  const fullLink = work(page).getByRole("button", { name: t("transcript.fullEntry"), exact: true });
  await reveal(page, fullLink);
  const fullResponse = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith(`/history/${seed.oversized}`));
  await fullLink.click();
  assert.equal((await fullResponse).status(), 200);
  const dialog = page.getByRole("dialog", { name: t("transcript.fullEntry"), exact: true });
  await expect(dialog.getByRole("heading", { name: "Full summary", exact: true })).toBeVisible();
  await expect(dialog.locator("strong").filter({ hasText: "FULL_SUMMARY_END" })).toHaveCount(1);
  await expect(dialog.locator(".katex-display")).toHaveCount(1);
  await dialog.getByRole("button", { name: t("dialog.close"), exact: true }).click();
  result.checks.push("stored folded compaction/divider, distinct branch summary, full oversized Markdown + KaTeX from HTTP");
}

async function filesPanel(page: Page, t: Labels, open: boolean) {
  if (page.viewportSize()!.width < 820) {
    await work(page).getByRole("tab", { name: t(open ? "work.filesTab" : "work.chatTab"), exact: true }).click();
  } else {
    const layout = work(page).locator("[data-work-layout]");
    if ((await layout.getAttribute("data-panel-open") === "true") !== open)
      await page.getByRole("banner").getByRole("button", { name: t("work.filesBrowser"), exact: true }).click();
    await expect(layout).toHaveAttribute("data-panel-open", String(open));
  }
}

async function checkComposer(page: Page, t: Labels, seed: ReturnType<typeof fixture>, result: CaseReport) {
  const input = composer(page);
  const writes: string[] = [];
  const observe = (request: import("@playwright/test").Request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && /\/(messages|compact)$/.test(path)) writes.push(path);
  };
  page.on("request", observe);
  try {
    await input.fill("/");
    const menu = work(page).getByRole("listbox");
    await expect(menu.getByRole("group", { name: t("composer.commands"), exact: true })).toBeVisible();
    await expect(menu.getByRole("group", { name: t("composer.skills"), exact: true })).toBeAttached();
    await input.fill("/chat-smoke-skill");
    await input.press("Enter");
    await expect(input).toHaveValue("/chat-smoke-skill ");
    await expect(menu).toHaveCount(0);
    await input.press("End");
    await input.pressSequentially("with arguments");
    await expect(input).toHaveValue("/chat-smoke-skill with arguments");
    assert.deepEqual(writes, [], "Choosing a Skill must only insert its invocation");

    await input.fill("/statistics");
    await input.press("Enter");
    const statistics = page.getByRole("dialog", { name: t("usage.statisticsTitle"), exact: true });
    await expect(statistics).toBeVisible();
    await expect(input).toHaveValue("");
    await statistics.getByRole("button", { name: t("dialog.close"), exact: true }).click();
    assert.deepEqual(writes, [], "Built-in statistics executes its UI action without a model prompt");

    const entriesResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/entries");
    await input.fill("@notes/");
    assert.equal((await entriesResponse).status(), 200);
    await work(page).getByRole("listbox", { name: t("composer.files"), exact: true }).getByRole("option", { name: "研究 100% +.md", exact: true }).click();
    await expect(input).toHaveValue(`"${seed.selectedFile}" `);
    const selectedChip = work(page).locator("[data-composer-reference]").filter({ hasText: seed.selectedFile });
    await expect(selectedChip).toHaveAttribute("title", seed.selectedFile);
    await selectedChip.getByRole("button").click();
    await expect(selectedChip).toHaveCount(0);
    assert(!(await input.inputValue()).includes(seed.selectedFile), "Removing the chip must remove only its exact path range");

    // Toolbar insertion must preserve a word directly after a collapsed caret.
    await input.fill("README notes");
    await input.evaluate((element) => { const textarea = element as HTMLTextAreaElement; textarea.focus(); textarea.setSelectionRange(0, 0); });
    const toolbarEntries = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/api/entries" && url.searchParams.get("path") === seed.cwd;
    });
    await work(page).locator("[data-chat-composer]").getByRole("button", { name: t("composer.files"), exact: true }).click();
    assert.equal((await toolbarEntries).status(), 200);
    await work(page).getByRole("listbox", { name: t("composer.files"), exact: true }).getByRole("option", { name: "compact", exact: true }).click();
    const chips = work(page).locator("[data-composer-reference]");
    await expect(chips).toHaveCount(1);
    await expect(chips).toHaveAttribute("title", seed.droppedFile);
    await expect(input).toHaveValue(`"${seed.droppedFile}" README notes`);
    await chips.getByRole("button").click();
    await expect(chips).toHaveCount(0);
    await expect(input).toHaveValue(" README notes");
    result.checks.push("Files toolbar at caret zero preserves the complete README notes suffix and inserts only its own reference");

    const nativeEdits: Array<Record<string, unknown>> = [];
    result.measurements.nativeComposerEdits = nativeEdits;
    for (const occurrence of ["first", "second"] as const) {
      await input.fill("A @notes/");
      await work(page).getByRole("listbox", { name: t("composer.files"), exact: true }).getByRole("option", { name: "研究 100% +.md", exact: true }).click();
      await expect(input).toHaveValue(`A ${seed.selectedFile} `);
      await input.evaluate((element) => { const textarea = element as HTMLTextAreaElement; textarea.focus(); textarea.setSelectionRange(textarea.value.length, textarea.value.length); });
      await input.pressSequentially(" B @notes/");
      await work(page).getByRole("listbox", { name: t("composer.files"), exact: true }).getByRole("option", { name: "研究 100% +.md", exact: true }).click();
      await expect(input).toHaveValue(`A ${seed.selectedFile}  B ${seed.selectedFile} `);
      await expect(chips).toHaveCount(2);
      assert.deepEqual(await chips.evaluateAll((elements) => elements.map((element) => element.getAttribute("title"))), [seed.selectedFile, seed.selectedFile]);
      const start = occurrence === "first" ? "A ".length : `A ${seed.selectedFile}  B `.length;
      const end = start + seed.selectedFile.length;
      const expected = occurrence === "first" ? `A   B ${seed.selectedFile} ` : `A ${seed.selectedFile}  B  `;
      // Observe native events without manufacturing input/beforeinput or changing
      // the controlled value. Only trusted keyboard Backspace performs the edit.
      const observed = await input.evaluateHandle((element) => {
        const textarea = element as HTMLTextAreaElement;
        const events: Array<{ type: string; trusted: boolean; inputType: string; start: number; end: number; value: string }> = [];
        const record = (event: Event) => {
          if (events.length < 8) events.push({ type: event.type, trusted: event.isTrusted, inputType: (event as InputEvent).inputType,
            start: textarea.selectionStart, end: textarea.selectionEnd, value: textarea.value });
        };
        textarea.addEventListener("beforeinput", record, true);
        textarea.addEventListener("input", record, true);
        return { events, dispose() { textarea.removeEventListener("beforeinput", record, true); textarea.removeEventListener("input", record, true); } };
      });
      try {
        await input.evaluate((element, range) => { const textarea = element as HTMLTextAreaElement; textarea.focus(); textarea.setSelectionRange(range.start, range.end); }, { start, end });
        await page.keyboard.press("Backspace");
        await expect(input).toHaveValue(expected);
        await expect(chips).toHaveCount(1);
        await expect(chips).toHaveAttribute("title", seed.selectedFile);
        const events = await observed.evaluate((value) => value.events);
        nativeEdits.push({ occurrence, selectedRange: { start, end }, events });
        const before = events.find((event) => event.type === "beforeinput");
        assert(before?.trusted && before.inputType === "deleteContentBackward", "Deletion must exercise Chromium's native beforeinput");
        assert.deepEqual({ start: before.start, end: before.end }, { start, end });
        assert(events.some((event) => event.type === "input" && event.trusted && event.inputType === "deleteContentBackward" && event.value === expected));
        // Equal chip titles cannot prove occurrence identity; removing the survivor
        // must delete the other exact path and preserve every prose/separator byte.
        await chips.getByRole("button").click();
        await expect(chips).toHaveCount(0);
        await expect(input).toHaveValue("A   B  ");
      } finally { await observed.evaluate((value) => value.dispose()); await observed.dispose(); }
    }
    assert.deepEqual(writes, [], "Toolbar insertion and native duplicate-reference editing must not execute commands or send");
    result.checks.push("same-file references: native selected-range Backspace in both orders retains only the correct removable occurrence");

    // Use the real tree's dragstart producer, then the real Work drop consumer.
    // This also exercises mobile's explicit Files -> Chat transition without
    // pretending that touch devices have a native desktop drag gesture.
    await input.fill("Before  after");
    await input.evaluate((element) => { (element as HTMLTextAreaElement).setSelectionRange(7, 7); element.dispatchEvent(new Event("select", { bubbles: true })); });
    await filesPanel(page, t, true);
    const toggle = work(page).getByRole("button", { name: t("tabs.toggleTree"), exact: true });
    if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
    const source = work(page).getByRole("treeitem", { name: "compact", exact: true });
    await expect(source).toBeVisible();
    const transfer = await page.evaluateHandle(() => new DataTransfer());
    try {
      await source.dispatchEvent("dragstart", { dataTransfer: transfer });
      await filesPanel(page, t, false);
      await work(page).locator('[data-work-pane="chat"]').dispatchEvent("dragover", { dataTransfer: transfer });
      await work(page).locator('[data-work-pane="chat"]').dispatchEvent("drop", { dataTransfer: transfer });
    } finally { await transfer.dispose(); }
    await expect(input).toHaveValue(`Before ${seed.droppedFile} after`);
    await expect(work(page).locator("[data-composer-reference]")).toHaveAttribute("title", seed.droppedFile);
    await expect(work(page).getByRole("listbox")).toHaveCount(0);
    assert.deepEqual(writes, [], "Selecting/dropping a file must not send or execute a slash command");
    result.checks.push("distinct command/Skill groups; execute vs insert; @ uses real directory HTTP; exact removable selected/dropped path chips");
  } finally { page.off("request", observe); }
}

async function checkLayoutAndMath(page: Page, result: CaseReport) {
  const answer = work(page).locator('[data-message-body="assistant"]').filter({ hasText: "ROOT_PRESENTATION_TAIL" });
  await expect(answer).toBeVisible();
  await expect(answer.locator(".katex")).toHaveCount(2);
  await expect(answer.locator(".katex-display")).toHaveCount(1);
  await expect(answer.locator(".katex-error")).toHaveCount(0);
  await expect(answer.locator('code[data-inline-kind="command"]')).toHaveText("pdflatex manuscript/main.tex");
  await expect(answer.locator('code[data-inline-kind="skill"]')).toHaveText("/skill:paper-search");
  await expect(answer.getByRole("button", { name: "notes/研究 100% +.md", exact: true })).toBeVisible();
  await expect(answer.getByRole("button", { name: "pdflatex manuscript/main.tex", exact: true })).toHaveCount(0);
  const geometry = await answer.evaluate((element) => {
    const css = getComputedStyle(element);
    return { background: css.backgroundColor, border: css.borderTopWidth, radius: css.borderTopLeftRadius,
      shadow: css.boxShadow, width: element.getBoundingClientRect().width,
      overflow: document.documentElement.scrollWidth > innerWidth };
  });
  assert.equal(geometry.background, "rgba(0, 0, 0, 0)", "Assistant prose must be unboxed");
  assert.equal(geometry.border, "0px");
  assert.equal(geometry.shadow, "none");
  assert(!geometry.overflow, "Chat must not overflow the viewport");
  result.measurements.layout = geometry;
  result.checks.push(`unboxed assistant Markdown; inline/display KaTeX (${result.markdown}); no viewport overflow`);
  result.checks.push("inline command / Skill / file distinction agrees in the actual Markdown rendering path");
}

async function checkLive(page: Page, t: Labels, json: Json, pi: Pi, seed: ReturnType<typeof fixture>, provider: ReturnType<typeof fakeProvider>, result: CaseReport) {
  const expectedText = (await composer(page).inputValue()).trim();
  assert(expectedText.includes(seed.droppedFile));
  result.measurements.nativeCut = verifySingleRequestCut(pi, seed, expectedText);
  const baseline = provider.requests.length;
  const releaseLive = provider.arm("live");
  let releaseCompact: (() => void) | undefined;
  try {
    await work(page).getByRole("button", { name: t("composer.send"), exact: true }).click();
    await expect(work(page).getByText("LIVE_CHAT_START", { exact: false })).toBeVisible();
    assert.equal(provider.requests.length, baseline + 1);
    await expect(work(page).locator("[data-work-layout]")).toHaveAttribute("data-panel-open", "false");
    releaseCompact = provider.arm("compact");
    await composer(page).fill("/compact");
    await composer(page).press("Enter");
    const activity = conversation(page).locator(".er-chat-compaction-active");
    await expect(activity).toBeVisible();
    await expect.poll(async () => (await json<SessionSnapshotDto>(`/api/sessions/${seed.id}/snapshot`)).compactionState).toBe("queued");
    releaseLive();
    await expect.poll(() => provider.requests.length).toBe(baseline + 2);
    await expect.poll(async () => (await json<SessionSnapshotDto>(`/api/sessions/${seed.id}/snapshot`)).compactionState).toBe("running");
    await expect(activity).toBeVisible();
    await expect(work(page).getByText("NATIVE_COMPACTION_PROOF", { exact: true })).toHaveCount(0);
    releaseCompact();
    await expect.poll(async () => (await json<SessionSnapshotDto>(`/api/sessions/${seed.id}/snapshot`)).compactionState).toBe("idle");
    await expect(activity).toHaveCount(0);
    const snapshot = await json<SessionSnapshotDto>(`/api/sessions/${seed.id}/snapshot`);
    assert(snapshot.timeline.some((entry) => {
      if (entry.kind !== "message" || entry.message.role !== "user") return false;
      const content = entry.message.content;
      return (typeof content === "string" ? content : content.filter((part) => part.type === "text").map((part) => part.text).join("")) === expectedText;
    }),
      "The exact dropped-path draft must reach persisted Pi user history");
    const compact = snapshot.timeline.find((entry) => entry.kind === "compaction" && entry.summary?.includes("NATIVE_COMPACTION_PROOF"));
    assert(compact, "Native compaction must publish the real persisted entry");
    const summary = row(page, `summary:${compact.entryId}`);
    await reveal(page, summary);
    await expect(summary.getByRole("button").first()).toHaveAttribute("aria-expanded", "false");
    await summary.getByRole("button").first().click();
    await expect(summary.getByText("NATIVE_COMPACTION_PROOF", { exact: true })).toBeVisible();
    await expect(summary.locator(".katex-display")).toHaveCount(1);
    result.checks.push("real deterministic live SSE; exact prompt path; queued/running native compaction -> persisted folded Markdown summary");
  } finally { releaseLive(); releaseCompact?.(); }
}

async function main() {
  assert(process.argv.length <= 3, "Usage: bun scripts/smoke-chat-presentation.ts [compiled-binary]");
  const binary = resolve(process.argv[2] ?? "release/easyresearch-linux-x64/bin/easyresearch");
  assert(existsSync(binary), `Wait for the controller's integrated compiled candidate: ${binary}`);
  const suppliedChromium = process.env.COMPARE_CHROMIUM_PATH;
  const cachedChromium = join(process.env.HOME ?? "", ".cache/ms-playwright/chromium-1228/chrome-linux64/chrome");
  const chromiumPath = suppliedChromium ?? (existsSync(cachedChromium) ? cachedChromium : undefined);
  if (chromiumPath) assert(existsSync(chromiumPath), `Chromium executable missing: ${chromiumPath}`);
  const artifacts = realpathSync(mkdtempSync(join(existsSync("/tmp/opencode") ? "/tmp/opencode" : tmpdir(), "easyresearch-chat-browser-")));
  const home = join(artifacts, "home");
  const agentDir = join(artifacts, "agent");
  const emptyPath = join(artifacts, "empty-path");
  const temporary = join(artifacts, "tmp");
  for (const path of [home, agentDir, emptyPath, temporary]) mkdirSync(path, { recursive: true });
  // Allowlist rather than copying ambient API keys, proxy settings or resource overrides.
  const env = { HOME: home, USERPROFILE: home, EASYRESEARCH_CODING_AGENT_DIR: agentDir, PATH: emptyPath,
    XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local/share"),
    TMPDIR: temporary, NO_PROXY: "localhost,127.0.0.1,::1", LANG: "C.UTF-8", PI_OFFLINE: "1" };
  Object.assign(process.env, env);
  for (const key of ["EASYRESEARCH_BUNDLED_ROOT", "EASYRESEARCH_SKIP_SETUP", "EASYRESEARCH_VENV", "PI_PACKAGE_DIR"]) delete process.env[key];
  const report = { binary, sha256: sha256(binary), artifacts, origin: "", cases: [] as CaseReport[],
    provider: [] as Array<{ kind: string; path: string }>, cleanup: [] as string[], errors: [] as string[], passed: false };
  console.log(`CHAT_PRESENTATION_SMOKE artifacts: ${artifacts}`);
  let browser: Browser | undefined;
  let provider: ReturnType<typeof fakeProvider> | undefined;
  let custody: ReturnType<typeof createSmokeDaemonCustody> | undefined;
  const failures: unknown[] = [];
  let watchdogTask: Promise<unknown> | undefined;
  const watchdog = setTimeout(() => {
    failures.push(new Error("Chat browser smoke exceeded its ten-minute deadline"));
    watchdogTask = Promise.allSettled([browser?.close(), provider?.close(), custody?.stopAndVerify()]);
  }, 10 * 60_000);
  try {
    provider = fakeProvider();
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { "chat-smoke": {
      baseUrl: provider.origin, api: "openai-completions", apiKey: "isolated-fixture",
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
      models: [{ id: "fixture", name: "Chat Smoke", contextWindow: 1_000_000, maxTokens: 2048 }],
    } } }));
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "chat-smoke", defaultModel: "fixture",
      compaction: { enabled: false, keepRecentTokens: KEEP_RECENT_TOKENS }, retry: { enabled: false },
      easyresearch: { web: { sessionIdleTimeoutMs: -1, showApiUsageDetails: false },
        agentDefaults: { "research-assistant": { model: "chat-smoke/fixture", thinking: "off" } } } }));
    const { importPi } = await import("../src/runtime/pi-import");
    const pi = await importPi();
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = probe.port!;
    await probe.stop(true);
    const origin = report.origin = `http://127.0.0.1:${port}`;
    custody = createSmokeDaemonCustody({ agentDir, host: "127.0.0.1", port });
    const launcher = Bun.spawn([binary, "--no-open", "--port", String(port)], { cwd: home, env, stdin: "ignore",
      stdout: Bun.file(join(artifacts, "startup.stdout")), stderr: Bun.file(join(artifacts, "startup.stderr")) });
    const launchTimeout = setTimeout(() => launcher.kill("SIGKILL"), 90_000);
    try { assert.equal(await launcher.exited, 0, `Compiled startup failed; see ${artifacts}`); }
    finally { clearTimeout(launchTimeout); }
    assert(await custody.capture(), "Compiled daemon must be authenticated before browser access");
    const json: Json = async <T>(path: string, body?: unknown): Promise<T> => {
      const response = await fetch(`${origin}${path}`, { proxy: "", signal: AbortSignal.timeout(20_000),
        method: body === undefined ? "GET" : "POST", headers: body === undefined ? {} : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body) });
      assert.equal(response.status, 200, `${path}: ${response.status}`);
      return await response.json() as T;
    };
    assert.equal((await json<{ agentDir: string }>("/api/status")).agentDir, agentDir);
    browser = await chromium.launch({ ...(chromiumPath ? { executablePath: chromiumPath } : { channel: "chrome" }),
      env, headless: true, timeout: 30_000, args: ["--no-proxy-server"] });
    const cases = [[1440, "light", "en", "worker"], [1440, "dark", "zh-CN", "worker"],
      [390, "light", "zh-CN", "worker"], [390, "dark", "en", "fallback"]] as const;
    for (const [width, theme, language, markdown] of cases) {
      const label = `${width}-${theme}`;
      const result: CaseReport = { width, theme, language, markdown, checks: [], pageErrors: [], consoleErrors: [], workers: [], measurements: {}, passed: false };
      report.cases.push(result);
      const seed = fixture(pi, artifacts, label);
      const t: Labels = (key) => messages[language][key];
      const context: BrowserContext = await browser.newContext({ viewport: { width, height: width < 820 ? 844 : 900 }, locale: language,
        colorScheme: theme, reducedMotion: "reduce", hasTouch: width < 820 });
      await context.addInitScript(({ language, theme, fallback, key }) => {
        if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ language, studioTheme: theme }));
        const evidence = { parsed: 0, mathParsed: 0, failed: 0 };
        (window as unknown as { __chatWorker: typeof evidence }).__chatWorker = evidence;
        if (fallback) { Object.defineProperty(window, "Worker", { value: undefined }); return; }
        const Native = window.Worker;
        window.Worker = new Proxy(Native, { construct(Target, args) {
          const worker = Reflect.construct(Target, args) as Worker;
          if (String(args[0]).includes("markdown.worker")) {
            worker.addEventListener("message", (event: MessageEvent<{ type?: string; source?: string }>) => {
              if (event.data.type === "parsed") {
                evidence.parsed++;
                if (event.data.source?.includes("ROOT_PRESENTATION_TAIL")) evidence.mathParsed++;
              } else if (event.data.type === "error") evidence.failed++;
            });
            worker.addEventListener("error", () => evidence.failed++);
          }
          return worker;
        } });
      }, { language, theme, fallback: markdown === "fallback", key: preferenceKey });
      const page: Page = await context.newPage();
      page.setDefaultTimeout(12_000);
      page.setDefaultNavigationTimeout(25_000);
      page.on("pageerror", (error) => { if (result.pageErrors.length < 60) result.pageErrors.push(error.message); });
      page.on("console", (message) => { if (message.type() === "error" && result.consoleErrors.length < 60) result.consoleErrors.push(message.text().slice(0, 1000)); });
      page.on("worker", (worker) => { if (result.workers.length < 30) result.workers.push(worker.url()); });
      try {
        result.measurements.http = await verifyHistory(json, seed);
        result.measurements.rootAfterHttp = verifyRootBytes(pi, seed);
        const callsBefore: number = provider.requests.length;
        await page.goto(`${origin}/#/work/${seed.id}?cwd=${encodeURIComponent(seed.cwd)}`, { waitUntil: "domcontentloaded" });
        await expect(work(page).getByText("ROOT_PRESENTATION_TAIL", { exact: true })).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute("data-ui-theme", theme);
        await expect(work(page).locator("[data-work-layout]")).toHaveAttribute("data-panel-open", "false");
        if (width < 820) await expect(work(page).getByRole("tab", { name: t("work.chatTab"), exact: true })).toHaveAttribute("aria-selected", "true");
        await checkLayoutAndMath(page, result);
        const workerProof = await page.evaluate(() => (window as unknown as { __chatWorker: { parsed: number; mathParsed: number; failed: number } }).__chatWorker);
        if (markdown === "worker") {
          assert(workerProof.mathParsed > 0 && workerProof.failed === 0, "Formula must be prepared by the real hashed Worker, not silent fallback");
          assert(result.workers.some((url) => new URL(url).origin === origin && /\/assets\/markdown\.worker-[^/]+\.js$/.test(new URL(url).pathname)));
        } else assert.equal(workerProof.parsed, 0);
        result.measurements.worker = workerProof;
        await page.screenshot({ path: join(artifacts, `chat-${label}.png`) });
        await checkPreferences(page, t, seed, result, artifacts);
        await checkDisclosures(page, t, result);
        await checkSummaries(page, t, seed, result);
        // Open the mapped child from the actual subagent disclosure.
        await openChildDetails(page, t, result);
        await expect(work(page).getByText("CHILD_PRESENTATION_TAIL", { exact: true })).toBeVisible();
        await expect(composer(page)).toBeDisabled();
        const childSummary = conversation(page).locator('[data-summary-kind="compaction"]');
        await childSummary.getByRole("button").first().click();
        await expect(childSummary.getByText("CHILD_SUMMARY", { exact: true })).toBeVisible();
        await expect(childSummary.locator(".katex-display")).toHaveCount(1);
        await page.screenshot({ path: join(artifacts, `child-${label}.png`) });
        await work(page).getByTestId("agent-tab-group").getByRole("button").first().click();
        await expect(composer(page)).toBeEnabled();
        await checkComposer(page, t, seed, result);
        assert.equal(provider.requests.length, callsBefore, "History/settings/commands/files must not invoke a provider");
        result.measurements.rootAfterReadOnlyUi = verifyRootBytes(pi, seed);
        if (width === 1440 && theme === "light") {
          await checkLive(page, t, json, pi, seed, provider, result);
          result.measurements.rootAfterNativeWork = verifyRootBytes(pi, seed, true);
        }
        assert.equal(sha256(seed.childPath), seed.childHash, "Browser inspection mutated the read-only child JSONL");
        assert.deepEqual(result.pageErrors, []);
        assert.deepEqual(result.consoleErrors, []);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        result.checks.push("mapped read-only child summary/KaTeX, explicit Files action, no incidental provider calls or browser errors");
        result.passed = true;
      } catch (error) {
        result.error = String(error);
        failures.push(error);
        await page.screenshot({ path: join(artifacts, `failure-${label}.png`), timeout: 5000 }).catch(() => {});
        await page.locator("body").ariaSnapshot({ timeout: 5000 }).then((snapshot) => writeFileSync(join(artifacts, `failure-${label}.yml`), snapshot)).catch(() => {});
      } finally { await context.close(); }
    }
    assert.deepEqual(provider.failures, []);
  } catch (error) { failures.push(error); }
  finally {
    clearTimeout(watchdog);
    await watchdogTask;
    report.provider = provider?.requests ?? [];
    // Attempt every cleanup independently; failed custody remains available for a
    // bounded retry, and diagnostics/state are retained instead of deleting evidence.
    const cleanup = async (label: string, stop: () => Promise<unknown>) => {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try { await stop(); report.cleanup.push(`${label}: verified (attempt ${attempt})`); return; }
        catch (error) { report.cleanup.push(`${label}: ${String(error)}`); if (attempt === 2) failures.push(error); }
      }
    };
    await Promise.allSettled([
      cleanup("browser", async () => { await browser?.close(); if (browser) assert(!browser.isConnected()); }),
      cleanup("fake provider", async () => { await provider?.close(); }),
      cleanup("owned daemon process/record/lease", async () => { await custody?.stopAndVerify(); }),
    ]);
    report.errors = failures.map(String);
    report.passed = failures.length === 0 && report.cases.length === 4 && report.cases.every((item) => item.passed);
    writeFileSync(join(artifacts, "report.json"), JSON.stringify(report, null, 2));
    console.log(`CHAT_PRESENTATION_SMOKE ${report.passed ? "PASS" : "FAIL"}: ${join(artifacts, "report.json")}`);
  }
  if (failures.length) throw new AggregateError(failures, `Chat presentation acceptance failed; artifacts: ${artifacts}`);
}

if (import.meta.main) await main();
