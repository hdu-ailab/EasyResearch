import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import type { ShellProcess } from "./process";
import { captureOutput } from "./storage";
import type { ManagedRemoteOperation, ShellInput, ShellResult } from "./types";
import { scheduleShellTimeout } from "./timer";

export function startRemoteOperation(input: ShellInput, file: string, operation: ManagedRemoteOperation): ShellProcess {
  const fd = openSync(file, "wx", 0o600);
  const abort = new AbortController();
  const started = Date.now();
  let reason: "cancelled" | "timeout" | undefined;
  let cancelTimer: (() => void) | undefined;
  let closed = false;
  const done = Promise.resolve().then(async (): Promise<ShellResult> => {
    let result: { exitCode: number | null; signal?: string; killed?: string };
    let failed = false;
    try {
      result = await operation({
        command: input.command, workdir: input.workdir, signal: abort.signal,
        onOutput(chunk) {
          if (closed) throw new Error("Remote shell output is already closed.");
          const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
          let offset = 0;
          while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
        },
      });
    } catch (error) {
      failed = true;
      result = { exitCode: null, killed: error instanceof Error ? error.message : String(error) };
    } finally {
      closed = true;
      cancelTimer?.();
      try { fsyncSync(fd); } finally { closeSync(fd); }
    }
    const capture = captureOutput(file);
    return {
      ...capture, ...result, status: reason === "cancelled" ? "cancelled" : failed ? "error" : "completed",
      wallTimeSeconds: (Date.now() - started) / 1000,
      ...(capture.truncated ? { outputPath: file } : {}),
      ...(reason === "timeout" ? { timeout: true, timeoutMs: input.timeout } : {}),
    };
  });
  const stop = (why: "cancelled" | "timeout" = "cancelled") => {
    if (!closed) { reason ??= why; abort.abort(); }
    // The transport must resolve only after its remote cancellation/stream cleanup.
    return done.then(() => undefined);
  };
  if (input.background && input.timeout) cancelTimer = scheduleShellTimeout(input.timeout, () => { void stop("timeout"); });
  return { done, stop };
}
