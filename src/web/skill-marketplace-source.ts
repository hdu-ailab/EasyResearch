import { createHash } from "node:crypto";
import { load } from "cheerio";
import TurndownService from "turndown";
import { importPi } from "../runtime/pi-import";
import { ConfigServiceError } from "./config-files";
import type { MarketSkillDto, SkillMarketView } from "./skill-marketplace-contracts";
import { skillMarketPageUrl } from "./skill-marketplace-contracts";
import { websiteSnapshot } from "./skill-marketplace-website";

export const MARKET_RECEIPT = ".easyresearch-marketplace.json";
const SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_SKILL_BYTES = 16 * 1024 * 1024;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

export function websiteDomain(value: string): boolean {
  return value.length <= 253 && value.includes(".") && !/^[\d.]+$/.test(value)
    && value.split(".").every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part));
}

export function validMarketRevision(value: unknown): value is string {
  return typeof value === "string" && /^(?:[a-f0-9]{40}|sha256:[a-f0-9]{64})$/.test(value);
}

export function validSkillName(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && value.split("::").every((part) => SKILL_NAME.test(part));
}

export function skillInstallDirectory(name: string): string { return name.replaceAll("::", "-"); }

export function marketError(message: string, status = 502, code = "SKILL_MARKET_UNAVAILABLE"): never {
  throw new ConfigServiceError(status, message, code);
}

export function parseMarketId(value: unknown): { id: string; source: string; slug: string; kind: "github" | "well-known" } {
  if (typeof value !== "string") marketError("Invalid skill identity.", 400);
  const parts = value.split("/");
  const slug = parts.at(-1)!;
  if (!slug || slug.length > 150 || !slug.split("::").every((part) => SEGMENT.test(part))) marketError("Unsupported skill identity.", 400);
  if (parts.length === 2 && websiteDomain(parts[0]!)) return { id: value, source: parts[0]!, slug, kind: "well-known" };
  if (parts.length === 3 && parts.slice(0, 2).every((part) => SEGMENT.test(part))) return { id: value, source: parts.slice(0, 2).join("/"), slug, kind: "github" };
  return marketError("This skill source requires manual or Agent-assisted installation.", 400);
}

export function safeSkillPath(path: string): boolean {
  return path.length <= 512 && path.split("/").every((part) =>
    part.length > 0 && part !== "." && part !== ".." && part.toLowerCase() !== ".git"
    && !/[\\\x00-\x1f\x7f:%?#<>"|*]/u.test(part) && !/[. ]$/u.test(part)
    && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(part));
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) marketError("Invalid skill catalog response.");
  return value as Record<string, unknown>;
}

export function parseMarketSkills(value: unknown): MarketSkillDto[] {
  if (!Array.isArray(value) || value.length > 1000) marketError("Invalid skill catalog response.");
  const result = new Map<string, MarketSkillDto>();
  for (const item of value) {
    const row = object(item);
    const slug = row.skillId ?? row.slug;
    if (typeof row.source !== "string" || row.source.length > 200 || typeof slug !== "string"
      || !slug || slug.length > 200 || typeof row.name !== "string" || row.name.length > 200
      || typeof row.installs !== "number" || !Number.isSafeInteger(row.installs) || row.installs < 0) {
      marketError("Invalid skill catalog response.");
    }
    const id = `${row.source}/${slug}`;
    let supported = true;
    try { parseMarketId(id); } catch { supported = false; }
    const unsupportedReason = slug.split("::").every((part) => SEGMENT.test(part)) ? "source" as const : "identity" as const;
    result.set(id, {
      id, source: row.source, slug, name: row.name, installs: row.installs, supported,
      ...(!supported ? { unsupportedReason } : {}),
      ...(typeof row.description === "string" ? { description: row.description.slice(0, 600) } : {}),
    });
  }
  return [...result.values()];
}

/** Decode Next's JSON string transport, never evaluate upstream JavaScript. */
export function parseMarketLeaderboard(html: string): MarketSkillDto[] {
  const $ = load(html);
  let payload = "";
  $("script").each((_, element) => {
    const script = $(element).text();
    for (const match of script.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/gu)) {
      try { payload += JSON.parse(match[1]!); } catch { /* Invalid transport is rejected below. */ }
    }
  });
  const marker = '"initialSkills":';
  const start = payload.indexOf(marker);
  if (start < 0) marketError("The skills.sh catalog format changed. Search is still available.");
  const arrayStart = payload.indexOf("[", start + marker.length);
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = arrayStart; index < payload.length; index += 1) {
    const char = payload[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "[") depth += 1;
    else if (char === "]" && --depth === 0) {
      try { return parseMarketSkills(JSON.parse(payload.slice(arrayStart, index + 1))); }
      catch { marketError("Invalid skills.sh leaderboard."); }
    }
  }
  return marketError("Invalid skills.sh leaderboard.");
}

