import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { chromium, expect, type Page } from "@playwright/test";
import { importPi } from "../src/runtime/pi-import";
import { en } from "../src/webui/src/i18n/messages";
import { assertMigratedWorkspacePreserved, contradictMigratedWorkspace, createMigratedWorkspaceSmokeFixture,
  createWorkspaceSmokeFixture, observeMigrationRemoval, type MigratedWorkspaceSmokeFixture } from "./smoke-workspace-management";

// Real compiled APIs and disk effects; no API or event mocking and no user profile.
const binary = resolve(process.argv[2] ?? "release/easyresearch-linux-x64/bin/easyresearch");
const artifacts = realpathSync(mkdtempSync(join(tmpdir(), "easyresearch-workspace-browser-")));
const runtime = join(artifacts, "runtime");
const home = join(runtime, "home");
const agentDir = join(home, ".easyresearch", "agent");
const emptyPath = join(runtime, "empty-path");
for (const path of [home, agentDir, emptyPath]) mkdirSync(path, { recursive: true });
assert.equal(Bun.which("node", { PATH: emptyPath }), null);
assert.equal(Bun.which("bun", { PATH: emptyPath }), null);
const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, EASYRESEARCH_CODING_AGENT_DIR: agentDir,
  XDG_CONFIG_HOME: join(runtime, "config"), XDG_CACHE_HOME: join(runtime, "cache"), PATH: emptyPath };
delete env.EASYRESEARCH_SKIP_SETUP;
process.env.HOME = home;
process.env.EASYRESEARCH_CODING_AGENT_DIR = agentDir;
const pi = await importPi();
// A local streaming provider keeps a real AgentSession busy. Deletion, lifecycle
// admission, HTTP responses and modal state all run through the compiled daemon.
let modelRequests = 0;
const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
const provider = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, async fetch(request) {
  assert.equal(new URL(request.url).pathname, "/v1/chat/completions");
  await request.json();
  modelRequests++;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  return new Response(new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      streams.add(value);
      value.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: "workspace-busy", object: "chat.completion.chunk",
        created: 1, model: "workspace-busy", choices: [{ index: 0, delta: { role: "assistant", content: "Synthetic busy work" }, finish_reason: null }] })}\n\n`));
    },
    cancel() { streams.delete(controller); },
  }), { headers: { "Content-Type": "text/event-stream" } });
} });
writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { "workspace-smoke": {
  baseUrl: `http://127.0.0.1:${provider.port}/v1`, api: "openai-completions", apiKey: "synthetic-key",
  compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
  models: [{ id: "workspace-busy", name: "Workspace busy smoke", contextWindow: 32000, maxTokens: 2048 }],
} } }));
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "workspace-smoke", defaultModel: "workspace-busy",
  easyresearch: { agentDefaults: { "research-assistant": { model: "workspace-smoke/workspace-busy", thinking: "off" } } } }));
