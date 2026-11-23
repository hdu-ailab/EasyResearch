import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { connect, type Socket } from "node:net";
import { readFileSync } from "node:fs";
import type { ShellProcess, ShellProcessInput } from "./process";
import type { ShellResult } from "./types";
import { receive, send, type WorkerHandoff, type WorkerInit, type WorkerMessage, type WorkerRegistration } from "./worker-protocol";

export class ShellWorkerUnavailable extends Error {}
export interface WorkerProcess extends ShellProcess {
  registration: WorkerRegistration;
  readonly result?: ShellResult;
  prepare(): Promise<WorkerHandoff>;
  detach(): Promise<void>;
  release(): Promise<void>;
}
export function readWorkerResult(registration: WorkerRegistration): ShellResult | undefined {
  try {
    const result = JSON.parse(readFileSync(registration.resultPath, "utf8")) as { version: number; token: string; result: ShellResult };
    return result.version === 1 && result.token === registration.token ? result.result : undefined;
  } catch { return undefined; }
}

async function connection(registration: WorkerRegistration, ticket?: string, child?: ChildProcess, cancelled?: () => boolean): Promise<WorkerProcess> {
  const socket: Socket = connect({ host: "127.0.0.1", port: registration.port });
  socket.setNoDelay(true);
  let sequence = 0;
  let detached = false;
  let outcome: ShellResult | undefined;
  let releasing: Promise<void> | undefined;
  let complete!: (result: ShellResult) => void;
  const done = new Promise<ShellResult>((resolve) => { complete = resolve; });
  const pending = new Map<number, { resolve(message: WorkerMessage): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const finish = (result: ShellResult) => { outcome = result; complete(result); };
  receive(socket, (message) => {
    if (message.result) finish(message.result);
    if (message.id === undefined) return;
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    clearTimeout(waiting.timer);
    if (message.error) waiting.reject(new Error(message.error));
    else waiting.resolve(message);
  });
  socket.on("error", () => {});
  socket.on("close", () => {
    for (const waiting of pending.values()) { clearTimeout(waiting.timer); waiting.reject(new Error("Shell worker connection lost; command admission may have succeeded.")); }
    pending.clear();
    if (detached || outcome) return;
    // Never respawn after connection loss. The worker owns cleanup on owner EOF.
    const result = readWorkerResult(registration);
    finish(result ?? { output: "Shell worker custody was lost.", killed: "Shell worker custody was lost.", status: "error", truncated: false, exitCode: null, wallTimeSeconds: 0 });
  });
  const request = (op: WorkerMessage["op"], extra?: Partial<WorkerMessage>): Promise<WorkerMessage> => new Promise((resolve, reject) => {
    if (socket.destroyed) { reject(new Error("Shell worker is disconnected.")); return; }
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("Shell worker response timed out; command admission may have succeeded.")); socket.destroy(); }, 10_000);
    pending.set(id, { resolve, reject, timer });
    send(socket, { id, op, token: registration.token, ...extra });
  });
  try {
    const attached = await request("attach", ticket ? { ticket } : undefined);
    if (!ticket && cancelled?.()) {
      await request("release");
      throw new Error("Command interrupted before it started.");
    }
    const started = ticket ? attached : await request("start");
    return {
      registration, pid: started.pid, done,
      get result() { return outcome; },
      async stop() { if (!outcome) await request("cancel"); await done; },
      async prepare() { const response = await request("prepare"); if (!response.handoff) throw new Error("Shell worker did not prepare custody."); return response.handoff; },
      async detach() {
        detached = true;
        try { await request("detach"); } catch (error) { detached = false; throw error; }
        socket.end();
        child?.stdout?.destroy();
        child?.stderr?.destroy();
        child?.unref();
      },
      release() {
        releasing ??= (async () => {
          if (!socket.destroyed && !detached) {
            try { await request("release"); } catch (error) {
              // Revocation may close the worker concurrently after its durable
              // terminal result. No command remains to cancel in that case.
              if (!outcome) throw error;
            }
          }
          socket.end();
          if (!socket.destroyed) await new Promise<void>((resolve) => socket.once("close", resolve));
          if (child && child.exitCode === null && child.signalCode === null) await new Promise<void>((resolve) => { child.once("close", resolve); });
        })();
        return releasing;
      },
    };
  } catch (error) {
    socket.destroy();
    // The spawned worker owns cancellation on EOF. Keep its cleanup owned even
    // when an admission response was lost; no local fallback is safe here.
    if (child && child.pid && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => { child.once("close", resolve); });
    }
    throw error;
  }
}