export interface SkillSourceFile { path: string; sha: string; size: number; executable: boolean; bytes?: Buffer }
export interface SkillSourceSnapshot {
  id: string;
  source: string;
  commit: string;
  directory: string;
  name: string;
  description: string;
  content: string;
  descriptorBytes: Buffer;
  files: SkillSourceFile[];
  sourceType?: "github" | "well-known";
  sourceUrl?: string;
}

export async function skillDescriptor(descriptorBytes: Buffer): Promise<{ name: string; description: string; content: string }> {
  const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(descriptorBytes);
  const { parseFrontmatter } = await importPi();
  let data: Record<string, unknown>;
  try { data = parseFrontmatter<Record<string, unknown>>(content).frontmatter; }
  catch { return marketError("Invalid SKILL.md frontmatter.", 422); }
  if (!validSkillName(data.name) || typeof data.description !== "string" || !data.description.trim()) {
    marketError("The skill must have a valid name and description in SKILL.md.", 422);
  }
  return { name: data.name, description: data.description.slice(0, 4000), content };
}

export class SkillMarketplaceSource {
  constructor(private readonly fetcher: (url: string, init: RequestInit) => Promise<Response>) {}

  async bytes(url: string, limit: number, signal: AbortSignal, website = false): Promise<Buffer> {
    signal.throwIfAborted();
    let response: Response;
    try {
      const original = new URL(url);
      const allowedHosts = original.hostname === "skills.sh" ? new Set(["skills.sh", "www.skills.sh"]) : new Set([original.hostname]);
      let target = original;
      for (let hop = 0; ; hop += 1) {
        response = await this.fetcher(target.href, { signal, redirect: "manual", headers: { Accept: "application/json", "User-Agent": "EasyResearch-Skill-Marketplace" } });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location || hop >= 3) throw new Error("redirect limit");
        target = new URL(location, target);
        if (target.protocol !== "https:" || target.port || target.username || target.password
          || !(website ? websiteDomain(target.hostname) : allowedHosts.has(target.hostname))) throw new Error("unsupported redirect");
      }
    } catch {
      signal.throwIfAborted();
      return marketError("Could not reach the skill source. Check Network settings and retry.");
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 429 || response.status === 403) {
        const retry = response.headers.get("retry-after");
        const seconds = retry && /^\d{1,6}$/.test(retry) ? ` Retry after ${retry} seconds.` : " Retry later.";
        marketError(`The skill source rate-limited this request.${seconds}`, 429, "SKILL_MARKET_RATE_LIMIT");
      }
      marketError(response.status === 404 ? "The skill source no longer exists." : "The skill source is unavailable.", response.status === 404 ? 404 : 502);
    }
    const reader = response.body?.getReader();
    if (!reader) marketError("Empty skill source response.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    const abort = () => { void reader.cancel().catch(() => undefined); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      for (;;) {
        const { done, value } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        size += value.byteLength;
        if (size > limit) marketError("The skill source exceeds the download limit.", 413);
        chunks.push(value);
      }
      return Buffer.concat(chunks);
    } finally {
      signal.removeEventListener("abort", abort);
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  async json(url: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    const bytes = await this.bytes(url, 8 * 1024 * 1024, signal);
    try { return object(JSON.parse(bytes.toString("utf8"))); }
    catch { return marketError("Invalid skill source response."); }
  }

  async catalog(query: string, view: SkillMarketView, signal: AbortSignal): Promise<MarketSkillDto[]> {
    if (query) {
      const result = await this.json(`https://skills.sh/api/search?${new URLSearchParams({ q: query, limit: "60" })}`, signal);
      return parseMarketSkills(result.skills);
    }
    const path = view === "all-time" ? "" : view;
    return parseMarketLeaderboard((await this.bytes(`https://skills.sh/${path}`, 4 * 1024 * 1024, signal)).toString("utf8")).slice(0, 90);
  }

  async snapshot(id: string, signal: AbortSignal, revision?: string): Promise<SkillSourceSnapshot> {
    const { source, slug, kind } = parseMarketId(id);
    if (kind === "well-known") return websiteSnapshot(this, id, signal, revision);
    const commit = revision ?? (await this.json(`https://api.github.com/repos/${source}/commits/HEAD`, signal)).sha;
    if (typeof commit !== "string" || !/^[a-f0-9]{40}$/.test(commit)) marketError("Invalid source revision.", 400);
    const tree = await this.json(`https://api.github.com/repos/${source}/git/trees/${commit}?recursive=1`, signal);
    if (tree.truncated !== false || !Array.isArray(tree.tree)) marketError("The repository tree is incomplete or too large.", 413);
    const entries = tree.tree.map(object);
    const descriptors = entries.filter((entry) => typeof entry.path === "string"
      && (entry.path === "SKILL.md" || entry.path.endsWith("/SKILL.md")));
    const matches = descriptors.filter((entry) => (entry.path as string).split("/").at(-2)?.toLowerCase() === slug.split("::").at(-1)!.toLowerCase());
    const candidates = matches.length ? matches : descriptors.filter((entry) => entry.path === "SKILL.md");
    if (candidates.length !== 1) marketError("Could not locate an unambiguous SKILL.md for this skill.", 422);
    const descriptorPath = candidates[0]!.path as string;
    const directory = descriptorPath.slice(0, -"SKILL.md".length);
    const files: SkillSourceFile[] = [];
    const identities = new Set<string>();
    let total = 0;
    for (const entry of entries) {
      if (typeof entry.path !== "string" || !entry.path.startsWith(directory)) continue;
      const path = entry.path.slice(directory.length);
      if (!path) continue;
      if (!safeSkillPath(path) || path.toLowerCase() === MARKET_RECEIPT || (path !== "SKILL.md" && /(^|\/)skill\.md$/i.test(path))) {
        marketError("This skill contains unsupported or conflicting file paths.", 422);
      }
      const key = path.toLowerCase();
      if (identities.has(key)) marketError("This skill has case-conflicting paths.", 422);
      identities.add(key);
      if (entry.type === "tree" && entry.mode === "040000") continue;
      if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")
        || typeof entry.sha !== "string" || !/^[a-f0-9]{40}$/.test(entry.sha)
        || !Number.isSafeInteger(entry.size) || (entry.size as number) < 0) {
        marketError("Only regular skill files are supported; links and submodules cannot be installed.", 422);
      }
      total += entry.size as number;
      if ((entry.size as number) > MAX_FILE_BYTES || total > MAX_SKILL_BYTES || files.length >= 256) {
        marketError("This skill exceeds the 256-file / 16 MiB installation limit.", 413);
      }
      files.push({ path, sha: entry.sha, size: entry.size as number, executable: entry.mode === "100755" });
    }
    const descriptor = files.find((file) => file.path === "SKILL.md");
    if (!descriptor || descriptor.size > 256 * 1024) marketError("Invalid or oversized SKILL.md.", 422);
    const snapshot = { id, source, commit, directory, files };
    const descriptorBytes = await this.file(snapshot, descriptor, signal);
    const metadata = await skillDescriptor(descriptorBytes);
    if (slug.includes("::") && metadata.name !== slug) marketError("The skill namespace does not match its descriptor.", 422);
    return { ...snapshot, ...metadata, descriptorBytes, sourceType: "github", sourceUrl: `https://github.com/${source}` };
  }

  async file(snapshot: Pick<SkillSourceSnapshot, "source" | "commit" | "directory">, file: SkillSourceFile, signal: AbortSignal): Promise<Buffer> {
    signal.throwIfAborted();
    if (file.bytes) return file.bytes;
    const path = `${snapshot.directory}${file.path}`.split("/").map(encodeURIComponent).join("/");
    const bytes = await this.bytes(`https://raw.githubusercontent.com/${snapshot.source}/${snapshot.commit}/${path}`, Math.min(file.size, MAX_FILE_BYTES), signal);
    const sha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (bytes.length !== file.size || sha !== file.sha) marketError("Skill file integrity verification failed.", 422);
    if (bytes.subarray(0, 80).toString("utf8").startsWith("version https://git-lfs.github.com/spec/")) {
      marketError("Git LFS skill assets are not supported.", 422);
    }
    return bytes;
  }

  async description(id: string, signal: AbortSignal): Promise<{ content: string; url: string; summary: string }> {
    const { source, slug } = parseMarketId(id);
    const url = skillMarketPageUrl(source, slug);
    const html = (await this.bytes(url, 4 * 1024 * 1024, signal)).toString("utf8");
    const $ = load(html);
    const prose = $(".prose").first();
    if (!prose.length) marketError("The public skill explanation is unavailable.", 404);
    prose.find("script,style,iframe,object,embed,form,input,button,img,svg,video,audio").remove();
    const metadata = $("meta[name='description']").attr("content") ?? $("meta[property='og:description']").attr("content");
    const body = prose.clone();
    body.find("h1").remove();
    body.find("p,li,h2,h3,h4,pre,blockquote,tr").append(" ");
    const summary = Array.from((metadata && metadata !== "Discover and install skills for AI agents." ? metadata : body.text())
      .replace(/\s+/g, " ").trim()).slice(0, 320).join("");
    prose.find("a").each((_, element) => {
      const link = $(element);
      const href = link.attr("href");
      try {
        const resolved = new URL(href ?? "", url);
        if (!href || !["https:", "http:"].includes(resolved.protocol)) link.removeAttr("href");
        else link.attr("href", resolved.href);
      } catch { link.removeAttr("href"); }
    });
    const content = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" }).turndown(prose.html() ?? "");
    if (!content.trim() || Buffer.byteLength(content) > 256 * 1024) marketError("The public skill explanation is unavailable or too large.", 422);
    return { content, url, summary };
  }
}
