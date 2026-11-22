#!/usr/bin/env bun
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { marketFixture } from "../src/web/skill-marketplace.test-helper";
import { startRecordingHttpProxy } from "./smoke-release-support";

// Supplemental Linux compiled/API/browser acceptance. The full native release
// smoke separately enforces Python setup and the complete Node/Bun-absent matrix.
const binary = resolve(process.argv[2] ?? "release/easyresearch-linux-x64/bin/easyresearch");
assert(existsSync(binary), "Build the Linux candidate first");
const root = mkdtempSync("/tmp/opencode/skill-market-browser-");
const home = join(root, "home");
const agent = join(root, "agent");
const project = join(root, "project");
const emptyPath = join(root, "empty-path");
for (const path of [home, agent, project, emptyPath]) mkdirSync(path);
const cert = join(root, "fixture.crt");
const key = join(root, "fixture.key");
const hosts = ["skills.sh", "www.skills.sh", "api.github.com", "raw.githubusercontent.com"];
const generated = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "2",
  "-subj", "/CN=EasyResearch marketplace smoke only", "-addext", `subjectAltName=${hosts.map(host => `DNS:${host}`).join(",")}`,
  "-keyout", key, "-out", cert], { encoding: "utf8" });
assert.equal(generated.status, 0, "Could not generate isolated fixture certificate");
const fixture = marketFixture();
const catalogRows = [fixture.skill, ...["literature-review", "scientific-writing", "data-analysis", "experiment-design", "paper-figures", "citation-check", "statistical-tests", "research-notes"].map((name, index) => ({
  id: `example/research/${name}`, source: "example/research", skillId: name, name, installs: 4200 - index * 310,
}))];
const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { key: readFileSync(key), cert: readFileSync(cert) },
  fetch(request) {
    const url = new URL(request.url);
    assert(hosts.includes(url.hostname));
    if (url.hostname === "skills.sh" || url.hostname === "www.skills.sh") {
      fixture.requests.push(url.href);
      if (url.searchParams.get("q") === "rate-limit") return Response.json({ error: "fixture" }, { status: 429, headers: { "Retry-After": "1" } });
      const rows = url.searchParams.get("q") ? [fixture.skill] : catalogRows;
      if (url.pathname === "/api/search") return Response.json({ skills: rows });
      const payload = `1:["$","$L1",null,${JSON.stringify({ initialSkills: rows })}]`;
      return new Response(`<html><script>self.__next_f.push([1,${JSON.stringify(payload)}])</script></html>`);
    }
    return fixture.response(url.href);
  },
});
const proxy = await startRecordingHttpProxy({ name: "market-search", fakeTargets: Object.fromEntries(hosts.map(host => [host, `https://127.0.0.1:${origin.port}`])) });
writeFileSync(join(agent, "settings.json"), JSON.stringify({ easyresearch: { network: { searchProxy: proxy.url } } }));
const portServer = createServer();
await new Promise<void>(resolve => portServer.listen(0, "127.0.0.1", resolve));
const address = portServer.address();
assert(address && typeof address !== "string");
const port = address.port;
await new Promise<void>(resolve => portServer.close(() => resolve()));
const base = `http://127.0.0.1:${port}`;
const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, EASYRESEARCH_CODING_AGENT_DIR: agent,
  PATH: emptyPath, NODE_EXTRA_CA_CERTS: cert };
