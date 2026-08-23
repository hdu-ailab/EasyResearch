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
import { acquireTransitionLease, type RuntimeLease } from "./runtime-lease";
import { runServe, type ServeOptions } from "./commands/serve";
import { createLogger } from "../runtime/logger";
import {
  DESKTOP_CONTROL_TOKEN_ENV,
  DESKTOP_EVENT_PREFIX,
  DESKTOP_LAUNCH_ENV,
  DESKTOP_RENDERER_TOKEN_ENV,
  type DesktopSidecarEvent,
} from "../desktop/contracts";

export {
  DESKTOP_CONTROL_TOKEN_ENV,
  DESKTOP_EVENT_PREFIX,
  DESKTOP_LAUNCH_ENV,
  DESKTOP_RENDERER_TOKEN_ENV,
};
export type { DesktopSidecarEvent };

export interface DesktopServeRequest {
  host: "127.0.0.1";
  port: 0;
  controlToken: string;
  rendererToken: string;
}

interface ParentLifeEmitter {
  once(event: "end" | "close" | "error", listener: () => void): unknown;
  removeListener(event: "end" | "close" | "error", listener: () => void): unknown;
  resume?: () => unknown;
}

interface DesktopServeDependencies {
  agentDir?: () => string;
  runtimeId?: () => string;
  acquireTransition?: (agentDir: string) => Promise<RuntimeLease>;
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
  if (!controlToken || controlToken.length < 32 || !rendererToken || rendererToken.length < 32) {
    throw new Error("Invalid EasyResearch desktop launch credentials.");
  }
  if (controlToken === rendererToken) {
    throw new Error("EasyResearch desktop launch credentials must be distinct.");
  }
  return { host: "127.0.0.1", port: 0, controlToken, rendererToken };
}

export function consumeDesktopServeRequest(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): DesktopServeRequest {
  const request = parseDesktopServeRequest(argv, env);
  delete env[DESKTOP_LAUNCH_ENV];
  delete env[DESKTOP_CONTROL_TOKEN_ENV];
  delete env[DESKTOP_RENDERER_TOKEN_ENV];
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
  const releaseTransition = (): void => {
    if (!transition || transitionReleased) return;
    if (!transition.release()) {
      throw new Error("EasyResearch desktop lost its runtime transition lease.");
    }
    transitionReleased = true;
  };

  try {
    transition = await (dependencies.acquireTransition
      ?? ((root) => acquireTransitionLease(root, "desktop")))(agentDir);
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

    const setupLog = (message: string): void => emit({
      type: "desktop.setup",
      message: (message || "Preparing EasyResearch resources...").slice(0, 4_096),
    });
    try {
      if (dependencies.setup) dependencies.setup(agentDir, setupLog);
      else performFirstRunSetup(agentDir, { log: setupLog });
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

    const parentLife = dependencies.parentLife ?? (process.stdin as unknown as EventEmitter);
    let ready = false;
    const exitCode = await (dependencies.serve ?? runServe)(request.host, request.port, {
      owner: "desktop",
      token: request.controlToken,
      runtimeId,
      rendererToken: request.rendererToken,
      registerShutdownTrigger: (requestShutdown) => bindParentLife(parentLife, requestShutdown),
      onReady: ({ port, logPath: readyLogPath }) => {
        ready = true;
        emit({
          type: "desktop.ready",
          origin: `http://${request.host}:${port}`,
          owner: "desktop",
          pid: process.pid,
          logPath: resolve(readyLogPath),
        });
        releaseTransition();
      },
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
    emit({ type: "desktop.stopped" });
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
