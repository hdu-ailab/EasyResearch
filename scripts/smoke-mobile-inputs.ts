import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium, expect, type Locator } from "@playwright/test";
import { preview } from "vite";

// Optional origin exercises installed assets; every API request remains intercepted.
// Desktop mobile emulation checks the font invariant, not iOS keyboard zoom itself.
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
    const session = { id: "mobile-smoke", cwd: "C:/papers", status: "running", isStreaming: true };
    const snapshot = {
      session,
      timeline: [],
      subagents: [],
      runtimeConfigurationGeneration: 0,
      compactionPolicy: { enabled: true, triggerPercent: 70 },
    };
    for (const [width, height, touch] of [
      [390, 844, true],
      [844, 390, true],
      [1024, 768, true],
      [819, 900, false],
      [820, 900, false],
      [1440, 900, false],
    ] as const) {
      const page = await browser.newPage({
        viewport: { width, height }, hasTouch: touch, isMobile: touch, locale: "en-US",
      });
      const unexpected: string[] = [];
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/api/**", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith("/events")) {
          const event = url.pathname === "/api/config/events" ? undefined : { type: "snapshot", ...snapshot };
          await route.fulfill({
            contentType: "text/event-stream",
            body: `retry: 60000\n\n${event ? `data: ${JSON.stringify(event)}\n\n` : ""}`,
          });
          return;
        }
        const fixtures: Record<string, unknown> = {
          "/api/status": {
            bootId: "mobile-smoke", agentDir: "C:/agent", homeDir: "C:/papers", sessions: [], activeSessions: [],
          },
          "/api/update-check": { latestVersion: null },
          "/api/settings/api-usage": { showApiUsageDetails: true },
          "/api/directories/roots": { roots: [{ name: "C:/", path: "C:/" }, { name: "D:/", path: "D:/" }] },
          "/api/directories": { path: url.searchParams.get("path"), entries: [] },
          "/api/agents": [],
          "/api/models": { models: [] },
          "/api/entries": { entries: [] },
          "/api/sessions/mobile-smoke/commands": { commands: [] },
          "/api/sessions/mobile-smoke/snapshot": snapshot,
          "/api/sessions/mobile-smoke/messages": { ok: true },
          "/api/sessions/mobile-smoke/tree": {
            tree: [], leafId: null, treeFilterMode: "default", branchSummary: { skipPrompt: false },
          },
        };
        if (!(url.pathname in fixtures)) {
          unexpected.push(`${route.request().method()} ${url.pathname}`);
          await route.fulfill({ status: 500, json: { error: "Unexpected smoke request" } });
          return;
        }
        await route.fulfill({ json: fixtures[url.pathname] });
      });
      await page.goto(origin);
      const protectedInput = width < 820 || touch;
      const checkFont = async (control: Locator, desktopSize: number) => {
        await expect(control).toBeVisible();
        const size = await control.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
        if (protectedInput) {
          assert(size >= 16,
            `${width}px touch=${touch}: ${await control.getAttribute("aria-label")} is ${size}px, below the iOS focus-zoom threshold`);
        } else {
          assert.equal(size, desktopSize, "Desktop control typography changed");
        }
        await control.focus();
        assert.equal(
          await control.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
          size,
          "Focus must not resize the control",
        );
      };
      const search = page.getByRole("searchbox", { name: "Search sessions" });
      await checkFont(search, 14);
      await search.fill("mobile search");
      await expect(search).toHaveValue("mobile search");
      await page.getByRole("button", { name: "New project", exact: true }).click();
      const path = page.getByRole("combobox", { name: "Directory path", exact: true });
      await checkFont(path, 13);
      const roots = page.locator("select");
      await checkFont(roots, 12);
      await roots.selectOption("D:/");
      await expect(path).toHaveValue("D:/");
      await page.getByRole("button", { name: "Close", exact: true }).click();

      await page.goto(`${origin}/#/work/mobile-smoke?cwd=C%3A%2Fpapers`);
      const composer = page.getByRole("textbox", { name: "Message", exact: true });
      await expect(composer).toBeEnabled();
      await checkFont(composer, 13);
      for (const size of [10, 20]) {
        await page.evaluate((size) => {
          document.documentElement.style.setProperty("--v2-chat-font-size", `${size}px`);
          document.documentElement.style.setProperty("--v2-files-font-size", `${size}px`);
        }, size);
        await checkFont(composer, 13);
      }
      await composer.fill("First line\nSecond line");
      await composer.blur();
      await expect(composer).toHaveValue("First line\nSecond line");
      const composerHeight = () => composer.evaluate((element) => element.getBoundingClientRect().height);
      const centerOffset = () => composer.evaluate((element) => {
        const input = element.getBoundingClientRect();
        const button = element.closest("form")!.querySelector('button:not([role="option"])')!.getBoundingClientRect();
        return Math.abs(input.y + input.height / 2 - button.y - button.height / 2);
      });
      const initialHeight = await composerHeight();
      const sendOffset = await centerOffset();
      await composer.fill("First\nSecond\nThird\nFourth");
      const multilineHeight = await composerHeight();
      assert(await centerOffset() <= 1, "Send must remain centered beside a multiline draft");
      await composer.fill("Long draft line\n".repeat(40));
      assert(await centerOffset() <= 1, "Send must remain centered at the input height limit");
      const capped = await composer.evaluate((element) => ({
        height: element.getBoundingClientRect().height,
        maxHeight: Number.parseFloat(getComputedStyle(element).maxHeight),
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      }));
      await composer.fill("Short draft");
      const shrunkHeight = await composerHeight();
      await composer.fill("Line\n".repeat(4));
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect(composer).toHaveValue("");
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
      const resetHeight = await composerHeight();
      const stopOffset = await centerOffset();
      // Check both reported regressions before failing, using actual browser geometry.
      assert.deepEqual({
        sendCentered: sendOffset <= 1,
        stopCentered: stopOffset <= 1,
        grows: multilineHeight > initialHeight,
        capped: capped.height === capped.maxHeight && capped.scrollHeight > capped.clientHeight,
        shrinks: shrunkHeight === initialHeight,
        resets: resetHeight === initialHeight,
      }, {
        sendCentered: true, stopCentered: true, grows: true, capped: true, shrinks: true, resets: true,
      }, JSON.stringify({ width, touch, sendOffset, stopOffset, initialHeight, multilineHeight, capped }));

      if (!touch && width === 1440) {
        await composer.fill("A draft that wraps when the available width changes. ".repeat(8));
        const wideHeight = await composerHeight();
        await page.setViewportSize({ width: 390, height: 844 });
        await expect.poll(composerHeight).toBeGreaterThan(wideHeight);
        await page.getByRole("tab", { name: "Files", exact: true }).click();
        await page.setViewportSize({ width: 450, height: 844 });
        await page.getByRole("tab", { name: "Chat", exact: true }).click();
        await expect(composer).toBeVisible();
        await expect.poll(composerHeight).toBeGreaterThan(wideHeight);
        const narrowHeight = await composerHeight();
        await page.setViewportSize({ width, height });
        await expect.poll(composerHeight).toBeLessThan(narrowHeight);
      }
      assert(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        "Page overflowed horizontally",
      );
      const viewport = await page.locator('meta[name="viewport"]').getAttribute("content");
      assert(
        viewport && !/user-scalable\s*=\s*(no|0)|maximum-scale\s*=/i.test(viewport),
        "User zoom must remain unrestricted",
      );
      assert.deepEqual(unexpected, []);
      assert.deepEqual(errors, []);
      console.log(`MOBILE_INPUT_SMOKE width=${width} touch=${touch} passed`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
} finally {
  if (server) await new Promise<void>((done, reject) => {
    server.httpServer.close((error) => error ? reject(error) : done());
  });
}
