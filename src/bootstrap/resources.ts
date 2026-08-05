import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { importPi } from "../runtime/pi-import";

export interface BootstrapOptions {
  agentDir?: string;
  bundledAgentsDir?: string;
  bundledSkillsDir?: string;
}

export interface BootstrapResult {
  copiedAgents: string[];
  copiedSkills: string[];
}

const sourceRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * Copy bundled agents (src/agents/<name>.md) and skills (src/skills/<name>/)
 * into the global Pi agent directory, copying only targets that are absent.
 * Existing user files are never overwritten or merged.
 */
export async function bootstrapBundledResources(
  options: BootstrapOptions = {},
): Promise<BootstrapResult> {
  const { getAgentDir } = await importPi();
  const agentDir = options.agentDir ?? getAgentDir();
  const bundledAgentsDir = options.bundledAgentsDir ?? join(sourceRoot, "agents");
  const bundledSkillsDir = options.bundledSkillsDir ?? join(sourceRoot, "skills");

  return {
    copiedAgents: copyMissingAgents(agentDir, bundledAgentsDir),
    copiedSkills: copyMissingSkills(agentDir, bundledSkillsDir),
  };
}

function copyMissingAgents(agentDir: string, bundledAgentsDir: string): string[] {
  const copied: string[] = [];
  for (const entry of readdirSafe(bundledAgentsDir)) {
    const sourcePath = join(bundledAgentsDir, entry);
    if (!statSafe(sourcePath)?.isFile()) continue;
    if (!entry.endsWith(".md")) continue;
    const targetPath = join(agentDir, "agents", entry);
    if (existsSync(targetPath)) continue;
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    cpSync(sourcePath, targetPath);
    copied.push(entry);
  }
  return copied;
}

function copyMissingSkills(agentDir: string, bundledSkillsDir: string): string[] {
  const copied: string[] = [];
  for (const entry of readdirSafe(bundledSkillsDir)) {
    const sourcePath = join(bundledSkillsDir, entry);
    const stat = statSafe(sourcePath);
    if (!stat?.isDirectory()) continue;
    if (!existsSync(join(sourcePath, "SKILL.md"))) continue;
    const targetPath = join(agentDir, "skills", entry);
    if (existsSync(targetPath)) continue;
    mkdirSync(join(agentDir, "skills"), { recursive: true });
    cpSync(sourcePath, targetPath, {
      recursive: true,
      filter: (src) => {
        const base = src.split("/").pop() ?? "";
        return base !== ".venv" && base !== "__pycache__" && !base.endsWith(".pyc");
      },
    });
    copied.push(entry);
  }
  return copied;
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function statSafe(path: string): ReturnType<typeof statSync> | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}