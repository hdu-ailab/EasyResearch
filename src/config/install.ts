import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { getSkillsDir } from "./paths";

export interface InstallSkillsResult {
  installed: string[];
  skipped: string[];
}

/**
 * Directory of skills bundled with the lazypaper package (src/skills/).
 */
export function bundledSkillsDir(): string {
  return join(fileURLToPath(new URL(".", import.meta.url)), "..", "skills");
}

/**
 * Copy bundled skills (src/skills/<name>/SKILL.md) into the config root's
 * skill store (<configRoot>/agent/skills/), where pi discovers them.
 *
 * - Only directories containing a SKILL.md are installed.
 * - Directories that already exist in the target are skipped: the user's
 *   config root owns its skills and may have modified them.
 * - Machine-local environment artifacts (.venv, __pycache__) are never
 *   copied; SKILL.md files document how to recreate them.
 *
 * Pure and injectable so tests can use fixture dirs (never the real root).
 */
export function installBundledSkills(
  options: { sourceDir?: string; targetDir?: string } = {},
): InstallSkillsResult {
  const sourceDir = options.sourceDir ?? bundledSkillsDir();
  const targetDir = options.targetDir ?? getSkillsDir();

  let entries: string[];
  try {
    entries = readdirSync(sourceDir);
  } catch {
    return { installed: [], skipped: [] };
  }

  const installed: string[] = [];
  const skipped: string[] = [];
  for (const entry of entries) {
    const sourcePath = join(sourceDir, entry);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(sourcePath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    if (!existsSync(join(sourcePath, "SKILL.md"))) continue;
    const targetPath = join(targetDir, entry);
    if (existsSync(targetPath)) {
      skipped.push(entry);
      continue;
    }
    mkdirSync(targetDir, { recursive: true });
    copySkillDir(sourcePath, targetPath);
    installed.push(entry);
  }
  return { installed, skipped };
}

function copySkillDir(sourcePath: string, targetPath: string): void {
  cpSync(sourcePath, targetPath, {
    recursive: true,
    filter: (src) => {
      const base = src.split("/").pop() ?? "";
      return base !== ".venv" && base !== "__pycache__";
    },
  });
}
