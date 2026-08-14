import { join } from "node:path";
import { createAuthGateway, type AuthGateway } from "./auth-gateway";

let cached: AuthGateway | null = null;

/**
 * Lazily construct the shared `AuthGateway` for the Web server process.
 *
 * Bootstraps the easyresearch identity (`importPi()`) before any Pi import,
 * resolves `agentDir`/`authPath`/`modelsPath` from the initialized
 * `getAgentDir()` (never the foreign `~/.pi`), builds a `ModelRuntime`
 * dedicated to auth operations, and wraps it in `createAuthGateway`.
 *
 * The Web server keeps one shared instance for its lifetime; RPC children
 * keep their own runtime reading the same `auth.json`. Tests inject a fake
 * gateway via `RouteServices.auth` directly and never call this.
 */
export async function getAuthGateway(): Promise<AuthGateway> {
  if (cached) return cached;
  const { importPi, getAgentDir } = await import("../runtime/pi-import");
  const { ModelRuntime } = await importPi();
  const agentDir = getAgentDir();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    refreshOnCreate: false,
  });
  cached = createAuthGateway(modelRuntime as never, undefined, { timeoutMs: 600_000 });
  return cached;
}

/**
 * Reset the cached gateway. Tests redirected to a temp HOME/agent dir call
 * this between cases to force a fresh `ModelRuntime` against the temp paths.
 */
export function resetAuthGatewayCacheForTests(): void {
  cached = null;
}