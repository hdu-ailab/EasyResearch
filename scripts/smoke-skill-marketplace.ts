#!/usr/bin/env bun
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
const hosts = ["skills.sh", "www.skills.sh", "api.github.com", "raw.githubusercontent.com", "open.feishu.cn"];
const generated = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "2",
  "-subj", "/CN=EasyResearch marketplace smoke only", "-addext", `subjectAltName=${hosts.map(host => `DNS:${host}`).join(",")}`,
  "-keyout", key, "-out", cert], { encoding: "utf8" });
assert.equal(generated.status, 0, "Could not generate isolated fixture certificate");
const fixture = marketFixture();
const websiteId = "open.feishu.cn/lark-mail";
const websiteFiles = new Map([
  ["SKILL.md", Buffer.from("---\nname: lark-mail\ndescription: Website mail skill\n---\n# Website Mail\n")],
  ["assets/binary.bin", Buffer.from([0, 255, 128])],
  ["references/help.md", Buffer.from("# Website help\n")],
]);
const namespaced = marketFixture();
const namespaceId = "example/namespaced/stitch::market-test";
const namespaceContent = namespaced.content.replace("name: market-test", "name: stitch::market-test");
namespaced.files.set("SKILL.md", Buffer.from(namespaceContent));
namespaced.tree[0]!.size = Buffer.byteLength(namespaceContent);
namespaced.tree[0]!.sha = createHash("sha1").update(`blob ${Buffer.byteLength(namespaceContent)}\0`).update(namespaceContent).digest("hex");
const websiteSkill = { id: websiteId, source: "open.feishu.cn", skillId: "lark-mail", name: "lark-mail", installs: 1000 };
const catalogRows = [fixture.skill, ...["literature-review", "scientific-writing", "data-analysis", "experiment-design", "paper-figures", "citation-check", "statistical-tests", "research-notes"].map((name, index) => ({
  id: `example/research/${name}`, source: "example/research", skillId: name, name, installs: 4200 - index * 310,
})), websiteSkill, { ...fixture.skill, id: "example/research/missing-skill", skillId: "missing-skill", name: "missing-skill" }];
const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { key: readFileSync(key), cert: readFileSync(cert) },
  fetch(request) {
    const url = new URL(request.url);
    assert(hosts.includes(url.hostname));
    if (url.hostname === "open.feishu.cn") {
      fixture.requests.push(url.href);
      if (url.pathname.includes("/agent-skills/")) return new Response("<html>Not an index</html>");
      if (url.pathname.endsWith("/index.json")) return Response.json({ skills: [{ name: "lark-mail", description: "Mail", files: [...websiteFiles.keys()] }] });
      const bytes = websiteFiles.get(url.pathname.split("/lark-mail/")[1]!);
      return bytes ? new Response(new Uint8Array(bytes)) : new Response("Missing", { status: 404 });
    }
    if (url.hostname === "skills.sh" || url.hostname === "www.skills.sh") {
      fixture.requests.push(url.href);
      if (url.searchParams.get("q") === "rate-limit") return Response.json({ error: "fixture" }, { status: 429, headers: { "Retry-After": "1" } });
      if (url.pathname === "/example/research/market-test") return new Response('<main><div class="prose"><h1>Catalog explanation</h1><p>Read this public skill guide.</p></div></main>');
      if (url.pathname === "/site/open.feishu.cn/lark-mail") return new Response('<div class="prose"><h1>Website catalog guide</h1></div>');
      if (url.pathname === "/example/research/missing-skill") return new Response('<div class="prose"><h1>Available explanation despite download failure</h1></div>');
      if (url.pathname.startsWith("/example/research/")) return new Response('<meta name="description" content="Research tools for collecting evidence, organizing references and building reproducible workflows."><div class="prose"><h1>Skill guide</h1><p>Detailed workflow instructions.</p></div>');
      const rows = url.searchParams.get("q") ? [fixture.skill] : catalogRows;
      if (url.pathname === "/api/search") return Response.json({ skills: rows });
      const payload = `1:["$","$L1",null,${JSON.stringify({ initialSkills: rows })}]`;
      return new Response(`<html><script>self.__next_f.push([1,${JSON.stringify(payload)}])</script></html>`);
    }
    return url.pathname.includes("/example/namespaced/") ? namespaced.response(url.href) : fixture.response(url.href);
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
  for (const id of [websiteId, namespaceId]) {
    const preview = await json(`/api/skill-marketplace/detail?id=${encodeURIComponent(id)}`);
    await json("/api/skill-marketplace/install", { id, commit: preview.commit });
    if (id === websiteId) {
      assert.match(preview.commit, /^sha256:/);
      for (const [path, bytes] of websiteFiles) assert.deepEqual(readFileSync(join(agent, "skills/lark-mail", path)), bytes);
    } else assert.equal(readFileSync(join(agent, "skills/stitch-market-test/SKILL.md"), "utf8"), namespaceContent);
  }

  browser = await chromium.launch({ executablePath: process.env.COMPARE_CHROMIUM_PATH ?? chromium.executablePath(), headless: true });
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, locale: "en-US" });
  await context.route("https://skills.sh/**", route => route.fulfill({ contentType: "text/html", body: "<h1>External skills source page</h1>" }));
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
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
  const firstCard = page.locator(".er-market-card").first();
  const resourcePanel = page.locator("#settings-panel-resources");
  assert.equal(await resourcePanel.getByRole("heading", { name: "Skills and tools", exact: true }).count(), 0);
  assert.equal(await resourcePanel.locator(".er-market-toolbar").getByRole("link", { name: "skills.sh", exact: true }).count(), 0);
  const searchBox = await resourcePanel.locator(".er-market-search").boundingBox();
  const viewControls = await resourcePanel.locator(".er-market-toolbar > .er-market-switch").boundingBox();
  assert(searchBox && viewControls && searchBox.x < viewControls.x && Math.abs(searchBox.y + searchBox.height / 2 - viewControls.y - viewControls.height / 2) < 2,
    "Search must lead the first row, with view controls aligned on the right");
  await firstCard.locator(".er-market-summary").filter({ hasText: "Read this public skill guide." }).waitFor();
  await page.locator(".er-market-card").nth(1).locator(".er-market-summary").filter({ hasText: "Research tools" }).waitFor();
  await page.screenshot({ path: join(root, "desktop.png") });
  assert.equal(await firstCard.locator(".er-market-avatar").count(), 0);
  assert.equal(await firstCard.getByRole("link", { name: "example/research", exact: true }).getAttribute("href"), "https://skills.sh/example/research");
  const [authorPage] = await Promise.all([page.waitForEvent("popup"), firstCard.getByRole("link", { name: "example/research", exact: true }).click()]);
  await authorPage.waitForURL("https://skills.sh/example/research");
  assert(authorPage.url().startsWith("https://skills.sh/example/research"));
  await authorPage.close();
  assert.equal(await page.locator(".er-market-detail").count(), 0, "Author link must not open the skill dialog");
  const sibling = await page.context().newPage();
  sibling.on("pageerror", error => errors.push(error.message));
  await sibling.goto(`${base}/#/?settings=1`);
  await sibling.getByRole("tab", { name: "Skills and tools", exact: true }).click();
  await sibling.getByRole("button", { name: "Marketplace", exact: true }).click();
  await sibling.getByRole("button", { name: "Add market-test", exact: true }).first().waitFor();
  await firstCard.click({ position: { x: 15, y: 15 } });
  const dialog = page.getByRole("dialog", { name: "market-test", exact: true });
  await dialog.getByText(fixture.commit, { exact: true }).waitFor();
  await dialog.getByRole("heading", { name: "Catalog explanation", exact: true }).waitFor();
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
  const allCommands = await json(`/api/sessions/${session.id}/commands`);
  for (const name of ["lark-mail", "stitch::market-test"]) assert(allCommands.commands.some((entry: any) => entry.name === name), `Native Skill missing: ${name}`);
  await page.getByRole("searchbox", { name: "Search skills" }).fill("rate-limit");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "rate-limited" }).waitFor();
  await page.getByRole("searchbox", { name: "Search skills" }).fill("research");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("button", { name: "View market-test", exact: true }).waitFor();
  await page.getByRole("button", { name: /^Installed \(/ }).click();
  await page.getByRole("button", { name: "Edit skill market-test", exact: true }).waitFor();
  await page.getByRole("button", { name: "Marketplace", exact: true }).click();
  assert.equal(await page.getByRole("searchbox", { name: "Search skills" }).inputValue(), "research", "View switching must preserve the search draft");
  await page.getByRole("button", { name: "All", exact: true }).click();
  await page.getByRole("button", { name: "View literature-review", exact: true }).first().waitFor();
  await page.getByRole("button", { name: "View missing-skill", exact: true }).click();
  const failedPreview = page.getByRole("dialog", { name: "missing-skill", exact: true });
  await failedPreview.getByRole("link", { name: "Manual download", exact: true }).waitFor();
  await failedPreview.getByRole("heading", { name: "Available explanation despite download failure", exact: true }).waitFor();
  await failedPreview.getByRole("button", { name: "Copy installation request", exact: true }).click();
  await failedPreview.getByText("Copied. Paste it into the Research Assistant conversation to install.", { exact: true }).waitFor();
  assert((await page.evaluate(() => navigator.clipboard.readText())).includes("example/research/missing-skill"));
  await page.screenshot({ path: join(root, "recovery.png") });
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error("fixture denial"); }; });
  await failedPreview.getByRole("button", { name: "Copy installation request", exact: true }).click();
  await failedPreview.getByText("Copy failed. The request is selected; copy it manually.", { exact: true }).waitFor();
  assert(await failedPreview.getByRole("textbox").evaluate((element: HTMLTextAreaElement) => element.selectionEnd - element.selectionStart === element.value.length));
  await page.keyboard.press("Escape");
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
  await page.getByRole("dialog", { name: "market-test", exact: true }).locator(".er-market-markdown").getByRole("heading", { name: "Catalog explanation", exact: true }).waitFor();
  assert(!workerUrls.some(url => url.includes("markdown.worker-")), "Fallback must render without a dedicated Worker");
  await page.keyboard.press("Escape");
  assert.deepEqual(errors, []);
  assert(hosts.filter(host => host !== "www.skills.sh").every(host => proxy.records().some(record => record.host === host)), "Catalog and downloads must use Search routing");
  writeFileSync(join(root, "report.json"), JSON.stringify({ binary, columns, catalogRenderMs, installed: fixture.id, websiteInstalled: websiteId, namespacedInstalled: namespaceId, cardSummaries: true, wholeCardPreview: true, authorPopup: true, copyAndManualSelection: true, nativeCommandAvailable: true, bytePreserved: true, crossTabRefresh: true, markdownWorkerAndFallback: true, browserErrors: errors, requests: fixture.requests, proxyRecords: proxy.records() }, null, 2));
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
