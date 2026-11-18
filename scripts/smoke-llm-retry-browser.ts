#!/usr/bin/env bun
/** Parent-built executable -> isolated native Pi -> real Chromium Retry controls.
 * TMPDIR=/tmp/opencode bun scripts/smoke-llm-retry-browser.ts /absolute/candidate
 * No API fulfillment, production state, browser installation or candidate build.
 */
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import type { SessionSnapshotDto, StatusDto } from "../src/web/contracts";
import { messages, type MessageKey } from "../src/webui/src/i18n/messages";
import { createSmokeDaemonCustody } from "./smoke-release-support";
import { recordingBridge } from "./smoke-session-tabs";
import { createLlmRetryFixture, type LlmRetryFixture } from "./smoke-llm-retry-fixture";
import { assertRetryRejected, captureRetryEvidence, recoverySnapshot, retrySmokeRequest, retrySmokeWait, waitRetryComplete } from "./smoke-llm-retry";

type Bridge = Awaited<ReturnType<typeof recordingBridge>>;
type Labels = (key: MessageKey) => string;
const surface = (page: Page) => page.locator('[data-session-surface][data-session-active="true"]');
const composer = (page: Page) => surface(page).locator("[data-chat-composer] textarea");
const retryButton = (page: Page, t: Labels) => surface(page).getByRole("button", { name: t("work.retryModelRequest"), exact: true });
const agentButton = (page: Page, t: Labels, name: string) => surface(page).getByTestId("agent-tab-group")
  .getByRole("button", { name: `${t("work.agentChip")} ${name}`, exact: true });
const workUrl = (origin: string, id: string, cwd: string) => `${origin}/#/work/${id}?cwd=${encodeURIComponent(cwd)}`;

