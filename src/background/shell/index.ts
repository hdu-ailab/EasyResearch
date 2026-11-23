import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BackgroundTask } from "../contracts";
import { shellEnvironment, startShellProcess, type ShellProcess } from "./process";
import { backgroundResult, shellNotification } from "./result";
import { captureIncompleteOutput, writeRecord } from "./storage";
import { adoptShellWorker, launchShellWorker, readWorkerResult, revokeShellWorker, ShellWorkerUnavailable, type WorkerProcess } from "./worker-client";
import type { WorkerHandoff, WorkerRegistration } from "./worker-protocol";
import { startRemoteOperation } from "./remote";
import { scheduleShellTimeout } from "./timer";
import type { ManagedRemoteOperation, ManagedShellService, RecoveredShellCall, ShellCallContext, ShellInput, ShellManagerOptions, ShellOwner, ShellRecoveryOptions, ShellResult } from "./types";

export type { ManagedRemoteOperation, ManagedShellService, RecoveredShellCall, ShellCallContext, ShellInput, ShellManagerOptions, ShellNotification, ShellOwner, ShellRecoveryOptions, ShellResult } from "./types";
export { BACKGROUND_INSTRUCTION, resultContent } from "./result";

// Match the reviewed reference's bounded, first-consumption-ordered history.
const CONSUMED_HISTORY_LIMIT = 25;

interface RecordData {
  version: 1;
  id: string;
  rootSessionID: string;
  sessionID: string;
  cwd: string;
  /** Remote working directory, interpreted only by the injected transport. */
  workdir?: string;
  command: string;
  file: string;
  started: number;
  notificationID: string;
  background: boolean;
  pending: boolean;
  notificationWake?: boolean;
  pid?: number;
  result?: ShellResult;
  worker?: WorkerRegistration;
  handoff?: WorkerHandoff;
  owner: { pid: number; instanceID: string; rootSessionID: string };
  toolCallID?: string;
  toolName?: ShellCallContext["toolName"];
  assistantEntryId?: string;
  foreground?: boolean;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
interface Active {
  record: RecordData;
  process?: ShellProcess;
  worker?: WorkerProcess;
  ready: ReturnType<typeof deferred<void>>;
  done: ReturnType<typeof deferred<ShellResult>>;
  promoted: ReturnType<typeof deferred<void>>;
  cancelled: ReturnType<typeof deferred<void>>;
  cancelRequested: boolean;
  starting?: Promise<void>;
  cancelling?: Promise<void>;
  callReleased?: boolean;
  cleanupComplete?: boolean;
  consumed?: boolean;
  delivering?: Promise<void>;
  settling?: Promise<void>;
  detaching?: Promise<void>;
  handedOff?: boolean;
  revoked?: boolean;
}

/** One instance per native root. All descendant owners attach to that same instance. */
export function createManagedShellManager(options: ShellManagerOptions): ManagedShellService {
  return new ShellManager(options);
}

class ShellManager implements ManagedShellService {
  private readonly directory: string;
  private readonly jobs = new Map<string, Active>();
  private readonly owners = new Map<string, ShellOwner>();
  private readonly listeners = new Set<() => void>();
  private readonly instanceID = randomUUID();
  // Keep recovery identities, not another unbounded copy of historical outputs.
  private readonly repairs: (Omit<RecoveredShellCall, "result"> & { shellID: string })[] = [];
  private closing = false;
  private handoffPreparing = false;
  private handoffRevoked = false;
  private disposed = false;
  private revoking?: Promise<void>;

