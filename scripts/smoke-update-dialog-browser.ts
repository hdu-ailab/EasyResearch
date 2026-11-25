#!/usr/bin/env bun
/** Compiled Web assets with a private Desktop updater fixture; never installs a product update. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import type { DesktopUpdateOpenIntent } from "../src/desktop/contracts";
import { LATEST_RELEASE_PAGE, type UpdateAction, type UpdateSnapshot } from "../src/runtime/update-contract";
import { messages, type MessageKey } from "../src/webui/src/i18n/messages";
import { createSmokeDaemonCustody } from "./smoke-release-support";

interface UpdateFixture {
  current: UpdateSnapshot;
  actions: UpdateAction[];
  reads: number;
  openListeners: number;
  publish(value: Partial<UpdateSnapshot>): void;
  open(intent: DesktopUpdateOpenIntent): void;
}
type FixtureWindow = Window & { updateFixture: UpdateFixture };

const binary = resolve(process.argv[2] ?? "release/easyresearch-linux-x64/bin/easyresearch");
assert(existsSync(binary), "Build the native candidate first");
const root = mkdtempSync(join(tmpdir(), "update-dialog-browser-"));
const home = join(root, "home"), agentDir = join(home, ".easyresearch", "agent"), emptyPath = join(root, "empty-path");
for (const directory of [home, agentDir, emptyPath]) mkdirSync(directory, { recursive: true, mode: 0o700 });
const env = {
  HOME: home, USERPROFILE: home, EASYRESEARCH_CODING_AGENT_DIR: agentDir, PATH: emptyPath,
  XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local/share"),
  TMPDIR: tmpdir(), PI_OFFLINE: "1", NO_PROXY: "localhost,127.0.0.1,::1", LANG: "C.UTF-8",
};
const portProbe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = portProbe.port!; await portProbe.stop(true);
const origin = `http://127.0.0.1:${port}`;
const custody = createSmokeDaemonCustody({ agentDir, host: "127.0.0.1", port });
const report: Record<string, any> = {
  root, binary, sha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
  updater: "private renderer bridge fixture; native host acceptance is separate",
  cases: [], browserErrors: [], cleanupErrors: [], passed: false,
};
let browser: Browser | undefined, context: BrowserContext | undefined;
let primary: unknown;
const publish = (page: Page, value: Partial<UpdateSnapshot>) => page.evaluate(
  value => (window as unknown as FixtureWindow).updateFixture.publish(value), value,
);
const open = (page: Page, intent: DesktopUpdateOpenIntent) => page.evaluate(
  intent => (window as unknown as FixtureWindow).updateFixture.open(intent), intent,
);
const actionCount = (page: Page, action: UpdateAction["action"]) => page.evaluate(
  action => (window as unknown as FixtureWindow).updateFixture.actions.filter(value => value.action === action).length, action,
);
async function assertDialogGeometry(page: Page, title: string) {
  const dialog = page.getByRole("dialog", { name: title, exact: true });
  const bounds = await dialog.evaluate(element => {
    const box = element.getBoundingClientRect();
    return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: innerWidth, height: innerHeight,
      overflowing: element.scrollWidth > element.clientWidth + 1, documentOverflow: document.documentElement.scrollWidth > innerWidth + 1 };
  });
  assert(bounds.x >= 0 && bounds.y >= 0 && bounds.right <= bounds.width + 1 && bounds.bottom <= bounds.height + 1
    && !bounds.overflowing && !bounds.documentOverflow, JSON.stringify(bounds));
  const close = dialog.getByRole("button", { name: /^(Close|关闭)$/ });
  await expect(close).toBeVisible();
  assert(await close.evaluate(element => {
    const box = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
  }), "Dialog close must retain a reachable hit target");
}

console.log(`UPDATE_DIALOG_BROWSER artifacts: ${root}`);
try {
  const launcher = Bun.spawn([binary, "--no-open", "--port", String(port)], {
    cwd: home, env, stdin: "ignore", stdout: Bun.file(join(root, "startup.log")), stderr: Bun.file(join(root, "startup-error.log")),
  });
  const timer = setTimeout(() => launcher.kill("SIGKILL"), 90_000);
  try { assert.equal(await launcher.exited, 0); } finally { clearTimeout(timer); }
  assert(await custody.capture());
  const response = await fetch(`${origin}/api/status`, { signal: AbortSignal.timeout(10_000) });
  assert(response.ok);
  const status = await response.json() as { agentDir: string; version: string };
  assert.equal(status.agentDir, agentDir);
  report.version = status.version;
  browser = await chromium.launch({
    executablePath: process.env.COMPARE_CHROMIUM_PATH ?? chromium.executablePath(), headless: true, args: ["--no-proxy-server"],
  });
  report.browser = browser.version();
  for (const [width, height, language, theme] of [
    [1280, 900, "en", "light"], [860, 720, "en", "dark"], [390, 844, "zh-CN", "dark"], [390, 844, "zh-CN", "light"],
  ] as const) {
    context = await browser.newContext({ viewport: { width, height }, locale: language, colorScheme: theme, reducedMotion: "reduce" });
    const t = (key: MessageKey) => messages[language][key];
    const initial: UpdateSnapshot = {
      revision: 0, operationId: null, owner: "desktop", phase: "idle", currentVersion: status.version,
      latestVersion: null, canDownload: false, canInstall: false, canActivate: false, canCancel: false, releaseUrl: LATEST_RELEASE_PAGE,
    };
    await context.addInitScript(({ initial, language, theme }) => {
      localStorage.setItem("easyresearch.webui.preferences", JSON.stringify({ language, studioTheme: theme }));
      let listener: ((intent: DesktopUpdateOpenIntent) => void) | undefined;
      let queued: DesktopUpdateOpenIntent | undefined = "check";
      const subscribers = new Set<(snapshot: UpdateSnapshot) => void>();
      const fixture: UpdateFixture = {
        current: initial, actions: [], reads: 0, openListeners: 0,
        publish(value) {
          fixture.current = { ...fixture.current, ...value, revision: fixture.current.revision + 1 };
          for (const subscribe of subscribers) subscribe(fixture.current);
        },
        open(intent) { if (listener) listener(intent); else queued = intent; },
      };
      (window as unknown as FixtureWindow).updateFixture = fixture;
      window.easyresearchDesktop = {
        platform: "win32", version: initial.currentVersion,
        persistWebUiPreferences() {},
        onOpenUpdates(callback) {
          listener = callback; fixture.openListeners++;
          queueMicrotask(() => { if (listener === callback && queued) { const intent = queued; queued = undefined; callback(intent); } });
          return () => { if (listener === callback) listener = undefined; fixture.openListeners--; };
        },
        async updateSnapshot() { fixture.reads++; return fixture.current; },
        onUpdate(callback) { subscribers.add(callback); return () => { subscribers.delete(callback); }; },
        async updateAction(action) {
          fixture.actions.push(action);
          if (action.action === "check") fixture.publish({ phase: "available", operationId: "fixture-operation", latestVersion: "999.0.1", canDownload: true });
          if (action.action === "download") fixture.publish({ phase: "downloading", canDownload: false, canCancel: true, bytesReceived: 0, bytesTotal: 104857600 });
          if (action.action === "install") {
            if (!action.force) return { code: "RUNTIME_BUSY", activeSessions: 2, authFlowActive: true };
            fixture.publish({ phase: "installing", canInstall: false, canCancel: true });
          }
          if (action.action === "cancel") fixture.publish({ phase: "cancelled", canCancel: false, canInstall: false });
          return fixture.current;
        },
      };
    }, { initial, language, theme });
    const unexpectedUpdateRequests: string[] = [];
    await context.route("**/api/update-check", route => route.fulfill({ json: { latestVersion: null } }));
    await context.route("**/api/update{,/**}", route => {
      unexpectedUpdateRequests.push(route.request().url());
      return route.fulfill({ status: 500, json: { error: "Desktop fixture must use its existing bridge" } });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.on("pageerror", error => report.browserErrors.push(error.message));
    const title = t("update.title"), closeName = t("dialog.close");
    const dialog = page.getByRole("dialog", { name: title, exact: true });
    const label = `${width}-${language}-${theme}`;
    const checks: string[] = [];
    try {
      const started = performance.now();
      await page.goto(`${origin}/#/`);
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText(t("update.available"), { exact: true })).toBeVisible();
      assert.equal(await actionCount(page, "check"), 1);
      await assertDialogGeometry(page, title);
      await page.screenshot({ path: join(root, `${label}-available.png`) });
      report.cases.push({ width, height, language, theme, initialDialogMs: Math.round(performance.now() - started), checks });
      checks.push("queued tray check opens shared dialog; one explicit check");

      await dialog.getByRole("button", { name: t("update.download"), exact: true }).click();
      await publish(page, { bytesReceived: 52428800 });
      await expect(dialog.getByRole("progressbar")).toHaveAttribute("value", "52428800");
      await expect(dialog.getByRole("progressbar")).toHaveAttribute("max", "104857600");
      await page.screenshot({ path: join(root, `${label}-progress.png`) });
      await dialog.getByRole("button", { name: closeName, exact: true }).click();
      await open(page, "check");
      await open(page, "check");
      await expect(dialog.getByRole("progressbar")).toBeVisible();
      assert.equal(await actionCount(page, "check"), 1);
      assert.equal(await actionCount(page, "cancel"), 0);
      checks.push("measured native progress; close/repeated tray open preserve active download");

      await publish(page, { phase: "downloaded", bytesReceived: 104857600, canCancel: false, canInstall: true, canReveal: true });
      await dialog.getByRole("button", { name: t("update.install"), exact: true }).click();
      assert.equal(await actionCount(page, "install"), 0);
      await dialog.getByRole("button", { name: t("update.confirmInstall"), exact: true }).click();
      await expect(dialog.getByText(t("update.busy").replace("{n}", "2"))).toBeVisible();
      await page.screenshot({ path: join(root, `${label}-confirmation.png`) });
      await dialog.getByRole("button", { name: t("update.force"), exact: true }).click();
      await expect(dialog.getByRole("progressbar")).not.toHaveAttribute("value");
      await dialog.getByRole("button", { name: t("update.cancel"), exact: true }).click();
      await expect(dialog.getByText(t("update.cancelled"), { exact: true })).toBeVisible();
      assert.equal(await actionCount(page, "install"), 2);
      checks.push("explicit install; renewed busy consent; indeterminate install; independent cancel");

      await publish(page, { phase: "failed", canCancel: false, canInstall: false, canReveal: false, message: "The update failed. Your previous installation was restored." });
      await dialog.getByRole("button", { name: closeName, exact: true }).click();
      await open(page, "recovery");
      await expect(dialog.getByText(t("update.failed"), { exact: true })).toBeVisible();
      await expect(dialog.getByRole("link", { name: t("update.release"), exact: true })).toHaveAttribute("href", LATEST_RELEASE_PAGE);
      assert.equal(await actionCount(page, "check"), 1);
      await assertDialogGeometry(page, title);
      await page.screenshot({ path: join(root, `${label}-recovery.png`) });
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(page.getByRole("button", { name: `${title} · v${status.version}`, exact: true })).toBeFocused();
      checks.push("recovery preserves failed snapshot; Release link; Escape restores header focus");

      await page.getByRole("button", { name: t("home.settings"), exact: true }).click();
      const settings = page.getByRole("dialog", { name: t("settings.title"), exact: true });
      await expect(settings).toBeVisible();
      await open(page, "recovery");
      await expect(dialog).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(settings).toBeVisible();
      assert(await settings.evaluate(element => element.contains(document.activeElement)), "Focus must return to the retained Settings layer");
      await settings.getByRole("button", { name: t("settings.config.entry"), exact: true }).click();
      const configBack = page.getByRole("button", { name: t("config.backToSettings"), exact: true });
      await expect(configBack).toBeVisible();
      await configBack.focus();
      await open(page, "recovery");
      await expect(dialog).toBeVisible();
      await expect(configBack).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(configBack).toBeFocused();
      await configBack.click();
      await settings.getByRole("button", { name: closeName, exact: true }).click();
      checks.push("tray request overlays retained Settings/Config with inert background and restored focus");

      if (width === 1280) {
        await open(page, "recovery");
        await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
        await assertDialogGeometry(page, title);
        await page.screenshot({ path: join(root, "zoom-200.png") });
        await page.evaluate(() => { document.documentElement.style.zoom = ""; });
        await page.emulateMedia({ forcedColors: "active" });
        await assertDialogGeometry(page, title);
        await page.screenshot({ path: join(root, "forced-colors.png") });
        checks.push("200% CSS zoom and forced colors");
      }
      assert.deepEqual(unexpectedUpdateRequests, []);
      assert.equal(await page.evaluate(() => (window as unknown as FixtureWindow).updateFixture.openListeners), 1);
    } catch (error) {
      await page.screenshot({ path: join(root, `${label}-failure.png`) }).catch(() => {});
      writeFileSync(join(root, `${label}-failure.txt`), await page.locator("body").innerText().catch(() => ""));
      throw error;
    } finally { await context.close(); context = undefined; }
  }
  assert.deepEqual(report.browserErrors, []);
  report.passed = true;
} catch (error) { primary = error; report.error = String(error); }
finally {
  const results = await Promise.allSettled([
    (async () => { await context?.close(); await browser?.close(); })(),
    custody.stopAndVerify(),
  ]);
  report.cleanupErrors = results.flatMap(result => result.status === "rejected" ? [String(result.reason)] : []);
  if (report.cleanupErrors.length) report.passed = false;
  writeFileSync(join(root, "report.json"), JSON.stringify(report, null, 2));
}
if (primary) throw primary;
assert(report.passed, JSON.stringify(report.cleanupErrors));
console.log(`UPDATE_DIALOG_BROWSER passed: ${root}/report.json`);