export async function launchShellWorker(executable: string, args: string[], input: ShellProcessInput, resultPath: string, cancelled?: () => boolean): Promise<WorkerProcess> {
  const token = randomBytes(32).toString("hex");
  const child = spawn(executable, args, { env: input.env, detached: process.platform !== "win32", windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
  child.stdin!.on("error", () => {});
  child.stdin!.end(JSON.stringify({ version: 1, token, input, resultPath } satisfies WorkerInit));
  let registration: WorkerRegistration;
  try {
    registration = await new Promise<WorkerRegistration>((resolve, reject) => {
      let text = "";
      const fail = (error: Error) => { clearTimeout(timer); reject(new ShellWorkerUnavailable(error.message)); };
      const timer = setTimeout(() => { child.kill("SIGKILL"); fail(new Error("Shell worker startup timed out.")); }, 10_000);
      child.once("error", fail);
      child.once("exit", () => fail(new Error(`Shell worker exited before admission. ${stderr}`)));
      child.stdout!.on("data", (chunk: Buffer) => {
        text += chunk.toString();
        if (text.length > 4096) { child.kill("SIGKILL"); fail(new Error("Invalid shell worker startup.")); return; }
        if (!text.includes("\n")) return;
        try {
          const ready = JSON.parse(text.slice(0, text.indexOf("\n"))) as { version: number; port: number; workerPID: number };
          if (ready.version !== 1 || !Number.isInteger(ready.port) || ready.port < 1 || ready.port > 65535 || ready.workerPID !== child.pid) throw new Error("Invalid shell worker registration.");
          clearTimeout(timer);
          resolve({ port: ready.port, workerPID: ready.workerPID, token, resultPath });
        } catch (error) { child.kill("SIGKILL"); fail(error as Error); }
      });
    });
  } catch (error) {
    // Nothing can execute until authenticated start; only this failure permits fallback.
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => { child.once("close", resolve); });
    }
    throw error;
  }
  return connection(registration, undefined, child, cancelled);
}
export function adoptShellWorker(registration: WorkerRegistration, handoff: WorkerHandoff): Promise<WorkerProcess> {
  if (handoff.expiresAt <= Date.now()) throw new Error("Shell worker handoff expired.");
  return connection(registration, handoff.ticket);
}

/** A prepared transition retains explicit terminal-cancellation authority after detach. */
export function revokeShellWorker(registration: WorkerRegistration, handoff: WorkerHandoff): Promise<ShellResult> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: registration.port });
    let result: ShellResult | undefined;
    let error: Error | undefined;
    const timer = setTimeout(() => { error = new Error("Shell handoff revocation did not settle."); socket.destroy(); }, 10_000);
    socket.on("error", (failure) => { error = failure; });
    receive(socket, (message) => {
      if (message.error) { error = new Error(message.error); socket.destroy(); return; }
      if (message.result) result = message.result;
    });
    socket.on("connect", () => send(socket, { id: 1, op: "revoke", token: registration.token, ticket: handoff.ticket }));
    socket.on("close", () => {
      clearTimeout(timer);
      result ??= readWorkerResult(registration);
      if (result) resolve(result);
      else reject(error ?? new Error("Shell handoff revocation lost custody."));
    });
  });
}
