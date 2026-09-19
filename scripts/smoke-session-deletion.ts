import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect, type Page } from "@playwright/test";
import { preview } from "vite";
import type { SessionSummaryDto, StatusDto } from "../src/web/contracts";
import { createSmokeDaemonCustody, finishSmokeCleanup } from "./smoke-release-support";

// No supplied origin is accepted: compiled mode owns its daemon and all its state.
// With no binary argument, only the rebuilt Vite bundle + intercepted API cases run.
assert(process.argv.length <= 3, "Usage: bun scripts/smoke-session-deletion.ts [native-binary]");
const binary = process.argv[2] ? resolve(process.argv[2]) : undefined;
const artifacts = mkdtempSync(join(tmpdir(), "easyresearch-deletion-browser-"));
const home = join(artifacts, "home");
const agentDir = join(artifacts, "agent");
const project = join(artifacts, "project");
const emptyPath = join(artifacts, "empty-path");
for (const path of [home, agentDir, project, emptyPath]) mkdirSync(path);
// The parent uses Pi only to write isolated fixtures, never to run a model.
Object.assign(process.env, { HOME: home, USERPROFILE: home, EASYRESEARCH_CODING_AGENT_DIR: agentDir });
const daemonEnv = {
  HOME: home, USERPROFILE: home, EASYRESEARCH_CODING_AGENT_DIR: agentDir,
  PATH: emptyPath, NO_PROXY: "localhost,127.0.0.1,::1", LANG: "C.UTF-8",
};
const evidence: unknown[] = [];
console.log(`SESSION_DELETION_SMOKE artifacts: ${artifacts}`);
let origin = "";
let server: Awaited<ReturnType<typeof preview>> | undefined;
let daemon: ReturnType<typeof createSmokeDaemonCustody> | undefined;
let primaryError: Error | undefined;

async function runCli(args: string[], label: string): Promise<void> {
  assert(binary);
  const child = Bun.spawn([binary, ...args], {
    cwd: project, env: daemonEnv, stdin: "ignore",
    stdout: Bun.file(join(artifacts, `${label}-stdout.txt`)),
    stderr: Bun.file(join(artifacts, `${label}-stderr.txt`)),
  });
  const timer = setTimeout(() => child.kill(), 30_000);
  try { assert.equal(await child.exited, 0, `${label} failed; see ${artifacts}`); }
  finally { clearTimeout(timer); }
}

async function noOverflow(page: Page): Promise<void> {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Horizontal page overflow");
}

