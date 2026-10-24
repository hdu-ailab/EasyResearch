import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { importPi } from "../src/runtime/pi-import";
import { createWorkspaceSmokeFixture } from "./smoke-workspace-management";

// Real compiled APIs and disk effects; no API or event mocking and no user profile.
const binary = resolve(process.argv[2] ?? "release/easyresearch-linux-x64/bin/easyresearch");
const artifacts = realpathSync(mkdtempSync(join(tmpdir(), "easyresearch-workspace-browser-")));
const runtime = join(artifacts, "runtime");
const home = join(runtime, "home");
const agentDir = join(runtime, "agent");
const emptyPath = join(runtime, "empty-path");
for (const path of [home, agentDir, emptyPath]) mkdirSync(path, { recursive: true });
const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, EASYRESEARCH_CODING_AGENT_DIR: agentDir,
  XDG_CONFIG_HOME: join(runtime, "config"), XDG_CACHE_HOME: join(runtime, "cache"), PATH: emptyPath };
delete env.EASYRESEARCH_SKIP_SETUP;
process.env.HOME = home;
process.env.EASYRESEARCH_CODING_AGENT_DIR = agentDir;
const pi = await importPi();
const portProbe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("probe") });
const port = portProbe.port!;
portProbe.stop(true);
const origin = `http://127.0.0.1:${port}`;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const start = spawnSync(binary, ["--no-open", "--port", String(port)], { env, cwd: home, encoding: "utf8", timeout: 90_000 });
  writeFileSync(join(artifacts, "startup.log"), `${start.stdout}\n${start.stderr}`);
  assert.equal(start.status, 0, start.error?.message ?? start.stderr);
  browser = await chromium.launch({ channel: "chrome", executablePath: process.env.COMPARE_CHROMIUM_PATH, headless: true });
  const report: unknown[] = [];
  for (const [width, theme] of [[1440, "light"], [390, "dark"]] as const) {
    const fixture = createWorkspaceSmokeFixture(pi, runtime, `${width}-${theme}`);
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "en-US", hasTouch: width < 820 });
    try {
      await context.addInitScript((studioTheme) => localStorage.setItem("easyresearch.webui.preferences", JSON.stringify({ language: "en", studioTheme })), theme);
      const page = await context.newPage();
      const work = await context.newPage();
      const errors: string[] = [];
      for (const view of [page, work]) view.on("pageerror", (error) => errors.push(error.message));
      const workUrl = (cwd: string) => `${origin}/#/work/${fixture.parent.id}?cwd=${encodeURIComponent(cwd)}`;
      await work.goto(workUrl(fixture.cwd));
      await expect(work.getByText(`Workspace response ${width}-${theme}`, { exact: true })).toBeVisible();
      await page.goto(origin);
      if (width < 820) await page.getByRole("combobox", { name: "Workspaces", exact: true }).selectOption(fixture.cwd);
      await page.getByLabel(`Workspace actions: ${fixture.cwd}`, { exact: true }).click();
      await page.getByRole("button", { name: "Edit workspace name", exact: true }).click();
      const rename = page.getByRole("dialog", { name: "Edit workspace name", exact: true });
      const renamed = join(runtime, `renamed-${width}`);
      await rename.getByLabel("Folder name", { exact: true }).fill(basename(renamed));
      await rename.getByRole("button", { name: "Edit workspace name", exact: true }).click();
      await expect(rename).toBeHidden();
      await expect(work).toHaveURL(workUrl(renamed));
      await expect(work.getByText(`Workspace response ${width}-${theme}`, { exact: true })).toBeVisible();
      assert(!existsSync(fixture.cwd));
      assert.equal(readFileSync(join(renamed, "keep.txt"), "utf8"), fixture.sentinel);
      for (const entry of [fixture.parent, fixture.child]) {
        const header = JSON.parse(readFileSync(entry.path, "utf8").split("\n", 1)[0]!);
        assert.equal(header.id, entry.id);
        assert.equal(header.cwd, renamed);
      }
      const moved = join(runtime, `externally-moved-${width}`);
      renameSync(renamed, moved);
      // Reloading the actual Work deep link must recover, too.
      await work.reload();
      const recovery = work.getByRole("dialog", { name: "Workspace folder not found", exact: true });
      await expect(recovery).toBeVisible();
      await work.screenshot({ path: join(artifacts, `missing-${width}.png`), fullPage: true });
      await recovery.getByRole("button", { name: "Choose new folder", exact: true }).click();
      const picker = work.getByRole("dialog", { name: "Choose new folder", exact: true });
      await picker.getByRole("combobox").fill(moved);
      await picker.getByRole("combobox").press("Enter");
      await expect(picker.getByRole("button", { name: "Migrate and open", exact: true })).toBeEnabled();
      await picker.getByRole("button", { name: "Migrate and open", exact: true }).click();
      await expect(work).toHaveURL(workUrl(moved));
      await expect(work.getByText(`Workspace response ${width}-${theme}`, { exact: true })).toBeVisible();
      await expect(work.getByRole("dialog")).toHaveCount(0);
      await page.reload();
      if (width < 820) await page.getByRole("combobox", { name: "Workspaces", exact: true }).selectOption(moved);
      await page.getByLabel(`Workspace actions: ${moved}`, { exact: true }).click();
      await page.getByRole("button", { name: "Delete workspace", exact: true }).click();
      const deletion = page.getByRole("dialog", { name: "Delete workspace", exact: true });
      await expect(deletion).toContainText("project files are kept");
      await page.screenshot({ path: join(artifacts, `delete-${width}.png`), fullPage: true });
      await deletion.getByRole("button", { name: "Delete workspace", exact: true }).click();
      await expect(deletion).toBeHidden();
      await expect(page.getByLabel(`Workspace actions: ${moved}`, { exact: true })).toHaveCount(0);
      assert(!existsSync(fixture.parent.path));
      assert(!existsSync(fixture.child.path));
      assert.equal(readFileSync(join(moved, "keep.txt"), "utf8"), fixture.sentinel);
      assert.deepEqual(readFileSync(fixture.unrelated.path), fixture.originals.get(fixture.unrelated.path));
      assert.deepEqual(errors, []);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Workspace controls overflow the viewport");
      report.push({ width, theme, passed: true, sessionId: fixture.parent.id });
      console.log(`[workspace-browser] ${theme} ${width}px rename, live-tab relocation, deep-link recovery and history-only delete passed`);
    } finally { await context.close(); }
  }
  writeFileSync(join(artifacts, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
} finally {
  await browser?.close();
  const stop = spawnSync(binary, ["exit"], { env, cwd: home, encoding: "utf8", timeout: 30_000 });
  writeFileSync(join(artifacts, "shutdown.log"), `${stop.stdout}\n${stop.stderr}`);
  assert.equal(stop.status, 0, stop.error?.message ?? stop.stderr);
  rmSync(runtime, { recursive: true, force: true });
  console.log(`[workspace-browser] evidence: ${artifacts}`);
}
