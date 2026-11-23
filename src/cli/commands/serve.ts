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
import { localHttpOrigin } from "../local-http";
import type { RuntimeRestartReservation } from "../../web/runtime-restart";
import type { Server } from "../../web/server";
import { consumeNpmProvenance, NPM_PROVENANCE_ENV, type NpmProvenance } from "../../runtime/npm-update-provenance";
import type { NpmUpdateCandidate } from "../../runtime/npm-update";
import { prepareNpmUpdateBoot, type NpmUpdateServeRequest } from "../npm-update-entry";
import { discardNpmUpdateCandidate, reclaimNpmUpdateArtifacts, registerNpmArtifactProcess } from "../npm-update-artifact";

export interface ServeOptions {
  npmProvenance?: NpmProvenance;
  updateBoot?: NpmUpdateServeRequest;
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
  const receivedProvenance = consumeNpmProvenance(environment);
  const npmProvenance = options.npmProvenance ?? receivedProvenance;
  const token = options.token ?? environment[DAEMON_TOKEN_ENV] ?? randomUUID();
  const runtimeId = options.runtimeId ?? environment[DAEMON_RUNTIME_ID_ENV] ?? `direct:${process.pid}`;
  const owner = options.owner ?? daemonOwner(environment[DAEMON_OWNER_ENV]);
  delete environment[DAEMON_TOKEN_ENV];
  delete environment[DAEMON_RUNTIME_ID_ENV];
  delete environment[DAEMON_OWNER_ENV];
  const agentDir = getAgentDir();
  const bootId = randomUUID();
  let server: Server | undefined;
  let serverLease: RuntimeLease | undefined;
  let ownsRecord = false;
  let serverStopped = false;
  let backgroundHandoffPrepared = false;
  let leaseReleased = false;
  let restartTransition: RuntimeLease | undefined;
  let restartTransitionReleaseAttempted = false;
  let restartReservationActive = false;
  let shutdownMode: "stop" | "restart" | "update" = "stop";
  let updateTransition: RuntimeLease | undefined;
  let updateCandidate: NpmUpdateCandidate | undefined;
  let updateActivated = false;
  let retainUpdateCustody = false;
  let executableUse: ReturnType<typeof registerNpmArtifactProcess>;
  let reclaimTimer: ReturnType<typeof setTimeout> | undefined;
  let reclaimTask: Promise<void> | undefined;
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
    server?.beginShutdown?.();
    if (!successorReadiness.signal.aborted) {
      successorReadiness.abort(new Error("EasyResearch terminal shutdown cancelled successor readiness."));
    }
    wakeShutdown();
  };
  const signalShutdown = () => requestTerminalShutdown();
  let unregisterShutdownTrigger: (() => void) | undefined;
  let exitCode = 1;

  const revokePreparedBackground = async () => {
    if (!backgroundHandoffPrepared || !server) return;
    // The predecessor may have released its server lease while awaiting readiness.
    // Reacquisition proves the successor has stopped its writers before fresh native
    // root/child journals are opened. A still-live successor remains fail-closed.
    const revocationLease = serverLease?.held ? undefined
      : await acquireServerLease(agentDir, owner, token, { timeoutMs: 0 });
    try {
      await server.stop();
      backgroundHandoffPrepared = false;
    } finally {
      if (revocationLease && !revocationLease.release()) throw new Error("EasyResearch could not release background-revocation ownership.");
    }
  };

  const reserveRestart = async (): Promise<RuntimeRestartReservation> => {
    if (terminalShutdownRequested || restartReservationActive || restartTransition || updateTransition) {
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
  const updateWasCommitted = (): boolean => shutdownMode === "update";
  const reserveUpdate = async (): Promise<RuntimeLease> => {
    if (owner !== "cli" || terminalShutdownRequested || restartReservationActive || restartTransition || updateTransition) throw new Error("Update transition is unavailable.");
    restartReservationActive = true;
    try {
      const lease = await acquireTransitionLease(agentDir, "cli", { timeoutMs: 0 });
      if (terminalShutdownRequested) { lease.release(); throw new Error("Update was cancelled by terminal shutdown."); }
      const handle: RuntimeLease = {
        get path() { return lease.path; }, get token() { return lease.token; }, get held() { return lease.held; },
        reserveHandoff: (childToken) => lease.reserveHandoff(childToken),
        release: () => { const released = lease.release(); if (released && updateTransition === handle) updateTransition = undefined; return released; },
      };
      updateTransition = handle;
      return handle;
    } finally { restartReservationActive = false; }
  };

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
    executableUse = registerNpmArtifactProcess(process.execPath);
    if (options.updateBoot) await prepareNpmUpdateBoot(options.updateBoot, agentDir);
    await bootstrapBundledResources();
    const { startServer } = await import("../../web/server");
    server = await startServer({
      host,
      port,
      ownsExclusiveServerLease: serverLease.held,
      bootId,
      networkPolicy,
      npmUpdate: {
        provenance: npmProvenance,
        reserve: reserveUpdate,
        activate(candidate, lease) {
          if (owner !== "cli" || terminalShutdownRequested || lease !== updateTransition || !lease.held) throw new Error("Update transition ownership changed.");
          // This is terminal shutdown of old-version work, never a prepared background handover.
          server?.beginShutdown?.();
          restartTransition = lease;
          updateTransition = undefined;
          updateCandidate = candidate;
          shutdownMode = "update";
          wakeShutdown();
        },
      },
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
    // One bounded boot-time retry lets the predecessor actually exit (and
    // release Windows executable locks). Later explicit checks/startups retry
    // any still-owned receipts; this is not a permanent polling service.
    reclaimTimer = setTimeout(() => { reclaimTask = reclaimNpmUpdateArtifacts(agentDir).catch(() => {}); }, 1500);
    reclaimTimer.unref?.();
    console.log(`EasyResearch server listening on ${localHttpOrigin(host, server.port)}`);
    console.log(`Logs: ${logPath}`);
    await shutdownRequested;
    // Let the authenticated control response flush before closing the listener.
    await new Promise((resolve) => setTimeout(resolve, 25));
    backgroundHandoffPrepared = restartWasCommitted() && !terminalShutdownRequested;
    await server.stop(backgroundHandoffPrepared ? { restart: true } : undefined);
    if (terminalShutdownRequested && backgroundHandoffPrepared) {
      await revokePreparedBackground();
    }
    serverStopped = true;
    if (!backgroundHandoffPrepared) executableUse?.retire();
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
    if ((restartWasCommitted() || updateWasCommitted()) && owner === "cli" && !terminalShutdownRequested) {
      if (!restartTransition) {
        throw new Error("EasyResearch restart transition ownership was not committed.");
      }
      await startCliDaemonSuccessor({
        agentDir,
        daemonExecutable: updateCandidate?.executable ?? process.execPath,
        sourceExecutable: process.execPath,
        sourceEntry: fileURLToPath(new URL("../index.ts", import.meta.url)),
        embedded: updateCandidate !== undefined || isEmbeddedBuild(),
        platform: process.platform,
        host,
        port: server.port,
        runtimeId: updateCandidate?.runtimeId ?? runtimeId,
        ...(updateCandidate ? { updateCandidate: { version: updateCandidate.version, sha256: updateCandidate.sha256 }, expectedVersion: updateCandidate.version, readyTimeoutMs: 10 * 60_000 } : {}),
        previousToken: token,
        oldBootId: bootId,
        oldPid: process.pid,
        currentEnvironment: { ...environment, ...(npmProvenance ? { [NPM_PROVENANCE_ENV]: JSON.stringify({ ...npmProvenance, version: updateCandidate?.version ?? npmProvenance.version }) } : {}) },
        startupBaseline,
        signal: successorReadiness.signal,
        transitionLease: restartTransition,
      });
      updateActivated = !successorReadiness.signal.aborted;
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
        executableUse?.retire();
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
    clearTimeout(reclaimTimer);
    await reclaimTask;
    if (terminalShutdownRequested && backgroundHandoffPrepared && server) {
      try { await revokePreparedBackground(); }
      catch (error) {
        exitCode = 1;
        createLogger("web-server").error(`EasyResearch terminal background cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    unregisterShutdownTrigger?.();
    process.removeListener("SIGTERM", signalShutdown);
    process.removeListener("SIGINT", signalShutdown);
    if (!server) { try { executableUse?.retire(); } catch { exitCode = 1; } }
    if (serverStopped || !server) executableUse?.close();
    if (updateCandidate && !updateActivated && restartTransition?.held) {
      try { await discardNpmUpdateCandidate(updateCandidate); }
      catch {
        retainUpdateCustody = true;
        exitCode = 1;
        createLogger("web-server").error("Update executable cleanup is pending; transition custody is retained.");
      }
    }
    if (restartTransition?.held && !restartTransitionReleaseAttempted && !retainUpdateCustody) {
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
