import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "./runtime/pi-import";

export interface RenameOptions {
  agentDir: string;
  bundledAgentsDir: string;
  bundledSkillsDir: string;
  log?: (msg: string) => void;
}

export interface RenameEntry {
  name: string;
  kind: "agent" | "skill";
  renamed: boolean;
  oldPath?: string;
  newPath?: string;
}

export interface RenameResult {
  entries: RenameEntry[];
}

let renameLog: (msg: string) => void = (msg) => console.log(`[easyresearch] ${msg}`);
export function setRenameLogger(log: (msg: string) => void): void {
  renameLog = log;
}

export function listBundledAgents(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".md") && !name.endsWith(".test.md"))
      .sort()
      .map((name) => name.slice(0, -3));
  } catch {
    return [];
  }
}

export function listBundledSkills(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * ADR-069: retire the user's same-name agent `.md` files and skill directories
 * by renaming them to `.bak` (overwriting any previous `.bak`). Bundled
 * versions then take effect automatically through the read-only fallback
 * layer. Rename-only: user entries not present in the bundle are untouched
 * and nothing is copied into the user config dir.
 */
export function renameSameNameToBak(options: RenameOptions): RenameResult {
  if (options.log) renameLog = options.log;
  const entries: RenameEntry[] = [];

  for (const name of listBundledAgents(options.bundledAgentsDir)) {
    const agentPath = join(options.agentDir, "agents", `${name}.md`);
    if (!existsSync(agentPath)) continue;
    const bakPath = join(options.agentDir, "agents", `${name}.md.bak`);
    try {
      if (existsSync(bakPath)) rmSync(bakPath);
      renameSync(agentPath, bakPath);
      entries.push({ name, kind: "agent", renamed: true, oldPath: agentPath, newPath: bakPath });
    } catch (error) {
      renameLog(`rename failed for ${agentPath}: ${error instanceof Error ? error.message : String(error)}`);
      entries.push({ name, kind: "agent", renamed: false });
    }
  }

  for (const name of listBundledSkills(options.bundledSkillsDir)) {
    const skillPath = join(options.agentDir, "skills", name);
    if (!existsSync(skillPath)) continue;
    const bakPath = join(options.agentDir, "skills", `${name}.bak`);
    try {
      if (existsSync(bakPath)) rmSync(bakPath, { recursive: true });
      renameSync(skillPath, bakPath);
      entries.push({ name, kind: "skill", renamed: true, oldPath: skillPath, newPath: bakPath });
    } catch (error) {
      renameLog(`rename failed for ${skillPath}: ${error instanceof Error ? error.message : String(error)}`);
      entries.push({ name, kind: "skill", renamed: false });
    }
  }

  return { entries };
}

export function main(): number {
  const agentDir = getAgentDir();
  const sourceDir = dirname(fileURLToPath(import.meta.url));
  const result = renameSameNameToBak({
    agentDir,
    bundledAgentsDir: join(sourceDir, "agents"),
    bundledSkillsDir: join(sourceDir, "skills"),
  });
  const count = result.entries.filter((entry) => entry.renamed).length;
  console.log(`[easyresearch] Retired ${count} same-name user copies to .bak under ${agentDir}`);
  return 0;
}

if (import.meta.main) process.exit(main());
