import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface SkillResolverDeps {
  cwd: string;
  agentDir: string;
  homeDir?: string;
  bundledSkillsDir?: string;
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
    join(deps.homeDir ?? homedir(), ".agents", "skills"),
    deps.bundledSkillsDir ?? dirnameFromModule(),
  ];
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
