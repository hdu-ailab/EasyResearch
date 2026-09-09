import { existsSync, lstatSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getAgentDir } from "./runtime/pi-import";
import { bundledSourceRoot } from "./runtime/bundled-assets";

export interface RenameOptions {
  agentDir: string;
  bundledAgentsDir: string;
  bundledSkillsDir: string;
  log?: (msg: string) => void;
  version?: string;
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

interface RetirementProgress {
  version: string;
  completed: string[];
  pending?: { key: string; dev: string; ino: string };
}

let renameLog: (msg: string) => void = (msg) => console.log(`[easyresearch] ${msg}`);
const FORMER_MAIN_AGENT_FILES = ["paper-assistant.md", "Paper Assistant.md", "论文助手.md"] as const;

export function setRenameLogger(log: (msg: string) => void): void {
  renameLog = log;
}

export function listBundledAgents(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md") && !name.endsWith(".test.md"))
    .sort()
    .map((name) => name.slice(0, -3));
}

export function listBundledSkills(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * ADR-069/092: retire same-name Agent and Skill resources by rename so the
 * latest bundled fallback applies. Runtime defaults live in settings.json.
 */
export function renameSameNameToBak(options: RenameOptions): RenameResult {
  if (options.log) renameLog = options.log;
  const entries: RenameEntry[] = [];
  const bundledAgentFiles = listBundledAgents(options.bundledAgentsDir).map((name) => `${name}.md`);
  const agentFiles = [...new Set([...bundledAgentFiles, ...FORMER_MAIN_AGENT_FILES])];
  const resources = [
    ...agentFiles.map((file) => ({ key: `agents/${file}`, name: file.slice(0, -3), kind: "agent" as const })),
    ...listBundledSkills(options.bundledSkillsDir).map((name) => ({ key: `skills/${name}`, name, kind: "skill" as const })),
  ];
  const progressPath = join(options.agentDir, ".easyresearch-resource-retirement-progress");
  let progress: RetirementProgress = { version: options.version ?? "", completed: [] };
  if (options.version) {
    try {
      const saved = JSON.parse(readFileSync(progressPath, "utf8")) as RetirementProgress;
      if (!saved || typeof saved.version !== "string" || !Array.isArray(saved.completed)
        || !saved.completed.every((key) => typeof key === "string")
        || (saved.pending !== undefined && (!saved.pending || typeof saved.pending.key !== "string"
          || typeof saved.pending.dev !== "string" || typeof saved.pending.ino !== "string"))) {
        throw new Error("Invalid resource retirement progress; left unchanged.");
      }
      if (saved.version === options.version) progress = saved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const completed = new Set(progress.completed);
  const saveProgress = (): void => {
    if (!options.version) return;
    progress.completed = [...completed];
    const temporary = `${progressPath}.tmp-${randomUUID()}`;
    writeFileSync(temporary, JSON.stringify(progress), { flag: "wx", mode: 0o600 });
    try {
      renameSync(temporary, progressPath);
    } finally {
      rmSync(temporary, { force: true });
    }
  };
  const complete = (key: string): void => {
    completed.add(key);
    delete progress.pending;
    saveProgress();
  };
  const reconcilePending = (): void => {
    const pending = progress.pending;
    if (!pending) return;
    const { key } = pending;
    if (!resources.some((resource) => resource.key === key)) {
      throw new Error("Unknown pending resource retirement; left unchanged.");
    }
    const source = join(options.agentDir, key);
    const backup = `${source}.bak`;
    // Rename preserves identity, so a lost completion write cannot retire a new user copy.
    if (pending.ino === "0") {
      throw new Error("Cannot verify interrupted resource retirement without file identity; left unchanged.");
    }
    const current = existsSync(source) ? lstatSync(source, { bigint: true }) : undefined;
    const originalRemains = current?.dev.toString() === pending.dev && current?.ino.toString() === pending.ino;
    const moved = existsSync(backup) ? lstatSync(backup, { bigint: true }) : undefined;
    if (!current || (!originalRemains && moved?.dev.toString() === pending.dev && moved?.ino.toString() === pending.ino)) {
      complete(key);
      return;
    }
    if (!originalRemains) {
      throw new Error("Interrupted resource retirement identity changed; left unchanged.");
    }
    delete progress.pending;
    saveProgress();
  };

  reconcilePending();
  for (const { key, name, kind } of resources) {
    if (completed.has(key)) continue;
    const source = join(options.agentDir, key);
    const backup = `${source}.bak`;
    if (!existsSync(source)) {
      complete(key);
      continue;
    }
    if (options.version) {
      const stat = lstatSync(source, { bigint: true });
      progress.pending = { key, dev: String(stat.dev), ino: String(stat.ino) };
      saveProgress();
    }
    try {
      if (existsSync(backup)) rmSync(backup, { recursive: kind === "skill" });
      renameSync(source, backup);
    } catch (error) {
      renameLog(`rename failed for ${source}: ${error instanceof Error ? error.message : String(error)}`);
      entries.push({ name, kind, renamed: false });
      reconcilePending();
      continue;
    }
    complete(key);
    entries.push({ name, kind, renamed: true, oldPath: source, newPath: backup });
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
  console.log(`[easyresearch] Retired ${count} same-name user resources to backups under ${agentDir}`);
  return 0;
}

if (import.meta.main) process.exit(main());
