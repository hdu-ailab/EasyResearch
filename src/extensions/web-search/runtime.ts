import type { OpenWebSearchConfig } from "open-websearch/build/config.js";
import type { OpenWebSearchRuntime } from "open-websearch/build/runtime/createRuntime.js";
import type {
  AppliedSearchRoute,
  SearchProxyConfiguration,
} from "../../runtime/network-routing";
import { WEB_SEARCH_ENGINES, type OpenWebSearchService } from "./contracts";
import {
  ensureSearchAxiosInterceptorInstalled,
  type SearchRequestRouting,
} from "./request-context";

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
  readonly requestRouting: SearchRequestRouting;
  readonly search: OpenWebSearchService;
}

type ConfigModule = typeof import("open-websearch/build/config.js");
type RuntimeModule = typeof import("open-websearch/build/runtime/createRuntime.js");
type EnvironmentSnapshot = Record<string, { present: boolean; value?: string }>;

interface OpenWebSearchRequestAgents {
  readonly httpAgent?: unknown;
  readonly httpsAgent?: unknown;
}

interface HttpRequestModule {
  buildAxiosRequestOptions(): OpenWebSearchRequestAgents;
}

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

function configMatches(actual: OpenWebSearchConfig, expectedConfig: OpenWebSearchConfig): boolean {
  for (const [key, expected] of Object.entries(expectedConfig)) {
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
  expectedConfig: OpenWebSearchConfig,
): asserts value is OpenWebSearchRuntime {
  if (!value || typeof value !== "object") throw new Error("Open-WebSearch runtime is invalid");
  if (value.config !== sharedConfig || !configMatches(value.config, expectedConfig)) {
    throw new Error("Open-WebSearch runtime did not retain the fixed shared config");
  }
  if (!value.services || typeof value.services.search?.execute !== "function") {
    throw new Error("Open-WebSearch runtime has no search service");
  }
}

interface OpenWebSearchInitializerOptions {
  env?: NodeJS.ProcessEnv;
  loadConfig?: () => Promise<ConfigModule>;
  loadHttpRequest?: () => Promise<HttpRequestModule>;
  loadRuntime?: () => Promise<RuntimeModule>;
}

class NetworkProxyRestartRequiredError extends Error {
  readonly code = "NETWORK_PROXY_RESTART_REQUIRED" as const;

  constructor() {
    super("The applied Search network route changed; restart EasyResearch before initializing Open-WebSearch again.");
    this.name = "NetworkProxyRestartRequiredError";
  }
}

function defaultErrorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "Open-WebSearch initialization failed.";
  }
}

const DIRECT_SEARCH_ROUTE: AppliedSearchRoute = Object.freeze({
  policyFingerprint: "direct",
  applyProxyConfiguration(config: SearchProxyConfiguration) {
    config.useProxy = false;
  },
  bypasses: () => false,
  invalidError: () => undefined,
  sanitizeError: defaultErrorMessage,
});

function configForRoute(route: AppliedSearchRoute): OpenWebSearchConfig {
  const config: OpenWebSearchConfig = {
    ...FIXED_OPEN_WEBSEARCH_CONFIG,
    allowedSearchEngines: [...FIXED_OPEN_WEBSEARCH_CONFIG.allowedSearchEngines],
    fakeIpCidrs: [],
  };
  route.applyProxyConfiguration(config);
  return config;
}

function requireRequestAgents(
  options: OpenWebSearchRequestAgents,
  label: string,
): Readonly<{ httpAgent: unknown; httpsAgent: unknown }> {
  if (!options.httpAgent || !options.httpsAgent) {
    throw new Error(`Open-WebSearch ${label} request agents are unavailable`);
  }
  return Object.freeze({
    httpAgent: options.httpAgent,
    httpsAgent: options.httpsAgent,
  });
}

