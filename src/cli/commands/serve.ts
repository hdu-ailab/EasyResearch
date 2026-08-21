import { randomUUID } from "node:crypto";
import { getAgentDir } from "../../runtime/pi-import";
import { createLogger } from "../../runtime/logger";
import {
  DAEMON_RUNTIME_ID_ENV,
  DAEMON_TOKEN_ENV,
  removeServerPid,
  serverLogFile,
  writeServerProcess,
} from "../server-process";
import { bootstrapBundledResources } from "../../bootstrap/resources";
import { DEFAULT_HOST } from "../index";

export async function runServe(host = DEFAULT_HOST, port = 3000): Promise<number> {
  const agentDir = getAgentDir();
  const token = process.env[DAEMON_TOKEN_ENV] ?? randomUUID();
  const runtimeId = process.env[DAEMON_RUNTIME_ID_ENV] ?? `direct:${process.pid}`;
  delete process.env[DAEMON_TOKEN_ENV];
  delete process.env[DAEMON_RUNTIME_ID_ENV];
  let server: { port: number; stop: () => Promise<void> } | undefined;
  let ownsRecord = false;
  let serverStopped = false;
  let resolveShutdown: (() => void) | undefined;
  const shutdownRequested = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });
  const requestShutdown = () => resolveShutdown?.();
  const signalShutdown = () => requestShutdown();

  try {
    await bootstrapBundledResources();
    const { startServer } = await import("../../web/server");
    server = await startServer({
      host,
      port,
      daemonControl: { token, runtimeId, requestShutdown },
    });
    writeServerProcess(agentDir, {
      schema: 1,
      pid: process.pid,
      host,
      port: server.port,
      token,
      runtimeId,
    });
    ownsRecord = true;
    process.once("SIGTERM", signalShutdown);
    process.once("SIGINT", signalShutdown);
    console.log(`EasyResearch server listening on http://${host}:${server.port}`);
    console.log(`Logs: ${serverLogFile(agentDir)}`);
    await shutdownRequested;
    // Let the authenticated control response flush before closing the listener.
    await new Promise((resolve) => setTimeout(resolve, 25));
    await server.stop();
    serverStopped = true;
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
    if (ownsRecord && serverStopped) removeServerPid(agentDir, token);
    return 1;
  } finally {
    process.removeListener("SIGTERM", signalShutdown);
    process.removeListener("SIGINT", signalShutdown);
  }
}
