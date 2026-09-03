import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "../../runtime/pi-import";
import { createLogger } from "../../runtime/logger";
import {
  DAEMON_OWNER_ENV,
  DAEMON_RUNTIME_ID_ENV,
  DAEMON_TOKEN_ENV,
  removeServerPid,
  serverLogFile,
  type ServerOwner,
  writeServerProcess,
} from "../server-process";
import {
  acquireServerLease,
  acquireTransitionLease,
  type RuntimeLease,
} from "../runtime-lease";
import { bootstrapBundledResources } from "../../bootstrap/resources";
import {
  applyNetworkPolicyEnvironment,
  loadNetworkPolicy,
  restoreBunSandboxEnvironment,
  type BunSandboxEnvironmentOptions,
  type EnvironmentMap,
} from "../../runtime/network-policy";
import { isEmbeddedBuild } from "../../runtime/bundled-assets";
import { startCliDaemonSuccessor } from "../daemon-spawn";
import type { RuntimeRestartReservation } from "../../web/runtime-restart";

export interface ServeOptions {
  owner?: ServerOwner;
  token?: string;
  runtimeId?: string;
  rendererToken?: string;
  registerShutdownTrigger?: (requestShutdown: () => void) => (() => void);
  onReady?: (ready: { port: number; logPath: string; bootId: string }) => void;
  onExpectedRestart?: (bootId: string, transitionLease: RuntimeLease) => void;
  /** Startup environment seam for compiled-sandbox tests. */
  environment?: EnvironmentMap;
  environmentRestore?: BunSandboxEnvironmentOptions;
}

