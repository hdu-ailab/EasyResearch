import { Client } from "ssh2";
import { createHash } from "node:crypto";
import type { SshExecutionRequest, SshExecutionResult } from "./runtime";

const MAX_OUTPUT_BYTES = 256 * 1024;

interface EventSourceLike {
  on(event: string, listener: (...args: any[]) => void): this;
}

export interface SshCommandStreamLike extends EventSourceLike {
  stderr: EventSourceLike;
}

export interface SshClientLike extends EventSourceLike {
  connect(options: Record<string, unknown>): void;
  exec(
    command: string,
    callback: (error: Error | undefined, stream?: SshCommandStreamLike) => void,
  ): void;
  end(): void;
  destroy(): void;
}

export interface SshExecutorDependencies {
  createClient?: () => SshClientLike;
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export function createSshExecutor(
  deps: SshExecutorDependencies = {},
): (request: SshExecutionRequest) => Promise<SshExecutionResult> {
  const createClient = deps.createClient ?? (() => new Client() as unknown as SshClientLike);
  return (request) => new Promise<SshExecutionResult>((resolve, reject) => {
    const client = createClient();
    let settled = false;
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const timeout = setTimeout(() => {
      fail(new Error(`ssh-bash operation exceeded ${request.timeoutSeconds} seconds`));
    }, request.timeoutSeconds * 1000);

    const cleanup = (): void => {
      clearTimeout(timeout);
      request.signal.removeEventListener("abort", onAbort);
    };
    const finish = (result: SshExecutionResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        client.end();
      } catch {}
      resolve(result);
    };
    function fail(error: Error): void {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        client.destroy();
      } catch {}
      reject(error);
    }
    const onAbort = (): void => fail(abortError("ssh-bash operation aborted"));
    request.signal.addEventListener("abort", onAbort, { once: true });
    if (request.signal.aborted) {
      onAbort();
      return;
    }

    client.on("error", (error: Error) => fail(error));
    client.on("ready", () => {
      if (settled) return;
      client.exec(request.command, (error, stream) => {
        if (error) {
          fail(error);
          return;
        }
        if (!stream) {
          fail(new Error("ssh-bash did not receive a command stream"));
          return;
        }
        stream.on("data", (chunk: Buffer | string) => {
          const text = chunk.toString();
          stdoutBytes += Buffer.byteLength(text);
          if (stdoutBytes + stderrBytes > MAX_OUTPUT_BYTES) {
            fail(new Error("ssh-bash output exceeded the 256 KiB limit"));
            return;
          }
          stdout += text;
          request.onUpdate?.(text);
        });
        stream.stderr.on("data", (chunk: Buffer | string) => {
          const text = chunk.toString();
          stderrBytes += Buffer.byteLength(text);
          if (stdoutBytes + stderrBytes > MAX_OUTPUT_BYTES) {
            fail(new Error("ssh-bash output exceeded the 256 KiB limit"));
            return;
          }
          stderr += text;
          request.onUpdate?.(text);
        });
        stream.on("error", (streamError: Error) => fail(streamError));
        stream.on("close", (code?: number | null) => {
          finish({ stdout, stderr, exitCode: typeof code === "number" ? code : 255 });
        });
      });
    });

    const connectOptions: Record<string, unknown> = {
      host: request.config.host,
      port: request.config.port,
      username: request.config.username,
      hostVerifier: (key: Buffer) => {
        const fingerprint = createHash("sha256").update(key).digest("base64").replace(/=+$/u, "");
        return `SHA256:${fingerprint}` === request.config.hostFingerprint;
      },
      readyTimeout: Math.min(request.timeoutSeconds, 30) * 1000,
      keepaliveInterval: 15_000,
      keepaliveCountMax: 2,
    };
    if (request.password !== undefined) connectOptions.password = request.password;
    if (request.privateKey !== undefined) connectOptions.privateKey = request.privateKey;
    if (request.passphrase !== undefined) connectOptions.passphrase = request.passphrase;
    try {
      client.connect(connectOptions);
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
