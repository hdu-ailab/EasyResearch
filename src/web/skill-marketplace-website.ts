import { createHash } from "node:crypto";
import { ConfigServiceError } from "./config-files";
import { MAX_FILE_BYTES, MAX_SKILL_BYTES, MARKET_RECEIPT, marketError, parseMarketId, safeSkillPath, skillDescriptor, websiteDomain, type SkillMarketplaceSource, type SkillSourceSnapshot, type SkillSourceFile } from "./skill-marketplace-source";

const SCHEMA_V2 = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function artifactUrl(value: string, base: string): string {
  if (value.length > 4096) marketError("The website artifact URL is too long.", 422);
  const url = new URL(value, base);
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash || !websiteDomain(url.hostname)) {
    marketError("The website artifact URL is not a supported HTTPS source.", 422);
  }
  return url.href;
}

function validatePaths(paths: unknown): string[] {
  if (!Array.isArray(paths) || !paths.length || paths.length > 256 || !paths.includes("SKILL.md")) marketError("The website skill has an invalid file list.", 422);
  const seen = new Set<string>();
  for (const path of paths) {
    if (typeof path !== "string" || !safeSkillPath(path) || path.toLowerCase() === MARKET_RECEIPT
      || (path !== "SKILL.md" && /(^|\/)skill\.md$/i.test(path)) || seen.has(path.toLowerCase())) {
      marketError("The website skill contains conflicting or unsupported file paths.", 422);
    }
    seen.add(path.toLowerCase());
  }
  for (const path of seen) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index++) {
      if (seen.has(parts.slice(0, index).join("/"))) marketError("The website skill has conflicting directory paths.", 422);
    }
  }
  return paths as string[];
}

export async function websiteSnapshot(client: SkillMarketplaceSource, id: string, signal: AbortSignal, revision?: string): Promise<SkillSourceSnapshot> {
  const { source, slug } = parseMarketId(id);
  let selected: { entry: Record<string, unknown>; url: string; v2: boolean } | undefined;
  for (const location of ["agent-skills", "skills"]) {
    const url = `https://${source}/.well-known/${location}/index.json`;
    let bytes: Buffer;
    try { bytes = await client.bytes(url, 4 * 1024 * 1024, signal, true); }
    catch (error) {
      if (error instanceof ConfigServiceError && error.status === 404) continue;
      throw error;
    }
    let data: Record<string, unknown> | undefined;
    try { data = record(JSON.parse(bytes.toString("utf8"))); } catch { continue; }
    if (!data || !Array.isArray(data.skills)) continue;
    if (data.$schema !== undefined && data.$schema !== SCHEMA_V2) marketError("The website uses an unsupported skill discovery version. Use manual or Agent-assisted installation.", 422);
    if (data.skills.length > 10_000) marketError("The website skill index is too large.", 413);
    const matches = data.skills.map(record).filter(entry => entry?.name === slug);
    if (!matches.length) continue;
    if (matches.length !== 1) marketError("The website lists multiple skills with the same identity.", 422);
    selected = { entry: matches[0]!, url, v2: data.$schema === SCHEMA_V2 };
    break;
  }
  if (!selected) marketError("This website does not publish a discoverable index entry for the selected skill. Use manual or Agent-assisted installation.", 404);
  const { entry, url, v2 } = selected;
  const files: SkillSourceFile[] = [];
  let sourcePath = new URL(`./${encodeURIComponent(slug)}/`, url).pathname;
  const add = (path: string, bytes: Buffer) => files.push({ path, sha: sha256(bytes), size: bytes.length, executable: /\.(?:sh|bash|py)$/i.test(path), bytes });
  if (v2) {
    if (entry.type === "archive") marketError("This website distributes the skill as an archive. Use manual download or copy the Agent installation request.", 422, "SKILL_MARKET_ARCHIVE");
    if (entry.type !== "skill-md") marketError("The website uses an unsupported artifact type. Use manual or Agent-assisted installation.", 422);
    if (typeof entry.url !== "string" || typeof entry.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(entry.digest)) marketError("The website artifact is missing a valid SHA-256 digest.", 422);
    sourcePath = artifactUrl(entry.url, url);
    const bytes = await client.bytes(sourcePath, 256 * 1024, signal, true);
    if (`sha256:${sha256(bytes)}` !== entry.digest) marketError("The website skill failed SHA-256 verification.", 422);
    add("SKILL.md", bytes);
  } else {
    const paths = validatePaths(entry.files);
    const abort = new AbortController();
    const combined = AbortSignal.any([signal, abort.signal]);
    let next = 0;
    let total = 0;
    const outcomes = await Promise.allSettled(Array.from({ length: Math.min(4, paths.length) }, async () => {
      try {
        for (;;) {
          const path = paths[next++];
          if (!path) return;
          combined.throwIfAborted();
          const fileUrl = new URL(`${encodeURIComponent(slug)}/${path.split("/").map(encodeURIComponent).join("/")}`, url).href;
          const bytes = await client.bytes(fileUrl, path === "SKILL.md" ? 256 * 1024 : MAX_FILE_BYTES, combined, true);
          total += bytes.length;
          if (total > MAX_SKILL_BYTES) marketError("The website skill exceeds the 16 MiB installation limit.", 413);
          add(path, bytes);
        }
      } catch (error) { abort.abort(error); throw error; }
    }));
    const failure = outcomes.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
  signal.throwIfAborted();
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const descriptorBytes = files.find(file => file.path === "SKILL.md")!.bytes!;
  const metadata = await skillDescriptor(descriptorBytes);
  if (metadata.name !== slug) marketError("The website descriptor does not match the selected skill identity.", 422);
  const hash = createHash("sha256");
  for (const file of files) hash.update(file.path).update("\0").update(file.bytes!).update("\0");
  const commit = `sha256:${hash.digest("hex")}`;
  if (revision && revision !== commit) marketError("The website skill changed since preview. Reopen the preview before installing.", 409, "SKILL_MARKET_CHANGED");
  return { id, source, commit, directory: sourcePath,
    ...metadata, descriptorBytes, files, sourceType: "well-known", sourceUrl: `https://${source}` };
}
