import type { OpenWebSearchConfig } from "open-websearch/build/config.js";
import type { OpenWebSearchRuntime } from "open-websearch/build/runtime/createRuntime.js";
import { WEB_SEARCH_ENGINES, type OpenWebSearchService } from "./contracts";
import { ensureSearchAxiosInterceptorInstalled } from "./request-context";

export const FIXED_OPEN_WEBSEARCH_CONFIG: OpenWebSearchConfig = {
  defaultSearchEngine: "duckduckgo",
  allowedSearchEngines: [...WEB_SEARCH_ENGINES],
  searchMode: "request",
  proxyUrl: "http://127.0.0.1:7890",
  useProxy: false,
  fakeIpCidrs: [],
  fetchWebAllowInsecureTls: false,
  playwrightPackage: "auto",
  playwrightModulePath: undefined,
  playwrightExecutablePath: undefined,
  playwrightWsEndpoint: undefined,
  playwrightCdpEndpoint: undefined,
  playwrightHeadless: true,
  playwrightNavigationTimeoutMs: 30_000,
  enableCors: false,
  corsOrigin: "*",
  enableHttpServer: false,
};

export const OPEN_WEBSEARCH_ENV = {
  DEFAULT_SEARCH_ENGINE: "duckduckgo",
  ALLOWED_SEARCH_ENGINES: WEB_SEARCH_ENGINES.join(","),
  SEARCH_MODE: "request",
  PROXY_URL: "http://127.0.0.1:7890",
  USE_PROXY: "false",
  FAKE_IP_CIDRS: "",
  FETCH_WEB_INSECURE_TLS: "false",
  PLAYWRIGHT_PACKAGE: "auto",
  PLAYWRIGHT_MODULE_PATH: "",
  PLAYWRIGHT_EXECUTABLE_PATH: "",
  PLAYWRIGHT_WS_ENDPOINT: "",
  PLAYWRIGHT_CDP_ENDPOINT: "",
  PLAYWRIGHT_HEADLESS: "true",
  PLAYWRIGHT_NAVIGATION_TIMEOUT_MS: "30000",
  ENABLE_CORS: "false",
  CORS_ORIGIN: "*",
  MODE: "stdio",
  OPEN_WEBSEARCH_QUIET_STARTUP: "true",
} as const;

export interface InitializedOpenWebSearchRuntime {
  readonly config: OpenWebSearchConfig;
  readonly search: OpenWebSearchService;
}

type ConfigModule = typeof import("open-websearch/build/config.js");
type RuntimeModule = typeof import("open-websearch/build/runtime/createRuntime.js");
type EnvironmentSnapshot = Record<string, { present: boolean; value?: string }>;

function snapshotEnvironment(env: NodeJS.ProcessEnv): EnvironmentSnapshot {
  return Object.fromEntries(Object.keys(OPEN_WEBSEARCH_ENV).map((key) => [key, {
    present: Object.prototype.hasOwnProperty.call(env, key),
    value: env[key],
  }]));
}

function restoreEnvironment(env: NodeJS.ProcessEnv, snapshot: EnvironmentSnapshot): void {
  for (const [key, state] of Object.entries(snapshot)) {
    if (state.present) env[key] = state.value;
    else delete env[key];
  }
}

async function withTemporaryEnvironment<T>(
  env: NodeJS.ProcessEnv,
  operation: () => Promise<T>,
): Promise<T> {
  const snapshot = snapshotEnvironment(env);
  Object.assign(env, OPEN_WEBSEARCH_ENV);
  try {
    return await operation();
  } finally {
    restoreEnvironment(env, snapshot);
  }
}

function configMatches(actual: OpenWebSearchConfig): boolean {
  for (const [key, expected] of Object.entries(FIXED_OPEN_WEBSEARCH_CONFIG)) {
    const value = actual[key as keyof OpenWebSearchConfig];
    if (Array.isArray(expected)) {
      if (!Array.isArray(value) || value.length !== expected.length || value.some((item, index) => item !== expected[index])) {
        return false;
      }
    } else if (value !== expected) {
      return false;
    }
  }
  return true;
}

function validateRuntime(
  value: OpenWebSearchRuntime,
  sharedConfig: OpenWebSearchConfig,
): asserts value is OpenWebSearchRuntime {
  if (!value || typeof value !== "object") throw new Error("Open-WebSearch runtime is invalid");
  if (value.config !== sharedConfig || !configMatches(value.config)) {
    throw new Error("Open-WebSearch runtime did not retain the fixed shared config");
  }
  if (!value.services || typeof value.services.search?.execute !== "function") {
    throw new Error("Open-WebSearch runtime has no search service");
  }
}

export function createOpenWebSearchRuntimeInitializer(
  options: {
    env?: NodeJS.ProcessEnv;
    loadConfig?: () => Promise<ConfigModule>;
    loadRuntime?: () => Promise<RuntimeModule>;
  } = {},
): () => Promise<InitializedOpenWebSearchRuntime> {
  let pending: Promise<InitializedOpenWebSearchRuntime> | undefined;
  return () => pending ??= withTemporaryEnvironment(
    options.env ?? process.env,
    async () => {
      const configModule = await (options.loadConfig ?? (() => import("open-websearch/build/config.js")))();
      Object.assign(configModule.config, FIXED_OPEN_WEBSEARCH_CONFIG, {
        allowedSearchEngines: [...FIXED_OPEN_WEBSEARCH_CONFIG.allowedSearchEngines],
        fakeIpCidrs: [],
      });
      const runtimeModule = await (options.loadRuntime
        ?? (() => import("open-websearch/build/runtime/createRuntime.js")))();
      const runtime = runtimeModule.createOpenWebSearchRuntime({ config: configModule.config });
      validateRuntime(runtime, configModule.config);
      ensureSearchAxiosInterceptorInstalled();
      return {
        config: configModule.config,
        search: runtime.services.search as OpenWebSearchService,
      };
    },
  );
}

export const initializeOpenWebSearchRuntime = createOpenWebSearchRuntimeInitializer();
