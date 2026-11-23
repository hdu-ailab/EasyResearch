import { Client } from "ssh2";
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { SshExecutionRequest, SshExecutionResult } from "./runtime";

const MAX_OUTPUT_BYTES = 256 * 1024;
const TERM_GRACE_MS = 250;
const CLEANUP_LIMIT_MS = 1_000;

interface EventSourceLike {
  on(event: string, listener: (...args: any[]) => void): this;
}

export interface SshCommandStreamLike extends EventSourceLike {
  stderr: EventSourceLike;
  signal(name: string): void;
  close(): void;
  destroy(): void;
}

export interface SshClientLike extends EventSourceLike {
  connect(options: Record<string, unknown>): void;
  exec(command: string, callback: (error: Error | undefined, stream?: SshCommandStreamLike) => void): void;
  end(): void;
  destroy(): void;
}

export interface SshExecutorDependencies {
  createClient?: () => SshClientLike;
}

function abortError(): Error {
  const error = new Error("ssh-bash operation aborted; remote descendants may outlive the closed SSH channel");
  error.name = "AbortError";
  return error;
}

/** Only this transport-owned cancellation may be converted to manager timeout/cancel semantics. */
export class SshOperationAbortedError extends Error {
  constructor(readonly outcome: { exitCode: number | null; signal?: string }) {
    super(abortError().message);
    this.name = "AbortError";
  }
}

export function createSshExecutor(deps: SshExecutorDependencies = {}) {
  const createClient = deps.createClient ?? (() => new Client() as unknown as SshClientLike);
  return (request: SshExecutionRequest): Promise<SshExecutionResult> => new Promise((resolve, reject) => {
    const client = createClient();
    let stream: SshCommandStreamLike | undefined;
    let settled = false;
    let finishing = false;
    let execPending = false;
    let aborting = false;
    let failure: Error | undefined;
    let result: SshExecutionResult | undefined;
    let observedExit: { exitCode: number | null; signal?: string } = { exitCode: null };
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    let commandTimer: ReturnType<typeof setTimeout> | undefined;
    let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
    let termTimer: ReturnType<typeof setTimeout> | undefined;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;

    const safeError = (error: unknown): Error => {
      let message = error instanceof Error ? error.message : String(error);
      for (const secret of [request.password, request.privateKey, request.passphrase]) {
        if (secret) message = message.replaceAll(secret, "[redacted]");
      }
      const safe = new Error(message);
      if (error instanceof Error) safe.name = error.name;
      return safe;
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      for (const timer of [commandTimer, handshakeTimer, termTimer, cleanupTimer]) clearTimeout(timer);
      request.signal.removeEventListener("abort", onAbort);
      if (aborting) reject(new SshOperationAbortedError(observedExit));
      else if (failure) reject(safeError(failure));
      else if (result) resolve(result);
      else reject(new Error("SSH connection closed before command completion."));
    };
    const destroy = () => {
      try { stream?.destroy(); } catch (error) { failure = safeError(error); aborting = false; }
      try { client.destroy(); } catch (error) { failure = safeError(error); aborting = false; }
      finish();
    };
    const closeConnection = () => {
      if (settled || finishing) return;
      finishing = true;
      clearTimeout(commandTimer);
      clearTimeout(handshakeTimer);
      cleanupTimer ??= setTimeout(destroy, CLEANUP_LIMIT_MS);
      try { client.end(); } catch (error) { failure = safeError(error); aborting = false; destroy(); }
    };
    const fail = (error: unknown) => {
      if (settled) return;
      failure = safeError(error);
      aborting = false;
      destroy();
    };
    const stopChannel = () => {
      try { stream?.signal("TERM"); } catch {}
      if (settled) return;
      termTimer = setTimeout(() => {
        try { stream?.close(); } catch (error) { fail(error); return; }
        closeConnection();
      }, TERM_GRACE_MS);
    };
    const onAbort = () => {
      if (settled || failure) return;
      failure = abortError();
      aborting = true;
      clearTimeout(commandTimer);
      clearTimeout(handshakeTimer);
      cleanupTimer ??= setTimeout(destroy, CLEANUP_LIMIT_MS);
      if (stream) stopChannel();
      // Exec may already have started remotely before its acknowledgement arrives.
      // Retain bounded custody so that callback can signal its actual channel.
      else if (!execPending) destroy();
    };
    const output = (channel: "stdout" | "stderr", chunk: Buffer | string) => {
      if (settled) return;
      try {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        if (request.onOutput) { request.onOutput(bytes); return; }
        outputBytes += bytes.length;
        if (outputBytes > MAX_OUTPUT_BYTES) { fail(new Error("ssh-bash output exceeded the 256 KiB limit")); return; }
        const text = decoders[channel].write(bytes);
        if (channel === "stdout") stdout += text; else stderr += text;
        if (text) request.onUpdate?.(text);
      } catch (error) { fail(error); }
    };

    request.signal.addEventListener("abort", onAbort, { once: true });
    if (request.signal.aborted) { onAbort(); return; }
    handshakeTimer = setTimeout(() => fail(new Error("SSH connection handshake exceeded 30 seconds")), 30_000);
    if (request.timeoutSeconds !== undefined) {
      commandTimer = setTimeout(() => fail(new Error(`ssh-bash operation exceeded ${request.timeoutSeconds} seconds`)), request.timeoutSeconds * 1000);
    }
    client.on("error", fail);
    client.on("close", finish);
    client.on("ready", () => {
      if (settled || failure) return;
      clearTimeout(handshakeTimer);
      try {
        execPending = true;
        client.exec(request.command, (error, channel) => {
          execPending = false;
          if (settled) { try { channel?.close(); } catch {} return; }
          if (error) { fail(error); return; }
          if (!channel) { fail(new Error("ssh-bash did not receive a command stream")); return; }
          stream = channel;
          channel.on("data", chunk => output("stdout", chunk));
          channel.stderr.on("data", chunk => output("stderr", chunk));
          channel.on("error", fail);
          channel.on("close", (code?: number | null, signal?: string) => {
            if (settled) return;
            observedExit = { exitCode: typeof code === "number" ? code : null, ...(signal ? { signal } : {}) };
            if (!request.onOutput) { stdout += decoders.stdout.end(); stderr += decoders.stderr.end(); }
            result = { stdout, stderr, exitCode: typeof code === "number" ? code : request.onOutput ? null : 255,
              ...(signal ? { signal } : {}) };
            closeConnection();
          });
          if (aborting) stopChannel();
        });
      } catch (error) { fail(error); }
    });

    const connectOptions: Record<string, unknown> = {
      host: request.config.host, port: request.config.port, username: request.config.username,
      hostVerifier: (key: Buffer) => `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/u, "")}` === request.config.hostFingerprint,
      readyTimeout: Math.min(request.timeoutSeconds ?? 30, 30) * 1000,
      keepaliveInterval: 15_000, keepaliveCountMax: 2,
    };
    if (request.password !== undefined) connectOptions.password = request.password;
    if (request.privateKey !== undefined) connectOptions.privateKey = request.privateKey;
    if (request.passphrase !== undefined) connectOptions.passphrase = request.passphrase;
    try { client.connect(connectOptions); } catch (error) { fail(error); }
  });
}
