import { randomUUID } from "node:crypto";
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
import { acquireServerLease, type RuntimeLease } from "../runtime-lease";
import { bootstrapBundledResources } from "../../bootstrap/resources";

export interface ServeOptions {
  owner?: ServerOwner;
  token?: string;
  runtimeId?: string;
  rendererToken?: string;
  registerShutdownTrigger?: (requestShutdown: () => void) => (() => void);
  onReady?: (ready: { port: number; logPath: string }) => void;
}

export async function runServe(
  host = "127.0.0.1",
  port = 3000,
  options: ServeOptions = {},
): Promise<number> {
  const agentDir = getAgentDir();
  const token = options.token ?? process.env[DAEMON_TOKEN_ENV] ?? randomUUID();
  const runtimeId = options.runtimeId ?? process.env[DAEMON_RUNTIME_ID_ENV] ?? `direct:${process.pid}`;
  const owner = options.owner ?? daemonOwner(process.env[DAEMON_OWNER_ENV]);
  delete process.env[DAEMON_TOKEN_ENV];
  delete process.env[DAEMON_RUNTIME_ID_ENV];
  delete process.env[DAEMON_OWNER_ENV];
  let server: { port: number; stop: () => Promise<void> } | undefined;
  let serverLease: RuntimeLease | undefined;
  let ownsRecord = false;
  let serverStopped = false;
  let leaseReleased = false;
  let resolveShutdown: (() => void) | undefined;
  const shutdownRequested = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });
  const requestShutdown = () => resolveShutdown?.();
  const signalShutdown = () => requestShutdown();
  let unregisterShutdownTrigger: (() => void) | undefined;

  try {
    if (owner === "desktop" && !options.rendererToken) {
      throw new Error("EasyResearch desktop server requires renderer authentication.");
    }
    serverLease = await acquireServerLease(agentDir, owner, token);
    await bootstrapBundledResources();
    const { startServer } = await import("../../web/server");
    server = await startServer({
      host,
      port,
      daemonControl: { token, runtimeId, requestShutdown },
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
    unregisterShutdownTrigger = options.registerShutdownTrigger?.(requestShutdown);
    const logPath = serverLogFile(agentDir);
    options.onReady?.({ port: server.port, logPath });
    console.log(`EasyResearch server listening on http://${host}:${server.port}`);
    console.log(`Logs: ${logPath}`);
    await shutdownRequested;
    // Let the authenticated control response flush before closing the listener.
    await new Promise((resolve) => setTimeout(resolve, 25));
    await server.stop();
    serverStopped = true;
    if (!serverLease.release()) {
      throw new Error("EasyResearch server stopped but could not release its live-server lease.");
    }
    leaseReleased = true;
    removeServerPid(agentDir, token);
    ownsRecord = false;
    return 0;
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
      try {
        leaseReleased = serverLease.release();
      } catch (cleanupError) {
        createLogger("web-server").error(
          `EasyResearch server lease cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        );
      }
    }
    if (ownsRecord && serverStopped && leaseReleased) removeServerPid(agentDir, token);
    return 1;
  } finally {
    unregisterShutdownTrigger?.();
    process.removeListener("SIGTERM", signalShutdown);
    process.removeListener("SIGINT", signalShutdown);
  }
}

function daemonOwner(value: string | undefined): ServerOwner {
  return value === "desktop" ? "desktop" : "cli";
}
