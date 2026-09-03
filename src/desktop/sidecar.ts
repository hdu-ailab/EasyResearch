import { randomBytes } from "node:crypto";
import {
  spawn as nodeSpawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { isAbsolute } from "node:path";
import { DAEMON_CONTROL_PATH, DAEMON_TOKEN_HEADER } from "../cli/daemon-control";
import { createDirectLocalHttpFetch, type LocalHttpFetch } from "../cli/local-http";
import {
  adoptTransitionLease,
  type RuntimeLease,
  type RuntimeLeaseHandoff,
} from "../cli/runtime-lease";
import {
  DESKTOP_ACCESS_HEADER,
  DESKTOP_CONTROL_TOKEN_ENV,
  DESKTOP_HOST_PID_ENV,
  DESKTOP_HOST_TRANSITION_TOKEN_ENV,
  DESKTOP_LAUNCH_ENV,
  DESKTOP_RENDERER_TOKEN_ENV,
  DESKTOP_TRANSITION_HANDOFF_ENV,
  type DesktopReadyEvent,
  type DesktopRestartRequestedEvent,
} from "./contracts";
import { windowsTaskkillCommand } from "./environment";
import { parseDesktopSidecarLine } from "./sidecar-events";

interface SpawnOptions {
  env: NodeJS.ProcessEnv;
  stdio: ["pipe", "pipe", "pipe"];
  windowsHide: boolean;
  detached?: boolean;
}

type FetchLike = LocalHttpFetch;

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
  createHostTransitionToken?: () => string;
  hostPid?: number;
  agentDir?: string;
  transitionLease?: RuntimeLease;
  adoptTransition?: typeof adoptTransitionLease;
  onSetup?: (message: string) => void;
  onSpawned?: (handle: DesktopSidecarProcessHandle) => void;
  onTransitionCommitted?: (handle: DesktopSidecarProcessHandle) => void;
  onRestartRequested?: (event: DesktopRestartRequestedEvent) => void;
  log?: (line: string) => void;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  forcedShutdownTimeoutMs?: number;
  platform?: NodeJS.Platform;
  systemRoot?: string;
  killProcess?: (pid: number, signal: NodeJS.Signals) => unknown;
}

const WINDOWS_TASKKILL_TIMEOUT_MS = 5_000;

export interface DesktopSidecarExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  expectedRestart?: DesktopRestartRequestedEvent;
  protocolError?: string;
}

export interface DesktopSidecarProcessHandle {
  readonly pid?: number;
  readonly exited: Promise<DesktopSidecarExit>;
  shutdown(): Promise<void>;
  forceTerminate(): void;
}

