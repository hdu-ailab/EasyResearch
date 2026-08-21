import {
  createBashTool,
  type BashOperations,
  type ExtensionAPI,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { win32 } from "node:path";
import { Type } from "typebox";

const MAX_TIMEOUT_MS = 2_147_483_647;
const EXIT_STDIO_GRACE_MS = 100;

export type WindowsShellKind = "powershell5.1" | "powershell7" | "gitbash" | "other-bash" | "other-shell";

export interface WindowsShellInfo {
  kind: WindowsShellKind;
  displayName: string;
}

interface BashDetectionOptions {
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  locateOnPath?: (name: string) => string | undefined;
}

function normalized(value: string | undefined): string {
  return (value ?? "").toLowerCase();
}

function isGitBashExecutable(pathname: string): boolean {
  const value = normalized(pathname);
  return value.includes("program files") && value.includes("\\git\\") && value.endsWith("\\bin\\bash.exe");
}

function resolveBashFromKnownWindowsPaths(
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
  locateOnPath: (name: string) => string | undefined,
): string | undefined {
  const candidates = [
    env.ProgramFiles,
    env["ProgramFiles(x86)"],
    env.PROGRAMFILES,
    env["PROGRAMFILES(X86)"],
  ]
    .filter((entry): entry is string => !!entry)
    .map((entry) => win32.join(entry, "Git", "bin", "bash.exe"));

  const gitBash = candidates.find((path) => exists(path));
  if (gitBash) return gitBash;

  const pathBash = locateOnPath("bash.exe");
  return pathBash && exists(pathBash) ? pathBash : undefined;
}

function hasBashMarker(value: string): boolean {
  return /(?:^|[\\/])bash(?:\.exe)?$/u.test(value) || value.includes("/bash") || value.includes("\\bash");
}

export function resolveWindowsShellFromEnv(options: BashDetectionOptions = {}): WindowsShellInfo {
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const locateOnPath = options.locateOnPath ?? locateWindowsExecutable;
  const shell = normalized(env.SHELL);
  const psmodulePath = normalized(env.PSModulePath);
  const psHome = normalized(env.PSHOME);
  const comSpec = normalized(env.ComSpec);

  if (env.MSYSTEM || env.MSYS || /(?:msys|mingw)/u.test(normalized(env.MSYSTEM_CARCH))) {
    return { kind: "gitbash", displayName: "Git Bash" };
  }

  if (shell.includes("program files/git/usr/bin/bash") || shell.includes("program files\\git\\bin\\bash.exe")) {
    return { kind: "gitbash", displayName: "Git Bash" };
  }
  if (shell.includes("/cygwin") || shell.includes("/msys") || shell.includes("/wsl") || shell.includes("\\cygwin") || shell.includes("\\msys") || shell.includes("\\wsl")) {
    return { kind: "other-bash", displayName: "Other Bash" };
  }

  if (hasBashMarker(shell) || shell.includes("/bin/bash") || shell.includes("\\bin\\bash")) {
    return { kind: "other-bash", displayName: "Other Bash" };
  }

  if (psmodulePath.includes("powershell\\7\\modules")) {
    return { kind: "powershell7", displayName: "PowerShell 7" };
  }
  if (psmodulePath.includes("windowspowershell\\v1.0\\modules")) {
    return { kind: "powershell5.1", displayName: "Windows PowerShell 5.1" };
  }

  if (psHome.includes("powershell\\7") || shell.includes("pwsh") || comSpec.includes("pwsh")) {
    return { kind: "powershell7", displayName: "PowerShell 7" };
  }
  if (psHome.includes("windowspowershell") || shell.includes("powershell") || shell.includes("powershell.exe")) {
    return { kind: "powershell5.1", displayName: "Windows PowerShell 5.1" };
  }

  const bashPath = resolveBashFromKnownWindowsPaths(env, exists, locateOnPath);
  if (bashPath) {
    if (isGitBashExecutable(bashPath)) {
      return { kind: "gitbash", displayName: "Git Bash" };
    }
    return { kind: "other-bash", displayName: "Other Bash" };
  }

  return { kind: "other-shell", displayName: "Other shell" };
}

export interface PowerShellResolutionOptions {
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  locateOnPath?: (name: string) => string | undefined;
}

export interface PowerShellOperationsOptions extends PowerShellResolutionOptions {
  executable?: string;
  taskkill?: string;
  spawnProcess?: typeof spawn;
  killTree?: (pid: number) => void;
}

function locateWindowsExecutable(name: string): string | undefined {
  const result = spawnSync("where.exe", [name], {
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
  });
  if (result.status !== 0 || !result.stdout) return undefined;
  return result.stdout
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0 && existsSync(entry));
}

