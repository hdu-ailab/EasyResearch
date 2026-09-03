import axios, {
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureInheritedProxyEnvironment,
  parseNetworkProxySettings,
  resolveNetworkPolicy,
} from "../../runtime/network-policy";
import {
  createAppliedSearchRoute,
  type AppliedSearchRoute,
} from "../../runtime/network-routing";
import { createWebSearchAdapter } from "./adapter";
import {
  type SearchRequestRouting,
  withSearchRequestDeadline,
} from "./request-context";
import {
  FIXED_OPEN_WEBSEARCH_CONFIG,
  OPEN_WEBSEARCH_ENV,
  createAppliedOpenWebSearchRuntimeInitializer,
  createOpenWebSearchRuntimeInitializer,
  type InitializedOpenWebSearchRuntime,
} from "./runtime";

type EnvSnapshot = Record<string, { present: boolean; value?: string }>;

function snapshotEnvironment(env: NodeJS.ProcessEnv): EnvSnapshot {
  return Object.fromEntries(Object.keys(OPEN_WEBSEARCH_ENV).map((key) => [key, {
    present: Object.prototype.hasOwnProperty.call(env, key),
    value: env[key],
  }]));
}

function restoreEnvironment(env: NodeJS.ProcessEnv, snapshot: EnvSnapshot): void {
  for (const [key, state] of Object.entries(snapshot)) {
    if (state.present) env[key] = state.value;
    else delete env[key];
  }
}

function axiosResponse(
  config: InternalAxiosRequestConfig,
  data: string,
): AxiosResponse<string> {
  return {
    data,
    status: 200,
    statusText: "OK",
    headers: {},
    config,
  };
}

const originalEnvironment = snapshotEnvironment(process.env);

afterEach(() => {
  restoreEnvironment(process.env, originalEnvironment);
  vi.restoreAllMocks();
});

function appliedSearchRoute(
  settings: unknown = {},
  environment: Record<string, string | undefined> = {},
): AppliedSearchRoute {
  return createAppliedSearchRoute(resolveNetworkPolicy(
    parseNetworkProxySettings(settings),
    captureInheritedProxyEnvironment(environment),
  ));
}

function fakeRuntimeDependencies() {
  const config = {
    ...FIXED_OPEN_WEBSEARCH_CONFIG,
    allowedSearchEngines: [...FIXED_OPEN_WEBSEARCH_CONFIG.allowedSearchEngines],
    fakeIpCidrs: [],
  };
  const service = { execute: vi.fn() };
  const directHttpAgent = { kind: "filtering-http" };
  const directHttpsAgent = { kind: "filtering-https" };
  const proxyAgent = { kind: "proxy" };
  return {
    config,
    directHttpAgent,
    directHttpsAgent,
    proxyAgent,
    service,
    loadConfig: vi.fn(async () => ({ config })),
    loadHttpRequest: vi.fn(async () => ({
      buildAxiosRequestOptions: () => config.useProxy
        ? { httpAgent: proxyAgent, httpsAgent: proxyAgent }
        : { httpAgent: directHttpAgent, httpsAgent: directHttpsAgent },
    })),
    loadRuntime: vi.fn(async () => ({
      createOpenWebSearchRuntime: () => ({
        config,
        services: { search: service },
      }),
    }) as never),
  };
}

