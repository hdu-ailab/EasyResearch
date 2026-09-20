#!/usr/bin/env bun
/**
 * Behavioural regression check for the interface-version setting.
 *
 * The setting is the only switch that changes presentation without changing
 * data, so nothing in the unit suite can prove the two layouts, the palette
 * scope, the icon, and the cross-surface consistency all actually follow it.
 * This script drives a running instance and asserts each of those.
 *
 * Usage:
 *   bun run dev -p 3004 --no-open            # in one terminal
 *   bun run scripts/verify-ui-toggle.ts 3004 # in another
 *
 * A browser is required. Playwright's bundled build is used when the local
 * cache has one; set `COMPARE_CHROMIUM_PATH` to any Chromium executable when it
 * does not. Screenshots land in a temporary directory and are only useful when
 * a check fails.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const port = Number(process.argv[2] ?? 3000);
const origin = `http://127.0.0.1:${port}`;
const artifacts = mkdtempSync(join(tmpdir(), "easyresearch-ui-toggle-"));

const browser = await chromium.launch({ headless: true, executablePath: process.env.COMPARE_CHROMIUM_PATH });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
const page = await context.newPage();

const failures: string[] = [];
const check = (label: string, ok: boolean) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures.push(label);
};
const favicon = () => page.evaluate(() => document.querySelector('link[rel="icon"]')?.getAttribute("href") ?? "");
/** Resolved theme token, which is how the palette half of the refresh is scoped. */
const token = (name: string) =>
  page.evaluate((key) => getComputedStyle(document.documentElement).getPropertyValue(key).trim(), name);

await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
await page.evaluate(() => window.localStorage.clear());
await page.reload({ waitUntil: "domcontentloaded" });
await page.getByText("draft the fault diagnosis paper").first().waitFor({ state: "visible", timeout: 30_000 });

// 1) Default: refreshed Home (dolphin logo present, card grid layout).
let currentBlue = "";
check("default renders the refreshed logo", (await page.locator('[data-testid="product-logo"]').count()) === 1);
check("default favicon is the shipped SVG", (await favicon()) === "/favicon.svg");
currentBlue = await token("--color-v2-blue-600");
check("default palette is not the pre-refresh one", currentBlue.length > 0 && currentBlue !== "#3b5cf6");
await page.screenshot({ path: join(artifacts, "1-default-current.png"), fullPage: true });

// 2) The settings control exposes both versions and defaults to Current.
await page.getByRole("button", { name: "Settings" }).click();
const settings = page.getByRole("dialog", { name: "Settings" });
await settings.waitFor({ state: "visible", timeout: 15_000 });
const current = settings.getByRole("button", { name: "Current", exact: true });
const classic = settings.getByRole("button", { name: "Classic", exact: true });
check("settings expose the Interface version control", (await current.count()) === 1 && (await classic.count()) === 1);
check("Current is selected by default", (await current.getAttribute("aria-pressed")) === "true");
await page.screenshot({ path: join(artifacts, "2-settings-toggle.png") });

// 3) Switch to Classic through the UI.
await classic.click();
await page.waitForTimeout(400);
check("Classic becomes selected", (await classic.getAttribute("aria-pressed")) === "true");
check("favicon follows the classic version", (await favicon()).startsWith("data:image/svg+xml,"));
check("classic palette restores the pre-refresh blue", (await token("--color-v2-blue-600")) === "#3b5cf6");
check("classic palette restores the pre-refresh surface", (await token("--color-v2-grey-200")) === "#f2f2f2");
check("classic palette differs from the refreshed one", currentBlue !== "#3b5cf6");

// Close settings to see the classic Home.
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
check("classic Home drops the refreshed logo", (await page.locator('[data-testid="product-logo"]').count()) === 0);
check("classic Home still lists the sessions", (await page.getByText("draft the fault diagnosis paper").count()) > 0);
// Session deletion landed after this layout was replaced, so the classic
// surface has to carry it: switching versions must not remove a capability.
const classicDeletes = await page.getByRole("button", { name: /delete session/i }).count();
check("classic Home still offers delete", classicDeletes > 0);
await page.screenshot({ path: join(artifacts, "3-classic-home.png"), fullPage: true });

