import { getAgentDir } from "../../runtime/pi-import";
import { createLogger } from "../../runtime/logger";
import { serverLogFile, writeServerPid } from "../server-process";
import { bootstrapBundledResources } from "../../bootstrap/resources";
import { DEFAULT_HOST } from "../index";

export async function runServe(host = DEFAULT_HOST, port = 3000): Promise<number> {
  const agentDir = getAgentDir();
  writeServerPid(agentDir, process.pid);
  const onExit = async (): Promise<void> => {
    const { startServer } = await import("../../web/server");
    const server = await startServer({ host, port });
    const shutdown = async (): Promise<void> => {
      await server.stop();
      const { removeServerPid } = await import("../server-process");
      removeServerPid(agentDir);
      process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    console.log(`EasyResearch server listening on http://${host}:${server.port}`);
    console.log(`Logs: ${serverLogFile(agentDir)}`);
    return new Promise(() => {});
  };
  try {
    await bootstrapBundledResources();
    await onExit();
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    createLogger("web-server").error(`EasyResearch server failed to start: ${message}`);
    const { removeServerPid } = await import("../server-process");
    removeServerPid(agentDir);
    return 1;
  }
}
