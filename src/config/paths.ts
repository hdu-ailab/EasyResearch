import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR_NAME = ".lazyresearch";
export const ENV_CONFIG_ROOT = "LAZYRESEARCH_CONFIG_DIR";
export const ENV_PI_AGENT_DIR = "PI_CODING_AGENT_DIR";

export function expandTildePath(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

export function getConfigRoot(): string {
  const envDir = process.env[ENV_CONFIG_ROOT];
  if (envDir) return expandTildePath(envDir);
  return join(homedir(), CONFIG_DIR_NAME);
}

export function getConfigPath(): string {
  return join(getConfigRoot(), "config.json");
}

export function getAgentDir(): string {
  return join(getConfigRoot(), "agent");
}

export function getAgentsDir(): string {
  return join(getAgentDir(), "agents");
}

export function getSkillsDir(): string {
  return join(getAgentDir(), "skills");
}

export function getExtensionsDir(): string {
  return join(getAgentDir(), "extensions");
}

export function getPromptsDir(): string {
  return join(getAgentDir(), "prompts");
}

export function getSessionsDir(): string {
  return join(getAgentDir(), "sessions");
}

export function getAuthPath(): string {
  return join(getAgentDir(), "auth.json");
}

export function getModelsPath(): string {
  return join(getAgentDir(), "models.json");
}

export function getSettingsPath(): string {
  return join(getAgentDir(), "settings.json");
}

/**
 * Redirect pi's config resolution to our config root before any session is
 * created. pi reads PI_CODING_AGENT_DIR for getAgentDir(); pointing it at
 * <configRoot>/agent keeps all pi state inside .lazyresearch and never touches
 * ~/.pi. The env propagates to subagent child processes too.
 */
export function applyConfigRootToPi(): void {
  if (!process.env[ENV_PI_AGENT_DIR]) {
    process.env[ENV_PI_AGENT_DIR] = getAgentDir();
  }
}
