import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium, expect, type Locator } from "@playwright/test";
import { preview } from "vite";

// Optional origin exercises installed assets; every API request remains intercepted.
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
    for (const [width, height] of [[1440, 900], [390, 844], [844, 390]] as const) {
      const page = await browser.newPage({ viewport: { width, height }, locale: "en-US" });
      const errors: string[] = [];
      const unexpected: string[] = [];
      const patches: unknown[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const models = Array.from({ length: 180 }, (_, index) => ({
        provider: index < 90 ? "anthropic" : "openai",
        id: `catalog-model-${String(index).padStart(3, "0")}`,
        reasoning: true, thinkingLevelMap: {}, available: true, authRequired: false,
      }));
      const agents = ["research-assistant", "search"].map((name) => ({
        name, description: `Smoke ${name}`, enabled: true, builtin: true, source: "bundled",
        filePath: `/isolated/agents/${name}.md`, effectiveTools: [], effectiveSkills: [], missingSkills: [],
        model: "openai/catalog-model-179", effectiveModel: "openai/catalog-model-179",
      }));
      await page.route("**/api/**", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.pathname === "/api/config/events") {
          await route.fulfill({ contentType: "text/event-stream", body: "retry: 60000\n\n" });
          return;
        }
        if (request.method() === "PATCH" && url.pathname.startsWith("/api/agents/")) {
          const agent = agents.find((item) => item.name === url.pathname.split("/").at(-1));
          assert(agent);
          const patch = request.postDataJSON();
          patches.push({ name: agent.name, patch });
          Object.assign(agent, patch);
          await route.fulfill({ json: agent });
          return;
        }
        const fixtures: Record<string, unknown> = {
          "/api/status": { bootId: "settings-search-smoke", agentDir: "/isolated/agent", homeDir: "/isolated", sessions: [], activeSessions: [] },
          "/api/update-check": { latestVersion: null },
          "/api/settings/api-usage": { showApiUsageDetails: true },
          "/api/settings/compaction": { triggerPercent: 70, globalEnabled: true },
          "/api/settings/network-proxy": { configured: {}, appliedConfigured: {}, sources: { all: "direct", llm: "direct", search: "direct" }, errors: [], restartRequired: false },
          "/api/agents": agents,
          "/api/models": { models },
          "/api/agent-resources": [],
          "/api/skill-resources": [],
          "/api/config/projects": { home: "/isolated/agent", projects: [] },
          "/api/auth/providers": { providers: [] },
        };
        if (request.method() !== "GET" || !(url.pathname in fixtures)) {
          unexpected.push(`${request.method()} ${url.pathname}`);
          await route.fulfill({ status: 500, json: { error: "Unexpected smoke request" } });
          return;
        }
        await route.fulfill({ json: fixtures[url.pathname] });
      });
      await page.goto(origin);
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole(width < 820 ? "button" : "tab", { name: "Agents", exact: true }).click();
      await page.getByRole("button", { name: "Configure Search", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Agents", exact: true });
      const trigger = dialog.getByRole("combobox", { name: "Select model for Search", exact: true });
      await trigger.click();
      const search = dialog.getByRole("searchbox", { name: "Search", exact: true });
      const hitGeometry = async (control: Locator) => control.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return { rect: rect.toJSON(), hit: hit?.outerHTML.slice(0, 300), reachable: hit === element, focused: document.activeElement === element };
      });
      await expect(search).toBeFocused();
      const opened = await hitGeometry(search);
      console.log(`SETTINGS_SEARCH_OPEN width=${width} ${JSON.stringify(opened)}`);
      assert(opened.reachable, "Search must be visible and receive pointer input when opened");
      assert.deepEqual(patches, [], "Opening a model selector must not persist a default");
      await search.pressSequentially("ANTHROPIC/catalog-model-042");
      await expect(dialog.getByRole("listbox").getByRole("option")).toHaveCount(1);
      await search.press("Enter");
      await expect(trigger).toHaveText("anthropic/catalog-model-042");
      assert.deepEqual(patches, [{ name: "search", patch: { model: "anthropic/catalog-model-042" } }]);
      await trigger.click();
      await expect(search).toHaveValue("");
      const listbox = dialog.getByRole("listbox");
      await listbox.hover();
      await page.mouse.wheel(0, 1400);
      await expect.poll(async () => listbox.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      const scrolled = await hitGeometry(search);
      console.log(`SETTINGS_SEARCH_SCROLLED width=${width} ${JSON.stringify(scrolled)}`);
      assert(scrolled.reachable, "Browsing a long catalog must not scroll the search field out of view");
      await search.click();
      await search.pressSequentially("catalog-model-179");
      await expect(dialog.getByRole("listbox").getByRole("option")).toHaveCount(1);
      await dialog.getByRole("listbox").getByRole("option").click();
      await expect(trigger).toHaveText("openai/catalog-model-179");
      assert.deepEqual(patches, [
        { name: "search", patch: { model: "anthropic/catalog-model-042" } },
        { name: "search", patch: { model: "openai/catalog-model-179" } },
      ]);
      await trigger.click();
      await search.press("Escape");
      await expect(dialog).toBeVisible();
      await expect(trigger).toBeFocused();
      await trigger.press("Escape");
      await expect(page.getByRole("button", { name: "Configure Search", exact: true })).toBeFocused();
      assert.deepEqual(errors, []);
      assert.deepEqual(unexpected, []);
      console.log(`SETTINGS_MODEL_SEARCH_SMOKE width=${width} passed`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
} finally {
  if (server) await new Promise<void>((done, reject) => server.httpServer.close((error) => error ? reject(error) : done()));
}
