export interface WebCommandOptions {
  port?: number;
}

/**
 * `lazypaper web` — start the Web panel (Bun HTTP + SSE backend).
 * MVP placeholder: starts the server on the given port (default 3000).
 */
export async function runWeb(options: WebCommandOptions = {}): Promise<void> {
  const { startServer } = await import("../../web/server");
  const server = await startServer({ port: options.port });
  console.log(`LazyResearch Web panel: http://localhost:${server.port}`);
  return new Promise(() => {
    // keep alive until interrupted
  });
}
