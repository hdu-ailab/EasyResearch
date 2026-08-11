import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface SkillResolverDeps {
  cwd: string;
  agentDir: string;
  homeDir?: string;
}

const HOME_PREFIX = "~";

function expandHome(p: string, home?: string): string {
  return p.startsWith(HOME_PREFIX) ? join(home ?? homedir(), p.slice(1)) : p;
}

const NAME_SITES = (deps: SkillResolverDeps): string[] => [
  join(deps.cwd, ".easyresearch", "skills"),
  join(deps.cwd, ".agents", "skills"),
  join(deps.agentDir, "skills"),
  join(deps.homeDir ?? homedir(), ".agents", "skills"),
];

function isPathRef(v: string): boolean {
  return v.startsWith("/") || v.startsWith("~/") || v.startsWith(".") || v.includes("/");
}

function resolveOne(v: string, deps: SkillResolverDeps): string | undefined {
  if (isPathRef(v)) {
    const target = resolve(expandHome(v, deps.homeDir));
    return existsSync(target) ? target : undefined;
  }
  for (const site of NAME_SITES(deps)) {
    const target = join(site, v);
    if (existsSync(target)) return target;
  }
  return undefined;
}

export function resolveSkillDirectories(skills: string[] | undefined, deps: SkillResolverDeps): string[] | undefined {
  if (skills === undefined) return undefined;
  const out: string[] = [];
  for (const s of skills) {
    const resolved = resolveOne(s, deps);
    if (resolved) out.push(resolved);
  }
  return out;
}