  constructor(private readonly options: ShellManagerOptions) {
    this.directory = resolve(options.agentDir, "background", "shell", createHash("sha256").update(options.rootSessionID).digest("hex"));
  }
  private error(error: unknown) {
    try { this.options.onError?.(error); } catch { /* Diagnostics cannot release process ownership. */ }
  }
  private emit() {
    for (const listener of this.listeners) {
      try { listener(); } catch (error) { this.error(error); }
    }
  }
  private persist(job: Active) { writeRecord(join(this.directory, `${job.record.id}.json`), job.record); }
  private active(record: RecordData): Active {
    return { record, ready: deferred<void>(), done: deferred<ShellResult>(), promoted: deferred<void>(), cancelled: deferred<void>(), cancelRequested: false };
  }
  private pruneConsumed(): void {
    for (const [id, job] of [...this.jobs]) {
      if (job.consumed || !job.cleanupComplete || !job.callReleased || !job.record.result
        || job.record.pending || job.delivering || job.record.handoff || job.detaching || job.handedOff) continue;
      job.consumed = true;
      this.jobs.delete(id);
      this.jobs.set(id, job);
    }
    const consumed = [...this.jobs].filter(([, job]) => job.consumed);
    const expired = consumed.slice(0, -CONSUMED_HISTORY_LIMIT);
    for (const [id] of expired) this.jobs.delete(id);
    if (expired.length) this.emit();
  }
  attachOwner(owner: ShellOwner): () => void {
    if (this.disposed) throw new Error("Shell manager is disposed.");
    this.owners.set(owner.sessionID, owner);
    for (const job of this.jobs.values()) if (job.record.sessionID === owner.sessionID) void this.deliver(job);
    return () => { if (this.owners.get(owner.sessionID) === owner) this.owners.delete(owner.sessionID); };
  }
  detachOwner(sessionID: string) { this.owners.delete(sessionID); }
  async flushNotifications(sessionID?: string): Promise<void> {
    await Promise.all([...this.jobs.values()].filter((job) => !sessionID || job.record.sessionID === sessionID).map((job) => this.deliver(job)));
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  tasks(): BackgroundTask[] {
    return [...this.jobs.values()].map(({ record: r, callReleased }) => ({
      id: r.id, kind: "shell", sessionID: r.sessionID, description: r.command,
      status: r.result?.status === "running" ? "running" : r.result?.status ?? "running",
      blocking: !r.background && !r.result && !callReleased, shellID: r.id, command: r.command,
      ...(r.pid ? { pid: r.pid } : {}), outputPath: r.file, startedAt: r.started,
    }));
  }
  list(sessionID?: string) { return this.tasks().filter((task) => !sessionID || task.sessionID === sessionID); }
  blocking(sessionID: string) { return this.list(sessionID).filter((task) => task.blocking); }
  hasWork(sessionID?: string, descendants: readonly string[] = []): boolean {
    return [...this.jobs.values()].some(({ record: r }) =>
      (!sessionID || r.sessionID === sessionID || descendants.includes(r.sessionID)) && (!r.result || r.pending));
  }
  private deliver(job: Active): Promise<void> {
    if (job.delivering) return job.delivering;
    const owner = this.owners.get(job.record.sessionID);
    if (!owner || !job.record.pending || !job.record.result || this.disposed || this.closing) return Promise.resolve();
    // Store pending before entering user code, and retain it on every admission failure.
    job.delivering = Promise.resolve().then(async () => {
      await owner.notify(shellNotification(job.record, job.record.result!));
      const acknowledged = { ...job.record, pending: false };
      writeRecord(join(this.directory, `${job.record.id}.json`), acknowledged);
      job.record = acknowledged;
      this.emit();
    }).catch((error) => { this.error(error); }).finally(() => {
      job.delivering = undefined;
      this.pruneConsumed();
      if (this.owners.get(job.record.sessionID) !== owner) void this.deliver(job);
    });
    return job.delivering;
  }
  private settle(job: Active, result: ShellResult): Promise<void> {
    if (job.settling) return job.settling;
    job.settling = Promise.resolve().then(async () => {
      // Detach can be acknowledged by the worker before its reply reaches us.
      // From that boundary onward only recovery/revocation may publish the record.
      if (job.detaching || job.handedOff) { job.done.resolve(result); return; }
      job.record.result = result;
      job.record.pending = job.record.background;
      try {
        this.persist(job);
        job.done.resolve(result);
        this.emit();
        // Notification admission can wait on the recipient's model/compaction
        // state. Keep it owned by job.delivering, never by process settlement:
        // handoff/cancel join custody; disposal separately joins delivery.
        void this.deliver(job);
      } finally {
        if (job.worker && !job.record.handoff) await job.worker.release();
      }
    }).then(() => {
      if (!job.record.handoff && !job.detaching && !job.handedOff) {
        job.cleanupComplete = true;
        job.process = undefined;
        job.worker = undefined;
        this.pruneConsumed();
      }
    });
    // Keep the owned settlement rejected for disposal, without an unhandled promise.
    void job.settling.catch((error) => { this.error(error); job.done.resolve({ ...result, status: "error", killed: "Unable to persist shell completion." }); });
    return job.settling;
  }
  private move(job: Active): void {
    if (job.cancelRequested || job.record.background || job.record.result) return;
    job.record.background = true;
    this.persist(job);
    job.promoted.resolve();
    this.emit();
  }
  async promote(sessionID: string): Promise<void> {
    for (const job of this.jobs.values()) if (job.record.sessionID === sessionID) this.move(job);
  }
  private async interruptedCall(job: Active): Promise<ShellResult> {
    // The tool response is not command settlement. The manager retains both the
    // process completion and cancellation promises until actual cleanup finishes.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        job.done.promise,
        new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 500); }),
      ]);
      if (result) return result.status === "cancelled" ? { ...result, shellID: job.record.id, outputPath: job.record.file } : result;
      return {
        ...captureIncompleteOutput(job.record.file, "the command is still being stopped."),
        status: "cancelled", exitCode: null, shellID: job.record.id, pid: job.record.pid,
        wallTimeSeconds: (Date.now() - job.record.started) / 1000,
        stopping: true,
      };
    } finally {
      if (timer) clearTimeout(timer);
      job.callReleased = true;
      this.emit();
    }
  }
  execute(sessionID: string, input: ShellInput, signal?: AbortSignal, context?: ShellCallContext): Promise<ShellResult> {
    return this.executeOwned(sessionID, input, signal, undefined, context);
  }
  executeRemote(sessionID: string, input: ShellInput, operation: ManagedRemoteOperation, signal?: AbortSignal, context?: ShellCallContext): Promise<ShellResult> {
    return this.executeOwned(sessionID, input, signal, operation, context);
  }
  private async executeOwned(sessionID: string, input: ShellInput, signal?: AbortSignal, remote?: ManagedRemoteOperation, context?: ShellCallContext): Promise<ShellResult> {
    if (this.closing) throw new Error("Shell manager is closing.");
    const owner = this.owners.get(sessionID);
    if (!owner) throw new Error("Shell owner is not attached.");
    if (!input.command.trim()) throw new Error("Shell command must not be empty.");
    if (input.timeout !== undefined && (!Number.isSafeInteger(input.timeout) || input.timeout < 0)) throw new Error("Shell timeout must be a nonnegative safe integer in milliseconds.");
    signal?.throwIfAborted();
    const cwd = remote ? owner.cwd : resolve(owner.cwd, input.workdir ?? ".");
    if (!remote && !statSync(cwd).isDirectory()) throw new Error(`Working directory is not a directory: ${cwd}`);
    const id = `shell_${randomUUID()}`;
    const toolName = context?.toolName ?? (remote ? undefined : "shell");
    const job = this.active({
      version: 1, id, rootSessionID: this.options.rootSessionID, sessionID, cwd,
      command: input.command, file: join(this.directory, `${id}.out`), started: Date.now(),
      notificationID: `shell-result:${id}`, background: input.background === true, pending: false,
      owner: { pid: process.pid, instanceID: this.instanceID, rootSessionID: this.options.rootSessionID },
      ...(remote && input.workdir !== undefined ? { workdir: input.workdir } : {}),
      ...(toolName ? { toolName } : {}),
      ...(context ? { toolCallID: context.toolCallID, foreground: !input.background } : {}),
      ...(context?.assistantEntryId ? { assistantEntryId: context.assistantEntryId } : {}),
    });
    this.persist(job); // Admission precedes all process side effects.
    this.jobs.set(id, job);
    const abort = () => { void this.cancel(id).catch((error) => this.error(error)); };
    signal?.addEventListener("abort", abort, { once: true });
    this.emit();
    let cancelWaitTimer: (() => void) | undefined;
    try {
      job.starting = (async () => { try {
        if (remote) job.process = startRemoteOperation(input, job.record.file, remote);
        else {
        const shell = owner.shell?.();
        const processInput = {
          command: shell?.commandPrefix ? `${shell.commandPrefix}\n${input.command}` : input.command, cwd, file: job.record.file,
          env: shellEnvironment(this.options.environment ?? process.env, sessionID),
          shellPath: shell?.path ?? this.options.shellPath, timeout: input.background ? input.timeout ?? 0 : 0,
        };
        const worker = this.options.worker ?? (typeof Bun !== "undefined" ? {
          executable: process.execPath,
          args: Bun.embeddedFiles?.length ? ["--shell-worker"] : [fileURLToPath(new URL("../../cli/index.ts", import.meta.url)), "--shell-worker"],
        } : false);
        if (worker) {
          try {
            job.worker = await launchShellWorker(worker.executable, worker.args, processInput, join(this.directory, `${id}.result`), () => job.cancelRequested || signal?.aborted === true || (this.closing && !this.handoffPreparing));
            job.record.worker = job.worker.registration;
            job.process = job.worker;
          } catch (error) {
            if (!(error instanceof ShellWorkerUnavailable)) throw error;
            this.error(error);
          }
        }
        if (!job.process) {
          if (job.cancelRequested || signal?.aborted || (this.closing && !this.handoffPreparing)) throw new Error("Command interrupted before it started.");
          job.process = startShellProcess(processInput);
        }
        }
        job.record.pid = job.process.pid;
        this.persist(job);
        void job.process.done.then(
          (result) => this.settle(job, result),
          (error) => this.settle(job, { output: "", exitCode: null, status: "error", truncated: false, wallTimeSeconds: (Date.now() - job.record.started) / 1000, killed: error instanceof Error ? error.message : String(error) }),
        ).catch((error) => this.error(error));
      } catch (error) {
        await job.process?.stop();
        await this.settle(job, { output: "", exitCode: null, status: job.cancelRequested || signal?.aborted ? "cancelled" : "error", truncated: false, wallTimeSeconds: 0, killed: error instanceof Error ? error.message : String(error) });
      } finally { job.ready.resolve(); } })();
      // Admission keeps custody even when its reply outlives the interrupted
      // foreground call. Disposal/cancellation join ready before touching it.
      void job.starting.catch((error) => this.error(error));
      await Promise.race([job.starting, job.cancelled.promise]);
      if (job.cancelRequested || signal?.aborted || (this.closing && !this.handoffPreparing)) {
        abort();
        return await this.interruptedCall(job);
      }
      if (job.record.result?.status === "error") return job.record.result;
      if (input.background) return backgroundResult(job.record);
      const foreground = input.timeout || 120_000;
      let timedOut = false;
      cancelWaitTimer = scheduleShellTimeout(foreground, () => {
        timedOut = true;
        try { this.move(job); } catch (error) { this.error(error); abort(); }
      });
      const outcome = await Promise.race([
        job.done.promise.then((result) => ({ kind: "done" as const, result })),
        job.promoted.promise.then(() => ({ kind: "promoted" as const })),
        job.cancelled.promise.then(() => ({ kind: "cancelled" as const })),
      ]);
      if (job.cancelRequested) return await this.interruptedCall(job);
      return outcome.kind === "done" ? outcome.result : backgroundResult(job.record, timedOut ? foreground : undefined);
    } finally {
      cancelWaitTimer?.();
      signal?.removeEventListener("abort", abort);
      job.callReleased = true;
      this.pruneConsumed();
    }
  }
  async cancel(taskID: string): Promise<void> {
    const job = this.jobs.get(taskID);
    if (!job) throw new Error("Unknown shell task.");
    job.cancelRequested = true;
    job.cancelled.resolve();
    job.cancelling ??= (async () => {
      await job.ready.promise;
      await job.process?.stop();
      await job.done.promise;
      await job.settling;
    })();
    return job.cancelling;
  }
  async recover(options: ShellRecoveryOptions): Promise<void> {
    if (this.jobs.size) throw new Error("Shell recovery must precede new execution.");
    let files: string[];
    try { files = readdirSync(this.directory); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const file of files.filter((name) => /^shell_[\da-f-]+\.json$/.test(name))) {
      const record = JSON.parse(readFileSync(join(this.directory, file), "utf8")) as RecordData;
      if (record.version !== 1 || record.rootSessionID !== this.options.rootSessionID || `${record.id}.json` !== file || record.file !== join(this.directory, `${record.id}.out`)
        || (record.toolName !== undefined && record.toolName !== "shell" && record.toolName !== "ssh-bash")
        || record.owner?.rootSessionID !== this.options.rootSessionID || !Number.isSafeInteger(record.owner.pid) || record.owner.pid <= 0 || typeof record.owner.instanceID !== "string" || !record.owner.instanceID
        || (record.result && (!["completed", "cancelled", "error"].includes(record.result.status) || typeof record.result.output !== "string"
          || (record.result.exitCode !== null && !Number.isFinite(record.result.exitCode))))
        || (record.worker && (record.worker.resultPath !== join(this.directory, `${record.id}.result`) || !/^[a-f0-9]{64}$/.test(record.worker.token)
          || !Number.isInteger(record.worker.port) || record.worker.port < 1 || record.worker.port > 65535))
        || (record.handoff && (!/^[a-f0-9]{64}$/.test(record.handoff.ticket) || !Number.isFinite(record.handoff.expiresAt)))) throw new Error("Invalid shell recovery record.");
      const priorVerified = await options.verifyPriorOwner(record.owner);
      const prepared = record.worker && record.handoff && record.handoff.expiresAt > Date.now();
      // A durable terminal result carries no command execution custody. During a
      // host-authorized transition its history/outbox may be read even when the
      // predecessor is still waiting for us; unfinished work needs actual adoption.
      if (!priorVerified && (!options.allowPreparedHandoff || (!record.result && !prepared))) {
        throw new Error("Prior shell owner has not been verified.");
      }
      const job = this.active(record);
      job.callReleased = true;
      job.ready.resolve();
      let recovered = false;
      if (record.worker && record.handoff && prepared) {
        try {
          job.worker = await adoptShellWorker(record.worker, record.handoff);
          job.process = job.worker;
          this.jobs.set(record.id, job);
          record.owner = { pid: process.pid, instanceID: this.instanceID, rootSessionID: this.options.rootSessionID };
          delete record.handoff;
          record.background = true;
          record.notificationWake = !job.worker.result;
          this.persist(job);
          if (job.worker.result) await this.settle(job, job.worker.result);
          else void job.worker.done.then((result) => this.settle(job, result)).catch((error) => this.error(error));
          recovered = true;
        } catch (error) {
          this.error(error);
          if (!priorVerified && !record.result) throw new Error("Prior shell owner has not been verified and prepared custody could not be authenticated.", { cause: error });
        }
      }
      if (!recovered) {
        this.jobs.set(record.id, job);
        record.notificationWake = false;
        if (record.result) {
          this.persist(job);
          job.done.resolve(record.result);
          job.cleanupComplete = !record.handoff;
          await this.deliver(job);
        }
        else {
          record.background = true;
          const result = record.worker ? readWorkerResult(record.worker) : undefined;
          const lost = record.toolName === "ssh-bash" ? "Remote shell connection custody was lost during server restart." : "Shell process custody was lost during server restart.";
          await this.settle(job, result ?? { output: lost, killed: lost, status: "error", exitCode: null, truncated: false, wallTimeSeconds: (Date.now() - record.started) / 1000, outputPath: record.file });
        }
      }
      if (record.foreground && record.toolCallID) {
        this.repairs.push({ sessionID: record.sessionID, toolCallID: record.toolCallID, shellID: record.id,
          ...(record.toolName ? { toolName: record.toolName } : {}),
          ...(record.assistantEntryId ? { assistantEntryId: record.assistantEntryId } : {}),
        });
      }
      this.pruneConsumed();
    }
    this.emit();
  }
  recoveredCalls(): RecoveredShellCall[] {
    return this.repairs.map(({ shellID, ...repair }) => {
      const record = this.jobs.get(shellID)?.record ?? JSON.parse(readFileSync(join(this.directory, `${shellID}.json`), "utf8")) as RecordData;
      if (record.id !== shellID || record.rootSessionID !== this.options.rootSessionID || record.sessionID !== repair.sessionID
        || record.toolCallID !== repair.toolCallID || record.toolName !== repair.toolName || record.assistantEntryId !== repair.assistantEntryId) throw new Error("Shell recovery identity changed.");
      return { ...repair, result: { ...(record.result ?? backgroundResult(record)) } };
    });
  }
  async prepareHandoff(): Promise<void> {
    if (this.handoffRevoked) throw new Error("Shell handoff was revoked by terminal shutdown.");
    this.closing = true;
    this.handoffPreparing = true;
    await Promise.all([...this.jobs.values()].map(async (job) => {
      await job.ready.promise;
      if (job.record.result) { await job.settling; return; }
      if (job.cancelRequested) { await this.cancel(job.record.id); return; }
      if (!job.worker) { await this.cancel(job.record.id); return; }
      try { job.record.handoff = await job.worker.prepare(); } catch (error) {
        if (job.record.result) { await job.settling; return; }
        throw error;
      }
      if (this.handoffRevoked) {
        await job.worker.stop();
        await job.worker.release();
        delete job.record.handoff;
        this.persist(job);
        return;
      }
      this.move(job);
      this.persist(job);
    }));
  }
  revokeHandoff(): Promise<void> {
    if (this.revoking) return this.revoking;
    this.closing = true;
    this.handoffPreparing = false;
    this.handoffRevoked = true;
    this.revoking = (async () => {
      const results = await Promise.allSettled([...this.jobs.values()].map(async (job) => {
        await job.ready.promise;
        const { worker, handoff } = job.record;
        if (!worker || !handoff) {
          if (!job.detaching && !job.handedOff && !job.record.result) await this.cancel(job.record.id);
          if (!job.detaching && !job.handedOff && job.worker) await job.worker.release();
          return;
        }
        // Prepared custody is revocable through its ticket even while detach's
        // acknowledgement is in flight, and after a successor has adopted it.
        const result = await revokeShellWorker(worker, handoff);
        await job.settling;
        const path = join(this.directory, `${job.record.id}.json`);
        const latest = JSON.parse(readFileSync(path, "utf8")) as RecordData;
        // A successor may already own and settle this record. Never overwrite its
        // admission acknowledgement or ownership with the predecessor's snapshot.
        if (latest.handoff?.ticket === handoff.ticket) {
          delete latest.handoff;
          latest.result = result;
          latest.pending = latest.background;
          writeRecord(path, latest);
        }
        delete job.record.handoff;
        job.record.result = result;
        job.done.resolve(result);
        job.revoked = true;
        if (job.worker) await job.worker.release();
      }));
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (errors.length) throw new AggregateError(errors.map((result) => result.reason), "Shell handoff revocation failed.");
    })().finally(() => { this.revoking = undefined; });
    return this.revoking;
  }
  async dispose(options?: { handoff?: boolean }): Promise<void> {
    if (this.disposed) return;
    this.closing = true;
    if (!options?.handoff) this.handoffPreparing = false;
    const results = await Promise.allSettled([...this.jobs.values()].map(async (job) => {
      await job.ready.promise;
      if (options?.handoff && !this.handoffRevoked && job.worker && job.record.handoff && job.record.handoff.expiresAt > Date.now()) {
        job.detaching ??= job.worker.detach().then(() => { job.handedOff = true; });
        try { await job.detaching; } catch (error) {
          // A successful authenticated revoke can close this connection before
          // detach replies. It is the terminal authority, not an orphaned detach.
          if (this.revoking) await this.revoking;
          else if (!job.revoked) throw error;
        }
        if (this.revoking) await this.revoking;
        return;
      }
      try {
        if (!job.record.result) await this.cancel(job.record.id);
        await job.settling;
        await job.delivering;
      } finally { if (job.worker) await job.worker.release(); }
    }));
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (errors.length) throw new AggregateError(errors.map((result) => result.reason), "Shell cleanup failed.");
    this.disposed = true;
    this.listeners.clear();
    this.owners.clear();
  }
}