// 4) The choice survives a reload (it is persisted, not just component state).
await page.reload({ waitUntil: "domcontentloaded" });
await page.getByText("draft the fault diagnosis paper").first().waitFor({ state: "visible", timeout: 30_000 });
check("classic survives a reload", (await page.locator('[data-testid="product-logo"]').count()) === 0);

// 5) Switch back through settings.
await page.getByRole("button", { name: "Settings" }).click();
await page.getByRole("dialog", { name: "Settings" }).waitFor({ state: "visible", timeout: 15_000 });
await settings.getByRole("button", { name: "Current", exact: true }).click();
await page.waitForTimeout(400);
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
check("switching back restores the refreshed Home", (await page.locator('[data-testid="product-logo"]').count()) === 1);
check("favicon returns to the shipped SVG", (await favicon()) === "/favicon.svg");
await page.screenshot({ path: join(artifacts, "4-back-to-current.png"), fullPage: true });

// 6) The choice must also reach the work surface inside a session.
const openFirstSession = async () => {
  await page.getByText("draft the fault diagnosis paper").first().click();
  await page.waitForURL(/#\/work\//, { timeout: 30_000 });
  await page.locator("#work-panel-chat").waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(600);
};

await openFirstSession();
check("work surface uses the refreshed chrome by default", (await page.locator('[data-testid="product-logo"]').count()) === 1);
check("work surface shows the session heading by default", (await page.getByRole("heading", { level: 1 }).count()) === 1);
// The composer is a shared component rather than a page: the refreshed send
// control is a circle, the classic one a rounded square.
const sendRadius = async () =>
  page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>('form button[type="submit"]');
    return button === null ? "" : getComputedStyle(button).borderRadius;
  });
check("refreshed composer send control is not the classic square", (await sendRadius()) !== "6px");
await page.screenshot({ path: join(artifacts, "5-work-current.png"), fullPage: true });

// Flip to Classic from inside the session, then come back to it.
await page.getByRole("button", { name: "Settings" }).click();
await page.getByRole("dialog", { name: "Settings" }).waitFor({ state: "visible", timeout: 15_000 });
await classic.click();
await page.waitForTimeout(400);
await page.keyboard.press("Escape");
await page.waitForTimeout(600);
check("work surface drops the refreshed logo in classic", (await page.locator('[data-testid="product-logo"]').count()) === 0);
check("work surface drops the page heading in classic", (await page.getByRole("heading", { level: 1 }).count()) === 0);
check("classic composer uses the rounded square send control", (await sendRadius()).startsWith("6px"));
await page.screenshot({ path: join(artifacts, "6-work-classic.png"), fullPage: true });

// Back to the home surface for the final state.
await page.getByRole("button", { name: "Back to home" }).click();
await page.waitForTimeout(600);
check("home is still classic after leaving the session", (await page.locator('[data-testid="product-logo"]').count()) === 0);

// 7) The config browser sits behind Settings and follows the same version.
const openConfigBrowser = async () => {
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("dialog", { name: "Settings" }).waitFor({ state: "visible", timeout: 15_000 });
  await page.getByRole("button", { name: /open config browser/i }).click();
  await page.waitForURL(/#\/config/, { timeout: 15_000 });
  await page.waitForTimeout(700);
};

await openConfigBrowser();
check("config browser drops the refreshed logo in classic", (await page.locator('[data-testid="product-logo"]').count()) === 0);
await page.screenshot({ path: join(artifacts, "7-config-classic.png"), fullPage: true });

await page.getByRole("button", { name: "Settings" }).click();
await page.getByRole("dialog", { name: "Settings" }).waitFor({ state: "visible", timeout: 15_000 });
await settings.getByRole("button", { name: "Current", exact: true }).click();
await page.waitForTimeout(400);
await page.keyboard.press("Escape");
await page.waitForTimeout(700);
check("config browser restores the refreshed logo", (await page.locator('[data-testid="product-logo"]').count()) === 1);
await page.screenshot({ path: join(artifacts, "8-config-current.png"), fullPage: true });

await context.close();
await browser.close();

if (failures.length > 0) {
  console.error(`\nUI_TOGGLE_VERIFY failed (${failures.length}): ${failures.join("; ")}`);
  process.exit(1);
}
console.log(`\nUI_TOGGLE_VERIFY passed. Screenshots: ${artifacts}`);
