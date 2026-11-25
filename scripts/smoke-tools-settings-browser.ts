#!/usr/bin/env bun
/** Compiled Settings -> real native extension registrations; all state and sources are private fixtures. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import type { AgentDto, SessionSnapshotDto } from "../src/web/contracts";
import { messages, type MessageKey } from "../src/webui/src/i18n/messages";
import { smokeAgentText } from "./smoke-agent-scenario";
import { createSmokeDaemonCustody } from "./smoke-release-support";
import { recordingBridge } from "./smoke-session-tabs";

const binary = resolve(process.argv[2] ?? "release/easyresearch-linux-x64/bin/easyresearch");
assert(existsSync(binary), "Build the native candidate first");
const root = mkdtempSync("/tmp/opencode/tools-settings-browser-");
const home = join(root, "home");
const agentDir = join(home, ".easyresearch", "agent");
const emptyPath = join(root, "empty-path");
for (const path of [agentDir, emptyPath]) mkdirSync(path, { recursive: true, mode: 0o700 });
const key = randomUUID().replaceAll("-", "");
const privateError = `PRIVATE_FACTORY_BODY_${key}`;
const invocationError = `EXPECTED_INVOCATION_ERROR_${key}`;
const tasks = new Map<string, { tool?: string; final: string }>();
const providerRequests: string[] = [];
const failures: string[] = [];
const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(request) {
  try {
    assert.equal(new URL(request.url).pathname, "/v1/chat/completions");
    const body = await request.json();
    const task = [...body.messages].reverse().find((message: any) => message.role === "user" && tasks.has(smokeAgentText(message.content)));
    assert(task, "Unexpected model request outside the fixture's explicit tasks");
    const name = smokeAgentText(task.content);
    providerRequests.push(name);
    const spec = tasks.get(name)!;
    const callId = `call_${name.replaceAll(/[^a-z0-9]/gi, "_")}`;
    const result = body.messages.find((message: any) => message.role === "tool" && message.tool_call_id === callId);
    if (result) assert(smokeAgentText(result.content).includes(invocationError), "The throwing tool did not report its invocation error");
    const invoke = spec.tool && !result;
    const delta = invoke
      ? { role: "assistant", tool_calls: [{ index: 0, id: callId, type: "function", function: { name: spec.tool, arguments: "{}" } }] }
      : { role: "assistant", content: spec.final };
    const chunk = (value: unknown, finish: string | null) => ({ id: key, object: "chat.completion.chunk", created: 1, model: "fixture",
      choices: [{ index: 0, delta: value, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    return new Response([chunk(delta, null), chunk({}, invoke ? "tool_calls" : "stop")].map(value => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n",
      { headers: { "Content-Type": "text/event-stream" } });
  } catch (error) {
    failures.push(String(error));
    return Response.json({ error: { message: String(error) } }, { status: 400 });
  }
} });
writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
  baseUrl: `http://127.0.0.1:${provider.port}/v1`, api: "openai-completions", apiKey: "isolated-fixture",
  compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
  models: [{ id: "fixture", name: "Fixture", contextWindow: 32000, maxTokens: 2048 }],
} } }));
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture", compaction: { enabled: false },
  easyresearch: { web: { autoSessionTitle: false, sessionIdleTimeoutMs: -1 }, agentDefaults: { "research-assistant": { model: "fixture/fixture", thinking: "off" } } } }));
const portProbe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = portProbe.port!;
await portProbe.stop(true);
const base = `http://127.0.0.1:${port}`;
const custody = createSmokeDaemonCustody({ agentDir, host: "127.0.0.1", port });
const env = { HOME: home, USERPROFILE: home, EASYRESEARCH_CODING_AGENT_DIR: agentDir, PATH: emptyPath,
  XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local/share"),
  TMPDIR: "/tmp/opencode", PI_OFFLINE: "1", NO_PROXY: "localhost,127.0.0.1,::1", LANG: "C.UTF-8" };
const json = async <T = any>(path: string, body?: unknown): Promise<T> => {
  const response = await fetch(base + path, { signal: AbortSignal.timeout(20_000), ...(body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }) });
  assert(response.ok, `${path}: HTTP ${response.status}`);
  return response.json() as Promise<T>;
};
const catalog = async (cwd?: string) => (await json<AgentDto[]>(`/api/agents${cwd ? `?${new URLSearchParams({ cwd })}` : ""}`))
  .find(agent => agent.name === "research-assistant")!;
const snapshot = (id: string) => json<SessionSnapshotDto>(`/api/sessions/${id}/snapshot`);
const ready = async (cwd: string, name: string) => {
  mkdirSync(cwd, { recursive: true });
  const { id } = await json<{ id: string }>("/api/sessions", { cwd });
  const prompt = `TOOLS_BROWSER_${key}_${name}`;
  const final = `READY_${name}`;
  tasks.set(prompt, { final });
  await json(`/api/sessions/${id}/messages`, { message: prompt });
  await expect.poll(async () => {
    const current = await snapshot(id);
    return current.session.status === "ready" && current.timeline.some(row => row.kind === "message" && row.message.role === "assistant" && smokeAgentText(row.message.content) === final);
  }, { timeout: 20_000 }).toBe(true);
  return id;
};
const writeExtension = (path: string, names: string[], errorTool?: string, hiddenTool?: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  const content = [
    'import { Type } from "typebox";',
    "export default function(api) {",
    `  for (const name of ${JSON.stringify(names)}) api.registerTool({`,
    `    name, exposure: name === ${JSON.stringify(hiddenTool ?? "")} ? "hidden" : "direct",`,
    '    label: name, description: "Isolated tool fixture", parameters: Type.Object({}),',
    `    async execute() { if (name === ${JSON.stringify(errorTool ?? "")}) throw new Error(${JSON.stringify(invocationError)});`,
    '      return { content: [{ type: "text", text: "HEALTHY" }], details: {} }; },',
    "  });",
    "}", "",
  ].join("\n");
  const draft = `${path}.draft`;
  writeFileSync(draft, content);
  renameSync(draft, path);
};
const openTools = async (page: Page, origin: string, id: string, cwd: string, mobile: boolean, t: (key: MessageKey) => string) => {
  await page.goto(`${origin}/#/work/${id}?cwd=${encodeURIComponent(cwd)}&settings=1`);
  const dialog = page.getByRole("dialog", { name: t("settings.title"), exact: true });
  await dialog.getByRole(mobile ? "button" : "tab", { name: t("settings.resources.tools"), exact: true }).click();
  return page.locator("#settings-panel-tools");
};
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let bridge: Awaited<ReturnType<typeof recordingBridge>> | undefined;
let primary: unknown;
const report: Record<string, any> = { binary, sha256: createHash("sha256").update(readFileSync(binary)).digest("hex"), root,
  cases: [], browserErrors: [], cleanup: [], passed: false };
let phase = "startup";
console.log(`TOOLS_SETTINGS_BROWSER artifacts: ${root}`);
try {
  const launcher = Bun.spawn([binary, "--no-open", "--port", String(port)], { cwd: home, env, stdin: "ignore",
    stdout: Bun.file(join(root, "startup.stdout")), stderr: Bun.file(join(root, "startup.stderr")) });
  const timeout = setTimeout(() => launcher.kill("SIGKILL"), 90_000);
  try { assert.equal(await launcher.exited, 0); } finally { clearTimeout(timeout); }
  assert(await custody.capture());
  assert.equal((await json("/api/status")).agentDir, agentDir);
  browser = await chromium.launch({ executablePath: process.env.COMPARE_CHROMIUM_PATH ?? chromium.executablePath(),
    env, headless: true, args: ["--no-proxy-server"] });
  report.browser = browser.version();
  for (const [width, height, theme] of [[1440, 1000, "light"], [390, 844, "dark"]] as const) {
    const mobile = width < 820;
    const language = mobile ? "zh-CN" : "en";
    const t = (message: MessageKey) => messages[language][message];
    const cwd = join(root, `project-${width}`);
    const privateCwd = join(root, `private-${width}`);
    const id = await ready(cwd, `${width}_root`);
    const privateId = await ready(privateCwd, `${width}_private`);
    const prefix = `tools_${key}_${width}`;
    const healthy = `${prefix}_healthy`, throwing = `${prefix}_throwing`, privateTool = `${prefix}_private`;
    const globalDir = join(agentDir, "extensions", prefix);
    const privateDir = join(privateCwd, ".easyresearch", "extensions", prefix);
    mkdirSync(globalDir, { recursive: true });
    mkdirSync(privateDir, { recursive: true });
    const source = join(globalDir, "index.ts");
    const badOne = join(agentDir, "extensions", `${prefix}-bad.ts`);
    const badTwo = join(agentDir, "extensions", `${prefix}-missing.ts`);
    const conflictA = join(agentDir, "extensions", `${prefix}-conflict-a.ts`);
    const conflictB = join(agentDir, "extensions", `${prefix}-conflict-b.ts`);
    bridge = await recordingBridge(base);
    context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, locale: language,
      reducedMotion: "reduce", hasTouch: mobile });
    await context.addInitScript(({ theme, language }) => localStorage.setItem("easyresearch.webui.preferences", JSON.stringify({ language, studioTheme: theme })), { theme, language });
    const pages = [await context.newPage(), await context.newPage()];
    for (const page of pages) {
      page.setDefaultTimeout(20_000);
      page.on("pageerror", error => report.browserErrors.push({ phase, message: error.message }));
    }
    const panels = await Promise.all(pages.map(page => openTools(page, bridge!.origin, id, cwd, mobile, t)));
    const result = { width, theme, language, checks: [] as string[] };
    report.cases.push(result);
    try {
      phase = `${width}-healthy-registration`;
      const requestsBefore = providerRequests.length;
      writeExtension(source, [healthy, throwing], throwing);
      for (const panel of panels) await expect(panel.getByText(healthy, { exact: true })).toBeVisible();
      writeExtension(join(privateDir, "index.ts"), [privateTool]);
      await expect.poll(async () => (await catalog(privateCwd)).effectiveTools.includes(privateTool)).toBe(true);
      for (const panel of panels) await expect(panel.getByText(privateTool, { exact: true })).toHaveCount(0);
      const scope = panels[0]!.getByRole("combobox", { name: t("settings.resources.toolScope"), exact: true });
      await scope.selectOption(privateCwd);
      await expect(panels[0]!.getByText(privateTool, { exact: true })).toBeVisible();
      await expect(panels[1]!.getByText(privateTool, { exact: true })).toHaveCount(0);
      result.checks.push("real successful registrations; isolated project scope; two-view refresh");

      phase = `${width}-two-load-failures`;
      writeFileSync(badOne, `export default function () { throw new Error(${JSON.stringify(privateError)}); }\n`);
      writeFileSync(badTwo, 'import "./missing-dependency.mjs"; export default function() {}\n');
      for (const panel of panels) {
        await expect(panel.locator('[data-tool-diagnostic-kind="load"]')).toHaveCount(2);
        await expect(panel.locator("[data-tool-diagnostics-summary]")).toContainText("2");
        await expect(panel.getByText(healthy, { exact: true })).toBeVisible();
        assert(!(await panel.innerText()).includes(privateError));
      }
      await pages[0]!.screenshot({ path: join(root, `${width}-${theme}-load-errors.png`), fullPage: true });
      result.checks.push("two distinct failed extensions; safe diagnostics; healthy inventory retained");

      phase = `${width}-registration-issues`;
      const duplicate = `${prefix}_duplicate`, uniqueA = `${prefix}_unique_a`, uniqueB = `${prefix}_unique_b`;
      writeExtension(conflictA, [duplicate, uniqueA]);
      writeExtension(conflictB, [duplicate, uniqueB]);
      for (const panel of panels) {
        await expect(panel.locator('[data-tool-diagnostic-kind="registration"]')).toHaveCount(1);
        await expect(panel.locator('[data-tool-diagnostic-kind="load"]')).toHaveCount(2);
        await expect(panel.getByText(uniqueA, { exact: true })).toBeVisible();
        await expect(panel.getByText(uniqueB, { exact: true })).toBeVisible();
      }
      await pages[0]!.screenshot({ path: join(root, `${width}-${theme}-mixed-diagnostics.png`), fullPage: true });
      assert.equal(providerRequests.length, requestsBefore, "Settings/source metadata invoked a model");
      result.checks.push("registration conflict classified separately; both modules retain unique tools");

      phase = `${width}-invocation-error`;
      const task = `TOOLS_BROWSER_${key}_${width}_invoke`;
      const final = `INVOKED_${width}`;
      tasks.set(task, { tool: throwing, final });
      await json(`/api/sessions/${id}/messages`, { message: task });
      await expect.poll(async () => {
        const current = await snapshot(id);
        return current.session.status === "ready" && current.timeline.some(row => row.kind === "message" && row.message.role === "assistant" && smokeAgentText(row.message.content) === final);
      }).toBe(true);
      const current = await snapshot(id);
      assert(current.timeline.some(row => row.kind === "message" && row.message.role === "toolResult"
        && row.message.isError === true && smokeAgentText(row.message.content).includes(invocationError)));
      for (const panel of panels) {
        await expect(panel.getByText(throwing, { exact: true })).toBeVisible();
        await expect(panel.locator('[data-tool-diagnostic-kind="load"]')).toHaveCount(2);
      }
      result.checks.push("real invocation error stays in chat; tool registration/load counts unchanged");

      phase = `${width}-scope-independence`;
      const selectCategory = async (category: "skills" | "tools") => {
        if (mobile) await pages[0]!.getByRole("button", { name: t("settings.backToCategories"), exact: true }).click();
        await pages[0]!.getByRole(mobile ? "button" : "tab", { name: t(category === "skills" ? "settings.category.skills" : "settings.resources.tools"), exact: true }).click();
      };
      await selectCategory("skills");
      const skillsScope = pages[0]!.getByRole("combobox", { name: t("settings.resources.diagnosticScope"), exact: true });
      await expect(skillsScope).toHaveValue("global");
      await skillsScope.selectOption(cwd);
      await selectCategory("tools");
      await expect(scope).toHaveValue(privateCwd);
      await expect(panels[0]!.getByText(privateTool, { exact: true })).toBeVisible();
      result.checks.push("Skill diagnostics and Tool scopes retain independent selections");

      phase = `${width}-recovery`;
      for (const path of [badOne, badTwo, conflictA, conflictB]) rmSync(path);
      const beforeRefresh = bridge.records.length;
      const [refreshed] = await Promise.all([
        pages[0]!.waitForResponse(response =>
          new URL(response.url()).pathname === "/api/config/refresh" && response.request().method() === "POST"),
        panels[0]!.getByRole("button", { name: t("tools.refresh"), exact: true }).click(),
      ]);
      assert(refreshed.ok(), "Manual inventory synchronization failed");
      await refreshed.finished();
      for (const panel of panels) {
        await expect(panel.locator("[data-tool-diagnostic-kind]")).toHaveCount(0);
        await expect(panel.getByText(healthy, { exact: true })).toBeVisible();
      }
      const recoveryRequests = bridge.records.slice(beforeRefresh);
      assert(recoveryRequests.some(row => row.method === "POST" && row.path === "/api/config/refresh"));
      result.checks.push("synchronize/refetch recovery clears resolved issues without hiding valid tools");

      phase = `${width}-native-hidden-withdrawal`;
      writeExtension(source, [healthy, throwing], throwing, healthy);
      for (const panel of panels) {
        await expect(panel.getByText(healthy, { exact: true })).toHaveCount(0);
        await expect(panel.getByText(throwing, { exact: true })).toBeVisible();
        await expect(panel.locator("[data-tool-diagnostic-kind]")).toHaveCount(0);
      }
      writeExtension(source, [healthy, throwing], throwing);
      for (const panel of panels) await expect(panel.getByText(healthy, { exact: true })).toBeVisible();
      result.checks.push("native hidden withdrawal is not advertised as callable or misreported as a load failure");

      phase = `${width}-idle-transport`;
      await expect.poll(() => bridge!.records.filter(row => row.live && row.path.startsWith("/api/") && row.path !== "/api/events").length).toBe(0);
      const idleStart = bridge.records.length;
      await pages[0]!.waitForTimeout(5500); // Observe longer than the ordinary Home polling interval.
      assert.equal(bridge.records.slice(idleStart).filter(row => row.path.startsWith("/api/")).length, 0);
      assert.equal(bridge.records.filter(row => row.path === "/api/events").length, 1);
      assert(bridge.subscriptions().length >= 4);
      assert.deepEqual(bridge.observationErrors, []);
      for (const page of pages) assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      result.checks.push("one two-tab physical SSE; independent subscriptions; zero idle API polling");
    } catch (error) {
      for (const [index, page] of pages.entries()) {
        await page.screenshot({ path: join(root, `${width}-failure-${index}.png`), fullPage: true }).catch(() => undefined);
        writeFileSync(join(root, `${width}-failure-${index}.txt`), await page.locator("body").innerText().catch(() => ""));
      }
      throw error;
    } finally {
      writeFileSync(join(root, `wire-${width}.json`), JSON.stringify(bridge.records, null, 2));
      await context.close(); context = undefined;
      await bridge.close(); bridge = undefined;
      for (const session of [id, privateId]) await json(`/api/sessions/${session}/stop`, {});
      for (const path of [globalDir, privateDir, badOne, badTwo, conflictA, conflictB]) rmSync(path, { recursive: true, force: true });
    }
  }
  assert.deepEqual(failures, []);
  assert.deepEqual(report.browserErrors, []);
  report.passed = true;
} catch (error) { primary = error; report.error = { phase, message: String(error) }; }
finally {
  const results = await Promise.allSettled([
    (async () => { await context?.close(); await browser?.close(); report.cleanup.push("browser"); })(),
    (async () => { await bridge?.close(); report.cleanup.push("bridge"); })(),
    (async () => { await custody.stopAndVerify(); report.cleanup.push("daemon"); })(),
    (async () => { await provider.stop(true); report.cleanup.push("provider"); })(),
  ]);
  report.cleanupErrors = results.flatMap(result => result.status === "rejected" ? [String(result.reason)] : []);
  report.providerRequests = providerRequests;
  if (report.cleanupErrors.length) report.passed = false;
  writeFileSync(join(root, "report.json"), JSON.stringify(report, null, 2));
}
if (primary) throw primary;
assert(report.passed, JSON.stringify(report.cleanupErrors));
console.log(`TOOLS_SETTINGS_BROWSER passed: ${root}/report.json`);
