import { spawnSync } from "node:child_process";
import { posix, win32 } from "node:path";

interface ShellResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

interface DesktopEnvironmentOptions {
  runShell?: (
    command: string,
    args: readonly string[],
    options: {
      env: NodeJS.ProcessEnv;
      encoding: "utf8";
      timeout: number;
      maxBuffer: number;
    },
  ) => ShellResult;
  warn?: (message: string) => void;
}

export function resolvePackagedSidecar(resourcesPath: string, platform: NodeJS.Platform): string {
  if (platform === "win32") return win32.join(resourcesPath, "sidecar", "easyresearch.exe");
  if (platform === "darwin") return posix.join(resourcesPath, "sidecar", "easyresearch");
  throw new Error(`Unsupported desktop platform: ${platform}`);
}

export function resolveDesktopEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  options: DesktopEnvironmentOptions = {},
): NodeJS.ProcessEnv {
  const inherited = { ...baseEnv };
  if (platform === "win32") return inherited;
  if (platform !== "darwin") throw new Error(`Unsupported desktop platform: ${platform}`);

  const shell = inherited.SHELL || "/bin/zsh";
  const runShell = options.runShell ?? ((command, args, spawnOptions) => {
    const result = spawnSync(command, [...args], spawnOptions);
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      ...(result.error ? { error: result.error } : {}),
    };
  });
  const result = runShell(shell, ["-ilc", "/usr/bin/env -0"], {
    env: inherited,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    options.warn?.("EasyResearch could not resolve the macOS login shell environment; inherited app variables will be used.");
    return inherited;
  }
  return { ...parseNulEnvironment(result.stdout), ...inherited };
}

export function parseNulEnvironment(output: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const record of output.split("\0")) {
    const separator = record.indexOf("=");
    if (separator <= 0) continue;
    const name = record.slice(0, separator);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) continue;
    env[name] = record.slice(separator + 1);
  }
  return env;
}

export function windowsTaskkillCommand(systemRoot: string, pid: number): {
  command: string;
  args: string[];
} {
  return {
    command: win32.join(systemRoot, "System32", "taskkill.exe"),
    args: ["/PID", String(pid), "/T", "/F"],
  };
}
