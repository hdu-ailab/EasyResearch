import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { createAuthGateway, type AuthGateway } from "./auth-gateway";
import { ConfigFileService } from "./config-files";
import type { Logger } from "../runtime/logger";
import { createModelRuntimeTransaction } from "../runtime/model-runtime-transaction";
import { parsePiSettingsJson } from "../runtime/pi-settings-json";
import type {
  ModelCatalogValidator,
  ModelCatalogEntry,
  PreparedModelCatalog,
} from "../runtime/live-configuration";
import type { AuthModelRuntime } from "./auth-gateway";

const DEFAULT_AUTH_FLOW_TIMEOUT_MS = 600_000;

const SAFE_MODEL_CATALOG_ERROR =
  "Model configuration issue in global models.json. Open models.json in Config to repair it.";
const NO_AUTH_RUNTIME_KEY = "easyresearch-no-auth";

export interface RuntimeApiKeyModelRuntime {
  setRuntimeApiKey(providerId: string, apiKey: string): Promise<void>;
}

export interface AcceptedModelRuntime<T extends AuthModelRuntime = AuthModelRuntime>
  extends ModelCatalogValidator {
  /** Stable proxy delegated only to the last committed candidate runtime. */
  readonly runtime: T;
  getModelsJsonProviderIds(): ReadonlySet<string>;
  getNoAuthProviderIds(): ReadonlySet<string>;
  dispose(): Promise<void>;
}

export interface DaemonAuthRuntime {
  readonly auth: AuthGateway;
  readonly modelValidator: ModelCatalogValidator;
  readonly modelRuntime: AuthModelRuntime;
  noAuthProviderIds(): ReadonlySet<string>;
  dispose(): Promise<void>;
}

export interface DaemonAuthRuntimeOptions<T extends AuthModelRuntime & RuntimeApiKeyModelRuntime> {
  config: ConfigFileService;
  logger: Logger;
  createModelRuntime: () => Promise<T>;
  synchronizeCatalog: () => Promise<void>;
  onModelsChanged: () => Promise<void>;
  resolveFallbackModel?: (
    runtime: T,
  ) => Promise<{ provider: string; id: string } | undefined>;
}

/**
 * Build the daemon's transactional accepted model authority. Preparation owns
 * a fresh runtime and never changes the stable proxy. LiveConfiguration invokes
 * the synchronous commit only after Agent/model/fingerprint validation.
 */
