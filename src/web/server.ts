import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createRouteHandler, type RouteServices } from "./routes";
import { ActiveSessionRegistry } from "./active-sessions";
import { PiRpcSessionFactory } from "./rpc-session";
import { DirectoryService } from "./directories";
import { ConfigFileService } from "./config-files";
import type { SessionSummaryDto } from "./contracts";

export interface Server {
  port: number;
  stop: () => Promise<void>;
}

const WEBUI_DIST = join(fileURLToPath(new URL("..", import.meta.url)), "webui", "dist");

/**
 * Start the Web panel backend on 127.0.0.1:3000. The server owns the active
 * session registry and stops every Pi RPC child on shutdown.
 */
export async function startServer(): Promise<Server> {
  const { importPi } = await import("../runtime/pi-import");
  const { assertNoUserExtensions } = await import("../runtime/extensions-guard");
  assertNoUserExtensions();
  const registry = new ActiveSessionRegistry(await PiRpcSessionFactory.resolve());
  const { SessionManager, getAgentDir } = await importPi();
  const agentDir = getAgentDir();
  const services: RouteServices = {
    webuiDist: WEBUI_DIST,
    listAllSessions: async () => {
      const sessions = await SessionManager.listAll(undefined);
      return sessions.map((s) => {
        const dto: SessionSummaryDto = {
          id: s.id,
          path: s.path,
          cwd: s.cwd,
          name: s.name,
          created: new Date(s.created).toISOString(),
          modified: new Date(s.modified).toISOString(),
          messageCount: s.messageCount,
          firstMessage: s.firstMessage,
        };
        return dto;
      });
    },
    directories: new DirectoryService(),
    registry,
    config: new ConfigFileService(agentDir),
  };
  const handler = createRouteHandler(services);

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 3000,
    fetch: handler,
  });

  return {
    port: server.port ?? 3000,
    stop: async () => {
      await registry.shutdown();
      server.stop(true);
    },
  };
}
