import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { minimatch } from "minimatch";
import { parsePiSettingsJson } from "./pi-settings-json";

export interface SkillPatternScope {
  baseDir: string;
  homeDir?: string;
}

/** Only override existing controlled resources; plain entries never discover new roots. */
export function skillResourceOverrides(settings: unknown): string[] {
  const entries = skillResourceEntries(settings);
  return entries.filter((entry) => /^[!+-]/u.test(entry));
}

export function skillResourceEntries(settings: unknown): string[] {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("Invalid Skill settings.");
  const entries = (settings as { skills?: unknown }).skills;
  if (entries === undefined) return [];
  if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string")) throw new Error("Invalid Skill resource overrides.");
  return [...entries];
}

export function readSkillResourceOverrides(settingsPath: string): string[] {
  try {
    return skillResourceOverrides(parsePiSettingsJson(readFileSync(settingsPath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function posix(path: string): string { return path.split(sep).join("/"); }

function normalizePattern(pattern: string, scope: SkillPatternScope): string {
  let value = pattern;
  if (process.platform === "win32" && value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")) {
    const drive = value.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/iu);
    if (drive) value = `${drive[1]!.toUpperCase()}:\\${drive[2]?.replaceAll("/", "\\") ?? ""}`;
  }
  const home = scope.homeDir ?? homedir();
  if (value === "~") value = home;
  else if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) value = join(home, value.slice(2));
  if (value.startsWith("file://")) value = fileURLToPath(value);
  return posix(value);
}

/** Pi 1.6 resource semantics: exact descriptor paths also match their Skill directory. */
export function matchesExactSkillResource(path: string, pattern: string, scope: SkillPatternScope): boolean {
  const value = normalizePattern(pattern.replace(/^\.[\\/]/u, ""), scope);
  return [path, ...(basename(path) === "SKILL.md" ? [dirname(path)] : [])]
    .some((candidate) => value === posix(candidate) || value === posix(relative(scope.baseDir, candidate)));
}

function matchesGlob(path: string, pattern: string, scope: SkillPatternScope): boolean {
  const value = normalizePattern(pattern, scope);
  return [path, ...(basename(path) === "SKILL.md" ? [dirname(path)] : [])]
    .some((candidate) => [posix(candidate), posix(relative(scope.baseDir, candidate)), basename(candidate)]
      .some((candidate) => minimatch(candidate, value)));
}

/** Matches the pinned native order: glob excludes, exact includes, exact excludes. */
export function isSkillResourceEnabled(path: string, entries: readonly string[], scope: SkillPatternScope): boolean {
  let enabled = !entries.some((entry) => entry.startsWith("!") && matchesGlob(path, entry.slice(1), scope));
  if (entries.some((entry) => entry.startsWith("+") && matchesExactSkillResource(path, entry.slice(1), scope))) enabled = true;
  if (entries.some((entry) => entry.startsWith("-") && matchesExactSkillResource(path, entry.slice(1), scope))) enabled = false;
  return enabled;
}

export function setSkillResourceEnabled(entries: readonly string[], path: string, enabled: boolean, scope: SkillPatternScope): string[] {
  const exact = posix(path);
  if (!enabled) return entries.some((entry) => entry.startsWith("-") && matchesExactSkillResource(path, entry.slice(1), scope))
    ? [...entries] : [...entries, `-${exact}`];
  const next = entries.filter((entry) => !(entry.startsWith("-") && matchesExactSkillResource(path, entry.slice(1), scope)));
  return isSkillResourceEnabled(path, next, scope) ? next : [...next, `+${exact}`];
}

export function removeSkillResourceOverrides(entries: readonly string[], path: string, scope: SkillPatternScope): string[] {
  return entries.filter((entry) => !(/^[+-]/u.test(entry) && matchesExactSkillResource(path, entry.slice(1), scope)));
}
