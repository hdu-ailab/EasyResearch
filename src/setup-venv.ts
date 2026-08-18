#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "./runtime/pi-import";

export type RunFn = (command: string, args: string[]) => { status: number; stdout: string; stderr: string };

export function venvPythonPath(venvDir: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? join(venvDir, "Scripts", "python.exe") : join(venvDir, "bin", "python");
}

export function detectPython(run: RunFn): string | undefined {
  for (const candidate of ["python3", "python"]) {
    const result = run(candidate, ["--version"]);
    if (result.status === 0) return candidate;
  }
  return undefined;
}

export interface SetupDeps {
  venvDir: string;
  run: RunFn;
  log: (msg: string) => void;
  platform?: NodeJS.Platform;
  /** Test-only: inject a package manifest. */
  packages?: readonly SkillVenvPackage[];
}

export interface SetupResult {
  venvDir: string;
  success: boolean;
  reason?: string;
}

export interface SkillVenvPackage {
  distribution: string;
  imports: readonly [string, ...string[]];
}

export const SKILL_VENV_PACKAGES = [
  { distribution: "markitdown", imports: ["markitdown"] },
  { distribution: "arxiv", imports: ["arxiv"] },
  { distribution: "ddgr", imports: ["ddgr"] },
] as const satisfies readonly SkillVenvPackage[];

export function setupSkillVenv(deps: SetupDeps): SetupResult {
  const { venvDir, run, log, platform, packages = SKILL_VENV_PACKAGES } = deps;
  const python = venvPythonPath(venvDir, platform);
  const installArgs = ["-m", "pip", "install", "--upgrade", "pip", ...packages.map((pkg) => pkg.distribution)];
  if (existsSync(python)) {
    const result = run(python, installArgs);
    if (result.status !== 0) return { venvDir, success: false, reason: `pip install failed: ${result.stderr}` };
    return { venvDir, success: true };
  }
  const pythonCmd = detectPython(run);
  if (!pythonCmd) {
    return { venvDir, success: false, reason: "python3/python not found on PATH" };
  }
  const create = run(pythonCmd, ["-m", "venv", venvDir]);
  if (create.status !== 0) return { venvDir, success: false, reason: `venv creation failed: ${create.stderr}` };
  const install = run(python, installArgs);
  if (install.status !== 0) return { venvDir, success: false, reason: `pip install failed: ${install.stderr}` };
  log(`Skill venv ready at ${venvDir}`);
  return { venvDir, success: true };
}

function realRun(command: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 600_000 });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function streamingRun(command: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(command, args, { stdio: "inherit", timeout: 600_000 });
  return { status: result.status ?? 1, stdout: "", stderr: "" };
}

export interface EnsureVenvOptions {
  /** Stream venv creation and pip output to the terminal (progress display). */
  stream?: boolean;
  log?: (msg: string) => void;
  /** Test-only: inject a run function. */
  run?: RunFn;
  /** Test-only: inject a package manifest. */
  packages?: readonly SkillVenvPackage[];
}

/**
 * Idempotent first-run setup. Reuses an existing venv (quick import check
 * instead of reinstalling), recreates it when broken, and streams progress
 * to the terminal when `stream` is enabled. Never throws; failures degrade
 * to a warning so the CLI can keep working without the Python extras.
 */
export function ensureSkillVenv(agentDir: string, options: EnsureVenvOptions = {}): SetupResult {
  const run = options.run ?? (options.stream ? streamingRun : realRun);
  const log = options.log ?? (() => {});
  const packages = options.packages ?? SKILL_VENV_PACKAGES;
  const distributions = packages.map((pkg) => pkg.distribution);
  const venvDir = join(agentDir, "venv");
  const python = venvPythonPath(venvDir);

  if (existsSync(python)) {
    const imports = packages.flatMap((pkg) => pkg.imports);
    const check = run(python, ["-c", `import ${imports.join(", ")}`]);
    if (check.status === 0) {
      log(`Skill venv already ready: ${venvDir}`);
      return { venvDir, success: true };
    }
    log(`Skill venv missing packages — reinstalling ${distributions.join(" + ")}…`);
  } else {
    log(`First run: creating skill Python venv at ${venvDir}`);
  }

  const result = setupSkillVenv({ venvDir, run, log, packages });
  if (!result.success) {
    log(
      `Skill venv setup skipped: ${result.reason}. PDF conversion, arXiv SDK, and web-search (ddgr) features will fall back to system tools. Fix with: python3 -m venv "${venvDir}" && "${python}" -m pip install ${distributions.join(" ")}`,
    );
  }
  return result;
}

export function main(): number {
  ensureSkillVenv(getAgentDir(), { stream: true, log: (msg) => console.log(`[easyresearch] ${msg}`) });
  return 0;
}

if (import.meta.main) process.exit(main());