export function createAcceptedModelRuntime<T extends AuthModelRuntime>(
  createRuntime: () => Promise<T>,
  readProviderIds: () => Promise<ReadonlySet<string>> = async () => new Set(),
  resolveFallbackModel?: (
    runtime: T,
  ) => Promise<{ provider: string; id: string } | undefined>,
  readNoAuthProviderIds: () => Promise<ReadonlySet<string>> = async () => new Set(),
): AcceptedModelRuntime<T> {
  const transaction = createModelRuntimeTransaction(createRuntime);
  let acceptedProviderIds: ReadonlySet<string> = new Set();
  let acceptedNoAuthProviderIds: ReadonlySet<string> = new Set();

  return {
    runtime: transaction.runtime,
    currentAvailableModels() {
      return transaction.runtime.getAvailableSnapshot().map((model) => ({
        provider: model.provider,
        id: model.id,
      }));
    },
    async refreshAvailability() {
      try {
        await transaction.runtime.refresh({ allowNetwork: false });
      } catch {
        // Availability failures remain request/provider diagnostics, not host-config failures.
      }
      return transaction.runtime.getAvailableSnapshot().map((model) => ({
        provider: model.provider,
        id: model.id,
      }));
    },
    async prepareModelCatalog(): Promise<PreparedModelCatalog> {
      const candidate = await transaction.prepare();
      let owned = true;
      try {
        let diagnostic: string | undefined;
        try {
          const result = await candidate.runtime.refresh({ allowNetwork: false });
          if (result.aborted || result.errors.size > 0 || candidate.runtime.getError()) {
            diagnostic = SAFE_MODEL_CATALOG_ERROR;
          }
        } catch {
          diagnostic = SAFE_MODEL_CATALOG_ERROR;
        }
        const registeredModels = Object.freeze(
          [...candidate.runtime.getModels()].map(
            (model): ModelCatalogEntry => Object.freeze({ provider: model.provider, id: model.id }),
          ),
        );
        const availableModels = Object.freeze(
          candidate.runtime.getAvailableSnapshot().map(
            (model): ModelCatalogEntry => Object.freeze({ provider: model.provider, id: model.id }),
          ),
        );
        let resolvedFallback: { provider: string; id: string } | undefined;
        try {
          resolvedFallback = await resolveFallbackModel?.(candidate.runtime);
        } catch {
          // Fallback probing is recovery metadata; failure must not reject the
          // complete registered catalog or disable Provider/Settings surfaces.
        }
        const availableReferences = new Set(
          availableModels.map((model) => `${model.provider}/${model.id}`),
        );
        const fallbackModel = resolvedFallback
          && availableReferences.has(`${resolvedFallback.provider}/${resolvedFallback.id}`)
          ? Object.freeze({ provider: resolvedFallback.provider, id: resolvedFallback.id })
          : undefined;
        let providerIds: ReadonlySet<string> = new Set();
        let noAuthProviderIds: ReadonlySet<string> = new Set();
        try {
          providerIds = new Set(await readProviderIds());
          noAuthProviderIds = new Set(await readNoAuthProviderIds());
        } catch {
          diagnostic = SAFE_MODEL_CATALOG_ERROR;
        }

        return {
          registeredModels,
          availableModels,
          ...(fallbackModel ? { fallbackModel } : {}),
          ...(diagnostic ? { diagnostic } : {}),
          commit() {
            if (!owned) throw new Error("Model catalog candidate is already settled.");
            candidate.activate();
            acceptedProviderIds = providerIds;
            acceptedNoAuthProviderIds = noAuthProviderIds;
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
    getNoAuthProviderIds: () => new Set(acceptedNoAuthProviderIds),
    dispose: () => transaction.dispose(),
  };
}

export async function createDaemonAuthRuntime<T extends AuthModelRuntime & RuntimeApiKeyModelRuntime>(
  options: DaemonAuthRuntimeOptions<T>,
): Promise<DaemonAuthRuntime> {
  const modelsPath = join(options.config.globalRoot, "models.json");
  const accepted = createAcceptedModelRuntime(
    async () => {
      const runtime = await options.createModelRuntime();
      try {
        await configureNoAuthModelRuntime(runtime, modelsPath);
      } catch {
        // Pi's runtime keeps its built-in/default layer; candidate preparation
        // reports the malformed custom layer as a safe degraded diagnostic.
      }
      return runtime;
    },
    () => readModelsJsonProviderIds(modelsPath),
    options.resolveFallbackModel,
    () => readModelsJsonNoAuthProviderIds(modelsPath),
  );
  (await accepted.prepareModelCatalog()).commit();
  const auth = createAuthGateway(accepted.runtime, undefined, {
    timeoutMs: await readAuthFlowTimeout(options.config),
    logger: options.logger,
    acceptedModelsJsonProviderIds: () => accepted.getModelsJsonProviderIds(),
    acceptedNoAuthProviderIds: () => accepted.getNoAuthProviderIds(),
    synchronizeCatalog: options.synchronizeCatalog,
    onModelsChanged: options.onModelsChanged,
  });
  return {
    auth,
    modelValidator: accepted,
    modelRuntime: accepted.runtime,
    noAuthProviderIds: () => accepted.getNoAuthProviderIds(),
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
  const root = await readModelsJsonRoot(modelsPath);
  if (root === undefined) return new Set();
  const providers = root.providers;
  if (!isRecord(providers)) throw new Error('Invalid models.json: "providers" must be an object');
  return new Set(Object.keys(providers));
}

export async function readModelsJsonNoAuthProviderIds(modelsPath: string): Promise<ReadonlySet<string>> {
  const root = await readModelsJsonRoot(modelsPath);
  if (root === undefined) return new Set();
  const providers = root.providers;
  if (!isRecord(providers)) throw new Error('Invalid models.json: "providers" must be an object');
  return noAuthProviderIds(providers);
}

/**
 * Pi requires an auth resolution even for keyless compatible endpoints. Give
 * only complete, explicitly keyless custom providers a runtime-only key. The
 * public ModelRuntime API keeps this overlay out of auth.json.
 */
export async function configureNoAuthModelRuntime(
  runtime: RuntimeApiKeyModelRuntime,
  modelsPath: string,
): Promise<ReadonlySet<string>> {
  const root = await readModelsJsonRoot(modelsPath);
  if (root === undefined) return new Set();
  const providers = root.providers;
  if (!isRecord(providers)) throw new Error('Invalid models.json: "providers" must be an object');
  const providerIds = noAuthProviderIds(providers);
  for (const providerId of providerIds) {
    await runtime.setRuntimeApiKey(providerId, NO_AUTH_RUNTIME_KEY);
  }
  return providerIds;
}

function noAuthProviderIds(providers: Record<string, unknown>): ReadonlySet<string> {
  const providerIds = new Set<string>();
  for (const [providerId, value] of Object.entries(providers)) {
    const models = isRecord(value) && Array.isArray(value.models) ? value.models : [];
    const hasProviderBaseUrl = isRecord(value)
      && typeof value.baseUrl === "string"
      && value.baseUrl.trim().length > 0;
    const hasProviderApi = isRecord(value)
      && typeof value.api === "string"
      && value.api.trim().length > 0;
    const modelsAreComplete = models.length > 0 && models.every((model) =>
      isRecord(model)
      && (hasProviderBaseUrl || (typeof model.baseUrl === "string" && model.baseUrl.trim().length > 0))
      && (hasProviderApi || (typeof model.api === "string" && model.api.trim().length > 0))
    );
    if (
      !isRecord(value)
      || !modelsAreComplete
      || Object.hasOwn(value, "apiKey")
      || Object.hasOwn(value, "oauth")
    ) continue;
    providerIds.add(providerId);
  }
  return providerIds;
}

export async function createConfiguredModelRuntime<
  T extends RuntimeApiKeyModelRuntime & { getError(): string | undefined },
>(
  createRuntime: (modelsPath: string | null) => Promise<T>,
  modelsPath: string,
  decorateRuntime: (runtime: T) => T,
): Promise<T> {
  const createCandidate = async (candidatePath: string | null): Promise<T> =>
    decorateRuntime(await createRuntime(candidatePath));
  const runtime = await createCandidate(modelsPath);
  if (runtime.getError()) return createCandidate(null);
  try {
    await configureNoAuthModelRuntime(runtime, modelsPath);
  } catch {
    return createCandidate(null);
  }
  return runtime.getError() ? createCandidate(null) : runtime;
}

async function readModelsJsonRoot(modelsPath: string): Promise<Record<string, unknown> | undefined> {
  let content: string;
  try {
    content = await readFile(modelsPath, "utf8");
  } catch (cause) {
    if (isRecord(cause) && cause.code === "ENOENT") return undefined;
    throw new Error("Unable to read models.json", { cause });
  }

  let root: unknown;
  try {
    root = parsePiJsonObject(content);
  } catch (cause) {
    throw new Error("Unable to parse models.json", { cause });
  }

  if (!isRecord(root)) throw new Error("Invalid models.json: root must be an object");
  return root;
}

export function parsePiJsonObject(content: string): Record<string, unknown> {
  const root = JSON.parse(stripPiJsonComments(content)) as unknown;
  if (!isRecord(root)) throw new Error("JSON root must be an object");
  return root;
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
    return resolveAuthFlowTimeout(parsePiSettingsJson(content));
  } catch {
    return DEFAULT_AUTH_FLOW_TIMEOUT_MS;
  }
}
