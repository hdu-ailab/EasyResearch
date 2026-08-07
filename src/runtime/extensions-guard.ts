import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { getAgentDir } from "./pi-import";

/**
 * ADR-032: LazyResearch relies on Pi's native extension auto-discovery, which
 * the identity bootstrap (ADR-016) binds to `.lazyresearch` — global
 * `agent/extensions/`, project `.lazyresearch/extensions/`, and the settings
 * `extensions` array all load through Pi. Those discovery roots can never
 * point at `~/.pi` by construction. This guard keeps the two remaining
 * invariants of ADR-018/ADR-032: the `packages` array stays banned, and no
 * settings `extensions` entry may resolve inside the foreign `~/.pi` tree.
 */
export class ExtensionGuardError extends Error {}

export interface ExtensionGuardOptions {
  agentDir?: string;
  cwd?: string;
}

export function assertSafeExtensionSources(options: ExtensionGuardOptions = {}): void {
  const agentDir = options.agentDir ?? getAgentDir();
  const offenders: string[] = [];

  const globalSettings = readFileSafe(join(agentDir, "settings.json"));
  offenders.push(...unlistedPackageArrays(globalSettings, "global settings.json"));
  offenders.push(...foreignPiExtensions(globalSettings, "global settings.json"));

  if (options.cwd) {
    const projectSettings = readFileSafe(join(options.cwd, ".lazyresearch", "settings.json"));
    offenders.push(...unlistedPackageArrays(projectSettings, "project settings.json"));
    offenders.push(...foreignPiExtensions(projectSettings, "project settings.json"));
  }

  if (offenders.length > 0) {
    throw new ExtensionGuardError(`LazyResearch refused at startup: ${offenders.join("; ")}`);
  }
}

function asSettings(settings: unknown): Record<string, unknown> | null {
  if (settings === null || typeof settings !== "object") return null;
  return settings as Record<string, unknown>;
}

function unlistedPackageArrays(settings: unknown, label: string): string[] {
  const value = asSettings(settings);
  const list = value?.packages;
  if (Array.isArray(list) && list.length > 0) {
    return [`non-empty packages array in ${label}`];
  }
  return [];
}

function foreignPiExtensions(settings: unknown, label: string): string[] {
  const value = asSettings(settings);
  const list = value?.extensions;
  if (!Array.isArray(list)) return [];

  const home = homedir();
  const piRoot = resolve(home, ".pi");
  const offenders: string[] = [];
  for (const entry of list) {
    if (typeof entry !== "string" || entry.length === 0) continue;
    const expanded = entry.startsWith("~/") ? resolve(home, entry.slice(2)) : entry;
    const resolved = resolve(expanded);
    if (resolved === piRoot || resolved.startsWith(piRoot + sep)) {
      offenders.push(`${entry} in ${label}`);
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