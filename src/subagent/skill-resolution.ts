import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface SkillResolverDeps {
  cwd: string;
  agentDir: string;
  homeDir?: string;
  bundledSkillsDir?: string;
  enableDotAgentsSkill?: boolean;
  includeProject?: boolean;
}

function expandHome(path: string, home?: string): string {
  return path.startsWith("~") ? join(home ?? homedir(), path.slice(1)) : path;
}

function isPathRef(value: string): boolean {
  return value.startsWith("/") || value.startsWith("~/") || value.startsWith(".") || value.includes("/");
}

function skillSites(deps: SkillResolverDeps): string[] {
  return [
    ...(deps.includeProject === false ? [] : [join(deps.cwd, ".easyresearch", "skills")]),
    join(deps.agentDir, "skills"),
    ...(deps.enableDotAgentsSkill === true ? [join(deps.homeDir ?? homedir(), ".agents", "skills")] : []),
    deps.bundledSkillsDir ?? dirnameFromModule(),
  ];
}

export function isDotAgentsSkillEnabled(settings: unknown): boolean {
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return false;
  const easyresearch = (settings as { easyresearch?: unknown }).easyresearch;
  if (typeof easyresearch !== "object" || easyresearch === null || Array.isArray(easyresearch)) return false;
  return (easyresearch as { enable_dot_agents_skill?: unknown }).enable_dot_agents_skill === true;
}

export function defaultSkillDirectories(deps: SkillResolverDeps): string[] {
  return skillSites(deps).filter((site, index, sites) => sites.indexOf(site) === index && existsSync(site));
}

function skillNamesInDirectory(root: string, includeRootFiles = true): string[] {
  if (!existsSync(root)) return [];
  const names: string[] = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return names;
  }
  for (const entry of entries) {
    const entryPath = join(root, entry.name);
    let isDirectory = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        const stats = statSync(entryPath);
        isDirectory = stats.isDirectory();
        isFile = stats.isFile();
      } catch {
        continue;
      }
    }
    if (isDirectory) {
      if (validSkillPath(entryPath)) names.push(entry.name);
      else names.push(...skillNamesInDirectory(entryPath, false));
    } else if (includeRootFiles && isFile && entry.name.endsWith(".md")) {
      names.push(entry.name.slice(0, -3));
    }
  }
  return names;
}

export function resolveEffectiveSkillNames(skills: string[] | undefined, deps: SkillResolverDeps): string[] {
  return resolveSkillSelection(skills, deps).effectiveSkills;
}

export function resolveSkillSelection(
  skills: string[] | undefined,
  deps: SkillResolverDeps,
): { effectiveSkills: string[]; missingSkills: string[] } {
  if (skills !== undefined) {
    const effectiveSkills: string[] = [];
    const missingSkills: string[] = [];
    for (const skill of skills) {
      (resolveOne(skill, deps) === undefined ? missingSkills : effectiveSkills).push(skill);
    }
    return { effectiveSkills, missingSkills };
  }
  const names = new Set<string>();
  for (const site of skillSites(deps)) {
    for (const name of skillNamesInDirectory(site)) names.add(name);
  }
  return { effectiveSkills: [...names].sort((a, b) => a.localeCompare(b)), missingSkills: [] };
}

export function buildDefaultSkillArgs(deps: SkillResolverDeps): string[] {
  return ["--no-skills", ...defaultSkillDirectories(deps).flatMap((directory) => ["--skill", directory])];
}

export async function readGlobalDotAgentsSkillSetting(cwd: string, agentDir: string): Promise<boolean> {
  const { importPi } = await import("../runtime/pi-import");
  const { SettingsManager } = await importPi();
  if (!SettingsManager) return false;
  return isDotAgentsSkillEnabled(SettingsManager.create(cwd, agentDir).getGlobalSettings());
}

function dirnameFromModule(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "skills");
}

function resolveOne(value: string, deps: SkillResolverDeps): string | undefined {
  if (isPathRef(value)) {
    const expanded = expandHome(value, deps.homeDir);
    return validSkillPath(resolve(deps.cwd, expanded));
  }
  for (const site of skillSites(deps)) {
    const directory = validSkillPath(join(site, value));
    if (directory) return directory;
    const file = validSkillPath(join(site, `${value}.md`));
    if (file) return file;
  }
  return undefined;
}

function validSkillPath(target: string): string | undefined {
  if (!existsSync(target)) return undefined;
  try {
    const stats = statSync(target);
    if (stats.isDirectory()) {
      try {
        return statSync(join(target, "SKILL.md")).isFile() ? target : undefined;
      } catch {
        return undefined;
      }
    }
    return stats.isFile() && target.endsWith(".md") ? target : undefined;
  } catch {
    return undefined;
  }
}

export function resolveSkillDirectories(skills: string[] | undefined, deps: SkillResolverDeps): string[] | undefined {
  if (skills === undefined) return undefined;
  return skills.flatMap((skill) => {
    const resolved = resolveOne(skill, deps);
    return resolved ? [resolved] : [];
  });
}