const portProbe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("probe") });
const port = portProbe.port!;
portProbe.stop(true);
const origin = `http://127.0.0.1:${port}`;
const request = async (path: string, body?: unknown) => {
  const response = await fetch(`${origin}${path}`, { method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const value = await response.json();
  assert(response.ok, `${path}: ${JSON.stringify(value)}`);
  return value;
};
const openDeletion = async (page: Page, fixture: MigratedWorkspaceSmokeFixture, mode: "workspace" | "individual", width: number) => {
  await page.goto(origin);
  await page.reload();
  if (width < 820) await page.getByRole("combobox", { name: "Workspaces", exact: true }).selectOption(fixture.cwd);
  else await page.getByRole("button", { name: fixture.cwd, exact: true }).click();
  const missing = page.getByRole("dialog", { name: "Workspace folder not found", exact: true });
  await expect(missing).toBeVisible();
  if (mode === "workspace") {
    await missing.getByRole("button", { name: "Delete workspace", exact: true }).click();
  } else {
    await missing.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: `Delete session: ${fixture.name}`, exact: true }).click();
  }
  return page.getByRole("dialog", { name: mode === "workspace" ? "Delete workspace" : "Delete session", exact: true });
};
const deletionResponse = (page: Page, fixture: MigratedWorkspaceSmokeFixture, mode: "workspace" | "individual") =>
  page.waitForResponse((response) => response.request().method() === "DELETE"
    && new URL(response.url()).pathname === (mode === "workspace" ? "/api/workspaces" : `/api/sessions/${fixture.parent.id}`));
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const start = spawnSync(binary, ["--no-open", "--port", String(port)], { env, cwd: home, encoding: "utf8", timeout: 90_000 });
  writeFileSync(join(artifacts, "startup.log"), `${start.stdout}\n${start.stderr}`);
  assert.equal(start.status, 0, start.error?.message ?? start.stderr);
  assert.equal((await request("/api/status")).agentDir, agentDir);
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
      for (const mode of ["workspace", "individual"] as const) {
        const migrated = createMigratedWorkspaceSmokeFixture(pi, home, `${width}-${mode}`);
        const unrelatedBefore = readFileSync(migrated.unrelated.path);
        await request("/api/sessions/open", { path: migrated.unrelated.path });
        const beforeRequests = modelRequests;
        await request(`/api/sessions/${migrated.unrelated.id}/messages`, { message: "Hold synthetic busy work for deletion acceptance" });
        await expect.poll(() => modelRequests, { timeout: 15_000 }).toBe(beforeRequests + 1);
        const dialog = await openDeletion(page, migrated, mode, width);
        const action = mode === "workspace" ? "Delete workspace" : "Delete";
        const busyResponse = deletionResponse(page, migrated, mode);
        await dialog.getByRole("button", { name: action, exact: true }).click();
        const busy = await busyResponse;
        const busyBody = await busy.json();
        assert.equal(busy.status(), 409);
        assert.equal(busy.request().postDataJSON().force, false);
        assert.equal(busyBody.code, mode === "workspace" ? "WORKSPACE_BUSY" : "SESSION_BUSY");
        assert(busyBody.affectedCwds.includes(migrated.currentCwd));
        await expect(dialog).toContainText("Active work in these workspaces will also stop:");
        await expect(dialog.getByRole("listitem")).toContainText(migrated.currentCwd);
        assert.deepEqual(readFileSync(migrated.parent.path), migrated.originals.get(migrated.parent.path));
        assert.deepEqual(readFileSync(migrated.child.path), migrated.originals.get(migrated.child.path));
        await page.screenshot({ path: join(artifacts, `migration-busy-${mode}-${width}.png`), fullPage: true });
        const observation = observeMigrationRemoval(migrated);
        try {
          const successResponse = deletionResponse(page, migrated, mode);
          await dialog.getByRole("button", { name: mode === "workspace" ? "Stop and continue" : "Stop and delete", exact: true }).click();
          const success = await successResponse;
          assert.equal(success.status(), mode === "workspace" ? 200 : 204);
          assert.equal(success.request().postDataJSON().force, true);
          assert.deepEqual(new Set(success.request().postDataJSON().expectedCwds), new Set(busyBody.affectedCwds),
            "Explicit confirmation must echo every disclosed cwd");
          if (mode === "workspace") assert.deepEqual((await success.json()).sessionIds, [migrated.child.id, migrated.parent.id]);
          await expect(dialog).toBeHidden();
          await observation.assertChildFirst(Date.now() + 5_000);
        } finally { observation.close(); }
        // Stopping the unrelated active writer appends its terminal response, but
        // must retain its original conversation and physical file.
        const unrelatedAfter = readFileSync(migrated.unrelated.path);
        assert.deepEqual(unrelatedAfter.subarray(0, unrelatedBefore.length), unrelatedBefore);
        migrated.originals.set(migrated.unrelated.path, unrelatedAfter);
        assertMigratedWorkspacePreserved(migrated);
        assert(!(await request("/api/status")).activeSessions.some((session: { id: string }) => session.id === migrated.unrelated.id));
        await expect(page.getByRole("button", { name: `Delete session: ${migrated.name}`, exact: true })).toHaveCount(0);
        report.push({ width, theme, migration: mode, affectedCwd: migrated.currentCwd,
          unlinkOrderObserved: observation.observesUnlinkOrder, passed: true });
      }
      assert.deepEqual(errors, []);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Workspace controls overflow the viewport");
      report.push({ width, theme, passed: true, sessionId: fixture.parent.id });
      console.log(`[workspace-browser] ${theme} ${width}px rename, recovery, migration deletion and explicit additional-scope busy confirmation passed`);
    } finally { await context.close(); }
  }
  // Contradictory aliases remain on disk, so run these last rather than masking
  // the persistent conflict by repairing the fixture between requests.
  const conflict = createMigratedWorkspaceSmokeFixture(pi, home, "browser-conflict");
  contradictMigratedWorkspace(conflict);
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "en-US", hasTouch: width < 820 });
    try {
      await context.addInitScript(() => localStorage.setItem("easyresearch.webui.preferences", JSON.stringify({ language: "en" })));
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      for (const mode of ["workspace", "individual"] as const) {
        const dialog = await openDeletion(page, conflict, mode, width);
        for (let attempt = 0; attempt < 2; attempt++) {
          const pending = deletionResponse(page, conflict, mode);
          await dialog.getByRole("button", { name: mode === "workspace" ? "Delete workspace" : "Delete", exact: true }).click();
          const response = await pending;
          assert.equal(response.status(), 409);
          assert.equal((await response.json()).code, "SESSION_HISTORY_CONFLICT");
          await expect(dialog.getByRole("alert")).toHaveText(en["history.conflict"]);
          await expect(dialog.getByRole("alert")).not.toContainText(/refresh/i);
          await expect(dialog.getByRole("button", { name: /Stop and/ })).toHaveCount(0);
          assertMigratedWorkspacePreserved(conflict, true);
        }
        await page.screenshot({ path: join(artifacts, `migration-conflict-${mode}-${width}.png`), fullPage: true });
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        report.push({ width, migration: mode, conflict: "SESSION_HISTORY_CONFLICT", retries: 2, noDeletion: true });
      }
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
  writeFileSync(join(artifacts, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
} finally {
  await browser?.close();
  const stop = spawnSync(binary, ["exit"], { env, cwd: home, encoding: "utf8", timeout: 30_000 });
  writeFileSync(join(artifacts, "shutdown.log"), `${stop.stdout}\n${stop.stderr}`);
  for (const stream of streams) { try { stream.close(); } catch {} }
  provider.stop(true);
  assert.equal(stop.status, 0, stop.error?.message ?? stop.stderr);
  rmSync(runtime, { recursive: true, force: true });
  console.log(`[workspace-browser] evidence: ${artifacts}`);
}
