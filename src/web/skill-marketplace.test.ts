import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigFileService } from "./config-files";
import { listGlobalSkills } from "./agent-resources";
import { createRouteHandler, type RouteServices } from "./routes";
import { DESKTOP_ACCESS_HEADER } from "./desktop-access";
import { SkillMarketplace } from "./skill-marketplace";
import { publishNewSkill } from "./skill-marketplace-install";
import { parseMarketLeaderboard, parseMarketSkills, safeSkillPath, SkillMarketplaceSource } from "./skill-marketplace-source";
import { marketFixture } from "./skill-marketplace.test-helper";

let root: string;
let market: SkillMarketplace;
let fixture: ReturnType<typeof marketFixture>;
let config: ConfigFileService;
let skillOptions: { skillPolicy: { enableDotAgentsSkill: boolean }; bundledSkillsDir: string; homeDir: string };
let notify: ReturnType<typeof vi.fn<() => Promise<unknown>>>;
let fetcher: ReturnType<typeof vi.fn<(url: string, init: RequestInit) => Promise<Response>>>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "er-market-test-"));
  vi.stubEnv("HOME", root);
  vi.stubEnv("EASYRESEARCH_CODING_AGENT_DIR", join(root, "agent"));
  mkdirSync(join(root, "bundled"));
  fixture = marketFixture();
  config = new ConfigFileService(join(root, "agent"));
  skillOptions = { skillPolicy: { enableDotAgentsSkill: false }, bundledSkillsDir: join(root, "bundled"), homeDir: root };
  notify = vi.fn(async () => {
    for (const [path, bytes] of fixture.files) expect(readFileSync(join(config.globalRoot, "skills/market-test", path))).toEqual(bytes);
  });
  fetcher = vi.fn(async (url) => fixture.response(url));
  market = new SkillMarketplace({ config, skillOptions: () => skillOptions, notify, fetch: fetcher });
});
afterEach(async () => {
  await market.close();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("skill marketplace", () => {
  it("reads public catalogs without executing scripts and keeps searches isolated", async () => {
    const popular = await market.catalog("", "all-time");
    const search = await market.catalog("research & data", "all-time");
    expect(popular.skills[0]?.id).toBe(fixture.id);
    expect(search.skills[0]?.supported).toBe(true);
    await market.catalog("", "all-time");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fixture.requests[1]).toContain("q=research+%26+data");
    expect(() => parseMarketLeaderboard('<script>throw new Error("must not execute")</script>')).toThrow(/format changed/);
    await expect(market.catalog("x", "all-time")).rejects.toMatchObject({ status: 400 });
  });

  it("previews without writing and installs every immutable file byte-for-byte before notification", async () => {
    const detail = await market.detail(fixture.id);
    expect(detail.state).toBe("available");
    expect(existsSync(config.globalRoot)).toBe(false);
    await market.install({ id: fixture.id, commit: detail.commit });
    for (const [path, bytes] of fixture.files) expect(readFileSync(join(config.globalRoot, "skills/market-test", path))).toEqual(bytes);
    if (process.platform !== "win32") expect(statSync(join(config.globalRoot, "skills/market-test/scripts/check.py")).mode & 0o100).toBeTruthy();
    expect(notify).toHaveBeenCalledOnce();
    const installed = await listGlobalSkills(config, skillOptions);
    expect(installed).toMatchObject([{ name: "market-test", source: "global", marketplaceId: fixture.id }]);
    expect((await market.detail(fixture.id)).state).toBe("installed");
    await market.install({ id: fixture.id, commit: detail.commit });
    expect(notify).toHaveBeenCalledOnce();
    expect(fixture.requests.filter((url) => url.includes("raw.githubusercontent.com")).every((url) => url.includes(detail.commit))).toBe(true);
  });

  it("never overwrites a bundled or user skill with a matching name", async () => {
    const bundled = join(skillOptions.bundledSkillsDir, "market-test");
    mkdirSync(bundled);
    writeFileSync(join(bundled, "SKILL.md"), fixture.content);
    expect((await market.detail(fixture.id)).state).toBe("conflict");
    await expect(market.install({ id: fixture.id, commit: fixture.commit })).rejects.toMatchObject({ status: 409 });
    expect(readFileSync(join(bundled, "SKILL.md"), "utf8")).toBe(fixture.content);
    expect(existsSync(config.globalRoot)).toBe(false);
  });

  it("pins the previewed commit after cache loss", async () => {
    const detail = await market.detail(fixture.id);
    await market.close();
    fixture.requests.length = 0;
    market = new SkillMarketplace({ config, skillOptions: () => skillOptions, notify, fetch: fetcher });
    await market.install({ id: fixture.id, commit: detail.commit });
    expect(fixture.requests.some((url) => url.includes("/commits/HEAD"))).toBe(false);
    expect(fixture.requests.some((url) => url.includes(`/git/trees/${detail.commit}`))).toBe(true);
  });

  it.each(["symlink", "truncated", "nested", "traversal", "case", "oversized"])("rejects %s trees before publication", async (kind) => {
    if (kind === "symlink") fixture.tree[1]!.mode = "120000";
    if (kind === "nested") fixture.tree[1]!.path = "skills/market-test/child/SKILL.md";
    if (kind === "traversal") fixture.tree[1]!.path = "skills/market-test/../../outside";
    if (kind === "case") fixture.tree.push({ ...fixture.tree[1]!, path: fixture.tree[1]!.path.toUpperCase().replace("SKILLS/MARKET-TEST", "skills/market-test") });
    if (kind === "oversized") fixture.tree[1]!.size = 20 * 1024 * 1024;
    if (kind === "truncated") fetcher.mockImplementation(async (url) => url.includes("/git/trees/") ? Response.json({ truncated: true, tree: fixture.tree }) : fixture.response(url));
    await expect(market.install({ id: fixture.id, commit: fixture.commit })).rejects.toBeInstanceOf(Error);
    expect(existsSync(config.globalRoot)).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it("retains no partial skill after a corrupt supporting file", async () => {
    await market.detail(fixture.id);
    fixture.files.set("assets/sample.bin", Buffer.from([1, 2, 3, 4, 5]));
    await expect(market.install({ id: fixture.id, commit: fixture.commit })).rejects.toMatchObject({ status: 422 });
    expect(existsSync(config.globalRoot)).toBe(false);
  });

  it("owns concurrent installs and cancels downloads on shutdown", async () => {
    await market.detail(fixture.id);
    const started = Promise.withResolvers<void>();
    fetcher.mockImplementation(async (_url, init) => new Promise((_resolve, reject) => {
      started.resolve();
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    const first = market.install({ id: fixture.id, commit: fixture.commit });
    const rejection = expect(first).rejects.toMatchObject({ status: 408 });
    await started.promise;
    await expect(market.install({ id: fixture.id, commit: fixture.commit })).rejects.toMatchObject({ status: 409 });
    await market.close();
    await rejection;
    expect(existsSync(config.globalRoot)).toBe(false);
    await expect(market.catalog("", "hot")).rejects.toMatchObject({ status: 503 });
  });

  it("reports post-publication acceptance failure without deleting installed bytes", async () => {
    notify.mockRejectedValue(new Error("configuration rejected"));
    await expect(market.install({ id: fixture.id, commit: fixture.commit })).rejects.toThrow();
    expect(readFileSync(join(config.globalRoot, "skills/market-test/SKILL.md"), "utf8")).toBe(fixture.content);
  });

  it("routes typed APIs through Desktop admission and JSON mutation checks", async () => {
    const desktop = createRouteHandler({
      skillMarketplace: market, desktopAccess: { token: "fixture-only" }, directories: {},
    } as unknown as RouteServices);
    expect((await desktop(new Request("http://localhost/api/skill-marketplace"))).status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
    expect((await desktop(new Request("http://localhost/api/skill-marketplace", {
      headers: { [DESKTOP_ACCESS_HEADER]: "fixture-only" },
    }))).status).toBe(200);
    const handler = createRouteHandler({
      config, skillMarketplace: market, configuration: { skillPolicy: skillOptions.skillPolicy },
      directories: {}, registry: {}, logger: { error: vi.fn(), warn: vi.fn() },
    } as unknown as RouteServices);
    const preview = await handler(new Request(`http://localhost/api/skill-marketplace/detail?id=${fixture.id}`));
    expect(preview.status).toBe(200);
    const rejected = await handler(new Request("http://localhost/api/skill-marketplace/install", { method: "POST", body: JSON.stringify({ id: fixture.id, commit: fixture.commit }) }));
    expect(rejected.status).toBe(415);
    const installed = await handler(new Request("http://localhost/api/skill-marketplace/install", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: fixture.id, commit: fixture.commit }),
    }));
    expect(installed.status).toBe(200);
    const inventory = await handler(new Request("http://localhost/api/skill-resources"));
    expect(await inventory.json()).toEqual(expect.arrayContaining([expect.objectContaining({ marketplaceId: fixture.id })]));
    await handler.close?.();
  });
});

describe("bounded publication and transport", () => {
  it("admits namespaced GitHub and website catalog identities", () => {
    const rows = parseMarketSkills([fixture.skill, { ...fixture.skill, skillId: "stitch::design" }]);
    expect(rows[0]?.supported).toBe(true);
    expect(rows[1]?.supported).toBe(true);
    expect(parseMarketSkills([{ ...fixture.skill, source: "open.feishu.cn" }])[0]?.supported).toBe(true);
  });
  it("allows the public canonical redirect but never redirects to arbitrary hosts", async () => {
    const requested: string[] = [];
    const source = new SkillMarketplaceSource(async (url) => {
      requested.push(url);
      return url === "https://skills.sh/" ? new Response(null, { status: 308, headers: { Location: "https://www.skills.sh/" } }) : new Response("ok");
    });
    expect((await source.bytes("https://skills.sh/", 10, new AbortController().signal)).toString()).toBe("ok");
    expect(requested).toEqual(["https://skills.sh/", "https://www.skills.sh/"]);
    const redirected = vi.fn(async () => new Response(null, { status: 302, headers: { Location: "http://localhost/secrets" } }));
    await expect(new SkillMarketplaceSource(redirected).bytes("https://skills.sh/", 10, new AbortController().signal)).rejects.toThrow();
    expect(redirected).toHaveBeenCalledOnce();
  });
  it.each(["../x", "/tmp/x", "C:/x", "a\\b", "a/%2e%2e/x", "a/CON.txt", "a./file", "a//b"])("rejects unsafe portable path %s", (path) => {
    expect(safeSkillPath(path)).toBe(false);
  });
  it("refuses an existing empty directory, file/parent collision and redirected root", () => {
    const files = [{ path: "SKILL.md", bytes: Buffer.from(fixture.content) }];
    mkdirSync(join(config.globalRoot, "skills/market-test"), { recursive: true });
    expect(() => publishNewSkill(config.globalRoot, "market-test", files)).toThrow(/already exists/);
    expect(readdirSync(join(config.globalRoot, "skills/market-test"))).toEqual([]);
    expect(() => publishNewSkill(config.globalRoot, "other", [...files, { path: "a", bytes: Buffer.alloc(0) }, { path: "a/b", bytes: Buffer.alloc(0) }])).toThrow(/directory paths/);
    if (process.platform !== "win32") {
      const alias = join(root, "redirected");
      mkdirSync(alias);
      symlinkSync(join(config.globalRoot, "skills"), join(alias, "skills"));
      expect(() => publishNewSkill(alias, "other", files)).toThrow();
    }
  });
  it("bounds streaming bodies and aborts stalled readers", async () => {
    let cancelled = false;
    const source = new SkillMarketplaceSource(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(20)); }, cancel() { cancelled = true; },
    })));
    await expect(source.bytes("https://skills.sh", 10, new AbortController().signal)).rejects.toMatchObject({ status: 413 });
    expect(cancelled).toBe(true);
    const controller = new AbortController();
    const waiting = source.bytes("https://skills.sh", 30, controller.signal);
    const rejected = expect(waiting).rejects.toBeInstanceOf(Error);
    await Promise.resolve();
    controller.abort();
    await rejected;
  });
  it("returns safe rate-limit errors without upstream bodies", async () => {
    fetcher.mockResolvedValue(new Response("private proxy diagnostic", { status: 429, headers: { "Retry-After": "40" } }));
    await expect(market.catalog("test", "hot")).rejects.toMatchObject({ status: 429, message: expect.stringContaining("40 seconds") });
  });
});
