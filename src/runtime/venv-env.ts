import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "./pi-import";

export const SKILL_VENV_ENV = "EASYRESEARCH_VENV";

export function skillVenvDir(agentDir: string): string {
  return join(agentDir, "venv");
}

export function injectSkillVenvEnv(): string | undefined {
  const venvDir = skillVenvDir(getAgentDir());
  const bin = process.platform === "win32" ? join(venvDir, "Scripts", "python.exe") : join(venvDir, "bin", "python");
  if (!existsSync(bin)) return undefined;
  process.env[SKILL_VENV_ENV] = venvDir;
  return venvDir;
}
