import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "./pi-import";

/**
 * ADR-018: user-added Pi extensions are disabled. LazyResearch mounts its
 * bundled orchestrator/subagent extension only via `InlineExtension`; the Pi
 * extension auto-discovery directories and the `extensions`/`packages`
 * settings arrays must stay empty. Throws with the offending paths otherwise.
 */
export class ExtensionGuardError extends Error {}

export interface ExtensionGuardOptions {
  agentDir?: string;
  cwd?: string;
}

export function assertNoUserExtensions(options: ExtensionGuardOptions = {}): void {
  const agentDir = options.agentDir ?? getAgentDir();
  const offenders: string[] = [];

  const globalExtensions = join(agentDir, "extensions");
  if (isNonEmptyDir(globalExtensions)) offenders.push(globalExtensions);

  if (options.cwd) {
    const projectExtensions = join(options.cwd, ".lazyresearch", "extensions");
    if (isNonEmptyDir(projectExtensions)) offenders.push(projectExtensions);
  }

  const globalSettings = join(agentDir, "settings.json");
  offenders.push(...unlistedResources(readFileSafe(globalSettings), "global settings.json"));

  if (options.cwd) {
    const projectSettings = join(options.cwd, ".lazyresearch", "settings.json");
    offenders.push(...unlistedResources(readFileSafe(projectSettings), "project settings.json"));
  }

  if (offenders.length > 0) {
    throw new ExtensionGuardError(
      `LazyResearch does not load user-added Pi extensions (ADR-018). Remove or empty: ${offenders.join(", ")}`,
    );
  }
}

function unlistedResources(settings: unknown, label: string): string[] {
  if (settings === null || typeof settings !== "object") return [];
  const value = settings as Record<string, unknown>;
  const offenders: string[] = [];
  for (const key of ["extensions", "packages"]) {
    const list = value[key];
    if (Array.isArray(list) && list.length > 0) {
      offenders.push(`${key} array in ${label}`);
    }
  }
  return offenders;
}

function readFileSafe(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function isNonEmptyDir(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return readdirSync(path).length > 0;
  } catch {
    return false;
  }
}
