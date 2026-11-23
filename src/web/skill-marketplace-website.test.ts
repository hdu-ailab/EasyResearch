import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importPi } from "../runtime/pi-import";
import { ConfigFileService } from "./config-files";
import { listGlobalSkills } from "./agent-resources";
import { SkillMarketplace } from "./skill-marketplace";
import { SkillMarketplaceSource } from "./skill-marketplace-source";
import { marketFixture } from "./skill-marketplace.test-helper";

let root: string;
let market: SkillMarketplace;
let config: ConfigFileService;
let files: Map<string, Buffer>;
let index: Record<string, unknown>;
let preferred: "html" | "missing" | "index";
let calls: string[];
let notify: ReturnType<typeof vi.fn<() => Promise<void>>>;
const identity = "open.feishu.cn/lark-mail";
const options = () => ({ skillPolicy: { enableDotAgentsSkill: false }, bundledSkillsDir: join(root, "bundled"), homeDir: root });
const request = async (url: string): Promise<Response> => {
  calls.push(url);
  const path = new URL(url).pathname;
  if (path === "/.well-known/agent-skills/index.json" && preferred !== "index") {
    return new Response("<html>Not an index</html>", { status: preferred === "missing" ? 404 : 200 });
  }
  if (path.endsWith("/index.json")) return Response.json(index);
  const name = path.split("/lark-mail/")[1] ?? "SKILL.md";
  const bytes = files.get(name);
  return bytes ? new Response(new Uint8Array(bytes)) : new Response("Missing", { status: 404 });
};
const create = () => new SkillMarketplace({ config, skillOptions: options, fetch: request, notify });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "er-market-website-"));
  vi.stubEnv("HOME", root);
  vi.stubEnv("EASYRESEARCH_CODING_AGENT_DIR", join(root, "agent"));
  mkdirSync(join(root, "bundled"));
  config = new ConfigFileService(join(root, "agent"));
  files = new Map([
    ["SKILL.md", Buffer.from("---\nname: lark-mail\ndescription: Email workflows\n---\n# Mail\n")],
    ["references/send.md", Buffer.from("# Send\n")],
    ["assets/image.bin", Buffer.from([255, 0, 128, 123])],
  ]);
  index = { skills: [{ name: "lark-mail", description: "Mail", files: [...files.keys()] }] };
  preferred = "html";
  calls = [];
  notify = vi.fn(async () => {});
  market = create();
});
afterEach(async () => { await market.close(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe("website Skill compatibility", () => {
  it.each(["html", "missing"] as const)("discovers the legacy index after %s and publishes exact previewed bytes", async (mode) => {
    preferred = mode;
    const detail = await market.detail(identity);
    expect(detail.sourceType).toBe("well-known");
    expect(detail.commit).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(calls.slice(0, 2)).toEqual(["https://open.feishu.cn/.well-known/agent-skills/index.json", "https://open.feishu.cn/.well-known/skills/index.json"]);
    expect(existsSync(config.globalRoot)).toBe(false);
    const original = files.get("assets/image.bin")!;
    files.set("assets/image.bin", Buffer.from("Changed upstream after preview"));
    const before = calls.length;
    await market.install({ id: identity, commit: detail.commit });
    expect(calls).toHaveLength(before);
    expect(readFileSync(join(config.globalRoot, "skills/lark-mail/assets/image.bin"))).toEqual(original);
    expect(notify).toHaveBeenCalledOnce();
    expect(await listGlobalSkills(config, options())).toMatchObject([{ name: "lark-mail", marketplaceId: identity }]);
    const { loadSkillsFromDir } = await importPi();
    expect(loadSkillsFromDir({ dir: join(config.globalRoot, "skills"), source: "user" }).skills.map(skill => skill.name)).toContain("lark-mail");
  });
  it("rejects changed website bytes when the preview cache is gone", async () => {
    const detail = await market.detail(identity);
    await market.close(); market = create();
    files.set("references/send.md", Buffer.from("new instructions"));
    await expect(market.install({ id: identity, commit: detail.commit })).rejects.toMatchObject({ code: "SKILL_MARKET_CHANGED" });
    expect(existsSync(config.globalRoot)).toBe(false);
  });
  it("verifies v0.2.0 single-file digests without falling back on mismatch", async () => {
    preferred = "index";
    const entry = { name: "lark-mail", description: "Mail", type: "skill-md", url: "https://cdn.example.org/mail.md", digest: `sha256:${createHash("sha256").update(files.get("SKILL.md")!).digest("hex")}` };
    index = { $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json", skills: [entry] };
    expect((await market.detail(identity)).files).toEqual(["SKILL.md"]);
    await market.close(); market = create();
    entry.digest = `sha256:${"0".repeat(64)}`;
    calls.length = 0;
    await expect(market.detail(identity)).rejects.toThrow(/SHA-256/);
    expect(calls.some(url => url.includes("/.well-known/skills/"))).toBe(false);
  });
  it.each(["../escape", "references/../../x", "child/SKILL.md", "SKILL.MD", "refs", "https://other.site/file"])("rejects invalid file inventory %s before supporting downloads", async (path) => {
    index = { skills: [{ name: "lark-mail", files: ["SKILL.md", path, ...(path === "refs" ? ["refs/a.md"] : [])] }] };
    await expect(market.detail(identity)).rejects.toMatchObject({ status: 422 });
    expect(calls).toHaveLength(2);
  });
  it("does not install an incomplete website package", async () => {
    files.delete("references/send.md");
    await expect(market.detail(identity)).rejects.toMatchObject({ status: 404 });
    expect(existsSync(config.globalRoot)).toBe(false);
  });
  it("cancels the selected website download and never treats rate limits as index absence", async () => {
    const started = Promise.withResolvers<void>();
    const source = new SkillMarketplaceSource(async (url, init) => {
      if (url.endsWith("/index.json")) return request(url);
      return new Promise((_resolve, reject) => {
        started.resolve();
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    const controller = new AbortController();
    const pending = source.snapshot(identity, controller.signal);
    const rejected = expect(pending).rejects.toBeInstanceOf(Error);
    await started.promise;
    controller.abort();
    await rejected;
    const limited = vi.fn(async () => new Response(null, { status: 429 }));
    await expect(new SkillMarketplaceSource(limited).snapshot(identity, new AbortController().signal)).rejects.toMatchObject({ status: 429 });
    expect(limited).toHaveBeenCalledOnce();
  });
  it("reports archive distribution as an actionable recovery case", async () => {
    preferred = "index";
    index = { $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json", skills: [{ name: "lark-mail", type: "archive" }] };
    await expect(market.detail(identity)).rejects.toMatchObject({ code: "SKILL_MARKET_ARCHIVE" });
  });
  it("loads namespaced GitHub skills with original descriptors and portable directories", async () => {
    const fixture = marketFixture();
    const name = "stitch::market-test";
    const content = fixture.content.replace("name: market-test", `name: ${name}`);
    fixture.files.set("SKILL.md", Buffer.from(content));
    fixture.tree[0]!.size = Buffer.byteLength(content);
    fixture.tree[0]!.sha = createHash("sha1").update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest("hex");
    const namespaced = new SkillMarketplace({ config, skillOptions: options, notify, fetch: async url => fixture.response(url) });
    try {
      const id = "example/research/stitch::market-test";
      const detail = await namespaced.detail(id);
      await namespaced.install({ id, commit: detail.commit });
      expect(readFileSync(join(config.globalRoot, "skills/stitch-market-test/SKILL.md"), "utf8")).toBe(content);
      const { loadSkillsFromDir } = await importPi();
      expect(loadSkillsFromDir({ dir: join(config.globalRoot, "skills"), source: "user" }).skills.map(skill => skill.name)).toContain(name);
      expect(await listGlobalSkills(config, options())).toMatchObject([{ name, marketplaceId: id }]);
    } finally { await namespaced.close(); }
  });
});

it("reads only the public page explanation and strips executable markup", async () => {
  const fetcher = vi.fn(async (_url: string) => new Response('<nav>Not description</nav><div class="prose"><h1>Mail guide</h1><p>Read the guide.</p><script>bad()</script><iframe src="http://evil.test"></iframe><img src="http://tracker.test"><a href="javascript:bad()">Unsafe</a></div>'));
  const source = new SkillMarketplaceSource(fetcher);
  const description = await source.description(identity, new AbortController().signal);
  expect(description.content).toContain("# Mail guide");
  expect(description.summary).toBe("Read the guide. Unsafe");
  expect(description.content).not.toMatch(/bad\(\)|evil|tracker|Not description|javascript/);
  expect(fetcher.mock.calls[0]?.[0]).toBe("https://skills.sh/site/open.feishu.cn/lark-mail");
});

it("uses page description metadata for bounded card excerpts", async () => {
  const source = new SkillMarketplaceSource(async () => new Response('<meta name="description" content="Manage mail and drafts."><div class="prose"><h1>Mail guide</h1><p>Long instructions...</p></div>'));
  expect((await source.description(identity, new AbortController().signal)).summary).toBe("Manage mail and drafts.");
});
