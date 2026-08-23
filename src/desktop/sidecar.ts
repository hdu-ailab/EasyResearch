import { randomBytes } from "node:crypto";
import {
  spawn as nodeSpawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { isAbsolute } from "node:path";
import { DAEMON_CONTROL_PATH, DAEMON_TOKEN_HEADER } from "../cli/daemon-control";
import {
  DESKTOP_ACCESS_HEADER,
  DESKTOP_CONTROL_TOKEN_ENV,
  DESKTOP_LAUNCH_ENV,
  DESKTOP_RENDERER_TOKEN_ENV,
  type DesktopReadyEvent,
} from "./contracts";
import { windowsTaskkillCommand } from "./environment";
import { parseDesktopSidecarLine } from "./sidecar-events";

interface SpawnOptions {
  env: NodeJS.ProcessEnv;
  stdio: ["pipe", "pipe", "pipe"];
  windowsHide: boolean;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface DesktopSidecarStartOptions {
  sidecarPath: string;
  baseEnv: NodeJS.ProcessEnv;
  spawn?: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => ChildProcessWithoutNullStreams;
  fetch?: FetchLike;
  createToken?: () => string;
  onSetup?: (message: string) => void;
  log?: (line: string) => void;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  platform?: NodeJS.Platform;
  systemRoot?: string;
}

export interface DesktopSidecarHandle {
  readonly ready: DesktopReadyEvent;
  readonly rendererToken: string;
  readonly pid: number;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  shutdown(): Promise<void>;
  forceTerminate(): void;
}

export async function startDesktopSidecar(
  options: DesktopSidecarStartOptions,
): Promise<DesktopSidecarHandle> {
  if (!isAbsolute(options.sidecarPath)) {
    throw new Error(`Desktop sidecar path must be absolute: ${options.sidecarPath}`);
  }
  const createToken = options.createToken ?? (() => randomBytes(32).toString("base64url"));
  const controlToken = createToken();
  const rendererToken = createToken();
  if (controlToken.length < 32 || rendererToken.length < 32 || controlToken === rendererToken) {
    throw new Error("Desktop sidecar credentials must be distinct and at least 32 characters.");
  }
  const childEnv = {
    ...options.baseEnv,
    [DESKTOP_LAUNCH_ENV]: "1",
    [DESKTOP_CONTROL_TOKEN_ENV]: controlToken,
    [DESKTOP_RENDERER_TOKEN_ENV]: rendererToken,
  };
  const spawn = options.spawn ?? ((command, args, spawnOptions) =>
    nodeSpawn(command, [...args], spawnOptions));
  const child = spawn(
    options.sidecarPath,
    ["--desktop-serve", "127.0.0.1", "0"],
    { env: childEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const ready = await waitForReadyEvent(child, {
    timeoutMs: options.startupTimeoutMs ?? 15 * 60_000,
    onSetup: options.onSetup,
    log: options.log,
  }).catch((error) => {
    forceTerminateChild(child, options);
    throw error;
  });
  const childPid = child.pid;
  if (!childPid) {
    forceTerminateChild(child, options);
    throw new Error("EasyResearch desktop sidecar did not report a process id.");
  }
  if (ready.pid !== childPid) {
    forceTerminateChild(child, options);
    throw new Error("Desktop sidecar ready event did not match the owned child process.");
  }
  capturePostReadyLogs(child, options.log);

  const fetchImpl = options.fetch ?? fetch;
  let health: Response;
  try {
    health = await fetchImpl(`${ready.origin}/api/status`, {
      headers: { [DESKTOP_ACCESS_HEADER]: rendererToken },
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    forceTerminateChild(child, options);
    throw new Error("Desktop sidecar health check failed.", { cause: error });
  }
  if (!health.ok) {
    forceTerminateChild(child, options);
    throw new Error(`Desktop sidecar health check returned HTTP ${health.status}.`);
  }

  let shutdownAttempt: Promise<void> | undefined;
  const forceTerminate = (): void => forceTerminateChild(child, options);
  const shutdown = (): Promise<void> => {
    if (shutdownAttempt) return shutdownAttempt;
    shutdownAttempt = (async () => {
      try {
        await fetchImpl(`${ready.origin}${DAEMON_CONTROL_PATH}`, {
          method: "POST",
          headers: { [DAEMON_TOKEN_HEADER]: controlToken },
          redirect: "error",
          signal: AbortSignal.timeout(5_000),
        });
      } catch {
        // Closing stdin below is the independent parent-life shutdown signal.
      }
      child.stdin.end();
      const clean = await settlesBefore(exited, options.shutdownTimeoutMs ?? 15_000);
      if (clean) return;
      forceTerminate();
      if (!await settlesBefore(exited, 5_000)) {
        throw new Error("Desktop sidecar did not exit after forced termination.");
      }
    })();
    return shutdownAttempt;
  };

  return {
    ready,
    rendererToken,
    pid: childPid,
    exited,
    shutdown,
    forceTerminate,
  };
}

async function waitForReadyEvent(
  child: ChildProcessWithoutNullStreams,
  options: {
    timeoutMs: number;
    onSetup?: (message: string) => void;
    log?: (line: string) => void;
  },
): Promise<DesktopReadyEvent> {
  return new Promise<DesktopReadyEvent>((resolve, reject) => {
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout.removeListener("data", onStdout);
      child.stderr.removeListener("data", onStderr);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
      action();
    };
    const consume = (buffer: string, log: boolean): string => {
      const lines = buffer.split(/\r?\n/u);
      const remainder = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        if (log) {
          options.log?.(line);
          continue;
        }
        let event;
        try {
          event = parseDesktopSidecarLine(line);
        } catch (error) {
          finish(() => reject(error));
          return "";
        }
        if (!event) {
          options.log?.(line);
        } else if (event.type === "desktop.setup") {
          options.onSetup?.(event.message);
        } else if (event.type === "desktop.error") {
          finish(() => reject(new Error(`${event.message} Logs: ${event.logPath}`)));
          return "";
        } else if (event.type === "desktop.ready") {
          finish(() => resolve(event));
          return "";
        }
      }
      return remainder;
    };
    const onStdout = (chunk: Buffer | string): void => {
      stdoutBuffer = consume(stdoutBuffer + chunk.toString(), false);
    };
    const onStderr = (chunk: Buffer | string): void => {
      stderrBuffer = consume(stderrBuffer + chunk.toString(), true);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(() => reject(new Error(
        `Desktop sidecar exited before readiness (code ${code ?? "none"}, signal ${signal ?? "none"}).`,
      )));
    };
    const onError = (error: Error): void => {
      finish(() => reject(new Error(`Desktop sidecar failed to spawn: ${error.message}`, { cause: error })));
    };
    const timeout = setTimeout(() => {
      finish(() => reject(new Error("Desktop sidecar startup timed out.")));
    }, options.timeoutMs);
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

function capturePostReadyLogs(
  child: ChildProcessWithoutNullStreams,
  log: ((line: string) => void) | undefined,
): void {
  const write = log ?? (() => {});
  let stdoutBuffer = "";
  let stderrBuffer = "";
  const consume = (buffer: string, chunk: Buffer | string): string => {
    const lines = `${buffer}${chunk.toString()}`.split(/\r?\n/u);
    const remainder = lines.pop() ?? "";
    for (const line of lines) {
      if (line) write(line);
    }
    return remainder;
  };
  const onStdout = (chunk: Buffer | string): void => {
    stdoutBuffer = consume(stdoutBuffer, chunk);
  };
  const onStderr = (chunk: Buffer | string): void => {
    stderrBuffer = consume(stderrBuffer, chunk);
  };
  const onError = (error: Error): void => {
    write(`Desktop sidecar process error: ${error.message}`);
  };
  const cleanup = (): void => {
    if (stdoutBuffer) write(stdoutBuffer);
    if (stderrBuffer) write(stderrBuffer);
    child.stdout.removeListener("data", onStdout);
    child.stderr.removeListener("data", onStderr);
    child.removeListener("error", onError);
  };
  child.stdout.on("data", onStdout);
  child.stderr.on("data", onStderr);
  child.on("error", onError);
  child.once("exit", cleanup);
}

function forceTerminateChild(
  child: ChildProcessWithoutNullStreams,
  options: Pick<DesktopSidecarStartOptions, "platform" | "systemRoot">,
): void {
  if (!child.pid) return;
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const command = windowsTaskkillCommand(
      options.systemRoot ?? process.env.SystemRoot ?? "C:\\Windows",
      child.pid,
    );
    spawnSync(command.command, command.args, { windowsHide: true, stdio: "ignore" });
    return;
  }
  child.kill("SIGKILL");
}

async function settlesBefore(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}
