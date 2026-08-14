import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { createAuthGateway, type AuthGateway } from "./auth-gateway";
import { ConfigFileService } from "./config-files";
import type { Logger } from "../runtime/logger";

const DEFAULT_AUTH_FLOW_TIMEOUT_MS = 600_000;

let cached: AuthGateway | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extract provider ids declared in `models.json` (custom providers the user
 * added by hand). Never throws: unreadable/invalid files yield an empty set,
 * which only disables pinning of custom providers, never the auth flows.
 */
export async function readModelsJsonProviderIds(modelsPath: string): Promise<ReadonlySet<string>> {
  try {
    const content = await readFile(modelsPath, "utf8");
    const root = JSON.parse(content) as unknown;
    const providers = isRecord(root) ? root.providers : undefined;
    if (!isRecord(providers)) return new Set();
    return new Set(Object.keys(providers));
  } catch {
    return new Set();
  }
}

/**
 * Resolve the auth-flow timeout from global `settings.json`
 * `easyresearch.web.authFlowTimeoutMs`. `0` disables, `-1` never expires,
 * positive safe integers win, anything else falls back to the 10-minute
 * default (mirrors `readWebSessionIdleTimeout` semantics).
 */
export function resolveAuthFlowTimeout(settings: unknown): number {
  const root = isRecord(settings) ? settings : undefined;
  const easyresearch = isRecord(root?.easyresearch) ? root.easyresearch : undefined;
  const web = isRecord(easyresearch?.web) ? easyresearch.web : undefined;
  const value = web?.authFlowTimeoutMs;
  if (value === -1 || value === 0) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  return DEFAULT_AUTH_FLOW_TIMEOUT_MS;
}

async function readAuthFlowTimeout(config: ConfigFileService): Promise<number> {
  try {
    const content = await config.read({ scope: "global", path: "settings.json" });
    return resolveAuthFlowTimeout(JSON.parse(content) as unknown);
  } catch {
    return DEFAULT_AUTH_FLOW_TIMEOUT_MS;
  }
}

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
export async function getAuthGateway(logger: Logger): Promise<AuthGateway> {
  if (cached) return cached;
  const { importPi, getAgentDir } = await import("../runtime/pi-import");
  const { ModelRuntime } = await importPi();
  const agentDir = getAgentDir();
  const config = new ConfigFileService(agentDir);
  const timeoutMs = await readAuthFlowTimeout(config);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    refreshOnCreate: false,
  });
  const modelsJsonProviderIds = await readModelsJsonProviderIds(join(agentDir, "models.json"));
  cached = createAuthGateway(modelRuntime as never, undefined, {
    timeoutMs,
    logger,
    modelsJsonProviderIds,
  });
  return cached;
}

/**
 * Reset the cached gateway. Tests redirected to a temp HOME/agent dir call
 * this between cases to force a fresh `ModelRuntime` against the temp paths.
 */
export function resetAuthGatewayCacheForTests(): void {
  cached = null;
}