/** Resolve only native Windows PowerShell implementations; WSL is never a fallback. */
export function resolvePowerShellExecutable(options: PowerShellResolutionOptions = {}): string {
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const locateOnPath = options.locateOnPath ?? locateWindowsExecutable;
  const pwsh = locateOnPath("pwsh.exe");
  if (pwsh && exists(pwsh)) return pwsh;

  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
  const inbox = win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (exists(inbox)) return inbox;
  throw new Error(
    "Native Windows PowerShell was not found. Install PowerShell 7 (pwsh.exe) or enable the in-box Windows PowerShell feature.",
  );
}

export function resolveTaskkillExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
  return win32.join(systemRoot, "System32", "taskkill.exe");
}

export function buildPowerShellScript(command: string): string {
  // Keep stdin ASCII so Windows PowerShell 5.1 cannot decode non-ASCII command
  // text through the active OEM code page. The payload itself remains UTF-16LE.
  const exitStatusLines = [
    "$easyresearchCommandSucceeded = $?",
    "$easyresearchNativeExit = $global:LASTEXITCODE",
    "if ($easyresearchCommandSucceeded) { exit 0 }",
    "if ($null -ne $easyresearchNativeExit -and $easyresearchNativeExit -ne 0) { exit $easyresearchNativeExit }",
    "exit 1",
  ];
  const encodedCommand = Buffer.from(
    [command, "", ...exitStatusLines, ""].join("\r\n"),
    "utf16le",
  ).toString("base64");
  return [
    "$ErrorActionPreference = 'Continue'",
    "$easyresearchUtf8 = [System.Text.UTF8Encoding]::new($false)",
    "[Console]::OutputEncoding = $easyresearchUtf8",
    "$OutputEncoding = $easyresearchUtf8",
    `$easyresearchCommand = [System.Text.Encoding]::Unicode.GetString([System.Convert]::FromBase64String('${encodedCommand}'))`,
    "$easyresearchScript = [ScriptBlock]::Create($easyresearchCommand)",
    "& $easyresearchScript",
    ...exitStatusLines,
    "",
  ].join("\r\n");
}

