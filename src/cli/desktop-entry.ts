import { statSync } from "node:fs";
import type { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { defaultAgentDir, embeddedPackageVersion } from "../runtime/bundled-assets";
import { performFirstRunSetup } from "./first-run";
import {
  inspectServerProcess,
  serverLogFile,
  stopServerProcess,
} from "./server-process";
import {
  acquireTransitionLease,
  type RuntimeLease,
  waitForTransitionLeaseOwnership,
} from "./runtime-lease";
import { runServe, type ServeOptions } from "./commands/serve";
import { createLogger } from "../runtime/logger";
import {
  loadNetworkPolicy,
  restoreBunSandboxEnvironment,
  withTemporaryNetworkPolicyEnvironment,
  type BunSandboxEnvironmentOptions,
  type EnvironmentMap,
} from "../runtime/network-policy";
import {
  DESKTOP_CONTROL_TOKEN_ENV,
  DESKTOP_EVENT_PREFIX,
  DESKTOP_HOST_PID_ENV,
  DESKTOP_HOST_TRANSITION_TOKEN_ENV,
  DESKTOP_LAUNCH_ENV,
  DESKTOP_RENDERER_TOKEN_ENV,
  DESKTOP_TRANSITION_HANDOFF_ENV,
  type DesktopSidecarEvent,
} from "../desktop/contracts";

export {
  DESKTOP_CONTROL_TOKEN_ENV,
  DESKTOP_EVENT_PREFIX,
  DESKTOP_HOST_PID_ENV,
  DESKTOP_HOST_TRANSITION_TOKEN_ENV,
  DESKTOP_LAUNCH_ENV,
  DESKTOP_RENDERER_TOKEN_ENV,
  DESKTOP_TRANSITION_HANDOFF_ENV,
};
export type { DesktopSidecarEvent };

export interface DesktopServeRequest {
  host: "127.0.0.1";
  port: 0;
  controlToken: string;
  rendererToken: string;
  hostPid: number;
  hostTransitionToken: string;
  inheritedTransition: boolean;
}

interface ParentLifeEmitter {
  readonly destroyed?: boolean;
  readonly readableEnded?: boolean;
  once(event: "end" | "close" | "error", listener: () => void): unknown;
  removeListener(event: "end" | "close" | "error", listener: () => void): unknown;
  resume?: () => unknown;
}

interface DesktopServeDependencies {
  environment?: EnvironmentMap;
  environmentRestore?: BunSandboxEnvironmentOptions;
  agentDir?: () => string;
  runtimeId?: () => string;
  acquireTransition?: (agentDir: string) => Promise<RuntimeLease>;
  waitForInheritedTransition?: (
    agentDir: string,
    owner: "desktop",
    pid: number,
    token: string,
  ) => Promise<void>;
  inspectBackground?: (
    agentDir: string,
    runtimeId: string,
  ) => Promise<"none" | "current" | "stale" | "desktop">;
  stopCliOwner?: (agentDir: string) => Promise<boolean>;
  setup?: (agentDir: string, log: (message: string) => void) => unknown;
  serve?: (host: string, port: number, options: ServeOptions) => Promise<number>;
  emit?: (event: DesktopSidecarEvent) => void;
  logError?: (phase: "ownership" | "setup" | "server" | "shutdown", error: unknown) => void;
  parentLife?: ParentLifeEmitter;
}

export function parseDesktopServeRequest(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): DesktopServeRequest {
  if (
    argv.length !== 3
    || argv[0] !== "--desktop-serve"
    || argv[1] !== "127.0.0.1"
    || argv[2] !== "0"
    || env[DESKTOP_LAUNCH_ENV] !== "1"
  ) {
    throw new Error("Invalid EasyResearch desktop launch contract.");
  }
  const controlToken = env[DESKTOP_CONTROL_TOKEN_ENV];
  const rendererToken = env[DESKTOP_RENDERER_TOKEN_ENV];
  const hostTransitionToken = env[DESKTOP_HOST_TRANSITION_TOKEN_ENV];
  const hostPidValue = env[DESKTOP_HOST_PID_ENV];
  const hostPid = hostPidValue && /^[1-9]\d*$/u.test(hostPidValue)
    ? Number(hostPidValue)
    : Number.NaN;
  const inheritedTransitionValue = env[DESKTOP_TRANSITION_HANDOFF_ENV];
  if (
    !controlToken
    || controlToken.length < 32
    || !rendererToken
    || rendererToken.length < 32
    || !hostTransitionToken
    || hostTransitionToken.length < 32
  ) {
    throw new Error("Invalid EasyResearch desktop launch credentials.");
  }
  if (new Set([controlToken, rendererToken, hostTransitionToken]).size !== 3) {
    throw new Error("EasyResearch desktop launch credentials must be distinct.");
  }
  if (!Number.isSafeInteger(hostPid) || hostPid <= 0) {
    throw new Error("Invalid EasyResearch desktop host process identity.");
  }
  if (inheritedTransitionValue !== undefined && inheritedTransitionValue !== "1") {
    throw new Error("Invalid EasyResearch desktop transition handoff.");
  }
  return {
    host: "127.0.0.1",
    port: 0,
    controlToken,
    rendererToken,
    hostPid,
    hostTransitionToken,
    inheritedTransition: inheritedTransitionValue === "1",
  };
}

export function consumeDesktopServeRequest(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): DesktopServeRequest {
  const request = parseDesktopServeRequest(argv, env);
  delete env[DESKTOP_LAUNCH_ENV];
  delete env[DESKTOP_CONTROL_TOKEN_ENV];
  delete env[DESKTOP_RENDERER_TOKEN_ENV];
  delete env[DESKTOP_HOST_PID_ENV];
  delete env[DESKTOP_HOST_TRANSITION_TOKEN_ENV];
  delete env[DESKTOP_TRANSITION_HANDOFF_ENV];
  return request;
}

export function emitDesktopSidecarEvent(
  event: DesktopSidecarEvent,
  write: (line: string) => void = console.log,
): void {
  write(`${DESKTOP_EVENT_PREFIX}${JSON.stringify(event)}`);
}

export function bindParentLife(
  parentLife: ParentLifeEmitter,
  requestShutdown: () => void,
): () => void {
  let requested = false;
  const onEnd = () => {
    if (requested) return;
    requested = true;
    requestShutdown();
  };
  parentLife.once("end", onEnd);
  parentLife.once("close", onEnd);
  parentLife.once("error", onEnd);
  parentLife.resume?.();
  if (parentLife.readableEnded || parentLife.destroyed) onEnd();
  return () => {
    parentLife.removeListener("end", onEnd);
    parentLife.removeListener("close", onEnd);
    parentLife.removeListener("error", onEnd);
  };
}

export async function runDesktopServe(
  request: DesktopServeRequest,
  dependencies: DesktopServeDependencies = {},
): Promise<number> {
  const environment = dependencies.environment ?? process.env;
  restoreBunSandboxEnvironment(environment, dependencies.environmentRestore);
  delete environment[DESKTOP_LAUNCH_ENV];
  delete environment[DESKTOP_CONTROL_TOKEN_ENV];
  delete environment[DESKTOP_RENDERER_TOKEN_ENV];
  delete environment[DESKTOP_HOST_PID_ENV];
  delete environment[DESKTOP_HOST_TRANSITION_TOKEN_ENV];
  delete environment[DESKTOP_TRANSITION_HANDOFF_ENV];
  const agentDir = (dependencies.agentDir ?? defaultAgentDir)();
  const runtimeId = (dependencies.runtimeId ?? desktopRuntimeId)();
  const emit = dependencies.emit ?? emitDesktopSidecarEvent;
  const logPath = resolve(serverLogFile(agentDir));
  const logError = dependencies.logError ?? ((phase, error) => {
    createLogger("desktop-sidecar", { agentDir }).error(`Desktop ${phase} failed`, {
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    });
  });
  let transition: RuntimeLease | undefined;
  let transitionReleased = false;
  let parentShutdownRequested = false;
  let activeServeShutdown: (() => void) | undefined;
  const parentLife = dependencies.parentLife ?? (process.stdin as unknown as EventEmitter);
  const unbindParentLife = bindParentLife(parentLife, () => {
    parentShutdownRequested = true;
    activeServeShutdown?.();
  });
  const releaseTransition = (): void => {
    if (!transition || transitionReleased) return;
    if (!transition.release()) {
      throw new Error("EasyResearch desktop lost its runtime transition lease.");
    }
    transitionReleased = true;
  };
  const handoffTransitionToHost = (lease: RuntimeLease): void => {
    const handoff = lease.reserveHandoff(request.hostTransitionToken);
    try {
      handoff.commit(request.hostPid);
      handoff.relinquish();
    } catch (error) {
      if (!handoff.transferred) {
        try {
          handoff.cancel();
        } catch (cancelError) {
          throw new AggregateError(
            [error, cancelError],
            "EasyResearch desktop transition handoff cleanup failed.",
          );
        }
      }
      throw error;
    }
    if (lease === transition) transitionReleased = true;
  };

  try {
    if (parentShutdownRequested) return 0;
    if (request.inheritedTransition) {
      await (dependencies.waitForInheritedTransition ?? waitForTransitionLeaseOwnership)(
        agentDir,
        "desktop",
        process.pid,
        request.controlToken,
      );
      transitionReleased = true;
    } else {
      transition = await (dependencies.acquireTransition
        ?? ((root) => acquireTransitionLease(root, "desktop")))(agentDir);
    }
    if (parentShutdownRequested) return 0;
    const background = await (dependencies.inspectBackground
      ?? ((root, currentRuntimeId) =>
        inspectServerProcess(root, currentRuntimeId, request.host, request.port)))(agentDir, runtimeId);
    if (background === "desktop") {
      emit(desktopError("ownership", "DESKTOP_ALREADY_RUNNING", "EasyResearch Desktop is already running.", logPath));
      return 1;
    }
    if (background === "current" || background === "stale") {
      await (dependencies.stopCliOwner
        ?? ((root) => stopServerProcess(root, { expectedOwner: "cli" })))(agentDir);
    }
    if (parentShutdownRequested) return 0;

    const setupLog = (message: string): void => emit({
      type: "desktop.setup",
      message: (message || "Preparing EasyResearch resources...").slice(0, 4_096),
    });
    try {
      const { baseline, policy } = loadNetworkPolicy(
        agentDir,
        environment,
        dependencies.environmentRestore,
      );
      withTemporaryNetworkPolicyEnvironment(policy, baseline, environment, () => {
        if (dependencies.setup) dependencies.setup(agentDir, setupLog);
        else performFirstRunSetup(agentDir, { log: setupLog });
      });
    } catch (error) {
      logError("setup", error);
      emit(desktopError(
        "setup",
        "DESKTOP_SETUP_FAILED",
        "EasyResearch could not complete desktop setup.",
        logPath,
      ));
      return 1;
    }
    if (parentShutdownRequested) return 0;

    let ready = false;
    let readyBootId: string | undefined;
    let restartRequested = false;
    const exitCode = await (dependencies.serve ?? runServe)(request.host, request.port, {
      owner: "desktop",
      token: request.controlToken,
      runtimeId,
      rendererToken: request.rendererToken,
      registerShutdownTrigger: (requestShutdown) => {
        activeServeShutdown = requestShutdown;
        if (parentShutdownRequested) requestShutdown();
        return () => {
          if (activeServeShutdown === requestShutdown) activeServeShutdown = undefined;
        };
      },
      onReady: ({ port, logPath: readyLogPath, bootId }) => {
        if (transition?.held) handoffTransitionToHost(transition);
        ready = true;
        readyBootId = bootId;
        emit({
          type: "desktop.ready",
          origin: `http://${request.host}:${port}`,
          owner: "desktop",
          pid: process.pid,
          logPath: resolve(readyLogPath),
          bootId,
        });
      },
      onExpectedRestart: (bootId, restartTransition) => {
        if (!readyBootId || bootId !== readyBootId || restartRequested) {
          throw new Error("EasyResearch desktop restart identity did not match its ready event.");
        }
        handoffTransitionToHost(restartTransition);
        restartRequested = true;
        emit({ type: "desktop.restart-requested", bootId });
      },
      environment,
      environmentRestore: dependencies.environmentRestore,
    });
    if (exitCode !== 0) {
      emit(desktopError(
        ready ? "shutdown" : "server",
        ready ? "DESKTOP_SHUTDOWN_FAILED" : "DESKTOP_SERVER_FAILED",
        ready
          ? "EasyResearch Desktop could not stop cleanly."
          : "EasyResearch Desktop could not start its local service.",
        logPath,
      ));
      return exitCode;
    }
    if (ready && !restartRequested) emit({ type: "desktop.stopped" });
    return 0;
  } catch (error) {
    logError("ownership", error);
    emit(desktopError(
      "ownership",
      "DESKTOP_OWNERSHIP_FAILED",
      "EasyResearch could not acquire exclusive desktop ownership.",
      logPath,
    ));
    return 1;
  } finally {
    unbindParentLife();
    if (transition && !transitionReleased) {
      try {
        releaseTransition();
      } catch (error) {
        logError("ownership", error);
        // The ownership error event above is the safe public diagnostic.
      }
    }
  }
}

function desktopRuntimeId(): string {
  const stat = statSync(process.execPath);
  return `desktop:${embeddedPackageVersion()}:${stat.size}:${stat.mtimeMs}`;
}

function desktopError(
  phase: "ownership" | "setup" | "server" | "shutdown",
  code: string,
  message: string,
  logPath: string,
): DesktopSidecarEvent {
  return { type: "desktop.error", phase, code, message, logPath };
}
