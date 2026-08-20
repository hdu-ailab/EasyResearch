import { copyFileSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "./runtime/pi-import";
import { bundledSourceRoot } from "./runtime/bundled-assets";

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

function mergeAgentModelSettings(bundled: string, previous: string): string {
  const previousFrontmatter = previous.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!previousFrontmatter) return bundled;

  const preserved = new Map<string, string>();
  for (const line of (previousFrontmatter[1] ?? "").split(/\r?\n/)) {
    const key = line.match(/^(model|thinking):[ \t]*(\S.*)$/)?.[1];
    if (key) preserved.set(key, line);
  }
  if (preserved.size === 0) return bundled;

  const bundledFrontmatter = bundled.match(/^---(\r?\n)([\s\S]*?)\r?\n---(?=\r?\n|$)/);
  if (!bundledFrontmatter) return bundled;

  const inserted = new Set<string>();
  const lines = (bundledFrontmatter[2] ?? "").split(/\r?\n/).flatMap((line) => {
    const key = line.match(/^(model|thinking):/)?.[1];
    if (!key || !preserved.has(key)) return [line];
    if (inserted.has(key)) return [];
    inserted.add(key);
    return [preserved.get(key)!];
  });
  for (const key of ["model", "thinking"]) {
    const line = preserved.get(key);
    if (line && !inserted.has(key)) lines.push(line);
  }

  const newline = bundledFrontmatter[1] ?? "\n";
  const headerEnd = bundledFrontmatter[0].length;
  return `---${newline}${lines.join(newline)}${newline}---${bundled.slice(headerEnd)}`;
}

/**
 * ADR-069/091: back up same-name resources, then refresh Agent Markdown from
 * the bundle while carrying forward explicit model/thinking fields. Skills
 * remain rename-only retirements. User entries absent from the bundle are
 * untouched.
 */
export function renameSameNameToBak(options: RenameOptions): RenameResult {
  if (options.log) renameLog = options.log;
  const entries: RenameEntry[] = [];

  for (const name of listBundledAgents(options.bundledAgentsDir)) {
    const agentPath = join(options.agentDir, "agents", `${name}.md`);
    if (!existsSync(agentPath)) continue;
    const bakPath = join(options.agentDir, "agents", `${name}.md.bak`);
    try {
      const bundledPath = join(options.bundledAgentsDir, `${name}.md`);
      const bundled = readFileSync(bundledPath, "utf8");
      const refreshed = mergeAgentModelSettings(bundled, readFileSync(agentPath, "utf8"));
      if (existsSync(bakPath)) rmSync(bakPath);
      renameSync(agentPath, bakPath);
      if (refreshed === bundled) copyFileSync(bundledPath, agentPath);
      else writeFileSync(agentPath, refreshed, { encoding: "utf8", mode: 0o600 });
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
  const sourceDir = bundledSourceRoot();
  const result = renameSameNameToBak({
    agentDir,
    bundledAgentsDir: join(sourceDir, "agents"),
    bundledSkillsDir: join(sourceDir, "skills"),
  });
  const count = result.entries.filter((entry) => entry.renamed).length;
  console.log(`[easyresearch] Migrated ${count} same-name user resources with backups under ${agentDir}`);
  return 0;
}

if (import.meta.main) process.exit(main());