try {
  if (binary) {
    evidence.push({ binary, sha256: createHash("sha256").update(readFileSync(binary)).digest("hex") });
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = probe.port!;
    probe.stop(true);
    assert.notEqual(port, 3000);
    origin = `http://127.0.0.1:${port}`;
    daemon = createSmokeDaemonCustody({ agentDir, host: "127.0.0.1", port });
    // Visual acceptance needs no Python/model calls. This does not replace the
    // mandatory smoke-release first-run venv and no-Node/Bun acceptance chain.
    await runCli(["--no-open", "--port", String(port)], "startup");
    assert(await daemon.capture(), "Browser smoke daemon did not publish verified ownership");
    const status = await fetch(`${origin}/api/status`, { signal: AbortSignal.timeout(10_000) }).then((r) => r.json()) as StatusDto;
    assert.equal(status.agentDir, agentDir, "Refuse any daemon outside this smoke's private root");
  } else {
    server = await preview({
      configFile: resolve(import.meta.dir, "../src/webui/vite.config.ts"),
      preview: { host: "127.0.0.1", port: 0, open: false, proxy: {} },
    });
    const address = server.httpServer.address();
    assert(address && typeof address !== "string");
    origin = `http://127.0.0.1:${address.port}`;
  }
  const browser = await chromium.launch({
    channel: "chrome", headless: true, args: ["--no-proxy-server"],
    env: { ...process.env, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache") },
  });
  const deadline = setTimeout(() => void browser.close(), 120_000);
  try {
    evidence.push({ chrome: browser.version(), origin });
    for (const width of [1440, 390]) {
      const context = await browser.newContext({
        viewport: { width, height: 900 }, locale: "en-US", isMobile: width === 390, hasTouch: width === 390,
      });
      await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      const errors: string[] = [];
      const unexpected: string[] = [];
      const requests: Array<{ id: string; force: boolean }> = [];
      const fixtureCwd = "/isolated/session-deletion/project";
      const summary = (id: string, name: string): SessionSummaryDto => ({
        id, name, cwd: fixtureCwd, path: `/isolated/agent/sessions/${id}.jsonl`,
        created: new Date().toISOString(), modified: new Date().toISOString(), firstMessage: name, messageCount: 2,
      });
      let sessions = [summary("busy", "Stale idle session"), summary("recent", "Recent session"), summary("running", "Running session")];
      let activeSessions: StatusDto["activeSessions"] = [{
        id: "running", cwd: fixtureCwd, sessionName: "Running session", sessionFile: sessions[2]!.path,
        status: "running", isStreaming: true,
      }];
      let releaseDelete: (() => void) | undefined;
      let holdDelete = false;
      let failRecent = true;
      const workers: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("worker", (worker) => workers.push(worker.url()));
      // Mobile also proves the synchronous Markdown path in the rebuilt bundle.
      if (width === 390) await page.addInitScript(() => Object.defineProperty(window, "Worker", { value: undefined }));
      await page.route("**/api/**", async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (request.method() === "DELETE" && /^\/api\/sessions\/[^/]+$/.test(path)) {
          const id = path.split("/").at(-1)!;
          const body = request.postDataJSON() as { force: boolean };
          requests.push({ id, force: body.force });
          if (id === "busy" && !body.force) return route.fulfill({ status: 409, json: { code: "SESSION_BUSY", error: "Active work exists" } });
          if (id === "recent" && failRecent) {
            failRecent = false;
            return route.fulfill({ status: 500, json: { error: "Deletion fixture failed; retry" } });
          }
          if (holdDelete) await new Promise<void>((done) => { releaseDelete = done; });
          sessions = sessions.filter((session) => session.id !== id);
          activeSessions = activeSessions.filter((session) => session.id !== id);
          return route.fulfill({ status: 204 });
        }
        const snapshot = {
          session: { id: "work", cwd: fixtureCwd, status: "ready", isStreaming: false },
          timeline: [{ kind: "message", entryId: "md", message: { role: "assistant", content: [{ type: "text", text: "**Preserved transcript** with $x^2$." }], timestamp: 1 } }],
          subagents: [], runtimeConfigurationGeneration: 0, compactionPolicy: { enabled: true, triggerPercent: 70 },
        };
        if (path.endsWith("/events")) {
          const events = path === "/api/config/events" ? [] : [
            { type: "snapshot", ...snapshot },
            { type: "session_deleted", sessionId: "work" },
            { type: "snapshot", ...snapshot, session: { ...snapshot.session, status: "running", isStreaming: true }, timeline: [{ kind: "message", entryId: "late", message: { role: "user", content: "STALE_RESURRECTION", timestamp: 2 } }] },
          ];
          return route.fulfill({ contentType: "text/event-stream", body: `retry: 60000\n\n${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}` });
        }
        const fixtures: Record<string, unknown> = {
          "/api/status": { bootId: "deletion-fixture", agentDir: "/isolated/agent", homeDir: fixtureCwd, sessions, activeSessions },
          "/api/update-check": { latestVersion: null }, "/api/settings/api-usage": { showApiUsageDetails: true },
          "/api/agents": [], "/api/models": { models: [] }, "/api/entries": { entries: [] },
          "/api/sessions/work/commands": { commands: [] }, "/api/sessions/work/snapshot": snapshot,
          "/api/sessions/work/tree": { tree: [], leafId: null, treeFilterMode: "default", branchSummary: { skipPrompt: false } },
        };
        if (!(path in fixtures)) {
          unexpected.push(`${request.method()} ${path}`);
          return route.fulfill({ status: 500, json: { error: "Unexpected smoke request" } });
        }
        return route.fulfill({ json: fixtures[path] });
      });
      try {
        await page.goto(origin);
        const active = page.getByRole("region", { name: "Active sessions", exact: true });
        const recent = page.getByRole("region", { name: "Recent sessions", exact: true });
        const runningDelete = active.getByRole("button", { name: "Delete session: Running session", exact: true });
        const busyDelete = recent.getByRole("button", { name: "Delete session: Stale idle session", exact: true });
        const dialog = page.getByRole("dialog", { name: "Delete session", exact: true });
        const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
        await runningDelete.focus();
        await page.keyboard.press("Enter");
        await expect(cancel).toBeFocused();
        await expect(dialog.getByRole("button", { name: "Stop and delete", exact: true })).toBeVisible();
        await page.keyboard.press("Tab");
        await expect(dialog.getByRole("button", { name: "Stop and delete", exact: true })).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(cancel).toBeFocused();
        await page.keyboard.press("Shift+Tab");
        await expect(dialog.getByRole("button", { name: "Stop and delete", exact: true })).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        await expect(runningDelete).toBeFocused();
        assert.equal(requests.length, 0, "Cancel must not DELETE or open the row");
        await runningDelete.click();
        await page.mouse.click(2, 2);
        await expect(dialog).toHaveCount(0);
        await busyDelete.click();
        await expect(cancel).toBeFocused();
        await expect(dialog).toContainText("Project files are kept");
        await dialog.getByRole("button", { name: "Delete", exact: true }).click();
        const force = dialog.getByRole("button", { name: "Stop and delete", exact: true });
        await expect(force).toBeVisible();
        assert.deepEqual(requests, [{ id: "busy", force: false }], "Busy response must wait for a second user confirmation");
        await noOverflow(page);
        await page.screenshot({ path: join(artifacts, `fixture-${width}-busy.png`) });
        await cancel.click();
        await expect(busyDelete).toBeVisible();
        assert.equal(requests.length, 1);
        await busyDelete.click();
        await dialog.getByRole("button", { name: "Delete", exact: true }).click();
        await expect(force).toBeVisible();
        holdDelete = true;
        await force.click();
        await expect(dialog).toHaveAttribute("aria-busy", "true");
        await expect(cancel).toBeDisabled();
        await expect(dialog.getByRole("button", { name: "Deleting...", exact: true })).toBeDisabled();
        await page.keyboard.press("Escape");
        await page.mouse.click(2, 2);
        await page.keyboard.press("Tab");
        await page.keyboard.press("Enter");
        await expect(dialog).toBeVisible();
        assert(await dialog.evaluate((element) => element.contains(document.activeElement)), "Pending focus escaped modal");
        assert.deepEqual(requests.slice(1), [{ id: "busy", force: false }, { id: "busy", force: true }]);
        await noOverflow(page);
        assert(releaseDelete);
        releaseDelete();
        holdDelete = false;
        await expect(dialog).toHaveCount(0);
        await expect(busyDelete).toHaveCount(0);
        await recent.getByRole("button", { name: "Delete session: Recent session", exact: true }).click();
        await dialog.getByRole("button", { name: "Delete", exact: true }).click();
        await expect(dialog.getByRole("alert")).toContainText("Deletion fixture failed");
        await dialog.getByRole("button", { name: "Retry deletion", exact: true }).click();
        await expect(dialog).toHaveCount(0);
        await page.getByRole("button", { name: fixtureCwd, exact: true }).click();
        await runningDelete.click();
        await dialog.getByRole("button", { name: "Stop and delete", exact: true }).click();
        await expect(page.getByRole("heading", { name: "All projects", exact: true })).toBeVisible();
        assert.deepEqual(requests.slice(3), [{ id: "recent", force: false }, { id: "recent", force: false }, { id: "running", force: true }]);
        await noOverflow(page);
        await page.screenshot({ path: join(artifacts, `fixture-${width}-home.png`) });
        await page.goto(`${origin}/#/work/work?cwd=${encodeURIComponent(fixtureCwd)}`);
        await expect(page.getByText("This session was deleted.", { exact: true })).toBeVisible();
        await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeDisabled();
        await expect(page.getByText("STALE_RESURRECTION", { exact: true })).toHaveCount(0);
        await expect(page.locator(".katex")).toBeVisible();
        if (width === 1440) assert(workers.some((url) => url.startsWith(`${origin}/assets/`) && url.endsWith(".js")), "Hashed Markdown Worker missing");
        else assert.deepEqual(workers, [], "Fallback must not start a Worker");
        await noOverflow(page);
        await page.screenshot({ path: join(artifacts, `fixture-${width}-deleted.png`) });
        assert.deepEqual(errors, []);
        assert.deepEqual(unexpected, []);
        evidence.push({ mode: "intercepted-api", width, requests, workers, assertions: "both Home lists; cancel/Escape/backdrop; focus/wrap/restore; explicit busy escalation; pending dismissal/duplicate guard; retry; project reconciliation; terminal Work defeats late snapshot; no horizontal overflow" });
      } finally {
        releaseDelete?.();
        await context.tracing.stop({ path: join(artifacts, `fixture-${width}-trace.zip`) });
        await context.close();
      }
    }

    if (binary) {
      const { importPi } = await import("../src/runtime/pi-import");
      const pi = await importPi();
      const createHistory = (name: string) => {
        const manager = pi.SessionManager.create(project);
        manager.appendMessage({ role: "user", content: name, timestamp: Date.now() });
        manager.appendMessage({
          role: "assistant", content: [{ type: "text", text: "**Browser acceptance** with $x^2$." }],
          api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "stop", timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        });
        manager.appendSessionInfo(name);
        const path = manager.getSessionFile();
        assert(path && existsSync(path));
        return { manager, id: manager.getSessionId(), path, name };
      };
      const sibling = createHistory("Unrelated same-cwd history");
      const siblingBytes = readFileSync(sibling.path);
      const sentinelPath = join(project, "manuscript.md");
      writeFileSync(sentinelPath, "Keep project files unchanged.\n", { flag: "wx" });
      for (const width of [1440, 390]) {
        const root = createHistory(`Real deletion ${width}`);
        const child = createHistory("easyresearch:search");
        root.manager.appendCustomEntry("easyresearch:subagent_session_alias", {
          id: "search_0", agent: "search", sessionId: child.id, sessionPath: child.path,
        });
        const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "en-US", isMobile: width === 390, hasTouch: width === 390 });
        await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
        // Only the informational external update check is intercepted in real-API mode.
        await context.route("**/api/update-check", (route) => route.fulfill({ json: { latestVersion: null } }));
        const work = await context.newPage();
        const homePage = await context.newPage();
        const errors: string[] = [];
        const mutations: string[] = [];
        for (const page of [work, homePage]) {
          page.setDefaultTimeout(10_000);
          page.on("pageerror", (error) => errors.push(error.message));
          page.on("request", (request) => {
            if (request.method() !== "GET") mutations.push(`${request.method()} ${new URL(request.url()).pathname}`);
          });
        }
        try {
          await work.goto(`${origin}/#/work/${root.id}?cwd=${encodeURIComponent(project)}`);
          const composer = work.getByRole("textbox", { name: "Message", exact: true });
          await expect(composer).toBeEnabled();
          await composer.fill("Draft must never be sent after deletion");
          if (width === 390) {
            const stopped = await context.request.post(`${origin}/api/sessions/${root.id}/stop`);
            assert.equal(stopped.status(), 200);
            const status = await context.request.get(`${origin}/api/status`).then((response) => response.json()) as StatusDto;
            assert(!status.activeSessions.some((session) => session.id === root.id));
            await expect(composer).toBeEnabled();
          }
          await homePage.goto(origin);
          const section = homePage.getByRole("region", { name: width === 390 ? "Recent sessions" : "Active sessions", exact: true });
          const trash = section.getByRole("button", { name: `Delete session: ${root.name}`, exact: true });
          await trash.click();
          const dialog = homePage.getByRole("dialog", { name: "Delete session", exact: true });
          await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
          assert(existsSync(root.path) && existsSync(child.path), "Real cancellation removed history");
          assert(!mutations.some((request) => request.startsWith("DELETE ")));
          await trash.click();
          const response = homePage.waitForResponse((response) => response.url() === `${origin}/api/sessions/${root.id}` && response.request().method() === "DELETE");
          await dialog.getByRole("button", { name: "Delete", exact: true }).click();
          assert.equal((await response).status(), 204);
          await expect(trash).toHaveCount(0);
          await expect(work.getByText("This session was deleted.", { exact: true })).toBeVisible();
          await expect(composer).toBeDisabled();
          assert(!existsSync(root.path) && !existsSync(child.path));
          assert.deepEqual(readFileSync(sibling.path), siblingBytes);
          assert.equal(readFileSync(sentinelPath, "utf8"), "Keep project files unchanged.\n");
          const baseline = mutations.length;
          await composer.press("Enter");
          assert(!mutations.slice(baseline).some((request) => /sessions\/(open|.*\/messages)$/.test(request)), "Deleted Work attempted automatic reopen/send");
          const stale = await context.request.post(`${origin}/api/sessions/open`, { data: { path: root.path } });
          assert.equal(stale.status(), 404);
          assert(!existsSync(root.path));
          await noOverflow(homePage);
          await noOverflow(work);
          await work.screenshot({ path: join(artifacts, `real-${width}-deleted.png`) });
          await homePage.screenshot({ path: join(artifacts, `real-${width}-home.png`) });
          await work.getByRole("button", { name: "Back to home", exact: true }).click();
          await expect(work.getByRole("heading", { name: "All projects", exact: true })).toBeVisible();
          assert.deepEqual(errors, []);
          evidence.push({ mode: "real-compiled-api-pi-seeded-history", width, root: root.path, child: child.path, sibling: sibling.path, mutations, assertions: "Cancel preserves files; HTTP DELETE 204; root+child absent; sibling/sentinel byte-preserved; subscribed Work terminal after live/disconnected deletion; old-path reopen 404; Home navigation; no overflow" });
        } finally {
          await context.tracing.stop({ path: join(artifacts, `real-${width}-trace.zip`) });
          await context.close();
        }
      }
    }
  } finally {
    clearTimeout(deadline);
    await browser.close();
  }
} catch (error) {
  primaryError = error instanceof Error ? error : new Error(String(error));
}
await finishSmokeCleanup({
  primaryError,
  writeDiagnostics: () => writeFileSync(join(artifacts, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`),
  shutdown: async () => { if (daemon && await daemon.capture()) await runCli(["exit"], "shutdown"); },
  stopAuxiliary: async () => {
    const httpServer = server?.httpServer;
    if (httpServer) await new Promise<void>((done, reject) => httpServer.close((error) => error ? reject(error) : done()));
  },
  verifyDaemonStopped: async () => { await daemon?.stopAndVerify(); },
  removeRoot: () => {}, // Preserve screenshots, traces and isolated state as acceptance evidence.
});
console.log(`SESSION_DELETION_SMOKE passed (${binary ? "compiled assets + real API and intercepted edge cases" : "rebuilt assets + intercepted API only"}). Artifacts: ${artifacts}`);
