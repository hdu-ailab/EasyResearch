import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ConfigServiceError, resolveAllowedConfigPath } from "./config-files";
import { MARKET_RECEIPT, parseMarketId, safeSkillPath, validMarketRevision } from "./skill-marketplace-source";
import type { SkillResourceDto } from "./contracts";

export function skillMarketplaceIdentity(skill: SkillResourceDto): string | undefined {
  if (skill.source !== "global" || skill.path === skill.skillPath) return;
  try {
    const path = join(skill.path, MARKET_RECEIPT);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 4096) return;
    const receipt: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!receipt || typeof receipt !== "object") return;
    const row = receipt as Record<string, unknown>;
    if (row.version !== 1 || row.name !== skill.name || !validMarketRevision(row.commit)) return;
    return parseMarketId(row.id).id;
  } catch { return; }
}

export interface SkillInstallFile { path: string; bytes: Buffer; executable?: boolean }

/** No awaits after exclusive reservation: readers only discover the final descriptor. */
export function publishNewSkill(globalRoot: string, name: string, files: readonly SkillInstallFile[]): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64
    || files.some((file) => !safeSkillPath(file.path))
    || files.filter((file) => file.path === "SKILL.md").length !== 1) {
    throw new ConfigServiceError(400, "Invalid skill installation files.");
  }
  const identities = new Set<string>();
  for (const { path } of files) {
    const key = path.toLowerCase();
    if (identities.has(key)) throw new ConfigServiceError(400, "Conflicting skill file paths.");
    identities.add(key);
  }
  for (const key of identities) {
    const parts = key.split("/");
    for (let length = 1; length < parts.length; length += 1) {
      if (identities.has(parts.slice(0, length).join("/"))) throw new ConfigServiceError(400, "Conflicting skill directory paths.");
    }
  }
  mkdirSync(globalRoot, { recursive: true });
  const root = realpathSync(globalRoot);
  const skills = resolveAllowedConfigPath(root, "skills", "write");
  // A redirected resource root must be repaired explicitly rather than receiving downloads.
  try {
    if (lstatSync(join(root, "skills")).isSymbolicLink()) throw new ConfigServiceError(409, "The global Skills directory is a symbolic link.");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  mkdirSync(skills, { recursive: true });
  if (readdirSync(skills).some((entry) => entry.toLowerCase() === name || entry.toLowerCase() === `${name}.md`)) {
    throw new ConfigServiceError(409, "A skill path with this name already exists.", "SKILL_MARKET_CONFLICT");
  }
  const target = join(skills, name);
  try { mkdirSync(target, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ConfigServiceError(409, "A skill directory with this name already exists.", "SKILL_MARKET_CONFLICT");
    }
    throw error;
  }
  const created: Array<{ path: string; ino: number; dev: number; bytes: Buffer }> = [];
  const directories = new Set<string>([target]);
  const ownedTarget = lstatSync(target);
  try {
    const ordered = [...files.filter((file) => file.path !== "SKILL.md"), ...files.filter((file) => file.path === "SKILL.md")];
    for (const file of ordered) {
      const path = join(target, file.path);
      const parents: string[] = [];
      for (let parent = dirname(path); parent !== target; parent = dirname(parent)) parents.unshift(parent);
      for (const parent of parents) {
        if (!directories.has(parent)) {
          mkdirSync(parent, { mode: 0o700 });
          directories.add(parent);
        }
      }
      writeFileSync(path, file.bytes, { flag: "wx", mode: file.executable ? 0o700 : 0o600 });
      const stat = lstatSync(path);
      created.push({ path, ino: stat.ino, dev: stat.dev, bytes: file.bytes });
    }
  } catch (error) {
    // Remove only our unchanged files. Concurrent user edits/additions remain intact.
    try {
      const current = lstatSync(target);
      if (current.ino === ownedTarget.ino && current.dev === ownedTarget.dev && !current.isSymbolicLink()) {
        for (const file of created.reverse()) {
          try {
            const stat = lstatSync(file.path);
            if (stat.isFile() && stat.ino === file.ino && stat.dev === file.dev && readFileSync(file.path).equals(file.bytes)) unlinkSync(file.path);
          } catch { /* Retain paths that cannot be verified. */ }
        }
        for (const dir of [...directories].reverse()) {
          try { rmdirSync(dir); } catch { /* Nonempty user paths are preserved. */ }
        }
      }
    } catch { /* The resource root changed; do not follow it during cleanup. */ }
    throw error;
  }
}
