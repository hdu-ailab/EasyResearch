import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium, expect, type Locator } from "@playwright/test";
import { preview } from "vite";

// Exercise built CSS and real React controls without a daemon or user configuration.
// Desktop mobile emulation checks the font invariant, not iOS keyboard zoom itself.
const server = await preview({
  configFile: resolve(import.meta.dir, "../src/webui/vite.config.ts"),
  preview: { host: "127.0.0.1", port: 0, open: false, proxy: {} },
});
try {
  const address = server.httpServer.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const session = { id: "mobile-smoke", cwd: "C:/papers", status: "ready", isStreaming: false };
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
  await new Promise<void>((done, reject) => {
    server.httpServer.close((error) => error ? reject(error) : done());
  });
}
