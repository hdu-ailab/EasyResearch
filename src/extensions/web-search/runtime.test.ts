import axios, {
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withSearchRequestDeadline } from "./request-context";
import {
  FIXED_OPEN_WEBSEARCH_CONFIG,
  OPEN_WEBSEARCH_ENV,
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
});
