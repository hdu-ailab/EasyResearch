import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, win32 } from "node:path";
import { WINDOWS_UPDATE_JOB_BOOTSTRAP, WINDOWS_UPDATE_JOB_SOURCE } from "./windows-update-job/host-source";

export interface WindowsUpdateJobOptions {
  cwd?: string;
  env: NodeJS.ProcessEnv;
  windowsVerbatimArguments?: boolean;
  signal?: AbortSignal;
  /** Bound for cancellation/guard settlement; does not limit installer runtime. */
  cleanupTimeoutMs?: number;
}

export interface WindowsUpdateJob {
  /** The owned PowerShell guard, NOT the target PID. stdin is private control. */
  child: ChildProcessWithoutNullStreams;
  /** Target exit code after the entire job empties AND output/guard close. */
  completed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Force-terminates the job, then requires positive settlement evidence. */
  cancel(): Promise<void>;
  /** Cancels if necessary; removes private files only after proven settlement. */
  dispose(): Promise<void>;
}

const unavailable = () => new Error("Windows update process custody is unavailable. Use the manual update action.");
const unresolved = () => Object.assign(new Error("Windows update process-tree settlement could not be verified."), { custodyUnresolved: true as const });

function filesystemDiagnostic(error: unknown, directory: string): Record<string, unknown> {
  if (!error || typeof error !== "object") return {};
  const value = error as NodeJS.ErrnoException;
  const entry = typeof value.path === "string" ? relative(directory, value.path) : undefined;
  return {
    code: typeof value.code === "string" && /^[A-Z][A-Z0-9_]{0,39}$/.test(value.code) ? value.code : undefined,
    errno: typeof value.errno === "number" && Number.isSafeInteger(value.errno) ? value.errno : undefined,
    syscall: typeof value.syscall === "string" && /^[a-zA-Z_][a-zA-Z0-9_]{0,39}$/.test(value.syscall) ? value.syscall : undefined,
    entry: entry && entry.length <= 256 && !isAbsolute(entry) && !/^\.\.(?:[/\\]|$)/.test(entry) && !/[\x00-\x1f\x7f]/.test(entry) ? entry : undefined,
  };
}

function nativeDiagnostic(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const phases = ["request", "private-directory", "create-job", "set-job-limits", "query-job", "publish-ready", "wait-admission",
    "duplicate-stdout", "duplicate-stderr", "open-null", "size-attributes", "initialize-attributes", "set-handle-list", "set-job-list",
    "create-process", "resume-thread", "wait-job", "wait-root", "terminate-job", "get-exit-code"];
  if (typeof record.phase !== "string" || !phases.includes(record.phase)) return undefined;
  const number = (field: unknown) => typeof field === "number" && Number.isSafeInteger(field) && field >= -2147483648 && field <= 0xffffffff ? field : undefined;
  return { phase: record.phase, win32Error: number(record.win32Error), hresult: number(record.hresult) };
}

