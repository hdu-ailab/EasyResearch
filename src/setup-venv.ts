#!/usr/bin/env bun
import { existsSync, lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, posix, win32 } from "node:path";
import { getAgentDir } from "./runtime/pi-import";

export type RunFn = (command: string, args: string[]) => { status: number; stdout: string; stderr: string };

export function venvPythonPath(venvDir: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32"
    ? win32.join(venvDir, "Scripts", "python.exe")
    : posix.join(venvDir, "bin", "python");
}

export interface PythonCommand {
  command: string;
  prefixArgs: string[];
}

export function detectPython(
  run: RunFn,
  platform: NodeJS.Platform = process.platform,
): PythonCommand | undefined {
  const candidates: PythonCommand[] = platform === "win32"
    ? [
      { command: "py", prefixArgs: ["-3"] },
      { command: "python", prefixArgs: [] },
      { command: "python3", prefixArgs: [] },
    ]
    : [
      { command: "python3", prefixArgs: [] },
      { command: "python", prefixArgs: [] },
    ];
  for (const candidate of candidates) {
    const result = run(candidate.command, [...candidate.prefixArgs, "--version"]);
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
] as const satisfies readonly SkillVenvPackage[];

const VENV_CREATION_MARKER = ".easyresearch-venv-creation";

function ownsVenvCreation(venvDir: string): boolean {
  try {
    const marker = JSON.parse(readFileSync(join(venvDir, VENV_CREATION_MARKER), "utf8")) as {
      schema?: unknown; path?: unknown; dev?: unknown; ino?: unknown;
    };
    const stat = lstatSync(venvDir, { bigint: true });
    return stat.isDirectory() && stat.ino !== 0n && marker?.schema === 1 && marker.path === venvDir
      && marker.dev === String(stat.dev) && marker.ino === String(stat.ino);
  } catch {
    return false;
  }
}

export function setupSkillVenv(deps: SetupDeps): SetupResult {
  const { venvDir, run, log, platform, packages = SKILL_VENV_PACKAGES } = deps;
  const runtimePlatform = platform ?? process.platform;
  const python = venvPythonPath(venvDir, runtimePlatform);
  const installArgs = ["-m", "pip", "install", "--upgrade", "pip", ...packages.map((pkg) => pkg.distribution)];
  const existing = existsSync(venvDir);
  const configured = existsSync(join(venvDir, "pyvenv.cfg")) && statSync(join(venvDir, "pyvenv.cfg")).isFile();
  if (existing && (!lstatSync(venvDir).isDirectory()
    || (!configured && !ownsVenvCreation(venvDir)))) {
    return { venvDir, success: false, reason: "Existing venv path is not a directory with pyvenv.cfg; left unchanged" };
  }
  let recreate = !configured || !existsSync(python) || run(python, ["--version"]).status !== 0;
  if (!recreate && run(python, ["-m", "pip", "--version"]).status !== 0) {
    const bootstrap = run(python, ["-m", "ensurepip", "--upgrade"]);
    if (bootstrap.status !== 0) return { venvDir, success: false, reason: `pip bootstrap failed: ${bootstrap.stderr}` };
    // Stale dist-info can make ensurepip succeed without restoring the pip module.
    recreate = run(python, ["-m", "pip", "--version"]).status !== 0;
  }
  if (recreate) {
    const pythonCmd = detectPython(run, runtimePlatform);
    if (!pythonCmd) {
      return {
        venvDir,
        success: false,
        reason: runtimePlatform === "win32" ? "py/python/python3 not found on PATH" : "python3/python not found on PATH",
      };
    }
    if (existing) {
      // Keep the entire broken environment, including any user files, rather than --clear.
      const backup = join(mkdtempSync(`${venvDir}.repair-`), "venv");
      renameSync(venvDir, backup);
      log(`Preserved broken skill venv at ${backup}`);
    }
    // Publish ownership before Python can leave partial files, but build at the final path.
    const staging = mkdtempSync(`${venvDir}.creating-`);
    try {
      const stat = lstatSync(staging, { bigint: true });
      writeFileSync(join(staging, VENV_CREATION_MARKER), JSON.stringify({
        schema: 1, path: venvDir, dev: String(stat.dev), ino: String(stat.ino),
      }), { flag: "wx", mode: 0o600 });
      if (existsSync(venvDir)) throw new Error("The venv directory changed during setup; left unchanged.");
      renameSync(staging, venvDir);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    const create = run(pythonCmd.command, [...pythonCmd.prefixArgs, "-m", "venv", venvDir]);
    if (!ownsVenvCreation(venvDir)) return { venvDir, success: false, reason: "The venv directory changed during creation; left unchanged" };
    if (create.status !== 0) return { venvDir, success: false, reason: `venv creation failed: ${create.stderr}` };
    const pip = run(python, ["-m", "pip", "--version"]);
    if (pip.status !== 0) return { venvDir, success: false, reason: `pip unavailable after venv creation: ${pip.stderr}` };
    unlinkSync(join(venvDir, VENV_CREATION_MARKER));
  }
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
  const result = spawnSync(command, args, {
    stdio: ["ignore", "inherit", "inherit"],
    timeout: 600_000,
  });
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
 * Idempotent first-run setup. Reuses an existing venv (package imports and pip CLI check
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

  if (existsSync(python) && existsSync(join(venvDir, "pyvenv.cfg"))) {
    const imports = [...new Set(["pip", ...packages.flatMap((pkg) => pkg.imports)])];
    const check = run(python, ["-c", `import ${imports.join(", ")}`]);
    if (check.status === 0 && run(python, ["-m", "pip", "--version"]).status === 0) {
      log(`Skill venv already ready: ${venvDir}`);
      return { venvDir, success: true };
    }
    log(`Skill venv missing packages — reinstalling ${distributions.join(" + ")}…`);
  } else {
    log(`First run: creating skill Python venv at ${venvDir}`);
  }

  let result: SetupResult;
  try {
    result = setupSkillVenv({ venvDir, run, log, packages });
  } catch (error) {
    result = { venvDir, success: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (!result.success) {
    const createCommand = process.platform === "win32"
      ? `py -3 -m venv "${venvDir}"; & "${python}" -m pip install ${distributions.join(" ")}`
      : `python3 -m venv "${venvDir}" && "${python}" -m pip install ${distributions.join(" ")}`;
    log(
      `Skill venv setup skipped: ${result.reason}. PDF conversion and arXiv SDK features will fall back to system tools. Fix with: ${createCommand}`,
    );
  }
  return result;
}

export function main(): number {
  ensureSkillVenv(getAgentDir(), { stream: true, log: (msg) => console.log(`[easyresearch] ${msg}`) });
  return 0;
}

if (import.meta.main) process.exit(main());