export interface DesktopSidecarHandle extends DesktopSidecarProcessHandle {
  readonly ready: DesktopReadyEvent;
  readonly rendererToken: string;
  readonly pid: number;
  readonly restartRequested: Promise<DesktopRestartRequestedEvent>;
  takeRestartTransition(): RuntimeLease;
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
  const hostTransitionToken = (options.createHostTransitionToken
    ?? (() => randomBytes(32).toString("base64url")))();
  const hostPid = options.hostPid ?? process.pid;
  if (
    controlToken.length < 32
    || rendererToken.length < 32
    || hostTransitionToken.length < 32
    || new Set([controlToken, rendererToken, hostTransitionToken]).size !== 3
  ) {
    throw new Error("Desktop sidecar credentials must be distinct and at least 32 characters.");
  }
  if (!Number.isSafeInteger(hostPid) || hostPid <= 0) {
    throw new Error("Desktop sidecar requires a valid host process identity.");
  }
  if (options.transitionLease && !options.agentDir) {
    throw new Error("Desktop replacement transition custody requires an agent directory.");
  }
  const childEnv = {
    ...options.baseEnv,
    [DESKTOP_LAUNCH_ENV]: "1",
    [DESKTOP_CONTROL_TOKEN_ENV]: controlToken,
    [DESKTOP_RENDERER_TOKEN_ENV]: rendererToken,
    [DESKTOP_HOST_PID_ENV]: String(hostPid),
    [DESKTOP_HOST_TRANSITION_TOKEN_ENV]: hostTransitionToken,
    ...(options.transitionLease ? { [DESKTOP_TRANSITION_HANDOFF_ENV]: "1" } : {}),
  };
  const spawn = options.spawn ?? ((command, args, spawnOptions) =>
    nodeSpawn(command, [...args], spawnOptions));
  const platform = options.platform ?? process.platform;
  let transitionHandoff: RuntimeLeaseHandoff | undefined;
  try {
    transitionHandoff = options.transitionLease?.reserveHandoff(controlToken);
  } catch (error) {
    if (options.transitionLease?.held) options.transitionLease.release();
    throw error;
  }
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(
      options.sidecarPath,
      ["--desktop-serve", "127.0.0.1", "0"],
      {
        env: childEnv,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        ...(platform === "darwin" ? { detached: true } : {}),
      },
    );
  } catch (error) {
    transitionHandoff?.cancel();
    if (options.transitionLease?.held) options.transitionLease.release();
    throw error;
  }
  // The group remains owned after its leader exits while descendants keep the pipes open.
  let childClosed = false;
  child.once("close", () => {
    childClosed = true;
  });
  const forceTerminate = (): void => forceTerminateChild(child, options, childClosed);
  const closeParentLife = (): void => {
    if (!child.stdin.writableEnded && !child.stdin.destroyed) child.stdin.end();
  };
  let startupTransition = options.transitionLease;
  let restartTransition: RuntimeLease | undefined;
  let restartTransitionClaimed = false;

  const protocol = monitorSidecarProtocol(child, {
    timeoutMs: options.startupTimeoutMs ?? 15 * 60_000,
    onSetup: options.onSetup,
    onRestartRequested: (event) => {
      if (options.agentDir) {
        restartTransition = (options.adoptTransition ?? adoptTransitionLease)(
          options.agentDir,
          "desktop",
          hostPid,
          hostTransitionToken,
        );
      }
      closeParentLife();
      options.onRestartRequested?.(event);
    },
    log: options.log,
    onProtocolViolation: forceTerminate,
  });
  const fetchImpl = options.fetch ?? createDirectLocalHttpFetch(5_000);
  let acceptedReady: DesktopReadyEvent | undefined;
  let shutdownAttempt: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    if (shutdownAttempt) return shutdownAttempt;
    const current = (async () => {
      if (acceptedReady) {
        try {
          await fetchImpl(`${acceptedReady.origin}${DAEMON_CONTROL_PATH}`, {
            method: "POST",
            headers: { [DAEMON_TOKEN_HEADER]: controlToken },
            redirect: "error",
            signal: AbortSignal.timeout(5_000),
          });
        } catch {
          // Closing stdin below is the independent parent-life shutdown signal.
        }
      }
      closeParentLife();
      const clean = await settlesBefore(protocol.exited, options.shutdownTimeoutMs ?? 15_000);
      if (clean) return;
      forceTerminate();
      if (!await settlesBefore(protocol.exited, options.forcedShutdownTimeoutMs ?? 5_000)) {
        throw new Error("Desktop sidecar did not exit after forced termination.");
      }
    })();
    shutdownAttempt = current;
    void current.catch(() => {
      if (shutdownAttempt === current) shutdownAttempt = undefined;
    });
    return current;
  };
  const spawnedHandle: DesktopSidecarProcessHandle = {
    pid: child.pid,
    exited: protocol.exited,
    shutdown,
    forceTerminate,
  };
  const releaseStartupTransition = (): void => {
    if (!startupTransition?.held) return;
    if (!startupTransition.release()) {
      throw new Error("Desktop host lost transition custody before authenticated readiness.");
    }
  };
  const leaveStartupTransitionWithSurvivingChild = (): void => {
    if (!startupTransition?.held) return;
    if (transitionHandoff) {
      if (!transitionHandoff.transferred) transitionHandoff.commit(child.pid!);
      transitionHandoff.relinquish();
      return;
    }
    const survivorHandoff = startupTransition.reserveHandoff(controlToken);
    survivorHandoff.commit(child.pid!);
    survivorHandoff.relinquish();
  };
  const failStartup = async (error: unknown): Promise<never> => {
    const cleanupErrors: unknown[] = [];
    try {
      await shutdown();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (!startupTransition && options.agentDir) {
      try {
        startupTransition = (options.adoptTransition ?? adoptTransitionLease)(
          options.agentDir,
          "desktop",
          hostPid,
          hostTransitionToken,
        );
      } catch {
        // The child may have failed before transferring its startup lease.
      }
    }
    try {
      if (childClosed) {
        if (transitionHandoff && !transitionHandoff.transferred) transitionHandoff.cancel();
        releaseStartupTransition();
      }
      else leaveStartupTransitionWithSurvivingChild();
    } catch (custodyError) {
      cleanupErrors.push(custodyError);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Desktop sidecar startup and owned-child cleanup failed.",
      );
    }
    throw error;
  };

  // A host callback may reject before this function awaits readiness.
  void protocol.ready.catch(() => {});
  try {
    options.onSpawned?.(spawnedHandle);
    if (child.pid) transitionHandoff?.commit(child.pid);
    if (transitionHandoff?.transferred) options.onTransitionCommitted?.(spawnedHandle);
    const ready = await protocol.ready;
    acceptedReady = ready;
    if (!startupTransition && options.agentDir) {
      startupTransition = (options.adoptTransition ?? adoptTransitionLease)(
        options.agentDir,
        "desktop",
        hostPid,
        hostTransitionToken,
      );
    }
    const childPid = child.pid;
    if (!childPid) {
      throw new Error("EasyResearch desktop sidecar did not report a process id.");
    }
    if (ready.pid !== childPid) {
      throw new Error("Desktop sidecar ready event did not match the owned child process.");
    }
    let health: Response;
    try {
      health = await fetchImpl(`${ready.origin}/api/status`, {
        headers: { [DESKTOP_ACCESS_HEADER]: rendererToken },
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
    } catch (error) {
      throw new Error("Desktop sidecar health check failed.", { cause: error });
    }
    if (!health.ok) {
      throw new Error(`Desktop sidecar health check returned HTTP ${health.status}.`);
    }
    releaseStartupTransition();

    return {
      ready,
      rendererToken,
      pid: childPid,
      restartRequested: protocol.restartRequested,
      exited: protocol.exited,
      shutdown,
      forceTerminate,
      takeRestartTransition() {
        if (!restartTransition && !restartTransitionClaimed && options.agentDir) {
          restartTransition = (options.adoptTransition ?? adoptTransitionLease)(
            options.agentDir,
            "desktop",
            hostPid,
            hostTransitionToken,
          );
        }
        if (!restartTransition) {
          throw new Error("Desktop restart transition was already claimed or never transferred.");
        }
        const claimed = restartTransition;
        restartTransition = undefined;
        restartTransitionClaimed = true;
        return claimed;
      },
    };
  } catch (error) {
    return failStartup(error);
  }
}

function monitorSidecarProtocol(
  child: ChildProcessWithoutNullStreams,
  options: {
    timeoutMs: number;
    onSetup?: (message: string) => void;
    onRestartRequested?: (event: DesktopRestartRequestedEvent) => void;
    log?: (line: string) => void;
    onProtocolViolation: () => void;
  },
): {
  ready: Promise<DesktopReadyEvent>;
  restartRequested: Promise<DesktopRestartRequestedEvent>;
  exited: Promise<DesktopSidecarExit>;
} {
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let readyEvent: DesktopReadyEvent | undefined;
  let terminalEvent: "restart" | "stopped" | undefined;
  let restartEvent: DesktopRestartRequestedEvent | undefined;
  let sidecarReportedError = false;
  let protocolError: string | undefined;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let processExited = false;
  let processClosed = false;
  let readySettled = false;
  let resolveReady!: (event: DesktopReadyEvent) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<DesktopReadyEvent>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let resolveRestartRequested!: (event: DesktopRestartRequestedEvent) => void;
  const restartRequested = new Promise<DesktopRestartRequestedEvent>((resolve) => {
    resolveRestartRequested = resolve;
  });
  let resolveExited!: (exit: DesktopSidecarExit) => void;
  const exited = new Promise<DesktopSidecarExit>((resolve) => {
    resolveExited = resolve;
  });
  const settleReady = (action: () => void): void => {
    if (readySettled) return;
    readySettled = true;
    clearTimeout(timeout);
    action();
  };
  const rejectBeforeReady = (error: Error): void => settleReady(() => rejectReady(error));
  const failProtocol = (publicMessage: string, logMessage: string): void => {
    if (protocolError) return;
    protocolError = publicMessage;
    options.log?.(`Desktop sidecar protocol error: ${logMessage}`);
    if (!readyEvent) rejectBeforeReady(new Error(publicMessage));
    else if (!processExited && !processClosed) {
      try {
        options.onProtocolViolation();
      } catch (error) {
        options.log?.(
          `Desktop sidecar force termination failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };
  const processStdoutLine = (line: string): void => {
    if (!line) return;
    let event;
    try {
      event = parseDesktopSidecarLine(line);
    } catch {
      failProtocol(
        "Desktop sidecar emitted an invalid machine event.",
        "invalid machine event.",
      );
      return;
    }
    if (!event) {
      options.log?.(line);
      return;
    }
    if (!readyEvent) {
      if (event.type === "desktop.setup") {
        options.onSetup?.(event.message);
        return;
      }
      if (event.type === "desktop.error") {
        rejectBeforeReady(new Error(`${event.message} Logs: ${event.logPath}`));
        return;
      }
      if (event.type === "desktop.ready") {
        readyEvent = event;
        settleReady(() => resolveReady(event));
        return;
      }
      failProtocol(
        "Desktop sidecar emitted a machine event before readiness.",
        "machine event arrived before readiness.",
      );
      return;
    }
    if (event.type === "desktop.restart-requested") {
      if (terminalEvent) {
        failProtocol(
          "Desktop sidecar emitted duplicate terminal machine events.",
          "duplicate terminal machine events.",
        );
        return;
      }
      if (event.bootId !== readyEvent.bootId) {
        failProtocol(
          "Desktop sidecar restart identity did not match readiness.",
          "restart identity did not match readiness.",
        );
        return;
      }
      terminalEvent = "restart";
      restartEvent = event;
      resolveRestartRequested(event);
      try {
        options.onRestartRequested?.(event);
      } catch {
        failProtocol(
          "Desktop host rejected the sidecar restart event.",
          "host callback rejected the restart event.",
        );
      }
      return;
    }
    if (event.type === "desktop.stopped") {
      if (terminalEvent) {
        failProtocol(
          "Desktop sidecar emitted duplicate terminal machine events.",
          "duplicate terminal machine events.",
        );
        return;
      }
      terminalEvent = "stopped";
      return;
    }
    if (event.type === "desktop.error") {
      sidecarReportedError = true;
      options.log?.(`${event.message} Logs: ${event.logPath}`);
      return;
    }
    failProtocol(
      "Desktop sidecar emitted a machine event in an invalid phase.",
      "machine event arrived in an invalid phase.",
    );
  };
  const consume = (buffer: string, chunk: Buffer | string, stdout: boolean): string => {
    const lines = `${buffer}${chunk.toString()}`.split(/\r?\n/u);
    const remainder = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      if (stdout) processStdoutLine(line);
      else options.log?.(line);
    }
    return remainder;
  };
  const onStdout = (chunk: Buffer | string): void => {
    stdoutBuffer = consume(stdoutBuffer, chunk, true);
  };
  const onStderr = (chunk: Buffer | string): void => {
    stderrBuffer = consume(stderrBuffer, chunk, false);
  };
  const onError = (error: Error): void => {
    if (!readyEvent) {
      rejectBeforeReady(new Error(`Desktop sidecar failed to spawn: ${error.message}`, { cause: error }));
    } else {
      options.log?.(`Desktop sidecar process error: ${error.message}`);
    }
  };
  const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    processExited = true;
    exitCode = code;
    exitSignal = signal;
    options.log?.(
      `Desktop sidecar process exited (code ${code ?? "none"}, signal ${signal ?? "none"}); waiting for stdio close.`,
    );
  };
  const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (processClosed) return;
    processClosed = true;
    if (!processExited) {
      exitCode = code;
      exitSignal = signal;
    }
    if (stdoutBuffer) processStdoutLine(stdoutBuffer);
    if (stderrBuffer) options.log?.(stderrBuffer);
    stdoutBuffer = "";
    stderrBuffer = "";
    child.stdout.removeListener("data", onStdout);
    child.stderr.removeListener("data", onStderr);
    child.removeListener("error", onError);
    child.removeListener("exit", onExit);
    if (!readyEvent) {
      rejectBeforeReady(new Error(
        `Desktop sidecar exited before readiness (code ${exitCode ?? "none"}, signal ${exitSignal ?? "none"}).`,
      ));
    }
    const cleanExpectedRestart = exitCode === 0
      && exitSignal === null
      && restartEvent !== undefined
      && terminalEvent === "restart"
      && !sidecarReportedError
      && !protocolError;
    resolveExited({
      code: exitCode,
      signal: exitSignal,
      ...(cleanExpectedRestart ? { expectedRestart: restartEvent } : {}),
      ...(protocolError ? { protocolError } : {}),
    });
  };
  const timeout = setTimeout(() => {
    rejectBeforeReady(new Error("Desktop sidecar startup timed out."));
  }, options.timeoutMs);
  child.stdout.on("data", onStdout);
  child.stderr.on("data", onStderr);
  child.on("error", onError);
  child.on("exit", onExit);
  child.once("close", onClose);
  return { ready, restartRequested, exited };
}

function forceTerminateChild(
  child: ChildProcessWithoutNullStreams,
  options: Pick<DesktopSidecarStartOptions, "platform" | "systemRoot" | "killProcess">,
  childClosed: boolean,
): void {
  if (!child.pid) return;
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") {
    if (!childClosed) (options.killProcess ?? process.kill)(-child.pid, "SIGKILL");
    return;
  }
  if (platform === "win32") {
    if (childClosed) return;
    const command = windowsTaskkillCommand(
      options.systemRoot ?? process.env.SystemRoot ?? "C:\\Windows",
      child.pid,
    );
    const result = spawnSync(command.command, command.args, {
      windowsHide: true,
      stdio: "ignore",
      timeout: WINDOWS_TASKKILL_TIMEOUT_MS,
    });
    if (result.error) {
      const timedOut = (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
      throw new Error(timedOut
        ? "Windows taskkill timed out for the EasyResearch sidecar."
        : "Windows taskkill failed for the EasyResearch sidecar.", {
        cause: result.error,
      });
    }
    if (result.signal !== null) {
      throw new Error(
        `Windows taskkill was terminated by ${result.signal} for the EasyResearch sidecar.`,
      );
    }
    if (result.status !== 0) {
      throw new Error(
        `Windows taskkill exited with status ${result.status ?? "unknown"} for the EasyResearch sidecar.`,
      );
    }
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
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