describe("Open-WebSearch runtime initialization", () => {
  it("neutralizes ambient config, restores it exactly, and initializes once", async () => {
    const before = snapshotEnvironment(process.env);
    Object.assign(process.env, {
      DEFAULT_SEARCH_ENGINE: "exa",
      ALLOWED_SEARCH_ENGINES: "exa,csdn",
      SEARCH_MODE: "playwright",
      PROXY_URL: "http://proxy.invalid:9999",
      USE_PROXY: "true",
      FAKE_IP_CIDRS: "198.18.0.0/15",
      FETCH_WEB_INSECURE_TLS: "true",
      PLAYWRIGHT_PACKAGE: "playwright",
      PLAYWRIGHT_MODULE_PATH: "/tmp/playwright",
      PLAYWRIGHT_EXECUTABLE_PATH: "/tmp/chrome",
      PLAYWRIGHT_WS_ENDPOINT: "ws://example.invalid",
      PLAYWRIGHT_CDP_ENDPOINT: "http://example.invalid",
      PLAYWRIGHT_HEADLESS: "false",
      PLAYWRIGHT_NAVIGATION_TIMEOUT_MS: "1",
      ENABLE_CORS: "true",
      CORS_ORIGIN: "https://example.invalid",
      MODE: "http",
      OPEN_WEBSEARCH_QUIET_STARTUP: "false",
    });
    const conflicting = snapshotEnvironment(process.env);
    const startupError = vi.spyOn(console, "error").mockImplementation(() => {});
    const startupWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const initialize = createOpenWebSearchRuntimeInitializer();
      const firstPromise = initialize();
      const secondPromise = initialize();
      expect(firstPromise).toBe(secondPromise);
      const [first, second] = await Promise.all([firstPromise, secondPromise]);

      expect(first).toBe(second);
      expect(first.config).toEqual(FIXED_OPEN_WEBSEARCH_CONFIG);
      expect(snapshotEnvironment(process.env)).toEqual(conflicting);
      expect(startupError).not.toHaveBeenCalled();
      expect(startupWarn).not.toHaveBeenCalled();
    } finally {
      restoreEnvironment(process.env, before);
    }
  });

  it("restores the environment when runtime validation fails", async () => {
    const env: NodeJS.ProcessEnv = { SEARCH_MODE: "playwright", USE_PROXY: "true" };
    const config = { ...FIXED_OPEN_WEBSEARCH_CONFIG };
    const initialize = createOpenWebSearchRuntimeInitializer({
      env,
      loadConfig: async () => ({ config }),
      loadRuntime: async () => ({
        createOpenWebSearchRuntime: () => ({
          config,
          services: {},
        }),
      }) as never,
    });

    await expect(initialize()).rejects.toThrow(/search service/i);
    expect(env).toEqual({ SEARCH_MODE: "playwright", USE_PROXY: "true" });
  });

  it.each([
    {
      label: "direct",
      settings: {},
      environment: {},
      expectedUseProxy: false,
      expectedProxyUrl: FIXED_OPEN_WEBSEARCH_CONFIG.proxyUrl,
    },
    {
      label: "configured",
      settings: { easyresearch: { network: { searchProxy: " HTTP://Proxy.Example:80/ " } } },
      environment: { HTTPS_PROXY: "http://ignored.proxy:9000" },
      expectedUseProxy: true,
      expectedProxyUrl: "http://proxy.example",
    },
    {
      label: "inherited",
      settings: {},
      environment: { HTTPS_PROXY: "http://ambient-user:ambient-secret@ambient.proxy:9000" },
      expectedUseProxy: true,
      expectedProxyUrl: "http://ambient-user:ambient-secret@ambient.proxy:9000",
    },
  ])("applies the immutable $label Search route to fixed request-only config", async ({
    settings,
    environment,
    expectedUseProxy,
    expectedProxyUrl,
  }) => {
    const env: NodeJS.ProcessEnv = {
      SEARCH_MODE: "playwright",
      USE_PROXY: "true",
      PROXY_URL: "http://ambient-package.invalid:9999",
    };
    const dependencies = fakeRuntimeDependencies();
    dependencies.loadConfig.mockImplementationOnce(async () => {
      expect(env).toMatchObject({
        SEARCH_MODE: "request",
        USE_PROXY: "false",
        PROXY_URL: "http://127.0.0.1:7890",
      });
      return { config: dependencies.config };
    });
    const initialize = createAppliedOpenWebSearchRuntimeInitializer({
      env,
      loadConfig: dependencies.loadConfig,
      loadRuntime: dependencies.loadRuntime,
    });

    const initialized = await initialize(appliedSearchRoute(settings, environment));

    expect(initialized.config).toMatchObject({
      searchMode: "request",
      useProxy: expectedUseProxy,
      proxyUrl: expectedProxyUrl,
      fakeIpCidrs: [],
      fetchWebAllowInsecureTls: false,
      playwrightModulePath: undefined,
      playwrightExecutablePath: undefined,
      playwrightWsEndpoint: undefined,
      playwrightCdpEndpoint: undefined,
      enableHttpServer: false,
      enableCors: false,
    });
    expect(env).toEqual({
      SEARCH_MODE: "playwright",
      USE_PROXY: "true",
      PROXY_URL: "http://ambient-package.invalid:9999",
    });
  });

  it("reuses one concurrent initialization promise for the same normalized Search route", async () => {
    const dependencies = fakeRuntimeDependencies();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    dependencies.loadConfig.mockImplementationOnce(async () => {
      await gate;
      return { config: dependencies.config };
    });
    const initialize = createAppliedOpenWebSearchRuntimeInitializer(dependencies);
    const configured = appliedSearchRoute({
      easyresearch: { network: { searchProxy: "HTTP://PROXY.EXAMPLE:80/" } },
    });
    const inherited = appliedSearchRoute({}, {
      HTTPS_PROXY: " http://proxy.example ",
    });

    const first = initialize(configured);
    const second = initialize(inherited);

    expect(second).toBe(first);
    expect(dependencies.loadConfig).toHaveBeenCalledTimes(1);
    release();
    const [firstRuntime, secondRuntime] = await Promise.all([first, second]);
    expect(secondRuntime).toBe(firstRuntime);
  });

  it("rejects a different Search route in the same process without disclosing either proxy", async () => {
    const dependencies = fakeRuntimeDependencies();
    const initialize = createAppliedOpenWebSearchRuntimeInitializer(dependencies);
    const firstProxy = "http://first.proxy:8001";
    const secondProxy = "http://second-user:second-secret@second.proxy:8002";

    await initialize(appliedSearchRoute({
      easyresearch: { network: { searchProxy: firstProxy } },
    }));
    const mismatch = await initialize(appliedSearchRoute({}, {
      HTTPS_PROXY: secondProxy,
    })).catch((error) => error);
    const visible = `${String(mismatch)}\n${mismatch instanceof Error ? mismatch.stack : ""}`;

    expect(mismatch).toMatchObject({ code: "NETWORK_PROXY_RESTART_REQUIRED" });
    expect(visible).toMatch(/restart/i);
    expect(visible).not.toContain(firstProxy);
    expect(visible).not.toContain(secondProxy);
    expect(visible).not.toContain("second-user");
    expect(visible).not.toContain("second-secret");
  });

  it("requires restart when only the effective proxy bypass behavior changes", async () => {
    const dependencies = fakeRuntimeDependencies();
    const initialize = createAppliedOpenWebSearchRuntimeInitializer(dependencies);
    const settings = {
      easyresearch: { network: { searchProxy: "http://proxy.example:8001" } },
    };

    await initialize(appliedSearchRoute(settings, { NO_PROXY: "*.first.example" }));
    await expect(initialize(appliedSearchRoute(settings, { NO_PROXY: "*.second.example" })))
      .rejects.toMatchObject({ code: "NETWORK_PROXY_RESTART_REQUIRED" });
  });
});