function createSearchRequestRouting(
  route: AppliedSearchRoute,
  direct: Readonly<{ httpAgent: unknown; httpsAgent: unknown }>,
  routed: Readonly<{ httpAgent: unknown; httpsAgent: unknown }>,
): SearchRequestRouting {
  return Object.freeze({
    bypasses: (url: string) => route.bypasses?.(url) ?? false,
    directAgentsFor(httpAgent: unknown, httpsAgent: unknown) {
      if (httpAgent !== routed.httpAgent && httpsAgent !== routed.httpsAgent) {
        return undefined;
      }
      return direct;
    },
  });
}

export function createAppliedOpenWebSearchRuntimeInitializer(
  options: OpenWebSearchInitializerOptions = {},
): (route: AppliedSearchRoute) => Promise<InitializedOpenWebSearchRuntime> {
  let policyFingerprint: string | undefined;
  let pending: Promise<InitializedOpenWebSearchRuntime> | undefined;
  return (route) => {
    if (policyFingerprint !== undefined && policyFingerprint !== route.policyFingerprint) {
      return Promise.reject(new NetworkProxyRestartRequiredError());
    }
    if (pending) return pending;
    policyFingerprint = route.policyFingerprint;

    const invalid = route.invalidError();
    if (invalid) {
      pending = Promise.reject(invalid);
      return pending;
    }

    const expectedConfig = configForRoute(route);
    pending = withTemporaryEnvironment(
      options.env ?? process.env,
      async () => {
        const configModule = await (options.loadConfig ?? (() => import("open-websearch/build/config.js")))();
        Object.assign(configModule.config, FIXED_OPEN_WEBSEARCH_CONFIG, {
          allowedSearchEngines: [...FIXED_OPEN_WEBSEARCH_CONFIG.allowedSearchEngines],
          fakeIpCidrs: [],
        });
        const httpRequestModule = await (options.loadHttpRequest ?? (() => (
          // @ts-expect-error Open-WebSearch does not publish types for this pinned deep runtime.
          import("open-websearch/build/utils/httpRequest.js") as unknown as Promise<HttpRequestModule>
        )))();
        const directAgents = requireRequestAgents(
          httpRequestModule.buildAxiosRequestOptions(),
          "direct",
        );
        Object.assign(configModule.config, expectedConfig, {
          allowedSearchEngines: [...expectedConfig.allowedSearchEngines],
          fakeIpCidrs: [],
        });
        const routedAgents = requireRequestAgents(
          httpRequestModule.buildAxiosRequestOptions(),
          expectedConfig.useProxy ? "proxy" : "direct",
        );
        const runtimeModule = await (options.loadRuntime
          ?? (() => import("open-websearch/build/runtime/createRuntime.js")))();
        const runtime = runtimeModule.createOpenWebSearchRuntime({ config: configModule.config });
        validateRuntime(runtime, configModule.config, expectedConfig);
        ensureSearchAxiosInterceptorInstalled();
        return {
          config: configModule.config,
          requestRouting: createSearchRequestRouting(route, directAgents, routedAgents),
          search: runtime.services.search as OpenWebSearchService,
        };
      },
    );
    return pending;
  };
}

export function createOpenWebSearchRuntimeInitializer(
  options: OpenWebSearchInitializerOptions = {},
): () => Promise<InitializedOpenWebSearchRuntime> {
  const initialize = createAppliedOpenWebSearchRuntimeInitializer(options);
  return () => initialize(DIRECT_SEARCH_ROUTE);
}

const initializeSharedOpenWebSearchRuntime = createAppliedOpenWebSearchRuntimeInitializer();

export const initializeOpenWebSearchRuntimeForRoute = (
  route: AppliedSearchRoute,
): Promise<InitializedOpenWebSearchRuntime> => initializeSharedOpenWebSearchRuntime(route);

export const initializeOpenWebSearchRuntime = (
): Promise<InitializedOpenWebSearchRuntime> => initializeSharedOpenWebSearchRuntime(DIRECT_SEARCH_ROUTE);
