import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { preview } from "vite";

// Optional origin verifies the compiled assets; API fixtures never use real user state.
const suppliedOrigin = process.argv[2];
const server = suppliedOrigin ? undefined : await preview({
  configFile: resolve(import.meta.dir, "../src/webui/vite.config.ts"),
  preview: { host: "127.0.0.1", port: 0, open: false, proxy: {} },
});
const artifacts = mkdtempSync(join(tmpdir(), "easyresearch-completion-browser-"));
try {
  const address = server?.httpServer.address();
  assert(suppliedOrigin || (address && typeof address !== "string"));
  const origin = suppliedOrigin ? new URL(suppliedOrigin).origin : `http://127.0.0.1:${(address as { port: number }).port}`;
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const deadline = setTimeout(() => void browser.close(), 90_000);
  try {
    for (const fallback of [false, true]) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      if (fallback) await page.addInitScript(() => Object.defineProperty(window, "Worker", { value: undefined }));
      const errors: string[] = [];
      const unexpected: string[] = [];
      const workers: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("worker", (worker) => workers.push(worker.url()));
      const firstSentence = `Verified the sources and the reproducible evidence ${"with supporting references ".repeat(18)}successfully.`;
      const completion = {
        kind: "subagent-completion", entryId: "completion-entry", batchId: "batch-0",
        timestamp: "2026-09-16T00:00:00.000Z",
        outcomes: [
          { launchId: "launch-0", agentId: "search_0", status: "complete", text: `${firstSentence} Second sentence stays collapsed.\n\n**Accepted evidence**\n\n| Source | Result |\n| --- | --- |\n| Paper A | Verified |\n\nMath: $x^2 + y^2$.` },
          { launchId: "launch-1", agentId: "review_0", status: "error" },
        ],
      };
      const session = { id: "completion-smoke", cwd: "/p", status: "ready", isStreaming: false };
      const initialTimeline = [{ kind: "message", entryId: "request-entry", message: { role: "user", content: "Verify the source package.", timestamp: 1 } }];
      let reconnect = false;
      await page.route("**/api/**", async (route) => {
        const url = new URL(route.request().url());
        const snapshot = {
          session, timeline: reconnect ? [...initialTimeline, completion] : initialTimeline,
          subagents: [], runtimeConfigurationGeneration: 0,
          compactionPolicy: { enabled: true, triggerPercent: 70 },
        };
        if (url.pathname.endsWith("/events")) {
          const events = url.pathname === "/api/config/events" ? [] : [
            { type: "snapshot", ...snapshot },
            { type: "timeline_entry_appended", entry: completion },
          ];
          reconnect = url.pathname !== "/api/config/events" || reconnect;
          return route.fulfill({
            contentType: "text/event-stream",
            body: `retry: 60000\n\n${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}`,
          });
        }
        const fixtures: Record<string, unknown> = {
          "/api/status": { bootId: "completion-smoke", agentDir: "/agent", homeDir: "/p", sessions: [], activeSessions: [] },
          "/api/update-check": { latestVersion: null },
          "/api/settings/api-usage": { showApiUsageDetails: true },
          "/api/agents": [], "/api/models": { models: [] }, "/api/entries": { entries: [] },
          "/api/sessions/completion-smoke/commands": { commands: [] },
          "/api/sessions/completion-smoke/snapshot": snapshot,
          "/api/sessions/completion-smoke/tree": { tree: [], leafId: null, treeFilterMode: "default", branchSummary: { skipPrompt: false } },
        };
        if (!(url.pathname in fixtures)) {
          unexpected.push(`${route.request().method()} ${url.pathname}`);
          return route.fulfill({ status: 500, json: { error: "Unexpected smoke request" } });
        }
        return route.fulfill({ json: fixtures[url.pathname] });
      });

      await page.goto(`${origin}/#/work/completion-smoke?cwd=%2Fp`);
      const card = page.getByRole("button", { name: /^search_0 is complete/ });
      await expect(card).toHaveCount(1);
      await expect(card).toHaveAttribute("aria-expanded", "false");
      await expect(card).toContainText(firstSentence);
      await expect(page.getByText("Second sentence stays collapsed.", { exact: false })).toHaveCount(0);
      const preview = card.locator("span").filter({ hasText: firstSentence }).last();
      const checkEllipsis = async () => {
        assert(await preview.evaluate((element) => {
          const style = getComputedStyle(element);
          return style.textOverflow === "ellipsis" && style.whiteSpace === "nowrap" && element.scrollWidth > element.clientWidth;
        }), "First-sentence preview must ellipsize at the actual available width");
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "No horizontal page overflow");
      };
      await checkEllipsis();
      await card.focus();
      await page.keyboard.press("Enter");
      await expect(card).toHaveAttribute("aria-expanded", "true");
      await expect(page.getByRole("table")).toBeVisible();
      await expect(page.locator(".katex")).toBeVisible();
      await expect(page.locator("strong", { hasText: "Accepted evidence" })).toBeVisible();
      await page.screenshot({ path: join(artifacts, `${fallback ? "fallback" : "worker"}-desktop.png`) });
      if (!fallback) assert(workers.some((url) => url.startsWith(`${origin}/assets/`) && url.endsWith(".js")), "Hashed same-origin Markdown Worker must load");
      await card.click();
      await expect(page.getByRole("table")).toHaveCount(0);
      await page.setViewportSize({ width: 390, height: 844 });
      await checkEllipsis();
      await page.screenshot({ path: join(artifacts, `${fallback ? "fallback" : "worker"}-mobile.png`) });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await card.focus();
      await page.keyboard.press("Space");
      await expect(page.getByRole("table")).toBeVisible();
      const errorCard = page.getByRole("button", { name: /^review_0/ });
      await expect(errorCard).toHaveAttribute("aria-expanded", "false");
      await errorCard.click();
      await expect(errorCard).toHaveAttribute("aria-expanded", "true");
      await expect(card).toHaveAttribute("aria-expanded", "true");
      await page.reload();
      await expect(card).toHaveCount(1);
      await expect(errorCard).toHaveCount(1);
      await expect(card).toHaveAttribute("aria-expanded", "false");
      await checkEllipsis();
      assert.deepEqual(errors, []);
      assert.deepEqual(unexpected, []);
      await context.close();
    }
    console.log(`SUBAGENT_COMPLETION_SMOKE passed: live/reconnect, desktop/mobile ellipsis, independent keyboard disclosures, Markdown Worker/fallback. Screenshots: ${artifacts}`);
  } finally {
    clearTimeout(deadline);
    await browser.close();
  }
} finally {
  if (server) await new Promise<void>((done, reject) => server.httpServer.close((error) => error ? reject(error) : done()));
}