describe("exact Open-WebSearch package contracts", () => {
  let initialized: InitializedOpenWebSearchRuntime;

  async function runtime(): Promise<InitializedOpenWebSearchRuntime> {
    initialized ??= await createOpenWebSearchRuntimeInitializer()();
    return initialized;
  }

  it("distributes quota, forwards request mode, runs engines concurrently, and preserves request order", async () => {
    const shared = await runtime();
    const { createOpenWebSearchRuntime } = await import("open-websearch/build/runtime/createRuntime.js");
    const calls: Array<{ engine: string; limit: number; mode: string | undefined }> = [];
    let active = 0;
    let maxActive = 0;
    const executor = (engine: string, delay: number) => async (
      _query: string,
      limit: number,
      context?: { searchMode?: "request" | "auto" | "playwright" },
    ) => {
      calls.push({ engine, limit, mode: context?.searchMode });
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, delay));
      active -= 1;
      return [{
        title: engine,
        url: `https://${engine}.example`,
        description: `${engine} result`,
        source: engine,
        engine,
      }];
    };
    const packageRuntime = createOpenWebSearchRuntime({
      config: shared.config,
      dependencies: {
        searchExecutors: {
          duckduckgo: executor("duckduckgo", 10),
          bing: executor("bing", 5),
          brave: executor("brave", 1),
        },
      },
    });

    const result = await packageRuntime.services.search.execute({
      query: "  package contract  ",
      engines: ["duckduckgo", "bing", "brave"],
      limit: 5,
      searchMode: "request",
    });

    expect(calls).toEqual(expect.arrayContaining([
      { engine: "duckduckgo", limit: 2, mode: "request" },
      { engine: "bing", limit: 2, mode: "request" },
      { engine: "brave", limit: 1, mode: "request" },
    ]));
    expect(maxActive).toBe(3);
    expect(result.query).toBe("package contract");
    expect(result.results.map((row) => row.engine)).toEqual(["duckduckgo", "bing", "brave"]);
  });

  it("routes a real engine through the same request-scoped Axios singleton", async () => {
    const shared = await runtime();
    let observed: InternalAxiosRequestConfig | undefined;
    const fixture = `
      <div id="content_left">
        <div>
          <h3><a href="https://fixture.example/paper">Fixture title</a></h3>
          <div class="c-font-normal c-color-text" aria-label="Fixture abstract"></div>
          <div class="cosc-source">Fixture source</div>
        </div>
      </div>
    `;
    const interceptor = axios.interceptors.request.use((config) => ({
      ...config,
      adapter: async (requestConfig) => {
        observed = requestConfig;
        return axiosResponse(requestConfig, fixture);
      },
    }));

    try {
      const result = await withSearchRequestDeadline(undefined, () => shared.search.execute({
        query: "fixture",
        engines: ["baidu"],
        limit: 1,
        searchMode: "request",
      }), { timeoutMs: 1_000 });

      expect(result.timedOut).toBe(false);
      if (result.timedOut) throw new Error("The fixture search timed out");
      expect(observed?.signal).toBeInstanceOf(AbortSignal);
      expect(observed?.timeout).toBeGreaterThan(0);
      expect(observed?.timeout).toBeLessThanOrEqual(1_000);
      expect(result.value.results).toEqual([{
        title: "Fixture title",
        url: "https://fixture.example/paper",
        description: "Fixture abstract",
        source: "Fixture source",
        engine: "baidu",
      }]);
    } finally {
      axios.interceptors.request.eject(interceptor);
    }
  });

  it("honors wildcard and domain/port bypass at the pinned Open-WebSearch Axios boundary", async () => {
    const fixture = `
      <div id="content_left">
        <div>
          <h3><a href="https://fixture.example/paper">Fixture title</a></h3>
          <div class="c-font-normal c-color-text" aria-label="Fixture abstract"></div>
          <div class="cosc-source">Fixture source</div>
        </div>
      </div>
    `;
    const cases = [
      {
        label: "wildcard",
        settings: {},
        environment: { HTTPS_PROXY: "http://proxy.example:8000", NO_PROXY: "*" },
        bypassed: true,
      },
      {
        label: "domain wildcard",
        settings: { easyresearch: { network: { searchProxy: "http://proxy.example:8000" } } },
        environment: { NO_PROXY: "*.baidu.com" },
        bypassed: true,
      },
      {
        label: "matching default port",
        settings: { easyresearch: { network: { searchProxy: "http://proxy.example:8000" } } },
        environment: { NO_PROXY: "www.baidu.com:443" },
        bypassed: true,
      },
      {
        label: "different port",
        settings: { easyresearch: { network: { searchProxy: "http://proxy.example:8000" } } },
        environment: { NO_PROXY: "www.baidu.com:8443" },
        bypassed: false,
      },
    ] as const;
    let observed: InternalAxiosRequestConfig | undefined;
    const interceptor = axios.interceptors.request.use((config) => ({
      ...config,
      adapter: async (requestConfig) => {
        observed = requestConfig;
        return axiosResponse(requestConfig, fixture);
      },
    }));

    try {
      for (const testCase of cases) {
        const route = appliedSearchRoute(testCase.settings, testCase.environment);
        const initialize = createAppliedOpenWebSearchRuntimeInitializer();
        const initialized = await initialize(route);
        const requestRouting = (initialized as InitializedOpenWebSearchRuntime & {
          requestRouting?: SearchRequestRouting;
        }).requestRouting;
        expect(requestRouting, `${testCase.label} route context`).toBeDefined();
        const { buildAxiosRequestOptions } = await import(
          // @ts-expect-error Open-WebSearch does not publish types for this pinned deep runtime.
          "open-websearch/build/utils/httpRequest.js"
        );
        const packageOptions = buildAxiosRequestOptions();
        const packageProxyAgent = packageOptions.httpsAgent;
        observed = undefined;

        const result = await createWebSearchAdapter(initialized.search, {
          requestRouting,
          timeoutMs: 1_000,
        }).search({ query: "fixture", engines: ["baidu"], num: 1 });

        expect(result.results, testCase.label).toHaveLength(1);
        expect(observed, testCase.label).toBeDefined();
        if (testCase.bypassed) {
          expect(observed!.httpsAgent, `${testCase.label} must not retain the proxy agent`)
            .not.toBe(packageProxyAgent);
          expect(
            (observed!.httpsAgent as { requestFilterOptions?: unknown }).requestFilterOptions,
            `${testCase.label} must retain Open-WebSearch's direct SSRF filter`,
          ).toBeDefined();
        } else {
          expect(observed!.httpsAgent, testCase.label).toBe(packageProxyAgent);
        }
      }
    } finally {
      axios.interceptors.request.eject(interceptor);
    }
  });
});
