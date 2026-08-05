import { bootstrapBundledResources } from "../../bootstrap/resources";

/**
 * `lazyresearch web` — start the Web panel (Bun HTTP + SSE backend) on 127.0.0.1:3000.
 * Accepts no additional arguments.
 */
export async function runWeb(): Promise<void> {
  await bootstrapBundledResources();
  const { startServer } = await import("../../web/server");
  const server = await startServer();
  console.log(`LazyResearch Web panel: http://localhost:${server.port}`);
  return new Promise(() => {
    // keep alive until interrupted
  });
}