async function manualCase(options: { base: string; directory: string; project: string; fixture: LlmRetryFixture;
  bridge: Bridge; page: Page; t: Labels; label: string; depth: 0 | 1; deadline: number }) {
  const { base, directory, project, fixture, bridge, page, t, label, depth, deadline } = options;
  const item = fixture.addCase(`${label}_depth_${depth}`, depth);
  const { id } = await retrySmokeRequest(base, "/api/sessions", { cwd: project });
  try {
    await page.goto(workUrl(bridge.origin, id, project), { waitUntil: "domcontentloaded" });
    await expect(composer(page)).toBeEnabled();
    await retrySmokeRequest(base, `/api/sessions/${id}/messages`, { message: item.prompt });
    const first = await recoverySnapshot(base, id, fixture, deadline);
    const evidence = captureRetryEvidence(first.snapshot, first.recovery, item, directory);
    const child = first.snapshot.subagents.find(job => job.childSessionId === first.recovery.targetSessionId);
    const select = async () => {
      if (child) await agentButton(page, t, child.agentId!).click();
      await expect(retryButton(page, t)).toBeVisible();
      if (child) await expect(composer(page)).toBeDisabled();
      else await expect(composer(page)).toBeEnabled();
    };
    if (child) {
      await expect(retryButton(page, t)).toHaveCount(0); // Root must not inherit child eligibility.
      await expect(agentButton(page, t, child.agentId!)).toContainText(t("work.awaitingRetry"));
    }
    await select();
    const requestsBeforeReload = fixture.requests;
    await page.reload({ waitUntil: "domcontentloaded" });
    await select();
    assert.equal(fixture.requests, requestsBeforeReload, "Browser reconnect restarted Agent work");
    evidence.check(await retrySmokeRequest(base, `/api/sessions/${id}/snapshot`));
    const draft = `UNSENT_DRAFT_${item.name}`;
    if (!child) await composer(page).fill(draft);
    await page.screenshot({ path: join(directory, `${item.name}-available.png`), fullPage: true });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Retry banner overflows the viewport");

    const start = bridge.records.length;
    const retries = () => bridge.records.slice(start).filter(record => record.method === "POST" && record.path === `/api/sessions/${id}/retry`);
    const ack = bridge.delay(record => record.method === "POST" && record.path === `/api/sessions/${id}/retry`);
    const held = item.leaf.holdNext();
    try {
      // Two native DOM click events in one browser task exercise the synchronous
      // duplicate fence; the second admitted cycle below uses actual keyboard input.
      await retryButton(page, t).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
      await expect.poll(() => retries().length).toBe(1);
      await expect.poll(() => held.hit).toBe(true);
      await expect.poll(() => retries()[0]?.status).toBe(202);
      assert.deepEqual(retries()[0]!.body, { targetSessionId: first.recovery.targetSessionId, failureId: first.recovery.failureId });
      const firstAttempts = item.leaf.requests.length;
      await assertRetryRejected(base, id, first.recovery);
      assert.equal(item.leaf.requests.length, firstAttempts);
      held.release();
      const second = await recoverySnapshot(base, id, fixture, deadline, first.recovery.failureId);
      evidence.check(second.snapshot);
      assert.equal(item.leaf.failures, 4);
      assert.notEqual(second.recovery.failedEntryId, first.recovery.failedEntryId);
      // The real 202 is still held while SSE has delivered a genuinely new failure.
      await expect(retryButton(page, t)).toHaveAttribute("aria-disabled", "false");
      ack.release();
      await expect.poll(() => retries()[0]!.live).toBe(false);
      await expect(retryButton(page, t)).toBeVisible();
      await expect(retryButton(page, t)).toHaveAttribute("aria-disabled", "false");
      if (!child) await expect(composer(page)).toHaveValue(draft);
      await retryButton(page, t).focus();
      await page.keyboard.press("Enter");
      const complete = await waitRetryComplete(base, id, item, fixture, deadline);
      const receipt = evidence.check(complete, "complete");
      await expect(retryButton(page, t)).toHaveCount(0);
      await expect.poll(() => retries().length).toBe(2);
      assert.deepEqual(retries()[1]!.body, { targetSessionId: second.recovery.targetSessionId, failureId: second.recovery.failureId });
      await expect.poll(() => retries()[1]!.status).toBe(202);
      assert.equal(item.leaf.requests.length, 7);
      if (!child) await expect(composer(page)).toHaveValue(draft);
      else await expect(composer(page)).toBeDisabled();
      assert.equal(bridge.records.slice(start).filter(record => record.method === "POST" && /\/(messages|abort|stop)$/.test(record.path)).length, 0,
        "Retry UI used send/reopen or cancelled the preserved operation");
      await page.screenshot({ path: join(directory, `${item.name}-complete.png`), fullPage: true });
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(composer(page)).toBeVisible();
      await expect(retryButton(page, t)).toHaveCount(0); // Historical failures have no recovery authority.
      evidence.check(await retrySmokeRequest(base, `/api/sessions/${id}/snapshot`), "complete");
      return { ...receipt, label, depth, retryRequests: retries().map(({ body, status }) => ({ body, status })),
        obsoleteAcknowledgement: { upstreamStatus: retries()[0]!.status, delivered: retries()[0]!.complete },
        checks: ["live + reconnect", "root/child scope", "completed tool/context", "same-task duplicate clicks", "held real 202 superseded by new SSE failure", "keyboard retry", "draft/read-only composer", "historical ineligibility"] };
    } finally { held.release(); ack.release(); }
  } finally { await retrySmokeRequest(base, `/api/sessions/${id}/stop`, {}); }
}

