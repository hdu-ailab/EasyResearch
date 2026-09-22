import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { preview } from "vite";

// Optional isolated compiled-daemon origin exercises the same served assets.
const suppliedOrigin = process.argv[2];
const server = suppliedOrigin ? undefined : await preview({
  configFile: resolve(import.meta.dir, "../src/webui/vite.config.ts"),
  preview: { host: "127.0.0.1", port: 0, open: false, proxy: {} },
});
const artifacts = mkdtempSync(join(tmpdir(), "easyresearch-write-errors-"));
try {
  const address = server?.httpServer.address();
  assert(suppliedOrigin || (address && typeof address !== "string"));
  const origin = suppliedOrigin ?? `http://127.0.0.1:${(address as { port: number }).port}`;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.COMPARE_CHROMIUM_PATH });
  try {
    for (const fallback of [false, true]) {
      const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, locale: "en-US" });
      try {
        const page = await context.newPage();
        const workerUrls: string[] = [];
        const errors: string[] = [];
        const unexpected: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        page.on("request", request => { if (request.url().includes("/assets/markdown.worker-")) workerUrls.push(request.url()); });
        if (fallback) await page.route("**/assets/markdown.worker-*.js", route => route.abort());
        const message = {
          role: "assistant", timestamp: Date.now() - 1000, stopReason: "error", errorMessage: "Stream ended without finish_reason",
          content: [
            { type: "text", text: "Now I will write the complete review report draft. $x^2$" },
            { type: "toolCall", id: "failed-write", name: "write", arguments: { path: "reviews/.draft-report.md" } },
          ],
        };
        const snapshot = {
          session: { id: "write-error", cwd: "/papers", status: "ready", isStreaming: false },
          timeline: [{ kind: "message", entryId: "failed-message", message }], subagents: [],
          runtimeConfigurationGeneration: 0, compactionPolicy: { enabled: true, triggerPercent: 70 },
        };
        await page.route("**/api/**", async route => {
          const path = new URL(route.request().url()).pathname;
          if (path.endsWith("/events")) {
            const events = path === "/api/config/events" ? [] : [{ type: "snapshot", ...snapshot }];
            await route.fulfill({ contentType: "text/event-stream", body: `retry: 60000\n\n${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")}` });
            return;
          }
          const fixtures: Record<string, unknown> = {
            "/api/status": { bootId: "write-error", agentDir: "/agent", homeDir: "/papers", sessions: [], activeSessions: [] },
            "/api/agents": [], "/api/models": { models: [] }, "/api/entries": { entries: [] },
            "/api/settings/api-usage": { showApiUsageDetails: true },
            "/api/sessions/write-error/commands": { commands: [] },
            "/api/sessions/write-error/snapshot": snapshot,
            "/api/sessions/write-error/tree": {
              tree: [{ id: "failed-message", parentId: null, role: "assistant", kind: "assistant", text: "Interrupted report" }],
              leafId: "failed-message", filterMode: "default", skipBranchSummaryPrompt: false,
            },
          };
          if (!(path in fixtures)) {
            unexpected.push(path);
            await route.fulfill({ status: 500, json: { error: "Unexpected browser API" } });
            return;
          }
          await route.fulfill({ json: fixtures[path] });
        });
        await page.goto(`${origin}/#/work/write-error?cwd=%2Fpapers`);
        await expect(page.getByText("Stream ended without finish_reason", { exact: false })).toBeVisible();
        await expect(page.getByText("Now I will write the complete review report draft.", { exact: false })).toBeVisible();
        await expect(page.locator(".katex")).toBeVisible();
        const tool = page.getByRole("button", { name: /Interrupted:.*write/ });
        await expect(tool).toBeVisible();
        await tool.click();
        await expect(page.getByText("No final result was recorded. The tool may not have executed.")).toBeVisible();
        if (!fallback) assert(workerUrls.length > 0, "hashed Markdown worker was not used");
        assert.deepEqual(errors, []);
        assert.deepEqual(unexpected, []);
        await page.screenshot({ path: join(artifacts, `${fallback ? "fallback" : "worker"}.png`), fullPage: true });
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
  console.log(`WRITE_ERRORS_VERIFY passed (Worker + fallback). Screenshots: ${artifacts}`);
} finally { await server?.close(); }
