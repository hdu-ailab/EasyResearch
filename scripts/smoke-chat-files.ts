import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { preview } from "vite";

// Pass an isolated compiled daemon origin to exercise the embedded assets instead.
const suppliedOrigin = process.argv[2];
const server = suppliedOrigin ? undefined : await preview({
  configFile: resolve(import.meta.dir, "../src/webui/vite.config.ts"),
  preview: { host: "127.0.0.1", port: 0, open: false, proxy: {} },
});
try {
  const address = server?.httpServer.address();
  assert(suppliedOrigin || (address && typeof address !== "string"));
  const origin = suppliedOrigin ? new URL(suppliedOrigin).origin : `http://127.0.0.1:${(address as { port: number }).port}`;
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    for (const width of [1440, 390]) for (const fallback of [false, true]) {
      const mobile = width < 820;
      const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "en-US", hasTouch: mobile });
      try {
        const page = await context.newPage();
        const errors: string[] = [];
        const unexpected: string[] = [];
        const reads: string[] = [];
        const workers: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("request", (request) => {
          if (request.url().includes("/assets/markdown.worker-")) workers.push(request.url());
        });
        if (fallback) await page.route("**/assets/markdown.worker-*.js", (route) => route.abort());
        const snapshot = {
          session: { id: "file-smoke", cwd: "/papers", status: "ready", isStreaming: false },
          timeline: [{
            kind: "message", entryId: "assistant",
            message: {
              role: "assistant", timestamp: 1,
              content: 'Read results/table.txt, `/shared/report.txt`, and [notes](notes/my%20draft.txt). Missing: missing.txt.\n\n$e^{i\\pi}+1=0$\n\n```text\nresults/code.txt\n```',
            },
          }],
          subagents: [], runtimeConfigurationGeneration: 0,
          compactionPolicy: { enabled: true, triggerPercent: 70 },
        };
        await page.route("**/api/**", async (route) => {
          const url = new URL(route.request().url());
          const path = url.pathname;
          if (path.endsWith("/events")) {
            await route.fulfill({
              contentType: "text/event-stream",
              body: `retry: 60000\n\n${path === "/api/config/events" ? "" : `data: ${JSON.stringify({ type: "snapshot", ...snapshot })}\n\n`}`,
            });
            return;
          }
          if (path === "/api/file") {
            const file = url.searchParams.get("path")!;
            reads.push(file);
            if (file === "/papers/missing.txt") {
              await route.fulfill({ status: 404, json: { error: "File not found" } });
            } else {
              assert(["/papers/results/table.txt", "/shared/report.txt", "/papers/notes/my draft.txt"].includes(file), `Unexpected file: ${file}`);
              await route.fulfill({ json: { path: file, content: `preview:${file}`, byteCount: 40, binary: false, truncated: false } });
            }
            return;
          }
          const fixtures: Record<string, unknown> = {
            "/api/status": { bootId: "file-smoke", agentDir: "/agent", homeDir: "/papers", sessions: [], activeSessions: [] },
            "/api/agents": [], "/api/models": { models: [] }, "/api/entries": { entries: [] },
            "/api/settings/api-usage": { showApiUsageDetails: true },
            "/api/sessions/file-smoke/commands": { commands: [] },
            "/api/sessions/file-smoke/snapshot": snapshot,
            "/api/sessions/file-smoke/tree": { tree: [], leafId: null, filterMode: "default", skipBranchSummaryPrompt: false },
          };
          if (!(path in fixtures)) {
            unexpected.push(`${route.request().method()} ${path}`);
            await route.fulfill({ status: 500, json: { error: "Unexpected smoke request" } });
            return;
          }
          await route.fulfill({ json: fixtures[path] });
        });
        const url = `${origin}/#/work/file-smoke?cwd=%2Fpapers`;
        await page.goto(url);
        const chat = page.getByRole("tabpanel", { name: "Chat", exact: true });
        const files = page.getByRole("tabpanel", { name: "Files", exact: true });
        const relative = chat.getByRole("button", { name: "results/table.txt", exact: true });
        await expect(relative).toBeVisible();
        await expect(chat.locator(".katex")).toBeVisible();
        await expect(chat.locator("[data-markdown-root] .katex")).toHaveCount(fallback ? 0 : 1);
        assert.deepEqual(reads, [], "Recognition must not probe or read files");
        const draft = chat.getByRole("textbox", { name: /message/i });
        await draft.fill("preserved draft");
        if (!mobile) await page.getByRole("button", { name: "Files browser", exact: true }).click();
        await relative.focus();
        await relative.press("Enter");
        await expect(files).toBeVisible();
        await expect(files.getByText("preview:/papers/results/table.txt", { exact: true })).toBeVisible();
        if (mobile) await expect(page.getByRole("tab", { name: "Files", exact: true })).toBeFocused();
        if (mobile) await page.getByRole("tab", { name: "Chat", exact: true }).click();
        await relative.click();
        await expect(files.getByRole("tab", { name: "table.txt", exact: true })).toHaveCount(1);
        await files.getByRole("button", { name: "Close table.txt", exact: true }).click();
        if (mobile) await page.getByRole("tab", { name: "Chat", exact: true }).click();
        await relative.click();
        await expect(files.getByText("preview:/papers/results/table.txt", { exact: true })).toBeVisible();
        if (mobile) await page.getByRole("tab", { name: "Chat", exact: true }).click();
        else await page.getByRole("button", { name: "Agent list", exact: true }).click();
        await chat.getByRole("button", { name: "/shared/report.txt", exact: true }).click();
        await expect(files.getByText("preview:/shared/report.txt", { exact: true })).toBeVisible();
        for (const [label, content] of [["notes", "preview:/papers/notes/my draft.txt"], ["missing.txt", "File not found"]] as const) {
          if (mobile) await page.getByRole("tab", { name: "Chat", exact: true }).click();
          await chat.getByRole("button", { name: label, exact: true }).click();
          await expect(files.getByText(content, { exact: label !== "missing.txt" })).toBeVisible();
        }
        if (mobile) await page.getByRole("tab", { name: "Chat", exact: true }).click();
        await expect(draft).toHaveValue("preserved draft");
        await expect(chat.locator("pre button")).toHaveCount(0);
        assert.equal(page.url(), url);
        assert.equal(reads.filter((path) => path === "/papers/results/table.txt").length, 2);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "No horizontal page overflow");
        assert(workers.length > 0 && workers.every((url) => new URL(url).origin === origin));
        assert.deepEqual(unexpected, []);
        assert.deepEqual(errors, []);
        console.log(`CHAT_FILES_SMOKE width=${width} fallback=${fallback} passed`);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
} finally {
  if (server) await new Promise<void>((done, reject) => server.httpServer.close((error) => error ? reject(error) : done()));
}
