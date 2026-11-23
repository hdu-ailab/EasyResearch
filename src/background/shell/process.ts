import { spawn } from "node:child_process";
import { accessSync, constants, createWriteStream, existsSync } from "node:fs";
import { basename, delimiter, isAbsolute, join, win32 } from "node:path";
import { captureIncompleteOutput, captureOutput } from "./storage";
import type { ShellResult } from "./types";
import { scheduleShellTimeout } from "./timer";

export interface ShellProcessInput {
  command: string;
  cwd: string;
  file: string;
  env: NodeJS.ProcessEnv;
  shellPath?: string;
  timeout: number;
}
export interface ShellProcess {
  pid?: number;
  done: Promise<ShellResult>;
  stop(reason?: "cancelled" | "timeout"): Promise<void>;
}

export function shellEnvironment(environment: NodeJS.ProcessEnv, sessionID: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...environment, AGENT: "1", EASYRESEARCH: "1", AI_AGENT: environment.AI_AGENT || "easyresearch", EASYRESEARCH_SESSION_ID: sessionID };
  for (const key of Object.keys(env)) {
    if (/^EASYRESEARCH_(?:DAEMON_|DESKTOP_|SHELL_WORKER_|.*BASELINE)/.test(key)) delete env[key];
  }
  return env;
}

export function selectShell(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, configured?: string): { executable: string; args(command: string): string[] } {
  const find = (name: string) => {
    const candidates = isAbsolute(name) ? [name] : (env.PATH ?? env.Path ?? "").split(delimiter).map((dir) => join(dir, name));
    return candidates.find((file) => {
      try { accessSync(file, constants.X_OK); return true; } catch { return false; }
    });
  };
  if (platform === "win32") {
    const powershell = configured && /^(?:pwsh|powershell)(?:\.exe)?$/i.test(win32.basename(configured)) ? configured : undefined;
    const executable = powershell ?? find("pwsh.exe") ?? find("powershell.exe");
    if (!executable) throw new Error("PowerShell was not found on PATH.");
    return { executable, args: (command) => ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n${command}`] };
  }
  const compatible = (shell?: string) => shell && /^(?:bash|sh|dash|zsh|ksh)$/.test(basename(shell)) ? find(shell) : undefined;
  const executable = configured ? find(configured) : compatible(env.SHELL) ?? find("bash") ?? (existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh");
  if (!executable) throw new Error("Configured shell was not found.");
  return { executable, args: (command) => basename(executable) === "zsh" ? ["+o", "nomatch", "-c", command] : ["-c", command] };
}

/** Own pipes and kill escalation through close, including descendants holding pipes. */
export function startShellProcess(input: ShellProcessInput): ShellProcess {
  const selected = selectShell(process.platform, input.env, input.shellPath);
  const started = Date.now();
  const stream = createWriteStream(input.file, { flags: "wx", mode: 0o600 });
  const child = spawn(selected.executable, selected.args(input.command), {
    cwd: input.cwd, env: input.env, detached: process.platform !== "win32", windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let reason: "cancelled" | "timeout" | undefined;
  let failure: Error | undefined;
  let closed = false;
  let exited = false;
  let incomplete = false;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  let drain: ReturnType<typeof setTimeout> | undefined;
  let cancelRuntimeTimer: (() => void) | undefined;
  const killers: Promise<void>[] = [];
  const signal = (force: boolean) => {
    if (!child.pid) return;
    if (process.platform === "win32") {
      const executable = join(input.env.SystemRoot ?? input.env.SYSTEMROOT ?? "C:\\Windows", "System32", "taskkill.exe");
      killers.push(new Promise((resolve) => {
        const killer = spawn(executable, ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])], { stdio: "ignore", windowsHide: true });
        killer.once("error", () => resolve());
        killer.once("close", () => resolve());
      }));
    } else {
      try { process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure ??= error as Error;
      }
    }
  };
  const boundStoppedOutput = () => {
    if (!exited || !reason || closed || drain) return;
    // An escaped descendant can retain inherited pipes after the owned shell
    // exits. Kill the remaining owned group, then close only our pipe readers;
    // already queued file writes are still flushed before terminal publication.
    drain = setTimeout(() => {
      if (closed || (child.stdout.readableEnded && child.stderr.readableEnded)) return;
      incomplete = true;
      signal(true);
      for (const pipe of [child.stdout, child.stderr]) {
        pipe.unpipe(stream);
        const buffered = pipe.read();
        if (buffered) stream.write(buffered);
        pipe.destroy();
      }
    }, 500);
  };
  const stop = (why: "cancelled" | "timeout" = "cancelled") => {
    if (!closed && !reason) {
      reason = why;
      signal(false);
      escalation = setTimeout(() => signal(true), 500);
      boundStoppedOutput();
    }
    return done.then(() => undefined);
  };
  child.stdout.pipe(stream, { end: false });
  child.stderr.pipe(stream, { end: false });
  stream.on("error", (error) => { failure ??= error; void stop(); });
  child.on("error", (error) => { failure ??= error; });
  child.once("exit", () => { exited = true; boundStoppedOutput(); });
  const done = new Promise<ShellResult>((resolve) => {
    child.once("close", (exitCode, exitSignal) => {
      closed = true;
      if (drain) clearTimeout(drain);
      cancelRuntimeTimer?.();
      // A shell may exit on TERM before its descendants; still terminate the group.
      if (escalation) { clearTimeout(escalation); signal(true); }
      const complete = async () => {
        await Promise.all(killers);
        let capture: { output: string; truncated: boolean; incomplete?: boolean };
        try { capture = incomplete
          ? captureIncompleteOutput(input.file, "inherited output pipes remained open after the shell exited.")
          : captureOutput(input.file); } catch (error) {
          failure ??= error as Error;
          capture = { output: "Shell command output is unavailable.", truncated: false };
        }
        resolve({
          ...capture, exitCode, wallTimeSeconds: (Date.now() - started) / 1000,
          status: failure ? "error" : reason === "cancelled" ? "cancelled" : "completed",
          ...(capture.truncated ? { outputPath: input.file } : {}),
          ...(exitSignal ? { signal: exitSignal } : {}),
          ...(reason === "timeout" ? { timeout: true, timeoutMs: input.timeout } : {}),
          ...(failure ? { killed: failure.message } : {}),
        });
      };
      if (stream.destroyed) void complete();
      else stream.end(() => { void complete(); });
    });
  });
  if (input.timeout > 0) cancelRuntimeTimer = scheduleShellTimeout(input.timeout, () => { void stop("timeout"); });
  return { pid: child.pid, done, stop };
}
