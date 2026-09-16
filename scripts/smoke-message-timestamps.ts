import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { preview } from "vite";

// An optional isolated daemon origin exercises the same checks on compiled assets.
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
    const messages = [
      { role: "user", timestamp: Date.parse("2026-01-16T00:02:03Z"), content: "User **question**" },
      { role: "assistant", timestamp: Date.parse("2026-07-16T00:02:03Z"), content: "Assistant **answer** $x^2$" },
    ];
    const snapshot = {
      session: { id: "time-smoke", cwd: "/papers", status: "ready", isStreaming: false },
      timeline: messages.map((message) => ({ kind: "message", entryId: message.role, message })),
      subagents: [],
      runtimeConfigurationGeneration: 0,
      compactionPolicy: { enabled: true, triggerPercent: 70 },
    };
    const streamTimestamp = Date.parse("2026-07-16T00:02:08Z");
    for (const [timezoneId, winter, summer, streaming] of [
      ["Asia/Shanghai", "2026-01-16 08:02:03", "2026-07-16 08:02:03", "2026-07-16 08:02:08"],
      ["America/Los_Angeles", "2026-01-15 16:02:03", "2026-07-15 17:02:03", "2026-07-15 17:02:08"],
      ["Asia/Kathmandu", "2026-01-16 05:47:03", "2026-07-16 05:47:03", "2026-07-16 05:47:08"],
    ] as const) {
      for (const [width, touch, fallback] of [[1440, false, false], [320, true, false], [1024, true, false], [1440, false, true]] as const) {
        const context = await browser.newContext({
          viewport: { width, height: 900 }, hasTouch: touch, isMobile: touch, locale: "en-US", timezoneId,
          permissions: ["clipboard-read", "clipboard-write"],
        });
        try {
          const page = await context.newPage();
          const pageSnapshot = structuredClone(snapshot);
          await page.clock.install({ time: new Date("2026-07-16T00:03:00Z") });
          const errors: string[] = [];
          const unexpected: string[] = [];
          const workerUrls: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          page.on("request", (request) => {
            if (request.url().includes("/assets/markdown.worker-")) workerUrls.push(request.url());
          });
          if (fallback) await page.route("**/assets/markdown.worker-*.js", (route) => route.abort());
          await page.route("**/api/**", async (route) => {
            const path = new URL(route.request().url()).pathname;
            if (path.endsWith("/events")) {
              const events = path === "/api/config/events" ? [] : [
                { type: "snapshot", ...pageSnapshot },
                { type: "agent_start" },
                { type: "message_start", message: { role: "assistant", timestamp: streamTimestamp, content: [] } },
                { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Streaming answer" } },
              ];
              await route.fulfill({
                contentType: "text/event-stream",
                body: `retry: 60000\n\n${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}`,
              });
              return;
            }
            const fixtures: Record<string, unknown> = {
              "/api/status": { bootId: "time-smoke", agentDir: "/agent", homeDir: "/papers", sessions: [], activeSessions: [] },
              "/api/agents": [],
              "/api/models": { models: [] },
              "/api/entries": { entries: [] },
              "/api/settings/api-usage": { showApiUsageDetails: true },
              "/api/sessions/time-smoke/commands": { commands: [] },
              "/api/sessions/time-smoke/snapshot": pageSnapshot,
              "/api/sessions/time-smoke/tree": {
                tree: messages.map((message, index) => ({
                  id: message.role, parentId: index === 0 ? null : "user", role: message.role, kind: message.role, text: message.content,
                })),
                leafId: "assistant", filterMode: "default", skipBranchSummaryPrompt: false,
              },
            };
            if (!(path in fixtures)) {
              unexpected.push(`${route.request().method()} ${path}`);
              await route.fulfill({ status: 500, json: { error: "Unexpected smoke request" } });
              return;
            }
            await route.fulfill({ json: fixtures[path] });
          });
          await page.goto(`${origin}/#/work/time-smoke?cwd=%2Fpapers`);
          await expect(page.locator(".katex")).toBeVisible();
          await expect(page.locator("[data-markdown-root] .katex")).toHaveCount(fallback ? 0 : 1);
          for (const [index, expected] of [winter.slice(5, 16), summer.slice(11, 16)].entries()) {
            const message = messages[index]!;
            const row = page.getByTestId(`transcript-row-${message.role}`);
            const time = row.locator("time");
            const footer = time.locator("..");
            await expect(time).toHaveText(expected);
            await expect(time).toHaveAttribute("datetime", new Date(message.timestamp).toISOString());
            await page.mouse.move(0, 0);
            await expect(footer).toHaveCSS("opacity", touch ? "1" : "0");
            const before = await row.boundingBox();
            await row.locator(".v2-md").hover();
            await expect(footer).toHaveCSS("opacity", "1");
            assert.equal((await row.boundingBox())?.height, before?.height, "Hover must not change row height");
            const firstAction = row.getByRole("button").first();
            const timeBox = await time.boundingBox();
            const actionBox = await firstAction.boundingBox();
            assert(timeBox && actionBox && timeBox.x + timeBox.width <= actionBox.x, "Time must precede actions visually");
            if (message.role === "user") await expect(row.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
            else await expect(row.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
            const copy = row.getByRole("button", { name: "Copy", exact: true });
            await page.mouse.move(0, 0);
            await copy.focus();
            await expect(footer).toHaveCSS("opacity", "1");
            await copy.press("Enter");
            assert.equal(await page.evaluate(() => navigator.clipboard.readText()), message.content);
            await copy.blur();
          }
          const streamingTime = page.getByTestId(`transcript-row-assistant:${streamTimestamp}`).locator("time");
          await expect(streamingTime).toHaveText(streaming.slice(11, 16));
          await page.getByTestId("transcript-row-assistant").getByRole("button", { name: "Copy", exact: true }).focus();
          await page.keyboard.press("Tab");
          await expect(streamingTime).toBeFocused();
          await expect(streamingTime.locator("..")).toHaveCSS("opacity", "1");
          for (const [now, event, prefixStart] of [
            ["2026-07-17T00:03:00Z", "focus", 5],
            ["2027-01-01T12:00:00Z", "visibilitychange", 0],
          ] as const) {
            await page.clock.setSystemTime(new Date(now));
            await page.evaluate((event) => (event === "focus" ? window : document).dispatchEvent(new Event(event)), event);
            await expect(page.getByTestId("transcript-row-user").locator("time")).toHaveText(winter.slice(prefixStart, 16));
            await expect(page.getByTestId("transcript-row-assistant").locator("time")).toHaveText(summer.slice(prefixStart, 16));
            await expect(streamingTime).toHaveText(streaming.slice(prefixStart, 16));
          }
          assert(await page.locator("time").evaluateAll((times) => times.every((time) => {
            const viewport = time.closest("section")!.getBoundingClientRect();
            const footer = time.parentElement!.getBoundingClientRect();
            return footer.x >= viewport.x && footer.right <= viewport.right;
          })), "Timestamp footer must fit the transcript at every width");
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Page must not overflow horizontally");
          assert(workerUrls.length > 0 && workerUrls.every((url) => new URL(url).origin === origin), "Must exercise hashed same-origin Worker or its blocked fallback");
          if (timezoneId === "America/Los_Angeles" && !touch && !fallback) {
            for (const [start, end, hours, expected] of [
              ["2026-03-08T08:00:00Z", "2026-03-09T07:00:00Z", 23, "03-08 00:00"],
              ["2026-11-01T07:00:00Z", "2026-11-02T08:00:00Z", 25, "11-01 00:00"],
            ] as const) {
              assert.equal(Date.parse(end) - Date.parse(start), hours * 60 * 60 * 1000);
              pageSnapshot.timeline[1]!.message.timestamp = Date.parse(start);
              await page.clock.setSystemTime(new Date(start));
              await page.clock.resume();
              await page.reload();
              const time = page.getByTestId("transcript-row-assistant").locator("time");
              await expect(time).toHaveText("00:00");
              await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
              const remaining = Date.parse(end) - await page.evaluate(() => Date.now());
              await page.clock.fastForward(remaining - 1);
              await expect(time).toHaveText("00:00");
              await page.clock.fastForward(1);
              await expect(time).toHaveText(expected);
              console.log(`MESSAGE_TIME_MIDNIGHT timezone=${timezoneId} dayHours=${hours} passed`);
            }
          }
          assert.deepEqual(unexpected, []);
          assert.deepEqual(errors, []);
          console.log(`MESSAGE_TIME_SMOKE timezone=${timezoneId} width=${width} touch=${touch} fallback=${fallback} passed`);
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
} finally {
  if (server) await new Promise<void>((done, reject) => {
    server.httpServer.close((error) => error ? reject(error) : done());
  });
}
