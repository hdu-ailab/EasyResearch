import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { routeRequest } from "./routes";

export interface ServerOptions {
  port?: number;
}

export interface Server {
  port: number;
  stop: () => Promise<void>;
}

const WEBUI_DIST = join(fileURLToPath(new URL("..", import.meta.url)), "webui", "dist");

/**
 * Start the Web panel backend. Bun HTTP server; request handling is delegated
 * to the pure `routeRequest` in routes.ts (node-compatible, unit-testable).
 */
export async function startServer(options: ServerOptions = {}): Promise<Server> {
  const server = Bun.serve<undefined>({
    port: options.port ?? 3000,
    async fetch(req) {
      return routeRequest(req, WEBUI_DIST);
    },
  });

  return {
    port: server.port ?? options.port ?? 3000,
    stop: () => server.stop(true),
  };
}
