import { spawn, spawnSync, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { windowsTaskkillCommand } from "./environment";
import { readFileSync, readdirSync } from "node:fs";
import { UPDATE_EVENT_PREFIX } from "./update-protocol";
import { startWindowsUpdateJob, type WindowsUpdateJob } from "../runtime/windows-update-job";

export interface OwnedDesktopInstaller {
  readonly child: ChildProcessWithoutNullStreams;
  readonly treeClosed: boolean;
  readonly treeSettled: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stop(): Promise<void>;
}

/** An NSIS Job Object guard is not a Desktop host or its parent-life channel. */
export function ownDesktopInstallerJob(job: WindowsUpdateJob): OwnedDesktopInstaller {
  let treeClosed = false;
  let stopping: Promise<void> | undefined;
  // Drain target bytes without retaining arbitrary installer output in memory/UI.
  job.child.stdout.resume(); job.child.stderr.resume();
  const treeSettled = job.completed.then(async (result) => {
    await job.dispose();
    treeClosed = true;
    return result;
  });
  void treeSettled.catch(() => {});
  return {
    child: job.child, treeSettled, get treeClosed() { return treeClosed; },
    stop() {
      if (treeClosed) return Promise.resolve();
      if (stopping) return stopping;
      const attempt = (async () => {
        await job.cancel(); await job.dispose(); treeClosed = true;
      })();
      stopping = attempt;
      void attempt.catch(() => { if (stopping === attempt) stopping = undefined; });
      return attempt;
    },
  };
}

export async function verifyDesktopSidecarVersion(executable: string, version: string, env: NodeJS.ProcessEnv, startJob: typeof startWindowsUpdateJob = startWindowsUpdateJob): Promise<void> {
  const job = await startJob(executable, ["--version"], { env });
  const chunks: Buffer[] = []; let bytes = 0; let overflow = false;
  job.child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 4096) { overflow = true; void job.cancel().catch(() => {}); return; }
    chunks.push(chunk);
  });
  job.child.stderr.resume();
  try {
    if (!await exitedWithin(job.completed, 30_000)) {
      await job.cancel(); throw new Error("Installed sidecar version probe timed out.");
    }
    const result = await job.completed;
    if (overflow || result.code !== 0 || result.signal !== null || Buffer.concat(chunks).toString("utf8").trim() !== `easyresearch ${version}`) throw new Error("Installed sidecar version mismatch.");
  } finally { await job.dispose(); }
}

export interface OwnedUpdateProcess {
  child: ChildProcessWithoutNullStreams;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly closed: boolean;
  readonly treeClosed: boolean;
  readonly treeSettled: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  exitError(): Error;
  event(type: string, token: string, timeoutMs: number): Promise<Record<string, unknown>>;
  send(message: unknown): Promise<void>;
  stop(): Promise<void>;
}

export async function waitForDesktopUpdateReadiness<T>(ready: Promise<T>, child: OwnedUpdateProcess, timeoutMs: number): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  let channelFailed = false, timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      ready.catch(error => { channelFailed = true; throw error; }),
      child.exited.then(() => { throw child.exitError(); }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Update successor readiness timed out.")), timeoutMs); }),
    ]);
  } catch (error) {
    if (!child.closed && channelFailed) {
      await exitedWithin(child.exited, Math.max(0, Math.min(1000, deadline - performance.now())));
    }
    if (child.closed) throw child.exitError();
    throw error;
  } finally { clearTimeout(timer); }
}

/** Shared launch boundary for the custodian and the host that survives its exit. */
export function spawnDesktopUpdateOwner(executable: string, args: string[], userDataDir: string, env: NodeJS.ProcessEnv): OwnedUpdateProcess {
  // A host that survives its custodian cannot remain in that process's Windows
  // kill-on-close job. Pipes and authenticated pre-acceptance custody stay owned.
  return spawnUpdateProcess(executable, args, { env, cwd: userDataDir, detached: true });
}

