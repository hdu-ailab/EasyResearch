#!/usr/bin/env bun
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { marketFixture } from "../src/web/skill-marketplace.test-helper";
import { createSmokeDaemonCustody, startRecordingHttpProxy } from "./smoke-release-support";

// Supplemental Linux compiled/API/browser acceptance. The full native release
// smoke separately enforces Python setup and the complete Node/Bun-absent matrix.
const binary = resolve(process.argv[2] ?? "release/easyresearch-linux-x64/bin/easyresearch");
assert(existsSync(binary), "Build the Linux candidate first");
const root = mkdtempSync("/tmp/opencode/skill-market-browser-");
const home = join(root, "home");
const agent = join(home, ".easyresearch", "agent");
const project = join(root, "project");
const emptyPath = join(root, "empty-path");
for (const path of [home, agent, project, emptyPath]) mkdirSync(path, { recursive: true });
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
const blockedId = "example/blocked/blocked-skill";
const blockedFiles = new Map([
  ["SKILL.md", Buffer.from("---\nname: blocked-skill\ndescription: An ignored descriptor fixture\n---\n# Blocked\n")],
  [".gitignore", Buffer.from("SKILL.md\n")],
]);
const blockedTree = [...blockedFiles].map(([path, bytes]) => ({
  path: `skills/blocked-skill/${path}`, type: "blob", mode: "100644", size: bytes.length,
  sha: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),
}));
const websiteSkill = { id: websiteId, source: "open.feishu.cn", skillId: "lark-mail", name: "lark-mail", installs: 1000 };
const catalogRows = [fixture.skill, ...["literature-review", "scientific-writing", "data-analysis", "experiment-design", "paper-figures", "citation-check", "statistical-tests", "research-notes"].map((name, index) => ({
  id: `example/research/${name}`, source: "example/research", skillId: name, name, installs: 4200 - index * 310,
})), websiteSkill, { ...fixture.skill, id: "example/research/missing-skill", skillId: "missing-skill", name: "missing-skill" }];
const upstreamRequests: string[] = [];
const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { key: readFileSync(key), cert: readFileSync(cert) },
  fetch(request) {
    const url = new URL(request.url);
    upstreamRequests.push(url.href);
    assert(hosts.includes(url.hostname));
    if (url.pathname.includes("/example/blocked/")) {
      if (url.pathname.endsWith("/commits/HEAD")) return Response.json({ sha: fixture.commit });
      if (url.pathname.includes("/git/trees/")) return Response.json({ truncated: false, tree: blockedTree });
      const bytes = blockedFiles.get(decodeURIComponent(url.pathname.split("/skills/blocked-skill/")[1] ?? ""));
      return bytes ? new Response(new Uint8Array(bytes)) : new Response("Missing", { status: 404 });
    }
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
const custody = createSmokeDaemonCustody({ agentDir: agent, host: "127.0.0.1", port });
const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home,
  XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local/share"),
  PATH: emptyPath, NODE_EXTRA_CA_CERTS: cert, PI_OFFLINE: "1" };
