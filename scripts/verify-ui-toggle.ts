#!/usr/bin/env bun
/**
 * Rebuild and verify the Web UI using isolated API fixtures and a temporary browser:
 *   bun run verify:ui-toggle
 * Or check already-built assets from an isolated compiled daemon (all APIs are intercepted):
 *   bun run verify:ui-toggle http://127.0.0.1:3004
 *   bun run verify:ui-toggle 3004
 * Set COMPARE_CHROMIUM_PATH when using an existing Chromium executable.
 * Screenshots and a trace are retained in the printed temporary artifact directory.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect, type Page } from "@playwright/test";
import { preview } from "vite";

const argument = process.argv[2];
const suppliedUrl = argument ? new URL(/^\d+$/.test(argument) ? `http://127.0.0.1:${argument}` : argument) : undefined;
if (suppliedUrl) {
  assert(["http:", "https:"].includes(suppliedUrl.protocol) && !suppliedUrl.username && !suppliedUrl.password
    && suppliedUrl.pathname === "/" && !suppliedUrl.search && !suppliedUrl.hash, "Supply an isolated HTTP(S) origin or port");
}
const configFile = resolve(import.meta.dir, "../src/webui/vite.config.ts");
if (!suppliedUrl) {
  const built = spawnSync(process.execPath, ["run", "build:web"], { cwd: resolve(import.meta.dir, ".."), stdio: "inherit" });
  if (built.error) throw built.error;
  assert.equal(built.status, 0, "Web rebuild must succeed before browser verification");
}
const artifacts = mkdtempSync(join(tmpdir(), "easyresearch-ui-toggle-"));
console.log(`UI_TOGGLE_VERIFY artifacts: ${artifacts}`);
const server = suppliedUrl ? undefined : await preview({
  configFile,
  preview: { host: "127.0.0.1", port: 0, open: false, proxy: {} },
});

async function assertHome(page: Page) {
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.getByRole("region", { name: "Research workspace", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "New project", exact: true })).toBeVisible();
  await expect(page.getByText("Config browser", { exact: true })).toHaveCount(0);
}

async function assertConfig(page: Page) {
  await expect(page).toHaveURL(/#\/config\?returnTo=/);
  await expect(page.getByRole("banner").getByText("Config browser", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Back to Settings", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Global /fixture/agent", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Research workspace", exact: true })).toHaveCount(0);
}

async function chooseVersion(page: Page, version: "Current" | "Classic") {
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(settings).toBeVisible();
  if (!await settings.getByRole("button", { name: version, exact: true }).isVisible()) {
    await settings.getByRole("button", { name: /General/ }).click();
  }
  await settings.getByRole("button", { name: version, exact: true }).click();
  await expect(settings.getByRole("button", { name: version, exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("html")).toHaveAttribute("data-ui-version", version.toLowerCase());
}

async function assertChrome(page: Page, classic: boolean) {
  // Scope to the visible rail: App retains a hidden Home/Work beneath Config.
  await expect(page.getByRole("banner").getByTestId("product-logo")).toHaveCount(classic ? 0 : 1);
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", classic ? /^data:image\/svg\+xml,/ : "/favicon.svg");
}

async function assertTopbarHitAreas(page: Page, width: number) {
  const buttons = page.getByRole("banner").getByRole("button");
  await expect(buttons).toHaveCount(width < 820 ? 2 : 4);
  for (const button of await buttons.all()) {
    const geometry = await button.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const parent = element.parentElement!.getBoundingClientRect();
      return {
        label: element.getAttribute("aria-label"), width: rect.width,
        inside: rect.left >= parent.left && rect.right <= parent.right && rect.left >= 0 && rect.right <= innerWidth,
        hit: [0.5, rect.width / 2, rect.width - 0.5].every((x) => element.contains(document.elementFromPoint(rect.x + x, rect.y + rect.height / 2))),
      };
    });
    assert(geometry.width >= 28 && geometry.inside && geometry.hit, `Clipped/shrunk topbar action at ${width}px: ${JSON.stringify(geometry)}`);
  }
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "No horizontal page overflow");
}

try {
  const address = server?.httpServer.address();
  assert(suppliedUrl || (address && typeof address !== "string"));
  const origin = suppliedUrl?.origin ?? `http://127.0.0.1:${(address as { port: number }).port}`;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.COMPARE_CHROMIUM_PATH });
  const deadline = setTimeout(() => {
    console.error("UI_TOGGLE_VERIFY exceeded its browser deadline");
    void browser.close();
  }, 120_000);
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US", serviceWorkers: "block" });
    try {
      await context.tracing.start({ screenshots: true, snapshots: true });
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      const unexpected: string[] = [];
      const errors: string[] = [];
      const requests: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const sessions = [
        { id: "toggle-posix", cwd: `/papers/${"long-project-path/".repeat(9)}fault-diagnosis`, name: `POSIX session ${"long label ".repeat(12)}`.trim() },
        { id: "toggle-windows", cwd: `C:\\papers\\${"long-project-path\\".repeat(9)}fault-diagnosis`, name: `Windows session ${"long label ".repeat(12)}`.trim() },
      ].map((session) => ({ ...session, path: `/fixture/${session.id}.jsonl`, created: "2026-09-21T00:00:00.000Z", modified: "2026-09-21T00:00:00.000Z", messageCount: 2, firstMessage: "Isolated UI toggle fixture" }));
      const active = (id: string) => {
        const session = sessions.find((candidate) => candidate.id === id);
        assert(session, `Unknown fixture session: ${id}`);
        return { id, cwd: session.cwd, sessionFile: session.path, sessionName: session.name, status: "ready", isStreaming: false };
      };
      const snapshot = (id: string) => ({
        session: active(id), timeline: [], subagents: [], runtimeConfigurationGeneration: 0,
        compactionPolicy: { enabled: true, triggerPercent: 70 },
      });
      // No request in /api can reach a daemon, including unexpected mutations.
      await context.route("**/api/**", async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        const key = `${request.method()} ${path}`;
        requests.push(key);
        if (key === "GET /api/config/events") {
          return route.fulfill({ contentType: "text/event-stream", body: "retry: 60000\n\n" });
        }
        const sessionRoute = /^\/api\/sessions\/(toggle-posix|toggle-windows)\/(events|snapshot|commands|tree)$/.exec(path);
        if (request.method() === "GET" && sessionRoute) {
          const id = sessionRoute[1]!;
          switch (sessionRoute[2]) {
            case "events": return route.fulfill({ contentType: "text/event-stream", body: `retry: 60000\n\ndata: ${JSON.stringify({ type: "snapshot", ...snapshot(id) })}\n\n` });
            case "snapshot": return route.fulfill({ json: snapshot(id) });
            case "commands": return route.fulfill({ json: { commands: [] } });
            case "tree": return route.fulfill({ json: { tree: [], leafId: null, treeFilterMode: "default", branchSummary: { skipPrompt: false } } });
          }
        }
        if (key === "POST /api/sessions/open") {
          const selected = sessions.find((session) => session.path === request.postDataJSON().path);
          assert(selected, "Open must use an exact fixture path");
          return route.fulfill({ json: active(selected.id) });
        }
        const fixtures: Record<string, unknown> = {
          "GET /api/status": { bootId: "ui-toggle-fixture", agentDir: "/fixture/agent", homeDir: "/fixture", sessions, activeSessions: [] },
          "GET /api/update-check": { latestVersion: null },
          "GET /api/agents": [], "GET /api/models": { models: [] }, "GET /api/entries": { entries: [] },
          "GET /api/agent-resources": [], "GET /api/skill-resources": [], "GET /api/auth/providers": { providers: [] },
          "GET /api/config/projects": { home: "/fixture/agent", projects: sessions.map(({ cwd }) => ({ cwd })) },
          "GET /api/settings/api-usage": { showApiUsageDetails: true },
          "GET /api/settings/compaction": { triggerPercent: 70, globalEnabled: true },
          "GET /api/settings/network-proxy": { configured: {}, appliedConfigured: {}, sources: { all: "direct", llm: "direct", search: "direct" }, errors: [], restartRequired: false },
        };
        if (!(key in fixtures)) {
          unexpected.push(key);
          return route.fulfill({ status: 500, json: { error: "Unexpected UI toggle fixture request" } });
        }
        return route.fulfill({ json: fixtures[key] });
      });

      try {
        await page.goto(`${origin}/#/`);
        await assertHome(page);
        await assertChrome(page, false);
        await expect(page.getByTitle(sessions[0]!.name, { exact: true })).toBeVisible();
        const currentBlue = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--color-v2-blue-600").trim());
        await page.screenshot({ path: join(artifacts, "home-current.png"), fullPage: true });
        await page.getByRole("button", { name: "Settings", exact: true }).click();
        await expect(page.getByRole("button", { name: "Current", exact: true })).toHaveAttribute("aria-pressed", "true");
        await chooseVersion(page, "Classic");
        await page.getByRole("button", { name: "Close", exact: true }).click();
        await assertHome(page);
        await assertChrome(page, true);
        const classicBlue = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--color-v2-blue-600").trim());
        assert.equal(classicBlue, "#3b5cf6");
        assert.notEqual(currentBlue, classicBlue);
        await page.screenshot({ path: join(artifacts, "home-classic.png"), fullPage: true });
        await page.reload();
        await assertHome(page);
        await assertChrome(page, true);

        for (const version of ["Classic", "Current"] as const) {
          await page.getByRole("button", { name: "Settings", exact: true }).click();
          await chooseVersion(page, version);
          // Always re-enter Config after changing the preference in Settings.
          await page.getByRole("button", { name: /open config browser/i }).click();
          await assertConfig(page);
          await assertChrome(page, version === "Classic");
          await page.screenshot({ path: join(artifacts, `config-${version.toLowerCase()}.png`), fullPage: true });
          await page.getByRole("button", { name: "Back to Settings", exact: true }).click();
          await page.getByRole("button", { name: "Close", exact: true }).click();
          await assertHome(page);
          await page.getByRole("button", { name: `Delete session: ${sessions[0]!.name}`, exact: true }).click();
          await expect(page.getByRole("dialog", { name: "Delete session", exact: true })).toBeVisible();
          await page.getByRole("button", { name: "Cancel", exact: true }).click();
          await expect(page.getByTitle(sessions[0]!.name, { exact: true })).toBeVisible();
        }
        console.log("UI_TOGGLE_VERIFY Home/Config routes, preferences, reload and deletion parity passed");

        for (const session of sessions) {
          await page.setViewportSize({ width: 1440, height: 900 });
          await page.getByTitle(session.name, { exact: true }).click();
          const workHash = `#/work/${session.id}?cwd=${encodeURIComponent(session.cwd)}`;
          await expect.poll(() => new URL(page.url()).hash).toBe(workHash);
          const composer = page.getByRole("textbox", { name: /message/i });
          await expect(composer).toBeVisible();
          await composer.fill("Draft retained across interface switches");
          const streamCount = requests.filter((key) => key === `GET /api/sessions/${session.id}/events`).length;
          for (const version of ["Current", "Classic"] as const) {
            await page.getByRole("button", { name: "Settings", exact: true }).click();
            await chooseVersion(page, version);
            await page.getByRole("button", { name: "Close", exact: true }).click();
            await expect.poll(() => new URL(page.url()).hash).toBe(workHash);
            await assertChrome(page, version === "Classic");
            await expect(composer).toHaveValue("Draft retained across interface switches");
            assert.equal(requests.filter((key) => key === `GET /api/sessions/${session.id}/events`).length, streamCount);
            await page.screenshot({ path: join(artifacts, `${session.id}-${version.toLowerCase()}.png`) });
          }
          for (const width of [1024, 821, 820, 819]) {
            await page.setViewportSize({ width, height: 900 });
            await assertTopbarHitAreas(page, width);
            if (width >= 820) {
              const path = page.getByRole("banner").getByTitle(session.cwd, { exact: true });
              assert(await path.evaluate((element) => element.scrollWidth > element.clientWidth && getComputedStyle(element).textOverflow === "ellipsis"), "Long path must truncate");
              for (const label of ["Files browser", "Agent list"]) {
                const button = page.getByRole("button", { name: label, exact: true });
                const before = await button.getAttribute("aria-pressed");
                await button.click();
                await expect(button).toHaveAttribute("aria-pressed", before === "true" ? "false" : "true");
              }
            }
            await page.getByRole("button", { name: "Settings", exact: true }).click();
            await chooseVersion(page, "Classic");
            await page.getByRole("button", { name: "Close", exact: true }).click();
            await expect.poll(() => new URL(page.url()).hash).toBe(workHash);
            await page.screenshot({ path: join(artifacts, `${session.id}-${width}.png`) });
            console.log(`UI_TOGGLE_VERIFY ${session.id} width=${width} navigation/actions passed`);
          }
          await page.getByRole("button", { name: "Back to home", exact: true }).click();
          await assertHome(page);
        }
        assert.deepEqual(unexpected, []);
        assert.deepEqual(errors, []);
        console.log(`UI_TOGGLE_VERIFY passed. Screenshots/trace: ${artifacts}`);
      } catch (error) {
        await page.screenshot({ path: join(artifacts, "failure.png"), fullPage: true }).catch(() => undefined);
        throw error;
      } finally {
        await context.tracing.stop({ path: join(artifacts, "trace.zip") });
      }
    } finally { await context.close(); }
  } finally {
    clearTimeout(deadline);
    await browser.close();
  }
} finally {
  if (server) await new Promise<void>((done, reject) => server.httpServer.close((error) => error ? reject(error) : done()));
}