/** Retains custody at spawn, including spawn errors and children that never become ready. */
export function spawnUpdateProcess(executable: string, args: string[], options: SpawnOptionsWithoutStdio = {}): OwnedUpdateProcess {
  const child = spawn(executable, args, { ...options, detached: process.platform !== "win32" || options.detached, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let closed = false;
  let treeClosed = false;
  let resolveTree!: (exit: { code: number | null; signal: NodeJS.Signals | null }) => void;
  const treeSettled = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => { resolveTree = resolve; });
  let rootExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let treeTimer: ReturnType<typeof setInterval> | undefined;
  let cleanupStarted: number | undefined;
  let treeInterrupted = false;
  let failure: Error | undefined;
  const events: Record<string, unknown>[] = [];
  const waiters = new Set<() => void>();
  let stdout = ""; let outputBytes = 0;
  let stderr: Buffer = Buffer.alloc(0); let stderrTruncated = false;
  const notify = () => { for (const waiter of waiters) waiter(); };
  child.on("error", (error) => { failure = error; notify(); });
  child.stdin.on("error", () => {});
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => {
      closed = true; rootExit = { code, signal }; resolve(rootExit); notify();
      if (process.platform === "win32") { treeClosed = true; resolveTree(rootExit); }
      else {
        treeTimer = setInterval(inspectTree, 25);
        inspectTree();
      }
    });
  });
  const signalGroup = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure = new Error("Update process group termination failed."); }
  };
  const inspectTree = () => {
    try {
      if (!child.pid || !desktopProcessGroupAlive(child.pid)) {
        treeClosed = true; clearInterval(treeTimer);
        resolveTree(treeInterrupted && rootExit?.code === 0 ? { code: 1, signal: null } : rootExit!);
        return;
      }
      treeInterrupted = true;
      if (cleanupStarted === undefined) { cleanupStarted = Date.now(); signalGroup("SIGTERM"); }
      else if (Date.now() - cleanupStarted >= 1500) signalGroup("SIGKILL");
    } catch { /* Keep custody and retry inspection; an unknown group is not empty. */ }
  };
  const consume = (chunk: Buffer, machine: boolean) => {
    outputBytes += chunk.length;
    if (outputBytes > 256 * 1024) { failure = new Error("Update process output exceeded its limit."); notify(); return; }
    if (!machine) {
      const combined = Buffer.concat([stderr, chunk]);
      if (combined.length > 8192) { stderr = combined.subarray(combined.length - 8192); stderrTruncated = true; }
      else stderr = combined;
      return;
    }
    stdout += chunk.toString("utf8");
    let newline: number;
    while ((newline = stdout.indexOf("\n")) !== -1) {
      const line = stdout.slice(0, newline).trimEnd(); stdout = stdout.slice(newline + 1);
      if (!line.startsWith(UPDATE_EVENT_PREFIX)) continue;
      try {
        const event = JSON.parse(line.slice(UPDATE_EVENT_PREFIX.length));
        if (!event || typeof event !== "object" || events.length >= 16) throw new Error("Invalid update event.");
        events.push(event); notify();
      } catch { failure = new Error("Invalid update process event."); notify(); }
    }
  };
  child.stdout.on("data", (chunk: Buffer) => consume(chunk, true));
  child.stderr.on("data", (chunk: Buffer) => consume(chunk, false));
  const exitError = () => failure ?? Object.assign(new Error("Update process exited before acknowledgement."), {
    code: "UPDATE_PROCESS_EXIT", childExitCode: rootExit?.code, childSignal: rootExit?.signal, stderr: stderr.toString("utf8"), stderrTruncated,
  });
  return {
    child, exited, treeSettled, exitError, get closed() { return closed; }, get treeClosed() { return treeClosed; },
    event(type, token, timeoutMs) {
      return new Promise((resolve, reject) => {
        const done = (error?: Error, value?: Record<string, unknown>) => {
          clearTimeout(timer); waiters.delete(check);
          if (error) reject(error); else resolve(value!);
        };
        const check = () => {
          if (failure || closed) {
            done(exitError());
            return;
          }
          const index = events.findIndex((event) => event.type === type && event.token === token);
          if (index >= 0) { done(undefined, events.splice(index, 1)[0]); return; }
        };
        const timer = setTimeout(() => done(new Error("Update process acknowledgement timed out.")), timeoutMs);
        waiters.add(check); check();
      });
    },
    send(message) {
      return new Promise((resolve, reject) => {
        child.stdin.write(`${JSON.stringify(message)}\n`, (error) => error ? reject(error) : resolve());
      });
    },
    async stop() {
      if (treeClosed) return;
      if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
      if (await exitedWithin(treeSettled, 2_000)) return;
      if (child.pid && !treeClosed) {
        if (process.platform === "win32") {
          const command = windowsTaskkillCommand(process.env.SystemRoot ?? "C:\\Windows", child.pid);
          const killed = spawnSync(command.command, command.args, { windowsHide: true, stdio: "ignore", timeout: 5_000 });
          if ((killed.error || killed.status !== 0) && !closed) throw new Error("Update child termination failed.");
        } else signalGroup("SIGKILL");
      }
      if (!await exitedWithin(treeSettled, 5_000)) throw new Error("Update process tree has not stopped.");
    },
  };
}

function desktopProcessGroupAlive(group: number): boolean {
  try { process.kill(-group, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
  if (process.platform !== "linux") return true;
  const entries = readdirSync("/proc").filter((entry) => /^\d+$/u.test(entry));
  if (entries.length > 131_072) throw new Error("Process inspection exceeded its limit.");
  for (const entry of entries) {
    let stat: string;
    try { stat = readFileSync(`/proc/${entry}/stat`, "utf8"); }
    catch (error) { if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) continue; throw error; }
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (Number(fields[2]) === group && fields[0] !== "Z" && fields[0] !== "X") return true;
  }
  return false;
}

export async function exitedWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise.then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