delete env.EASYRESEARCH_CODING_AGENT_DIR;
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
let accepted = false;
let phase = "startup";
try {
  const launcher = Bun.spawn([binary, "--no-open", "--port", String(port)], { cwd: project, env, stdout: Bun.file(join(root, "launcher.log")), stderr: Bun.file(join(root, "launcher-error.log")) });
  assert.equal(await launcher.exited, 0, `Candidate startup failed: ${root}`);
  assert(await custody.capture(), "No authenticated fixture daemon was captured");
  assert.equal((await json("/api/status")).agentDir, agent, "Native default Skill root must remain inside the isolated ~/.easyresearch");
  const initial = await json("/api/skill-marketplace");
  assert.equal(initial.skills[0].id, fixture.id);
  const detail = await json(`/api/skill-marketplace/detail?id=${fixture.id}`);
  assert.equal(detail.content, fixture.content);
  assert.equal(detail.state, "available");
  assert(!existsSync(join(agent, "skills/market-test")));
  const blockedPreview = await json(`/api/skill-marketplace/detail?id=${encodeURIComponent(blockedId)}`);
  const blockedInstall = await fetch(`${base}/api/skill-marketplace/install`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: blockedId, commit: blockedPreview.commit }), signal: AbortSignal.timeout(45_000),
  });
  assert(!blockedInstall.ok, "An ignored descriptor must not be reported as an installed Skill");
  const blockedFailure = await blockedInstall.json();
  assert.equal(blockedFailure.code, "SKILL_MARKET_NOT_DISCOVERABLE");
  assert(!existsSync(join(agent, "skills/blocked-skill")), "An obvious source ignore blocker must be rejected before publication");
  assert(!((await json("/api/skill-resources")) as Array<{ marketplaceId?: string }>).some(row => row.marketplaceId === blockedId));
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
  await context.tracing.start({ screenshots: true, snapshots: true });
  await context.route("https://skills.sh/**", route => route.fulfill({ contentType: "text/html", body: "<h1>External skills source page</h1>" }));
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const pageRequests: Array<{ method: string; path: string; body: unknown }> = [];
  page.on("request", request => {
    if (!request.url().startsWith(base)) return;
    pageRequests.push({ method: request.method(), path: new URL(request.url()).pathname, body: request.postDataJSON() });
  });
  const workerUrls: string[] = [];
  page.on("worker", worker => workerUrls.push(worker.url()));
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${base}/#/?settings=1`);
  await page.getByRole("dialog", { name: "Settings", exact: true }).waitFor();
  for (const name of ["Skills", "Skill marketplace", "Tools"]) await expect(page.getByRole("tab", { name, exact: true })).toBeVisible();
  assert.equal(await page.getByRole("tab", { name: "Skills and tools", exact: true }).count(), 0);
  const catalogStarted = performance.now();
  const browseStart = pageRequests.length;
  const upstreamBrowseStart = upstreamRequests.length;
  await page.getByRole("tab", { name: "Skill marketplace", exact: true }).click();
  await page.getByRole("button", { name: "Add market-test", exact: true }).first().waitFor();
  const catalogRenderMs = performance.now() - catalogStarted;
  const columns = await page.locator(".er-market-grid").last().evaluate(element => getComputedStyle(element).gridTemplateColumns.split(" ").length);
  assert.equal(columns, 3, "Desktop marketplace should use three columns");
  assert(await page.locator(".er-market-card").first().evaluate(element => getComputedStyle(element).backgroundColor !== "rgba(0, 0, 0, 0)"));
  const firstCard = page.locator(".er-market-card").first();
  const resourcePanel = page.locator("#settings-panel-marketplace");
  assert.equal(await resourcePanel.locator(".er-market-toolbar").getByRole("link", { name: "skills.sh", exact: true }).count(), 0);
  await page.locator(".er-market-card").last().scrollIntoViewIfNeeded();
  await page.getByRole("tab", { name: "Tools", exact: true }).click();
  await page.getByRole("tab", { name: "Skill marketplace", exact: true }).click();
  await firstCard.scrollIntoViewIfNeeded();
  await firstCard.getByRole("button", { name: "View market-test", exact: true }).focus();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  assert.deepEqual(pageRequests.slice(browseStart).filter(row => /\/skill-marketplace\/(detail|description)/.test(row.path)), [],
    "Browsing, scrolling, focus or category reentry must not request per-card details or summaries");
  assert(upstreamRequests.slice(upstreamBrowseStart).every(url => {
    const parsed = new URL(url);
    return parsed.hostname === "skills.sh" && ["/", "/api/search"].includes(parsed.pathname);
  }), "Catalog browsing enriched individual Skills upstream");
  const title = firstCard.locator(".er-market-title");
  const settledTitleStyle = async () => {
    await firstCard.evaluate(async node => {
      await Promise.all(node.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => undefined)));
    });
    return title.evaluate(node => ({ color: getComputedStyle(node).color, weight: getComputedStyle(node).fontWeight }));
  };
  await page.getByRole("tab", { name: "Skill marketplace", exact: true }).focus();
  await page.mouse.move(5, 5);
  const titleStyle = await settledTitleStyle();
  for (const target of ["background", "source", "install", "title-row gap"]) {
    if (target === "background") await firstCard.hover({ position: { x: 8, y: 8 } });
    else if (target === "source") await firstCard.getByRole("link", { name: "example/research", exact: true }).hover();
    else if (target === "install") await firstCard.getByRole("button", { name: "Add market-test", exact: true }).hover();
    else {
      const gap = await title.evaluate(node => {
        const range = document.createRange();
        range.selectNodeContents(node);
        const text = range.getBoundingClientRect();
        const heading = node.closest("h4")!.getBoundingClientRect();
        return { x: heading.right - 4, y: text.top + text.height / 2, exists: heading.right - text.right > 12 };
      });
      assert(gap.exists, "Hover fixture needs whitespace beside its short title");
      await page.mouse.move(gap.x, gap.y);
    }
    assert.deepEqual(await settledTitleStyle(), titleStyle,
      `Hovering ${target} unexpectedly changes the Skill title`);
  }
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
  await sibling.getByRole("tab", { name: "Skills", exact: true }).click();
  assert.equal(await sibling.locator('[data-skill-name="market-test"]').count(), 0);
  const installStart = pageRequests.length;
  const selectedInstall = firstCard.getByRole("button", { name: "Add market-test", exact: true });
  const sourceAdmission = Promise.withResolvers<void>();
  let sourceHeld = false;
  const detailPattern = `${base}/api/skill-marketplace/detail?*`;
  await page.route(detailPattern, async route => {
    sourceHeld = true;
    await sourceAdmission.promise;
    await route.continue().catch(error => errors.push(`Selected source request lost during navigation: ${String(error)}`));
  });
  try {
    await selectedInstall.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
    await expect.poll(() => sourceHeld).toBe(true);
    await page.getByRole("tab", { name: "Skills", exact: true }).click();
  } finally {
    sourceAdmission.resolve();
  }
  await page.locator('[data-skill-name="market-test"]').waitFor();
  await page.unroute(detailPattern);
  await page.getByRole("tab", { name: "Skill marketplace", exact: true }).click();
  await page.getByRole("button", { name: "View installed market-test", exact: true }).first().waitFor();
  assert.equal(await page.locator(".er-market-detail").count(), 0, "Plus must install directly rather than open a preview");
  const installRequests = pageRequests.slice(installStart).filter(row => row.path.startsWith("/api/skill-marketplace/"));
  assert.equal(installRequests.filter(row => row.path.endsWith("/detail")).length, 1);
  assert.equal(installRequests.filter(row => row.path.endsWith("/description")).length, 0, "Installation must not spend skills.sh explanation quota");
  assert.deepEqual(installRequests.filter(row => row.method === "POST").map(row => row.body), [{ id: fixture.id, commit: fixture.commit }]);
  await sibling.locator('[data-skill-name="market-test"]').waitFor();
  await page.getByRole("tab", { name: "Skills", exact: true }).click();
  await page.locator('[data-skill-name="market-test"]').waitFor();
  await expect(page.locator('[data-skill-name="market-test"]')).toContainText("Reproducible research workflows.");
  await page.screenshot({ path: join(root, "installed-skills.png") });
  await page.getByRole("tab", { name: "Skill marketplace", exact: true }).click();
  await sibling.getByRole("tab", { name: "Skill marketplace", exact: true }).click();
  await sibling.getByRole("button", { name: "View installed market-test", exact: true }).first().waitFor();
  await sibling.close();
  await firstCard.click({ position: { x: 15, y: 15 } });
  const dialog = page.getByRole("dialog", { name: "market-test", exact: true });
  await dialog.getByText(fixture.commit, { exact: true }).waitFor();
  await dialog.getByRole("heading", { name: "Catalog explanation", exact: true }).waitFor();
  await dialog.getByText("Files (4)", { exact: true }).click();
  await dialog.getByText("assets/sample.bin", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Installed", exact: true }).waitFor();
  assert(await dialog.getByRole("button", { name: "Installed", exact: true }).isDisabled());
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
  await page.getByRole("tab", { name: "Skills", exact: true }).click();
  const skillsPanel = page.locator("#settings-panel-skills");
  for (const name of ["All", "Search", "Experiments", "Figures", "Writing", "Review", "Utilities", "Other"]) {
    await expect(skillsPanel.getByRole("button", { name, exact: true })).toBeVisible();
  }
  await skillsPanel.getByRole("button", { name: "Search", exact: true }).click();
  await expect(skillsPanel.locator('[data-skill-name="paper-search"]')).toBeVisible();
  await expect(skillsPanel.locator('[data-skill-name="experiment"]')).toHaveCount(0);
  await skillsPanel.getByRole("button", { name: "Experiments", exact: true }).click();
  await expect(skillsPanel.locator('[data-skill-name="experiment"]')).toBeVisible();
  await expect(skillsPanel.locator('[data-skill-name="paper-search"]')).toHaveCount(0);
  await skillsPanel.getByRole("button", { name: "All", exact: true }).click();
  const installedCard = skillsPanel.locator('[data-skill-name="market-test"]');
  const actions = installedCard.locator('button[aria-haspopup="menu"]');
  phase = "menu keyboard and scroll ownership";
  await actions.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: /^Edit/ })).toBeFocused();
  await skillsPanel.evaluate(node => node.dispatchEvent(new Event("scroll")));
  await page.locator(".er-settings-navigation").evaluateAll(nodes => {
    for (const node of nodes) node.dispatchEvent(new Event("scroll"));
  });
  await expect(page.getByRole("menuitem", { name: /^Edit/ })).toBeFocused();
  await skillsPanel.evaluate(node => { node.scrollTop += 12; });
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(actions).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: /^Edit/ })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(actions).toBeFocused();
  await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
  await actions.click();
  phase = "edit Skill";
  await page.getByRole("menuitem", { name: /^Edit/ }).click();
  const markdownEditor = page.getByRole("textbox", { name: "Skill Markdown", exact: true });
  await markdownEditor.fill(`${fixture.content}\nVerified local edit.\n`);
  await page.getByRole("button", { name: "Save skill", exact: true }).click();
  await expect(markdownEditor).toHaveCount(0);
  assert.match(readFileSync(join(agent, "skills/market-test/SKILL.md"), "utf8"), /Verified local edit/);
  phase = "disable Skill";
  await actions.click();
  await page.getByRole("menuitem", { name: /^Disable/ }).click();
  await expect.poll(async () => (await json("/api/skill-resources")).find((row: any) => row.name === "market-test")?.enabled).toBe(false);
  await expect.poll(async () => (await json(`/api/sessions/${session.id}/commands`)).commands.some((row: any) => row.name === "market-test"), { timeout: 15_000 }).toBe(false);
  phase = "enable Skill";
  await actions.click();
  await page.getByRole("menuitem", { name: /^Enable/ }).click();
  await expect.poll(async () => (await json("/api/skill-resources")).find((row: any) => row.name === "market-test")?.enabled).toBe(true);
  await expect.poll(async () => (await json(`/api/sessions/${session.id}/commands`)).commands.some((row: any) => row.name === "market-test"), { timeout: 15_000 }).toBe(true);
  phase = "open first delete menu";
  await actions.click();
  await page.getByRole("menuitem", { name: /^Delete/ }).click();
  phase = "cancel delete";
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert(existsSync(join(agent, "skills/market-test/SKILL.md")), "Cancelling deletion removed the Skill");
  phase = "open second delete menu";
  await actions.click();
  await page.getByRole("menuitem", { name: /^Delete/ }).click();
  phase = "confirm delete";
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(installedCard).toHaveCount(0);
  assert(!existsSync(join(agent, "skills/market-test")), "Deletion left the owned global Skill directory behind");
  assert(existsSync(join(agent, "skills/lark-mail/SKILL.md")), "Deletion affected another Skill");
  await page.getByRole("tab", { name: "Skill marketplace", exact: true }).click();
  await page.getByRole("button", { name: "Add market-test", exact: true }).first().click();
  await page.getByRole("button", { name: "View installed market-test", exact: true }).first().waitFor();
  await expect.poll(async () => (await json("/api/skill-resources")).find((row: any) => row.name === "market-test")?.enabled).toBe(true);
  await expect.poll(async () => (await json(`/api/sessions/${session.id}/commands`)).commands.some((row: any) => row.name === "market-test"), { timeout: 15_000 }).toBe(true);
  // Exercise the compiled matcher, not merely its import or exact-path branch.
  phase = "native glob override";
  await page.getByRole("tab", { name: "Skills", exact: true }).click();
  const settingsPath = join(agent, "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const exclusion = "!skills/market-test/**";
  const replacementSettings = join(agent, ".skill-policy-next.json");
  writeFileSync(replacementSettings, JSON.stringify({ ...settings, skills: [...(settings.skills ?? []), exclusion] }));
  renameSync(replacementSettings, settingsPath);
  await expect.poll(async () => (await json("/api/skill-resources")).find((row: any) => row.name === "market-test")?.enabled, { timeout: 15_000 }).toBe(false);
  await expect.poll(async () => (await json(`/api/sessions/${session.id}/commands`)).commands.some((row: any) => row.name === "market-test"), { timeout: 15_000 }).toBe(false);
  await actions.click();
  await page.getByRole("menuitem", { name: /^Enable/ }).click();
  await expect.poll(async () => (await json(`/api/sessions/${session.id}/commands`)).commands.some((row: any) => row.name === "market-test"), { timeout: 15_000 }).toBe(true);
  assert(JSON.parse(readFileSync(settingsPath, "utf8")).skills.includes(exclusion), "Enable discarded the broader native exclusion");
  await page.getByRole("tab", { name: "Skill marketplace", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search skills" }).fill("rate-limit");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "rate-limited" }).waitFor();
  await page.getByRole("searchbox", { name: "Search skills" }).fill("research");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("button", { name: "View market-test", exact: true }).waitFor();
  await page.getByRole("tab", { name: "Skills", exact: true }).click();
  await page.locator('[data-skill-name="market-test"]').waitFor();
  await page.getByRole("tab", { name: "Skill marketplace", exact: true }).click();
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
  await page.getByRole("tab", { name: "Skill marketplace", exact: true }).click();
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
  await page.getByRole("button", { name: "技能市场", exact: true }).click();
  await page.getByRole("button", { name: "查看 market-test", exact: true }).first().waitFor();
  assert.equal(await page.locator(".er-market-grid").last().evaluate(element => getComputedStyle(element).gridTemplateColumns.split(" ").length), 1);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(root, "mobile-dark-zh.png") });
  await page.getByRole("button", { name: "查看 market-test", exact: true }).first().click();
  await page.getByRole("dialog", { name: "market-test", exact: true }).locator(".er-market-markdown").getByRole("heading", { name: "Catalog explanation", exact: true }).waitFor();
  assert(!workerUrls.some(url => url.includes("markdown.worker-")), "Fallback must render without a dedicated Worker");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "返回设置", exact: true }).click();
  await page.getByRole("button", { name: "技能", exact: true }).click();
  const mobileSkills = page.locator("#settings-panel-skills");
  await mobileSkills.locator('[data-skill-name="market-test"]').waitFor();
  for (const name of ["全部", "搜索类", "实验类", "图表类", "写作类", "审稿类", "实用类", "其他"]) {
    await expect(mobileSkills.getByRole("button", { name, exact: true })).toBeVisible();
  }
  assert(await mobileSkills.evaluate(node => node.scrollWidth <= node.clientWidth), "Installed Skill cards overflow the mobile panel");
  await page.screenshot({ path: join(root, "mobile-installed-dark-zh.png") });
  assert.deepEqual(errors, []);
  assert(hosts.filter(host => host !== "www.skills.sh").every(host => proxy.records().some(record => record.host === host)), "Catalog and downloads must use Search routing");
  writeFileSync(join(root, "report.json"), JSON.stringify({ binary, sha256: createHash("sha256").update(readFileSync(binary)).digest("hex"), columns, catalogRenderMs, installed: fixture.id, websiteInstalled: websiteId, namespacedInstalled: namespaceId, separateSettingsEntries: true, implicitCardRequests: 0, directInstallRequests: installRequests, titlePointerFeedback: true, installedVisibleWithoutReload: true, skillControls: ["local categories", "menu keyboard/Escape", "edit", "disable/enable native commands", "cancel delete", "delete own directory", "reinstall enabled", "native glob exclusion and exact re-enable"], falseInstallSuccessRejected: { status: blockedInstall.status, failure: blockedFailure }, defaultGlobalRoot: agent, wholeCardPreview: true, authorPopup: true, copyAndManualSelection: true, nativeCommandAvailable: true, bytePreserved: true, crossTabRefresh: true, markdownWorkerAndFallback: true, browserErrors: errors, requests: upstreamRequests, proxyRecords: proxy.records() }, null, 2));
  accepted = true;
  console.log(`Skill marketplace compiled/API/browser acceptance passed: ${root}`);
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) {
    await page.screenshot({ path: join(root, "failure.png") }).catch(() => undefined);
    writeFileSync(join(root, "failure.txt"), await page.locator("body").innerText().catch(() => ""));
    const state = await page.locator('[data-skill-name="market-test"]').evaluateAll(cards => cards.map(card => ({
      html: card.outerHTML, activeElement: document.activeElement?.outerHTML,
    }))).catch(() => []);
    writeFileSync(join(root, "failure-phase.json"), JSON.stringify({ phase, state }, null, 2));
  }
  console.error(`Marketplace smoke diagnostics: ${root}`);
  throw error;
} finally {
  await browser?.contexts()[0]?.tracing.stop({ path: join(root, "trace.zip") }).catch(() => undefined);
  const cleanup = await Promise.allSettled([
    browser?.close(),
    custody.stopAndVerify(),
    proxy.close(),
    origin.stop(true),
  ]);
  rmSync(key, { force: true });
  const failures = cleanup.flatMap((item, index) => item.status === "rejected"
    ? [{ owner: ["browser", "daemon", "proxy", "origin"][index], error: String(item.reason) }] : []);
  writeFileSync(join(root, "cleanup.json"), JSON.stringify({ passed: failures.length === 0, failures }, null, 2));
  if (accepted && failures.length) throw new Error(`Marketplace acceptance cleanup failed: ${JSON.stringify(failures)}`);
}
