import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface SkillResolverDeps {
  cwd: string;
  agentDir: string;
  homeDir?: string;
  bundledSkillsDir?: string;
  enableDotAgentsSkill?: boolean;
}

function expandHome(path: string, home?: string): string {
  return path.startsWith("~") ? join(home ?? homedir(), path.slice(1)) : path;
}

function isPathRef(value: string): boolean {
  return value.startsWith("/") || value.startsWith("~/") || value.startsWith(".") || value.includes("/");
}

function skillSites(deps: SkillResolverDeps): string[] {
  return [
    join(deps.cwd, ".easyresearch", "skills"),
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

function skillNamesInDirectory(root: string): string[] {
  if (!existsSync(root)) return [];
  const names: string[] = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return names;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillRoot = join(root, entry.name);
    if (existsSync(join(skillRoot, "SKILL.md"))) names.push(entry.name);
    else names.push(...skillNamesInDirectory(skillRoot));
  }
  return names;
}

export function resolveEffectiveSkillNames(skills: string[] | undefined, deps: SkillResolverDeps): string[] {
  if (skills !== undefined) {
    return skills.filter((skill) => resolveOne(skill, deps) !== undefined);
  }
  const names = new Set<string>();
  for (const site of skillSites(deps)) {
    for (const name of skillNamesInDirectory(site)) names.add(name);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
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
    const target = resolve(expandHome(value, deps.homeDir));
    return existsSync(target) ? target : undefined;
  }
  for (const site of skillSites(deps)) {
    const target = join(site, value);
    if (existsSync(target)) return target;
  }
  return undefined;
}

export function resolveSkillDirectories(skills: string[] | undefined, deps: SkillResolverDeps): string[] | undefined {
  if (skills === undefined) return undefined;
  return skills.flatMap((skill) => {
    const resolved = resolveOne(skill, deps);
    return resolved ? [resolved] : [];
  });
}