delete env.EASYRESEARCH_SKIP_SETUP;
delete env.EASYRESEARCH_BUNDLED_ROOT;
delete env.PI_PACKAGE_DIR;
const json = async (path: string, body?: unknown) => {
  const response = await fetch(base + path, { signal: AbortSignal.timeout(45_000), ...(body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }) });
  assert(response.ok, `${path}: ${response.status} ${await response.clone().text()}`);
  return response.json() as Promise<any>;
};
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const errors: string[] = [];
try {
  const launcher = Bun.spawn([binary, "--no-open", "--port", String(port)], { cwd: project, env, stdout: Bun.file(join(root, "launcher.log")), stderr: Bun.file(join(root, "launcher-error.log")) });
  assert.equal(await launcher.exited, 0, `Candidate startup failed: ${root}`);
  const initial = await json("/api/skill-marketplace");
  assert.equal(initial.skills[0].id, fixture.id);
  const detail = await json(`/api/skill-marketplace/detail?id=${fixture.id}`);
  assert.equal(detail.content, fixture.content);
  assert.equal(detail.state, "available");
  assert(!existsSync(join(agent, "skills/market-test")));
  const session = await json("/api/sessions", { cwd: project });
  const commandsBefore = await json(`/api/sessions/${session.id}/commands`);
  assert(!commandsBefore.commands.some((entry: any) => entry.name === "market-test"));

  browser = await chromium.launch({ executablePath: process.env.COMPARE_CHROMIUM_PATH ?? chromium.executablePath(), headless: true });
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, locale: "en-US" });
  const page = await context.newPage();
  const workerUrls: string[] = [];
  page.on("worker", worker => workerUrls.push(worker.url()));
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${base}/#/?settings=1`);
  await page.getByRole("dialog", { name: "Settings", exact: true }).waitFor();
  await page.getByRole("tab", { name: "Skills and tools", exact: true }).click();
  const catalogStarted = performance.now();
  await page.getByRole("button", { name: "Marketplace", exact: true }).click();
  await page.getByRole("button", { name: "Add market-test", exact: true }).first().waitFor();
  const catalogRenderMs = performance.now() - catalogStarted;
  const columns = await page.locator(".er-market-grid").last().evaluate(element => getComputedStyle(element).gridTemplateColumns.split(" ").length);
  assert.equal(columns, 3, "Desktop marketplace should use three columns");
  assert(await page.locator(".er-market-card").first().evaluate(element => getComputedStyle(element).backgroundColor !== "rgba(0, 0, 0, 0)"));
  await page.screenshot({ path: join(root, "desktop.png") });
  const sibling = await page.context().newPage();
  sibling.on("pageerror", error => errors.push(error.message));
  await sibling.goto(`${base}/#/?settings=1`);
  await sibling.getByRole("tab", { name: "Skills and tools", exact: true }).click();
  await sibling.getByRole("button", { name: "Marketplace", exact: true }).click();
  await sibling.getByRole("button", { name: "Add market-test", exact: true }).first().waitFor();
  await page.getByRole("button", { name: "Add market-test", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "market-test", exact: true });
  await dialog.getByText(fixture.commit, { exact: true }).waitFor();
  await dialog.getByText("Files (4)", { exact: true }).click();
  await dialog.getByText("assets/sample.bin", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Install globally", exact: true }).click();
  await dialog.getByRole("button", { name: "Installed", exact: true }).waitFor();
  assert(await dialog.getByRole("button", { name: "Installed", exact: true }).isDisabled());
  await sibling.getByRole("button", { name: "View installed market-test", exact: true }).first().waitFor();
  await sibling.close();
  assert(workerUrls.some(url => url.startsWith(`${base}/assets/markdown.worker-`)), "Preview must load the compiled Markdown Worker");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))));
  for (const [path, bytes] of fixture.files) assert.deepEqual(readFileSync(join(agent, "skills/market-test", path)), bytes);
  const installed = await json("/api/skill-resources");
  assert(installed.some((row: any) => row.marketplaceId === fixture.id));
  const retry = await json("/api/skill-marketplace/install", { id: fixture.id, commit: fixture.commit });
  assert.equal(retry.name, "market-test");
  const deadline = Date.now() + 15_000;
  for (;;) {
    const commands = await json(`/api/sessions/${session.id}/commands`);
    if (commands.commands.some((entry: any) => entry.name === "market-test")) break;
    assert(Date.now() < deadline, "Idle native runtime did not discover the installed Skill");
    await Bun.sleep(100);
  }
  await page.getByRole("searchbox", { name: "Search skills" }).fill("rate-limit");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "rate-limited" }).waitFor();
  await page.getByRole("searchbox", { name: "Search skills" }).fill("research");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("button", { name: "View market-test", exact: true }).waitFor();
  await page.getByRole("button", { name: /^Installed \(/ }).click();
  await page.getByRole("button", { name: "Edit skill market-test", exact: true }).waitFor();
  await page.getByRole("button", { name: "Marketplace", exact: true }).click();
  await page.getByRole("button", { name: "All", exact: true }).click();
  await page.getByRole("button", { name: "View literature-review", exact: true }).first().waitFor();
  await page.keyboard.press("Escape");
  await page.goto(`${base}/#/work/${session.id}?cwd=${encodeURIComponent(project)}`);
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("Keep this draft @");
  await page.getByRole("option", { name: "Discover more skills", exact: true }).click();
  await page.getByRole("button", { name: "View market-test", exact: true }).first().waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await composer.inputValue(), "Keep this draft @", "Marketplace navigation changed the draft");
  await page.goto(`${base}/#/?settings=1`);
  await page.getByRole("tab", { name: "Skills and tools", exact: true }).click();
  await page.getByRole("button", { name: "Marketplace", exact: true }).click();
  await page.getByRole("button", { name: "View market-test", exact: true }).first().waitFor();
  await page.evaluate(() => {
    const key = "easyresearch.webui.preferences";
    const preferences = JSON.parse(localStorage.getItem(key) ?? "{}");
    localStorage.setItem(key, JSON.stringify({ ...preferences, studioTheme: "dark", language: "zh-CN" }));
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => { Object.defineProperty(window, "Worker", { configurable: true, value: undefined }); });
  workerUrls.length = 0;
  await page.reload();
  await page.getByRole("button", { name: "技能与工具", exact: true }).click();
  await page.getByRole("button", { name: "技能市场", exact: true }).click();
  await page.getByRole("button", { name: "查看 market-test", exact: true }).first().waitFor();
  assert.equal(await page.locator(".er-market-grid").last().evaluate(element => getComputedStyle(element).gridTemplateColumns.split(" ").length), 1);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(root, "mobile-dark-zh.png") });
  await page.getByRole("button", { name: "查看 market-test", exact: true }).first().click();
  await page.getByRole("dialog", { name: "market-test", exact: true }).locator(".er-market-markdown").getByRole("heading", { name: "Research", exact: true }).waitFor();
  assert(!workerUrls.some(url => url.includes("markdown.worker-")), "Fallback must render without a dedicated Worker");
  await page.keyboard.press("Escape");
  assert.deepEqual(errors, []);
  assert(hosts.filter(host => host !== "www.skills.sh").every(host => proxy.records().some(record => record.host === host)), "Catalog and downloads must use Search routing");
  writeFileSync(join(root, "report.json"), JSON.stringify({ binary, columns, catalogRenderMs, installed: fixture.id, nativeCommandAvailable: true, bytePreserved: true, crossTabRefresh: true, markdownWorkerAndFallback: true, browserErrors: errors, requests: fixture.requests, proxyRecords: proxy.records() }, null, 2));
  console.log(`Skill marketplace compiled/API/browser acceptance passed: ${root}`);
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) {
    await page.screenshot({ path: join(root, "failure.png") }).catch(() => undefined);
    writeFileSync(join(root, "failure.txt"), await page.locator("body").innerText().catch(() => ""));
  }
  console.error(`Marketplace smoke diagnostics: ${root}`);
  throw error;
} finally {
  await browser?.close();
  const exit = Bun.spawn([binary, "exit"], { env, stdout: "ignore", stderr: "ignore" });
  await exit.exited;
  await proxy.close();
  origin.stop(true);
  rmSync(key, { force: true });
}