export async function runServe(
  host = "127.0.0.1",
  port = 3000,
  options: ServeOptions = {},
): Promise<number> {
  const environment = options.environment ?? process.env;
  restoreBunSandboxEnvironment(environment, options.environmentRestore);
  const token = options.token ?? environment[DAEMON_TOKEN_ENV] ?? randomUUID();
  const runtimeId = options.runtimeId ?? environment[DAEMON_RUNTIME_ID_ENV] ?? `direct:${process.pid}`;
  const owner = options.owner ?? daemonOwner(environment[DAEMON_OWNER_ENV]);
  delete environment[DAEMON_TOKEN_ENV];
  delete environment[DAEMON_RUNTIME_ID_ENV];
  delete environment[DAEMON_OWNER_ENV];
  const agentDir = getAgentDir();
  const bootId = randomUUID();
  let server: { port: number; stop: () => Promise<void> } | undefined;
  let serverLease: RuntimeLease | undefined;
  let ownsRecord = false;
  let serverStopped = false;
  let leaseReleased = false;
  let restartTransition: RuntimeLease | undefined;
  let restartTransitionReleaseAttempted = false;
  let restartReservationActive = false;
  let shutdownMode: "stop" | "restart" = "stop";
  let terminalShutdownRequested = false;
  const successorReadiness = new AbortController();
  let resolveShutdown: (() => void) | undefined;
  const shutdownRequested = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });
  const wakeShutdown = () => resolveShutdown?.();
  const requestTerminalShutdown = () => {
    terminalShutdownRequested = true;
    shutdownMode = "stop";
    if (!successorReadiness.signal.aborted) {
      successorReadiness.abort(new Error("EasyResearch terminal shutdown cancelled successor readiness."));
    }
    wakeShutdown();
  };
  const signalShutdown = () => requestTerminalShutdown();
  let unregisterShutdownTrigger: (() => void) | undefined;
  let exitCode = 1;

  const reserveRestart = async (): Promise<RuntimeRestartReservation> => {
    if (terminalShutdownRequested || restartReservationActive || restartTransition) {
      throw new Error("EasyResearch restart transition is unavailable.");
    }
    restartReservationActive = true;
    let transition: RuntimeLease;
    try {
      transition = await acquireTransitionLease(agentDir, owner, { timeoutMs: 0 });
    } catch (error) {
      restartReservationActive = false;
      throw error;
    }
    if (terminalShutdownRequested) {
      restartReservationActive = false;
      if (!transition.release()) {
        throw new Error("EasyResearch lost ownership of its restart transition lease.");
      }
      throw new Error("EasyResearch restart was superseded by terminal shutdown.");
    }

    let state: "reserved" | "committed" | "released" = "reserved";
    return {
      commit() {
        if (state !== "reserved") throw new Error("EasyResearch restart reservation was already consumed.");
        if (terminalShutdownRequested) {
          state = "released";
          restartReservationActive = false;
          if (!transition.release()) {
            throw new Error("EasyResearch lost ownership of its restart transition lease.");
          }
          throw new Error("EasyResearch restart was superseded by terminal shutdown.");
        }
        state = "committed";
        restartReservationActive = false;
        restartTransition = transition;
        shutdownMode = "restart";
        wakeShutdown();
      },
      release() {
        if (state !== "reserved") return false;
        state = "released";
        restartReservationActive = false;
        return transition.release();
      },
    };
  };
  const restartWasCommitted = (): boolean => shutdownMode === "restart";

  try {
    if (owner === "desktop" && !options.rendererToken) {
      throw new Error("EasyResearch desktop server requires renderer authentication.");
    }
    const { baseline: startupBaseline, policy: networkPolicy } = loadNetworkPolicy(
      agentDir,
      environment,
      options.environmentRestore,
    );
    applyNetworkPolicyEnvironment(networkPolicy, startupBaseline, environment);
    serverLease = await acquireServerLease(agentDir, owner, token);
    await bootstrapBundledResources();
    const { startServer } = await import("../../web/server");
    server = await startServer({
      host,
      port,
      bootId,
      networkPolicy,
      daemonControl: {
        token,
        runtimeId,
        requestShutdown: requestTerminalShutdown,
        reserveRestart,
      },
      ...(owner === "desktop" && options.rendererToken
        ? { desktopAccess: { token: options.rendererToken } }
        : {}),
    });
    writeServerProcess(agentDir, {
      schema: 1,
      owner,
      pid: process.pid,
      host,
      port: server.port,
      token,
      runtimeId,
    });
    ownsRecord = true;
    process.once("SIGTERM", signalShutdown);
    process.once("SIGINT", signalShutdown);
    unregisterShutdownTrigger = options.registerShutdownTrigger?.(requestTerminalShutdown);
    const logPath = serverLogFile(agentDir);
    options.onReady?.({ port: server.port, logPath, bootId });
    console.log(`EasyResearch server listening on http://${host}:${server.port}`);
    console.log(`Logs: ${logPath}`);
    await shutdownRequested;
    // Let the authenticated control response flush before closing the listener.
    await new Promise((resolve) => setTimeout(resolve, 25));
    await server.stop();
    serverStopped = true;
    if (!removeServerPid(agentDir, token, serverLease)) {
      throw new Error("EasyResearch server stopped but could not release its ownership record.");
    }
    ownsRecord = false;
    if (!serverLease.release()) {
      throw new Error("EasyResearch server stopped but could not release its live-server lease.");
    }
    leaseReleased = true;
    if (restartWasCommitted() && !terminalShutdownRequested) {
      if (!restartTransition) {
        throw new Error("EasyResearch restart transition ownership was not committed.");
      }
      options.onExpectedRestart?.(bootId, restartTransition);
    }
    if (restartWasCommitted() && owner === "cli" && !terminalShutdownRequested) {
      if (!restartTransition) {
        throw new Error("EasyResearch restart transition ownership was not committed.");
      }
      await startCliDaemonSuccessor({
        agentDir,
        daemonExecutable: process.execPath,
        sourceExecutable: process.execPath,
        sourceEntry: fileURLToPath(new URL("../index.ts", import.meta.url)),
        embedded: isEmbeddedBuild(),
        platform: process.platform,
        host,
        port: server.port,
        runtimeId,
        previousToken: token,
        oldBootId: bootId,
        oldPid: process.pid,
        currentEnvironment: environment,
        startupBaseline,
        signal: successorReadiness.signal,
        transitionLease: restartTransition,
      });
    }
    exitCode = 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    createLogger("web-server").error(`EasyResearch server failed to start: ${message}`);
    try {
      if (server && !serverStopped) {
        await server.stop();
        serverStopped = true;
      }
    } catch (cleanupError) {
      createLogger("web-server").error(
        `EasyResearch server cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      );
    }
    if (serverLease && !leaseReleased && (!server || serverStopped)) {
      if (ownsRecord) {
        try {
          ownsRecord = !removeServerPid(agentDir, token, serverLease);
        } catch (cleanupError) {
          createLogger("web-server").error(
            `EasyResearch ownership record cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          );
        }
      }
      try {
        leaseReleased = serverLease.release();
      } catch (cleanupError) {
        createLogger("web-server").error(
          `EasyResearch server lease cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        );
      }
    }
  } finally {
    unregisterShutdownTrigger?.();
    process.removeListener("SIGTERM", signalShutdown);
    process.removeListener("SIGINT", signalShutdown);
    if (restartTransition?.held && !restartTransitionReleaseAttempted) {
      restartTransitionReleaseAttempted = true;
      try {
        if (!restartTransition.release()) {
          throw new Error("EasyResearch lost ownership of its restart transition lease.");
        }
      } catch (error) {
        exitCode = 1;
        createLogger("web-server").error(
          `EasyResearch restart transition cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  return exitCode;
}

function daemonOwner(value: string | undefined): ServerOwner {
  return value === "desktop" ? "desktop" : "cli";
}