/** Windows CRT argv quoting; verbatim is intentionally only for the owned NSIS call. */
export function windowsUpdateCommandLine(command: string, args: readonly string[], verbatim = false): string {
  if (!/^(?:[a-z]:\\|\\\\[^\\?])/i.test(command) || /[\0"\r\n]/.test(command) || win32.extname(command).toLowerCase() !== ".exe") throw unavailable();
  const quote = (value: string): string => {
    if (value.includes("\0")) throw unavailable();
    if (value && !/[\s"]/.test(value)) return value;
    return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
  };
  // argv[0] is protected even for NSIS's otherwise raw, final /D= suffix.
  const line = [quote(command), ...args.map((arg) => {
    if (arg.includes("\0")) throw unavailable();
    return verbatim ? arg : quote(arg);
  })].join(" ");
  if (line.length > 32766) throw unavailable();
  return line;
}

function environmentBlock(environment: NodeJS.ProcessEnv): string {
  const seen = new Set<string>();
  const entries: string[] = [];
  // Match node's case-insensitive Windows environment-key selection.
  for (const key of Object.keys(environment).sort()) {
    const value = environment[key];
    if (value === undefined || seen.has(key.toUpperCase())) continue;
    if (!key || /[=\0]/.test(key) || value.includes("\0")) throw unavailable();
    seen.add(key.toUpperCase()); entries.push(`${key}=${value}`);
  }
  entries.sort((a, b) => a.toUpperCase() < b.toUpperCase() ? -1 : 1);
  return `${entries.join("\0")}\0\0`;
}

async function executable(path: string): Promise<string> {
  const canonical = await realpath(path);
  if (!(await lstat(canonical)).isFile()) throw unavailable();
  const file = await open(canonical, "r");
  try {
    const bytes = Buffer.alloc(2);
    const { bytesRead } = await file.read(bytes, 0, 2, 0);
    if (bytesRead !== 2 || bytes.toString("ascii") !== "MZ") throw unavailable();
  } finally { await file.close(); }
  return canonical;
}

async function powershellPath(): Promise<{ command: string; systemRoot: string }> {
  // The caller's target environment must never select the OS custody host.
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!root || !/^[a-z]:\\/i.test(root) || /[\0"\r\n]/.test(root)) throw unavailable();
  const systemRoot = await realpath(root);
  if (win32.normalize(root).toLowerCase() !== win32.normalize(systemRoot).toLowerCase()) throw unavailable();
  const expected = win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const command = await executable(expected);
  if (win32.normalize(command).toLowerCase() !== expected.toLowerCase()) throw unavailable();
  return { command, systemRoot };
}

interface Receipt {
  version: 1;
  nonce: string;
  guardPid: number;
  jobEmpty: boolean;
  rootPid: number;
  code: number | null;
  failure: null | "native-job-failed";
  diagnostics?: unknown;
}

async function readRecord(path: string, current: () => boolean): Promise<Record<string, unknown> | undefined> {
  if (!current()) return undefined;
  let file;
  try { file = await open(path, "r"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw unavailable(); }
  try {
    // A non-cooperative filesystem operation can outlive the custody deadline.
    // Keep its promise/handle owned, but perform no more inspection once revoked.
    if (!current()) return undefined;
    const info = await file.stat();
    if (!current()) return undefined;
    if (!info.isFile() || info.size > 4096) throw unavailable();
    const bytes = Buffer.alloc(4097);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (!current()) return undefined;
    if (bytesRead > 4096) throw unavailable();
    const value: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
    return value as Record<string, unknown>;
  } finally { await file.close(); }
}

/**
 * Only for host-owned npm/probe and NSIS children whose stdin is unused. Never
 * wrap PID/IPC-bearing custodians or successors. Callers drain stdout/stderr with
 * their existing bounded consumers and retain this handle through dispose().
 * Windows 10+ JOB_LIST is mandatory: target creation and job assignment are one
 * kernel operation, including while the target's primary thread is suspended.
 */
export async function startWindowsUpdateJob(command: string, args: readonly string[], options: WindowsUpdateJobOptions): Promise<WindowsUpdateJob> {
  options.signal?.throwIfAborted();
  if (process.platform !== "win32") throw unavailable();
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1 || cleanupTimeoutMs > 60_000) throw unavailable();
  windowsUpdateCommandLine(command, args, options.windowsVerbatimArguments);
  const environment = environmentBlock(options.env);
  let directory: string | undefined;
  let native: Awaited<ReturnType<typeof powershellPath>>;
  let request: string;
  const nonce = randomBytes(32).toString("hex");
  try {
    native = await powershellPath();
    const target = await executable(command);
    const cwd = options.cwd === undefined ? process.cwd() : await realpath(options.cwd);
    if (!(await lstat(cwd)).isDirectory()) throw unavailable();
    options.signal?.throwIfAborted();
    directory = await mkdtemp(join(tmpdir(), "easyresearch-update-job-"));
    // Windows TEMP can use an 8.3 alias. Retain the actual created directory's
    // canonical identity for native ACLs, compiler files, receipts and cleanup.
    directory = await realpath(directory);
    request = JSON.stringify({ version: 1, nonce, directory, command: target,
      commandLine: windowsUpdateCommandLine(target, args, options.windowsVerbatimArguments), cwd, environment, cleanupTimeoutMs });
    if (Buffer.byteLength(request, "utf8") > 1024 * 1024) throw unavailable();
    options.signal?.throwIfAborted();
  } catch (error) {
    if (directory) await rm(directory, { recursive: true, force: true });
    if (options.signal?.aborted) options.signal.throwIfAborted();
    // Never attach raw filesystem/spawn errors that may include secret argv/env.
    throw unavailable();
  }
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(native.command, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(WINDOWS_UPDATE_JOB_BOOTSTRAP, "utf16le").toString("base64")], {
      windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"],
      // No caller credentials or PowerShell profile/module environment is needed
      // by the guard. The target receives its explicit environment block instead.
      env: { SystemRoot: native.systemRoot, WINDIR: native.systemRoot, PATH: win32.join(native.systemRoot, "System32"), TEMP: directory, TMP: directory },
    });
  } catch {
    await rm(directory, { recursive: true, force: true });
    throw unavailable();
  }
  return supervise(child, directory, nonce, request, cleanupTimeoutMs, options.signal);
}

function supervise(child: ChildProcessWithoutNullStreams, directory: string, nonce: string, request: string, cleanupTimeoutMs: number, signal?: AbortSignal): WindowsUpdateJob {
  let closed = false, exited = false, launched = false, cancelled = false, finished = false, safe = false;
  let receipt: Receipt | undefined;
  let failure: Error | undefined;
  let cleanupDeadline: number | undefined;
  let forcedAt: number | undefined;
  const startedAt = performance.now();
  const startupDeadline = startedAt + 30_000;
  let readyAt: number | undefined, receiptAt: number | undefined, exitedAt: number | undefined, closedAt: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let inspectionRevoked = false;
  let checking: Promise<void> | undefined;
  let inputTask = Promise.resolve();
  let inputQueuedBytes = 0, inputAcknowledgedBytes = 0, inputWritePending = false, startQueued = false;
  let inputPhase: "source" | "request" | "start" | "cancel" | undefined;
  const inputCompleted: Partial<Record<"source" | "request" | "start" | "cancel", number>> = {};
  let resolveCompletion!: (result: { code: number | null; signal: NodeJS.Signals | null }) => void;
  let rejectCompletion!: (error: Error) => void;
  const completed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; });
  // Diagnostic consumers receive only owned identity, phase/timing and fixed
  // status fields. Never attach argv, environment, nonce or raw system errors.
  const diagnostics = (phase: string) => ({
    phase, directory, guardPid: child.pid ?? null, guardExitCode: child.exitCode, guardSignal: child.signalCode,
    launched, cancelled, exited, closed, inspectionRevoked, custodySettled: safe,
    receiptVerified: receipt !== undefined, jobEmpty: receipt?.jobEmpty ?? null,
    rootPid: receipt?.rootPid ?? null, targetCode: receipt?.code ?? null,
    native: nativeDiagnostic(receipt?.diagnostics),
    elapsedMs: Math.round(performance.now() - startedAt),
    timing: { readyMs: readyAt, receiptMs: receiptAt, exitedMs: exitedAt, closedMs: closedAt,
      forcedMs: forcedAt === undefined ? undefined : Math.round(forcedAt - startedAt) },
    input: { phase: inputPhase, queuedBytes: inputQueuedBytes, acknowledgedBytes: inputAcknowledgedBytes,
      writePending: inputWritePending, startQueued, completedMs: { ...inputCompleted } },
  });
  const custodyError = () => Object.assign(unresolved(), { diagnostics: diagnostics(inspectionRevoked ? "deadline" : "settlement") });
  // Ownership starts at spawn, even if the caller has not attached its consumer.
  void completed.catch(() => {});
  const stopGuard = () => {
    if (!closed && child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGKILL"); } catch { /* Absence is never inferred here. */ }
    }
  };
  const inputWritable = () => !finished && !inspectionRevoked && !closed && !child.stdin.destroyed && !child.stdin.writableEnded;
  const writeChunk = (bytes: Buffer): Promise<boolean> => new Promise((resolve) => {
    if (!inputWritable()) { resolve(false); return; }
    let acknowledged = false, drained = false, returned = false, needsDrain = false, done = false;
    inputWritePending = true;
    const settle = (accepted: boolean) => {
      if (done) return;
      done = true; inputWritePending = false;
      child.stdin.removeListener("drain", onDrain);
      child.stdin.removeListener("close", onClose);
      child.stdin.removeListener("error", onError);
      if (accepted) inputAcknowledgedBytes += bytes.length;
      resolve(accepted);
    };
    const checkWrite = () => { if (returned && acknowledged && (!needsDrain || drained)) settle(true); };
    const onDrain = () => { drained = true; checkWrite(); };
    const onClose = () => settle(false);
    const onError = () => { settle(false); beginCancel(unavailable()); };
    child.stdin.on("drain", onDrain); child.stdin.once("close", onClose); child.stdin.once("error", onError);
    try {
      needsDrain = !child.stdin.write(bytes, (error) => {
        if (error) { onError(); return; }
        acknowledged = true; checkWrite();
      });
      returned = true; checkWrite();
    } catch { onError(); }
  });
  const send = (phase: "source" | "request" | "start" | "cancel", line: string) => {
    const bytes = Buffer.from(line, "utf8");
    inputQueuedBytes += bytes.length;
    inputTask = inputTask.then(async () => {
      if (!inputWritable() || (phase === "start" && cancelled)) return;
      inputPhase = phase;
      if (phase === "start") { launched = true; armDeadline(); }
      // Keep each write within a Windows pipe page, and join BOTH callback and
      // backpressure before issuing the next chunk. The two initialization
      // frames and later control frames must never overtake one another.
      for (let offset = 0; offset < bytes.length; offset += 4096) {
        if (!inputWritable() || !await writeChunk(bytes.subarray(offset, offset + 4096))) return;
      }
      inputCompleted[phase] = Math.round(performance.now() - startedAt);
    }).catch(() => beginCancel(unavailable()));
  };
  const beginCancel = (error?: Error) => {
    if (finished) return;
    failure ??= error;
    if (cancelled) return;
    cancelled = true;
    cleanupDeadline ??= performance.now() + cleanupTimeoutMs;
    armDeadline();
    send("cancel", `cancel:${nonce}\n`);
  };
  const onAbort = () => beginCancel();
  const finish = (error?: Error) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    clearTimeout(deadlineTimer);
    signal?.removeEventListener("abort", onAbort);
    if (error) rejectCompletion(Object.assign(error, { diagnostics: diagnostics(inspectionRevoked ? "deadline" : "settlement") }));
    else resolveCompletion({ code: receipt?.code ?? null, signal: null });
  };
  // Enforcement never awaits receipt/ready I/O. In particular, cancellation's
  // force-kill and terminal rejection cannot depend on an inspector returning.
  const enforceDeadline = () => {
    if (finished) return;
    const now = performance.now();
    if (!launched && !cancelled && now >= startupDeadline) beginCancel(unavailable());
    if (cleanupDeadline !== undefined && now >= cleanupDeadline) {
      if (forcedAt === undefined) {
        inspectionRevoked = true;
        clearTimeout(timer);
        forcedAt = now; stopGuard();
      }
      if (finished) return;
      if (closed) {
        // Only a receipt already fully read, nonce-checked and handle-closed
        // before expiration may prove settlement. A late read cannot repair it.
        if (receipt?.jobEmpty) {
          safe = true;
          finish(failure ?? (receipt.failure ? unavailable() : undefined));
        } else finish(custodyError());
        return;
      }
      if (now - forcedAt >= 2000) { finish(custodyError()); return; }
    }
    armDeadline();
  };
  const armDeadline = () => {
    clearTimeout(deadlineTimer);
    if (finished) return;
    const deadline = forcedAt !== undefined ? forcedAt + 2000 : cleanupDeadline ?? (!launched ? startupDeadline : undefined);
    if (deadline !== undefined) deadlineTimer = setTimeout(enforceDeadline, Math.max(0, deadline - performance.now()));
  };
  const validIdentity = (record: Record<string, unknown>) => record.version === 1 && record.nonce === nonce && record.guardPid === child.pid;
  const inspect = async () => {
    const observedTerminal = exited || closed;
    try {
      if (!receipt) {
        const record = await readRecord(join(directory, "receipt.json"), () => !finished && !inspectionRevoked);
        enforceDeadline();
        if (finished || inspectionRevoked) return;
        if (record) {
          const integer = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff;
          if (!validIdentity(record) || typeof record.jobEmpty !== "boolean" || !integer(record.rootPid) ||
            !(record.code === null || integer(record.code)) || (record.rootPid === 0) !== (record.code === null) ||
            !(record.failure === null || record.failure === "native-job-failed")) throw unavailable();
          receipt = record as unknown as Receipt;
          receiptAt = Math.round(performance.now() - startedAt);
          if (!receipt.jobEmpty) beginCancel(custodyError());
          else { cleanupDeadline ??= performance.now() + cleanupTimeoutMs; armDeadline(); }
        }
      }
      if (!receipt && !launched && !startQueued && !cancelled && !closed && !exited) {
        const ready = await readRecord(join(directory, "ready.json"), () => !finished && !inspectionRevoked);
        enforceDeadline();
        if (finished || inspectionRevoked) return;
        if (ready) {
          if (!validIdentity(ready)) throw unavailable();
          readyAt = Math.round(performance.now() - startedAt);
          // Abort can arrive during either filesystem await. Recheck immediately
          // before the sole authorization to create/resume a target.
          if (!cancelled && !signal?.aborted && !closed && !exited) {
            startQueued = true; send("start", `start:${nonce}\n`);
          }
        }
      }
    } catch { if (!finished && !inspectionRevoked) beginCancel(unavailable()); }
    if (finished || inspectionRevoked) return;
    // An ENOENT sampled before the guard's final publication can finish after
    // its exit event. A terminal decision needs a read begun after that event.
    if ((exited || closed) && !observedTerminal) return;
    if (closed) {
      // A forced guard death (even during Add-Type) is not a positive settlement
      // receipt. A normal bootstrap failure before authorization cannot have
      // created a target; an OS spawn failure cannot have created a guard.
      safe = Boolean(receipt?.jobEmpty) || (!launched && (!child.pid ||
        (forcedAt === undefined && child.signalCode === null && child.exitCode === 70)));
      if (!safe) finish(custodyError());
      else if (failure || receipt?.failure || (!receipt && !cancelled)) finish(failure ?? unavailable());
      else finish();
      return;
    }
    // A target may retain inherited pipes after the guard exits, so waiting only
    // for ChildProcess.close could hide loss of custody forever. An exited guard
    // cannot publish new evidence. Retain the files and reject without claiming
    // that kill-on-close has synchronously settled the job.
    if (exited && !receipt?.jobEmpty && (launched || child.signalCode !== null || child.exitCode !== 70)) {
      finish(custodyError()); return;
    }
  };
  const check = (): Promise<void> => {
    if (finished || inspectionRevoked) return Promise.resolve();
    if (checking) return checking;
    clearTimeout(timer);
    checking = inspect().finally(() => {
      checking = undefined;
      if (!finished && !inspectionRevoked) timer = setTimeout(() => { void check(); }, 25);
    });
    return checking;
  };
  child.on("error", () => beginCancel(unavailable()));
  child.stdin.on("error", () => beginCancel(unavailable()));
  const terminalChanged = () => {
    if (finished) return;
    cleanupDeadline ??= performance.now() + cleanupTimeoutMs;
    if (forcedAt !== undefined) enforceDeadline();
    else { armDeadline(); void check(); }
  };
  child.once("exit", () => { exited = true; exitedAt = Math.round(performance.now() - startedAt); terminalChanged(); });
  child.once("close", () => { closed = true; closedAt = Math.round(performance.now() - startedAt); terminalChanged(); });
  signal?.addEventListener("abort", onAbort, { once: true });
  // Fixed compiler input and UTF-8 data, never interpolation into executable code.
  send("source", `${Buffer.from(WINDOWS_UPDATE_JOB_SOURCE, "utf8").toString("base64")}\n`);
  send("request", `${request}\n`);
  if (signal?.aborted) onAbort();
  armDeadline();
  void check();
  const cancel = async () => {
    if (!finished) beginCancel();
    await completed.catch(() => {});
    // Do not join a stalled inspector after the independently bounded outcome.
    // Its finalizer still closes any handle acquired after cancellation.
    if (!safe) throw custodyError();
  };
  let disposal: Promise<void> | undefined;
  return {
    child, completed, cancel,
    dispose() {
      disposal ??= (async () => {
        await cancel();
        try { await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
        catch (error) { throw Object.assign(new Error("Windows update helper cleanup is incomplete."), {
          custodyUnresolved: true as const,
          diagnostics: { ...diagnostics("cleanup"), ...filesystemDiagnostic(error, directory) },
        }); }
      })().catch((error: unknown) => { disposal = undefined; throw error; });
      return disposal;
    },
  };
}
