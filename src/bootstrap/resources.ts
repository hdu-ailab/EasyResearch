import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
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
  seededRegistry: boolean;
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
  const bundledRegistryPath = join(bundledAgentsDir, "agents.json");

  return {
    copiedAgents: copyMissingAgents(agentDir, bundledAgentsDir),
    copiedSkills: copyMissingSkills(agentDir, bundledSkillsDir),
    seededRegistry: seedMissingRegistry(agentDir, bundledRegistryPath),
  };
}

function seedMissingRegistry(agentDir: string, bundledRegistryPath: string): boolean {
  if (!existsSync(bundledRegistryPath)) return false;

  const settingsPath = join(agentDir, "settings.json");
  let settings: Record<string, unknown> = {};
  try {
    if (existsSync(settingsPath)) {
      settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    }
  } catch {
    return false;
  }

  const rawLazy = settings.lazyresearch ?? {};
  const lazy =
    typeof rawLazy === "object" && rawLazy !== null && !Array.isArray(rawLazy)
      ? (rawLazy as Record<string, unknown>)
      : {};
  if ("agents" in lazy) return false;

  lazy.agents = JSON.parse(readFileSync(bundledRegistryPath, "utf8"));
  settings.lazyresearch = lazy;

  const tmpPath = `${settingsPath}.tmp`;
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(tmpPath, JSON.stringify(settings, null, 2), "utf8");
  renameSync(tmpPath, settingsPath);
  return true;
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