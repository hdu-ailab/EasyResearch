import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { createAuthGateway, type AuthGateway } from "./auth-gateway";
import { ConfigFileService } from "./config-files";
import type { Logger } from "../runtime/logger";
import { createModelRuntimeTransaction } from "../runtime/model-runtime-transaction";
import type {
  ModelCatalogValidator,
  ModelCatalogEntry,
  PreparedModelCatalog,
} from "../runtime/live-configuration";
import type { AuthModelRuntime } from "./auth-gateway";

const DEFAULT_AUTH_FLOW_TIMEOUT_MS = 600_000;

const SAFE_MODEL_CATALOG_ERROR = "Model catalog validation failed.";

export interface AcceptedModelRuntime<T extends AuthModelRuntime = AuthModelRuntime>
  extends ModelCatalogValidator {
  /** Stable proxy delegated only to the last committed candidate runtime. */
  readonly runtime: T;
  getModelsJsonProviderIds(): ReadonlySet<string>;
  dispose(): Promise<void>;
}

export interface DaemonAuthRuntime {
  readonly auth: AuthGateway;
  readonly modelValidator: ModelCatalogValidator;
  readonly modelRuntime: AuthModelRuntime;
  dispose(): Promise<void>;
}

export interface DaemonAuthRuntimeOptions<T extends AuthModelRuntime> {
  config: ConfigFileService;
  logger: Logger;
  createModelRuntime: () => Promise<T>;
  synchronizeCatalog: () => Promise<void>;
  onModelsChanged: () => Promise<void>;
}

/**
 * Build the daemon's transactional accepted model authority. Preparation owns
 * a fresh runtime and never changes the stable proxy. LiveConfiguration invokes
 * the synchronous commit only after Agent/model/fingerprint validation.
 */
export function createAcceptedModelRuntime<T extends AuthModelRuntime>(
  createRuntime: () => Promise<T>,
  readProviderIds: () => Promise<ReadonlySet<string>> = async () => new Set(),
): AcceptedModelRuntime<T> {
  const transaction = createModelRuntimeTransaction(createRuntime);
  let acceptedProviderIds: ReadonlySet<string> = new Set();

  return {
    runtime: transaction.runtime,
    async prepareModelCatalog(): Promise<PreparedModelCatalog> {
      const candidate = await transaction.prepare();
      let owned = true;
      try {
        const result = await candidate.runtime.refresh({ allowNetwork: false });
        if (result.aborted || result.errors.size > 0) {
          throw result.errors.values().next().value ?? new Error("Model catalog refresh aborted");
        }
        const semanticError = candidate.runtime.getError();
        if (semanticError) throw new Error("Model catalog refresh failed", { cause: semanticError });
        const models = Object.freeze(
          candidate.runtime.getAvailableSnapshot().map(
            (model): ModelCatalogEntry => Object.freeze({ provider: model.provider, id: model.id }),
          ),
        );
        const providerIds = new Set(await readProviderIds());

        return {
          models,
          commit() {
            if (!owned) throw new Error("Model catalog candidate is already settled.");
            candidate.activate();
            acceptedProviderIds = providerIds;
            owned = false;
            void candidate.commit().catch(() => {
              // Retired runtime cleanup remains owned by the transaction.
            });
          },
          async rollback() {
            if (!owned) return;
            owned = false;
            await candidate.dispose();
          },
        };
      } catch (cause) {
        if (owned) {
          owned = false;
          try {
            await candidate.dispose();
          } catch {
            // Candidate cleanup cannot alter the accepted delegate.
          }
        }
        throw new Error(SAFE_MODEL_CATALOG_ERROR, { cause });
      }
    },
    getModelsJsonProviderIds: () => new Set(acceptedProviderIds),
    dispose: () => transaction.dispose(),
  };
}

export async function createDaemonAuthRuntime<T extends AuthModelRuntime>(
  options: DaemonAuthRuntimeOptions<T>,
): Promise<DaemonAuthRuntime> {
  const modelsPath = join(options.config.globalRoot, "models.json");
  const accepted = createAcceptedModelRuntime(
    options.createModelRuntime,
    () => readModelsJsonProviderIds(modelsPath),
  );
  const auth = createAuthGateway(accepted.runtime, undefined, {
    timeoutMs: await readAuthFlowTimeout(options.config),
    logger: options.logger,
    acceptedModelsJsonProviderIds: () => accepted.getModelsJsonProviderIds(),
    synchronizeCatalog: options.synchronizeCatalog,
    onModelsChanged: options.onModelsChanged,
  });
  return {
    auth,
    modelValidator: accepted,
    modelRuntime: accepted.runtime,
    dispose: () => accepted.dispose(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extract provider ids declared in `models.json` (custom providers the user
 * added by hand). A missing file is the valid empty configuration; actual
 * read, parse, and root-shape errors reject the catalog refresh.
 */
export async function readModelsJsonProviderIds(modelsPath: string): Promise<ReadonlySet<string>> {
  let content: string;
  try {
    content = await readFile(modelsPath, "utf8");
  } catch (cause) {
    if (isRecord(cause) && cause.code === "ENOENT") return new Set();
    throw new Error("Unable to read models.json", { cause });
  }

  let root: unknown;
  try {
    root = JSON.parse(stripPiJsonComments(content)) as unknown;
  } catch (cause) {
    throw new Error("Unable to parse models.json", { cause });
  }

  const providers = isRecord(root) ? root.providers : undefined;
  if (!isRecord(providers)) throw new Error('Invalid models.json: "providers" must be an object');
  return new Set(Object.keys(providers));
}

/** Match pinned Pi's accepted JSON syntax without importing Pi before bootstrap. */
function stripPiJsonComments(input: string): string {
  return input
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match[0] === '"' ? match : ""))
    .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail) => tail ?? (match[0] === '"' ? match : ""));
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
