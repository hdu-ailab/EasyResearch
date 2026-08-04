import { installBundledSkills } from "../../config";

export interface WebCommandOptions {
  port?: number;
}

/**
 * `lazypaper web` — start the Web panel (Bun HTTP + SSE backend).
 */
export async function runWeb(options: WebCommandOptions = {}): Promise<void> {
  installBundledSkills();
  const { startServer } = await import("../../web/server");
  const server = await startServer({ port: options.port });
  console.log(`LazyResearch Web panel: http://localhost:${server.port}`);
  return new Promise(() => {
    // keep alive until interrupted
  });
}
