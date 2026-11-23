import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { EnvironmentMap } from "./network-policy";
import { hasLiveOwnedProcessGroup } from "./owned-process-group";
import type { WindowsUpdateJob } from "./windows-update-job";

export interface NpmProcessResult { code: number; stdout: string; stderr: string }
export interface NpmProcessOptions {
  environment: EnvironmentMap;
  timeoutMs: number;
  signal?: AbortSignal;
  killAfterMs?: number;
  cwd?: string;
}

/** Fixed-argv host operation. Output is drained privately; no npm text enters SSE/logs. */
export async function runNpmUpdateProcess(command: string, args: string[], options: NpmProcessOptions): Promise<NpmProcessResult> {
  options.signal?.throwIfAborted();
  const environment = { ...options.environment };
  // Do not run arbitrary preloads or let npm config leak into a nested runtime.
  for (const key of Object.keys(environment)) {
    const name = process.platform === "win32" ? key.toUpperCase() : key;
    if (["NODE_OPTIONS", "NODE_PATH", "EASYRESEARCH_NPM_PROVENANCE"].includes(name)) delete environment[key];
  }
  if (process.platform === "win32") return runWindowsNpmUpdateProcess(command, args, { ...options, environment });
  const child = spawn(command, args, { env: environment, cwd: options.cwd, shell: false, windowsHide: true, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const output = captureOutput(child);
  let cancelled = false;
  let closed = false;
  let code: number | null = null;
  let spawnFailed = false;
  let cleanupStarted: number | undefined;
  let forced = false;
  let polling: ReturnType<typeof setInterval> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const terminate = (force: boolean): void => {
    if (!child.pid) return;
    try { process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM"); }
    catch { /* Only a later group-absence probe may release custody. */ }
  };
  let onAbort: () => void = () => {};
  try {
    return await new Promise<NpmProcessResult>((resolve, reject) => {
      let finished = false;
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        if (error) reject(error);
        else resolve(output(code));
      };
      const treeStopped = () => {
        if (!child.pid) return spawnFailed;
        try { return !hasLiveOwnedProcessGroup(child.pid); } catch { return false; }
      };
      const check = () => {
        if (finished) return;
        if (spawnFailed && !child.pid) { finish(new Error("Updater process could not start. Check npm availability and installation permissions.")); return; }
        if (cleanupStarted === undefined) {
          if (!closed) return;
          if (treeStopped()) { finish(); return; }
          // An exit-zero root does not authorize verification while a descendant
          // can still mutate the installation. Settle its remaining group first.
          beginCleanup();
        }
        if (!forced && Date.now() - cleanupStarted! >= (options.killAfterMs ?? 1500)) {
          forced = true; terminate(true);
        }
        if (closed && treeStopped()) {
          finish(new Error(cancelled ? "Updater process cancelled." : "Updater process exited before its descendants settled."));
        } else if (Date.now() - cleanupStarted! >= (options.killAfterMs ?? 1500) + 4000) {
          finish(Object.assign(new Error("Updater process-tree cleanup could not be verified."), { custodyUnresolved: true }));
        }
      };
      const beginCleanup = () => {
        if (cleanupStarted !== undefined) return;
        cleanupStarted = Date.now();
        terminate(false);
        polling = setInterval(check, 20);
      };
      onAbort = () => {
        if (cancelled) return;
        cancelled = true;
        beginCleanup(); check();
      };
      child.once("error", () => { spawnFailed = true; check(); });
      child.once("spawn", () => { if (cleanupStarted !== undefined) terminate(false); });
      // Pipe drain/root exit and descendant settlement are separate barriers.
      child.once("close", (exitCode) => { closed = true; code = exitCode; check(); });
      options.signal?.addEventListener("abort", onAbort, { once: true });
      deadline = setTimeout(onAbort, options.timeoutMs);
      if (options.signal?.aborted) onAbort();
    });
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    clearTimeout(deadline); clearInterval(polling);
  }
}

function captureOutput(child: Pick<ChildProcessWithoutNullStreams, "stdout" | "stderr">): (code: number | null) => NpmProcessResult {
  let stdout: Buffer = Buffer.alloc(0);
  let stderr: Buffer = Buffer.alloc(0);
  const append = (previous: Buffer, chunk: Buffer): Buffer => Buffer.concat([previous, chunk.subarray(-8192)]).subarray(-8192);
  child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
  child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
  return (code) => ({ code: code ?? 1, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") });
}

async function runWindowsNpmUpdateProcess(command: string, args: string[], options: NpmProcessOptions): Promise<NpmProcessResult> {
  const timeout = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
  const deadline = setTimeout(() => timeout.abort(), options.timeoutMs);
  let job: WindowsUpdateJob | undefined;
  try {
    const { startWindowsUpdateJob } = await import("./windows-update-job");
    signal.throwIfAborted();
    job = await startWindowsUpdateJob(command, args, {
      cwd: options.cwd, env: options.environment, windowsVerbatimArguments: false, signal,
    });
    const output = captureOutput(job.child);
    // Guard/root exit is not target-tree settlement. The adapter owns stdin,
    // cancellation and native job evidence; this consumer only drains output.
    const result = await job.completed;
    if (signal.aborted) throw new Error("Updater process cancelled or timed out.");
    return output(result.code);
  } finally {
    clearTimeout(deadline);
    if (job) {
      try { await job.dispose(); }
      catch (error) {
        if (error && typeof error === "object" && "custodyUnresolved" in error && error.custodyUnresolved) throw error;
        throw Object.assign(new Error("Windows updater cleanup could not be verified."), { custodyUnresolved: true });
      }
    }
  }
}