function timeoutMs(timeout: number | undefined): number | undefined {
  if (timeout === undefined) return undefined;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error("Invalid timeout: must be a finite number of seconds");
  }
  const milliseconds = timeout * 1000;
  if (milliseconds > MAX_TIMEOUT_MS) {
    throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_MS / 1000} seconds`);
  }
  return milliseconds;
}

export function killWindowsProcessTree(
  pid: number,
  taskkill = resolveTaskkillExecutable(),
): void {
  const result = spawnSync(taskkill, ["/PID", String(pid), "/T", "/F"], {
    stdio: "ignore",
    timeout: 15_000,
    windowsHide: true,
  });
  if (!result.error && result.status === 0) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process may already have exited between taskkill and the fallback.
  }
}

function waitForPowerShellProcess(
  child: ChildProcessWithoutNullStreams,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let postExitTimer: NodeJS.Timeout | undefined;
    let stdoutEnded = child.stdout.readableEnded;
    let stderrEnded = child.stderr.readableEnded;

    const cleanup = () => {
      if (postExitTimer) clearTimeout(postExitTimer);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.stdout.removeListener("end", onStdoutEnd);
      child.stderr.removeListener("end", onStderrEnd);
      child.stdout.removeListener("data", onData);
      child.stderr.removeListener("data", onData);
    };
    const finalize = (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdout.destroy();
      child.stderr.destroy();
      resolve(code);
    };
    const maybeFinalizeAfterExit = () => {
      if (exited && stdoutEnded && stderrEnded) finalize(exitCode);
    };
    const armIdleTimer = () => {
      if (postExitTimer) clearTimeout(postExitTimer);
      postExitTimer = setTimeout(() => finalize(exitCode), EXIT_STDIO_GRACE_MS);
    };
    const onData = () => {
      if (exited && !settled) armIdleTimer();
    };
    const onStdoutEnd = () => {
      stdoutEnded = true;
      maybeFinalizeAfterExit();
    };
    const onStderrEnd = () => {
      stderrEnded = true;
      maybeFinalizeAfterExit();
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null) => {
      exited = true;
      exitCode = code;
      maybeFinalizeAfterExit();
      if (!settled) armIdleTimer();
    };
    const onClose = (code: number | null) => finalize(code);

    child.stdout.once("end", onStdoutEnd);
    child.stderr.once("end", onStderrEnd);
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
  });
}

/** Native PowerShell implementation for Pi's stable BashOperations seam. */
export function createPowerShellOperations(options: PowerShellOperationsOptions = {}): BashOperations {
  const executable = options.executable ?? resolvePowerShellExecutable(options);
  const spawnProcess = options.spawnProcess ?? spawn;
  const killTree = options.killTree
    ?? ((pid: number) => killWindowsProcessTree(pid, options.taskkill ?? resolveTaskkillExecutable(options.env)));

  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      if (signal?.aborted) throw new Error("aborted");
      const limit = timeoutMs(timeout);
      const child = spawnProcess(
        executable,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"],
        {
          cwd,
          detached: false,
          env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      ) as ChildProcessWithoutNullStreams;

      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      const completion = waitForPowerShellProcess(child);
      child.stdin.on("error", () => {});
      child.stdin.end(buildPowerShellScript(command), "utf8");

      let finished = false;
      try {
        let timedOut = false;
        let aborted = false;
        let timer: NodeJS.Timeout | undefined;

        const terminate = (reason: "abort" | "timeout") => {
          if (finished) return;
          aborted ||= reason === "abort";
          timedOut ||= reason === "timeout";
          if (child.pid) killTree(child.pid);
        };
        const onAbort = () => terminate("abort");
        const cleanup = () => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        };
        if (limit !== undefined) timer = setTimeout(() => terminate("timeout"), limit);
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });

        try {
          const exitCode = await completion;
          if (aborted || signal?.aborted) throw new Error("aborted");
          if (timedOut) throw new Error(`timeout:${timeout}`);
          return { exitCode };
        } finally {
          cleanup();
        }
      } finally {
        finished = true;
      }
    },
  };
}

export interface WindowsPowerShellExtensionOptions extends PowerShellOperationsOptions {
  platform?: NodeJS.Platform;
}

export function createWindowsPowerShellExtension(
  options: WindowsPowerShellExtensionOptions = {},
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    if ((options.platform ?? process.platform) !== "win32") return;
    pi.on("session_start", (_event, ctx) => {
      const shell = resolveWindowsShellFromEnv({ env: options.env, exists: options.exists, locateOnPath: options.locateOnPath });
      const shellName = shell.displayName;
      const tool = createBashTool(ctx.cwd, {
        operations: createPowerShellOperations(options),
      });
      pi.registerTool({
        ...tool,
        label: "PowerShell",
        description:
          `Detected launcher shell: ${shellName}. Execute a native Windows command in the current working directory. Returns stdout and stderr with Pi's normal streaming and truncation behavior. WSL and Bash syntax are not available. Optionally provide a timeout in seconds.`,
        promptSnippet: `Execute native commands from ${shellName} context`,
        promptGuidelines: [
          `Detected launcher shell: ${shellName}.`,
          "Use PowerShell syntax and Windows paths. Do not emit Bash, WSL, cmd.exe batch, or POSIX-only commands.",
          "Use $env:NAME for environment variables and -LiteralPath for paths supplied as data.",
          "You can inspect PI_* environment variables for current model and session details.",
        ],
        parameters: Type.Object({
          command: Type.String({ description: "PowerShell command to execute" }),
          timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
        }),
      });
    });
  };
}

export default createWindowsPowerShellExtension();