async function automaticCase(options: { base: string; directory: string; project: string; fixture: LlmRetryFixture;
  bridge: Bridge; page: Page; t: Labels; label: string; deadline: number }) {
  const { base, directory, project, fixture, bridge, page, t, label, deadline } = options;
  const item = fixture.addCase(`${label}_automatic_child`, 1);
  const { id } = await retrySmokeRequest(base, "/api/sessions", { cwd: project });
  const automaticLabel = t("work.retrying").replace("{attempt}", "1").replace("{maxAttempts}", "1");
  try {
    await page.goto(workUrl(bridge.origin, id, project), { waitUntil: "domcontentloaded" });
    await expect(composer(page)).toBeEnabled();
    await retrySmokeRequest(base, `/api/sessions/${id}/messages`, { message: item.prompt });
    const backoff = await retrySmokeWait("browser child automatic backoff", deadline,
      () => retrySmokeRequest(base, `/api/sessions/${id}/snapshot`) as Promise<SessionSnapshotDto>,
      value => value.subagents.some(job => !!job.automaticRetry));
    const child = backoff.subagents.find(job => job.automaticRetry)!;
    assert.equal(child.automaticRetry!.delayMs, 15000);
    await expect(surface(page).getByRole("status").filter({ hasText: automaticLabel })).toHaveCount(0);
    await agentButton(page, t, child.agentId!).click();
    await expect(surface(page).getByRole("status").filter({ hasText: automaticLabel })).toBeVisible();
    await expect(composer(page)).toBeDisabled();
    await page.reload({ waitUntil: "domcontentloaded" });
    await agentButton(page, t, child.agentId!).click();
    await expect(surface(page).getByRole("status").filter({ hasText: automaticLabel })).toBeVisible();
    await page.screenshot({ path: join(directory, `${label}-child-backoff.png`), fullPage: true });
    await agentButton(page, t, t("agent.researchAssistant")).click();
    await expect(surface(page).getByRole("status").filter({ hasText: automaticLabel })).toHaveCount(0);
    await retrySmokeRequest(base, `/api/sessions/${id}/abort`, {});
    await retrySmokeWait("browser automatic Stop", deadline,
      () => retrySmokeRequest(base, `/api/sessions/${id}/snapshot`) as Promise<SessionSnapshotDto>,
      value => value.session.status === "ready");
    await expect(retryButton(page, t)).toHaveCount(0);
    return { label, automaticChild: child.childSessionId, explicitProjectDelayMs: 15000,
      checks: ["actual child native backoff", "root scope", "reconnect backoff snapshot", "read-only composer", "Stop invalidation"] };
  } finally { await retrySmokeRequest(base, `/api/sessions/${id}/stop`, {}); }
}

async function main() {
  assert.equal(process.argv.length, 3, "Usage: bun scripts/smoke-llm-retry-browser.ts /absolute/controller-built-executable");
  const binary = realpathSync(resolve(process.argv[2]!));
  const browserPath = process.env.COMPARE_CHROMIUM_PATH ?? chromium.executablePath();
  assert(existsSync(browserPath), "Supply an installed Chromium via COMPARE_CHROMIUM_PATH; this helper never installs browsers");
  const directory = realpathSync(mkdtempSync("/tmp/opencode/easyresearch-llm-retry-browser-"));
  const home = join(directory, "home");
  const agentDir = join(directory, "agent");
  const emptyPath = join(directory, "empty-path");
  const project = join(directory, "project");
  const autoProject = join(directory, "backoff-project");
  for (const path of [home, agentDir, emptyPath, join(project, ".easyresearch"), join(autoProject, ".easyresearch")]) mkdirSync(path, { recursive: true, mode: 0o700 });
  // Browser acceptance does not recreate the native smoke's Python/install gate.
  // The counter uses shell built-ins and still appends once on every execution.
  const env = { HOME: home, USERPROFILE: home, EASYRESEARCH_CODING_AGENT_DIR: agentDir, PATH: emptyPath,
    XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local/share"),
    TMPDIR: "/tmp/opencode", NO_PROXY: "localhost,127.0.0.1,::1", LANG: "C.UTF-8", PI_OFFLINE: "1" };
  const fixture = createLlmRetryFixture({ runId: randomUUID(), directory: join(directory, "counters") });
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, maxRequestBodySize: 4 * 1024 * 1024,
    async fetch(request) {
      assert.equal(new URL(request.url).pathname, "/v1/chat/completions");
      return fixture.respond(await request.json());
    } });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { "llm-retry-smoke": {
    baseUrl: `http://127.0.0.1:${provider.port}/v1`, api: "openai-completions", apiKey: "isolated-fixture",
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
    models: [{ id: "smoke-model", name: "Retry fixture", contextWindow: 32000, maxTokens: 2048 }],
  } } }));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "llm-retry-smoke", defaultModel: "smoke-model",
    compaction: { enabled: false }, easyresearch: { web: { sessionIdleTimeoutMs: -1 },
      agentDefaults: { "research-assistant": { model: "llm-retry-smoke/smoke-model", thinking: "off" } } } }));
  // Leave ample real backoff time for a fresh document/SharedWorker snapshot;
  // Stop ends it after the assertions. Native acceptance separately times 5000ms.
  for (const [cwd, baseDelayMs] of [[project, 0], [autoProject, 15000]] as const) writeFileSync(join(cwd, ".easyresearch", "settings.json"),
    JSON.stringify({ retry: { enabled: true, maxRetries: 1, baseDelayMs } }));
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port!;
  await probe.stop(true);
  const base = `http://127.0.0.1:${port}`;
  const custody = createSmokeDaemonCustody({ agentDir, host: "127.0.0.1", port });
  const report = { binary, sha256: createHash("sha256").update(readFileSync(binary)).digest("hex"), directory,
    browser: "", cases: [] as unknown[], errors: [] as string[], cleanup: [] as string[], passed: false };
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let bridge: Bridge | undefined;
  let primary: unknown;
  const deadline = Date.now() + 240_000;
  console.log(`LLM_RETRY_BROWSER artifacts: ${directory}`);
  const watchdog = setTimeout(() => {
    report.errors.push("Browser retry acceptance exceeded its four-minute deadline");
    fixture.release();
    void Promise.allSettled([browser?.close(), bridge?.close(), custody.stopAndVerify(), provider.stop(true)]);
  }, 240_000);
  try {
    const launcher = Bun.spawn([binary, "--no-open", "--port", String(port)], { cwd: home, env, stdin: "ignore",
      stdout: Bun.file(join(directory, "startup.stdout")), stderr: Bun.file(join(directory, "startup.stderr")) });
    const timeout = setTimeout(() => launcher.kill("SIGKILL"), 90_000);
    try { assert.equal(await launcher.exited, 0, `Startup failed: ${directory}/startup.stderr`); }
    finally { clearTimeout(timeout); }
    assert(await custody.capture());
    assert.equal((await retrySmokeRequest(base, "/api/status") as StatusDto).agentDir, agentDir);
    fixture.writeAgents(agentDir); // Post-bootstrap external resources, same path as native acceptance.
    await retrySmokeWait("browser custom Agent catalog", deadline, () => retrySmokeRequest(base, "/api/agents"),
      rows => rows.some((row: { name: string }) => row.name === fixture.leafAgent));
    browser = await chromium.launch({ executablePath: browserPath, env, headless: true, args: ["--no-proxy-server"] });
    report.browser = browser.version();
    for (const item of [{ width: 1440, theme: "light", language: "en" }, { width: 390, theme: "dark", language: "zh-CN" }] as const) {
      bridge = await recordingBridge(base);
      context = await browser.newContext({ viewport: { width: item.width, height: item.width < 820 ? 844 : 900 },
        colorScheme: item.theme, locale: item.language, reducedMotion: "reduce", hasTouch: item.width < 820 });
      await context.addInitScript(({ origin, preferences }) => {
        if (location.origin === origin) localStorage.setItem("easyresearch.webui.preferences", JSON.stringify(preferences));
      }, { origin: bridge.origin, preferences: { language: item.language, studioTheme: item.theme } });
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      page.on("pageerror", error => report.errors.push(error.message));
      const t: Labels = key => messages[item.language][key];
      const label = `${item.width}_${item.theme}`;
      for (const depth of [0, 1] as const) report.cases.push(await manualCase({ base, directory, project, fixture,
        bridge, page, t, label, depth, deadline }));
      report.cases.push(await automaticCase({ base, directory, project: autoProject, fixture, bridge, page, t, label, deadline }));
      assert.deepEqual(bridge.observationErrors, []);
      await context.close(); context = undefined;
      await bridge.close(); bridge = undefined;
    }
    if (fixture.failure) throw fixture.failure;
    assert.deepEqual(report.errors, []);
    report.passed = true;
  } catch (error) { primary = error; report.errors.push(String(error)); }
  finally {
    clearTimeout(watchdog);
    fixture.release();
    const steps = [["browser", async () => { await context?.close(); await browser?.close(); }],
      ["bridge", async () => { await bridge?.close(); }], ["daemon", () => custody.stopAndVerify()],
      ["provider", async () => { await provider.stop(true); assert.equal(provider.pendingRequests, 0); }]] as const;
    const results = await Promise.allSettled(steps.map(async ([name, cleanup]) => { await cleanup(); report.cleanup.push(name); }));
    for (const result of results) if (result.status === "rejected") report.errors.push(String(result.reason));
    report.passed &&= report.errors.length === 0;
    writeFileSync(join(directory, "report.json"), JSON.stringify(report, null, 2));
  }
  if (primary) throw primary;
  assert(report.passed, JSON.stringify(report.errors));
  console.log(`LLM_RETRY_BROWSER passed: compiled light desktop/dark mobile, real root/child controls, duplicates/late acknowledgments, reconnect and preserved context. ${directory}/report.json`);
}

if (import.meta.main) await main();
