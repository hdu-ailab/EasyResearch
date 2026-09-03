import axios, {
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from "axios";
import { describe, expect, it, vi } from "vitest";
import {
  ensureSearchAxiosInterceptorInstalled,
  type SearchRequestRouting,
  withSearchRequestDeadline,
} from "./request-context";

function response(config: InternalAxiosRequestConfig): AxiosResponse<string> {
  return {
    data: "ok",
    status: 200,
    statusText: "OK",
    headers: {},
    config,
  };
}

describe("web-search console sanitization", () => {
  it("does not patch console methods while only installing the Axios interceptor", () => {
    const originalError = console.error;
    const originalWarn = console.warn;

    ensureSearchAxiosInterceptorInstalled();
    const installedError = console.error;
    const installedWarn = console.warn;
    console.error = originalError;
    console.warn = originalWarn;

    expect(installedError).toBe(originalError);
    expect(installedWarn).toBe(originalWarn);
  });

  it("sanitizes scoped diagnostics before formatting and restores console after success", async () => {
    const secret = "http://proxy-user:proxy-secret@private.proxy:9000";
    const originalError = console.error;
    const originalWarn = console.warn;
    const calls: unknown[][] = [];
    const sink = ((...args: unknown[]) => {
      calls.push(args);
    }) as typeof console.error;
    console.error = sink;
    console.warn = sink;

    try {
      await withSearchRequestDeadline(undefined, async () => {
        console.error(
          `third-party request failed through ${secret}`,
          new Error(`nested failure through ${secret}`),
          { code: "EPROXY", message: `object failure through ${secret}` },
        );
      }, {
        timeoutMs: 1_000,
        sanitizeConsoleError: (value) => String(value).split(secret).join("[redacted proxy]"),
      });

      expect(calls).toHaveLength(1);
      expect(JSON.stringify(calls)).toContain("[redacted proxy]");
      expect(JSON.stringify(calls)).not.toContain(secret);
      expect(console.error).toBe(sink);
      expect(console.warn).toBe(sink);
    } finally {
      console.error = originalError;
      console.warn = originalWarn;
    }
  });

  it("restores console methods when the scoped operation rejects", async () => {
    const originalError = console.error;
    const originalWarn = console.warn;
    const sink = (() => {}) as typeof console.error;
    console.error = sink;
    console.warn = sink;

    try {
      await expect(withSearchRequestDeadline(undefined, async () => {
        throw new Error("search failed");
      }, {
        timeoutMs: 1_000,
        sanitizeConsoleError: (value) => String(value),
      })).rejects.toThrow("search failed");
      expect(console.error).toBe(sink);
      expect(console.warn).toBe(sink);
    } finally {
      console.error = originalError;
      console.warn = originalWarn;
    }
  });

  it("leaves concurrent unrelated console arguments unchanged", async () => {
    const secret = "SEARCH_PROXY_SECRET";
    const originalError = console.error;
    const originalWarn = console.warn;
    const calls: unknown[][] = [];
    const sink = ((...args: unknown[]) => {
      calls.push(args);
    }) as typeof console.warn;
    console.error = sink;
    console.warn = sink;
    let markEntered!: () => void;
    let releaseSearch!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseSearch = resolve;
    });
    const unrelated = { message: `unrelated ${secret}` };

    try {
      const search = withSearchRequestDeadline(undefined, async () => {
        markEntered();
        await gate;
        console.warn(`scoped ${secret}`);
      }, {
        timeoutMs: 1_000,
        sanitizeConsoleError: (value) => String(value).replaceAll(secret, "[redacted proxy]"),
      });
      await entered;
      console.warn(unrelated, "outside context");
      releaseSearch();
      await search;

      expect(calls[0]).toEqual([unrelated, "outside context"]);
      expect(calls[0]![0]).toBe(unrelated);
      expect(calls[1]).toEqual(["scoped [redacted proxy]"]);
      expect(console.error).toBe(sink);
      expect(console.warn).toBe(sink);
    } finally {
      releaseSearch();
      console.error = originalError;
      console.warn = originalWarn;
    }
  });

  it("returns at the deadline but retains scoped sanitization until an ignored operation settles", async () => {
    vi.useFakeTimers();
    const secret = "SEARCH_PROXY_SECRET";
    const originalError = console.error;
    const originalWarn = console.warn;
    const calls: unknown[][] = [];
    const sink = ((...args: unknown[]) => {
      calls.push(args);
    }) as typeof console.warn;
    console.error = sink;
    console.warn = sink;
    let releaseOperation!: () => void;
    const operationGate = new Promise<void>((resolve) => {
      releaseOperation = resolve;
    });
    let settlement: Promise<void> | undefined;

    try {
      const pending = withSearchRequestDeadline(undefined, async () => {
        await operationGate;
        console.warn(`scoped ${secret}`);
        return "late result";
      }, {
        timeoutMs: 25,
        sanitizeConsoleError: (value) => String(value).replaceAll(secret, "[redacted proxy]"),
      });
      settlement = pending.settled;
      let publicOutcome: unknown = "pending";
      void pending.then(
        (value) => {
          publicOutcome = value;
        },
        (error) => {
          publicOutcome = error;
        },
      );

      await vi.advanceTimersByTimeAsync(25);

      expect(publicOutcome).toEqual({ timedOut: true });
      expect(console.error).not.toBe(sink);
      expect(console.warn).not.toBe(sink);
      const unrelated = { message: `unrelated ${secret}` };
      console.warn(unrelated, "outside context");
      expect(calls[0]).toEqual([unrelated, "outside context"]);
      expect(calls[0]![0]).toBe(unrelated);

      releaseOperation();
      await pending.settled;

      expect(calls[1]).toEqual(["scoped [redacted proxy]"]);
      expect(console.error).toBe(sink);
      expect(console.warn).toBe(sink);
    } finally {
      releaseOperation();
      await settlement;
      console.error = originalError;
      console.warn = originalWarn;
      vi.useRealTimers();
    }
  });
});

describe("web-search Axios request context", () => {
  it("applies the remaining deadline only to requests in the search scope", async () => {
    ensureSearchAxiosInterceptorInstalled();
    ensureSearchAxiosInterceptorInstalled();
    const scoped: InternalAxiosRequestConfig[] = [];
    const unrelated: InternalAxiosRequestConfig[] = [];

    await withSearchRequestDeadline(undefined, async () => {
      await axios.get("https://scope.test", {
        timeout: 50_000,
        adapter: async (config) => {
          scoped.push(config);
          return response(config);
        },
      });
    }, { timeoutMs: 1_000 });
    await axios.get("https://outside.test", {
      adapter: async (config) => {
        unrelated.push(config);
        return response(config);
      },
    });

    expect(scoped[0]?.timeout).toBeGreaterThan(0);
    expect(scoped[0]?.timeout).toBeLessThanOrEqual(1_000);
    expect(scoped[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(unrelated[0]?.timeout).toBe(0);
    expect(unrelated[0]?.signal).toBeUndefined();
    expect(axios.defaults.timeout).toBe(0);
    expect(axios.defaults.signal).toBeUndefined();
  });

  it("preserves a smaller request timeout", async () => {
    let actualTimeout: number | undefined;
    await withSearchRequestDeadline(undefined, async () => {
      await axios.get("https://scope.test", {
        timeout: 25,
        adapter: async (config) => {
          actualTimeout = config.timeout;
          return response(config);
        },
      });
    }, { timeoutMs: 1_000 });

    expect(actualTimeout).toBe(25);
  });

  it("combines an existing request signal with the operation signal", async () => {
    const requestController = new AbortController();
    let combined: AbortSignal | undefined;
    await withSearchRequestDeadline(undefined, async () => {
      await axios.get("https://scope.test", {
        signal: requestController.signal,
        adapter: async (config) => {
          combined = config.signal as AbortSignal;
          return response(config);
        },
      });
    }, { timeoutMs: 1_000 });

    expect(combined).not.toBe(requestController.signal);
    expect(combined?.aborted).toBe(false);
    requestController.abort();
    expect(combined?.aborted).toBe(true);
  });

  it("replaces only matching scoped package proxy agents with safe direct agents", async () => {
    class Agent {
      constructor(readonly kind: string) {}
    }
    const proxyAgent = new Agent("package-proxy");
    const directHttpAgent = new Agent("filtering-http");
    const directHttpsAgent = new Agent("filtering-https");
    const requestRouting: SearchRequestRouting = {
      bypasses: (url) => new URL(url).hostname === "bypass.test",
      directAgentsFor: (httpAgent, httpsAgent) => (
        httpAgent === proxyAgent || httpsAgent === proxyAgent
          ? { httpAgent: directHttpAgent, httpsAgent: directHttpsAgent }
          : undefined
      ),
    };
    const observed: InternalAxiosRequestConfig[] = [];
    const request = (url: string, baseURL?: string) => axios.get(url, {
      ...(baseURL ? { baseURL } : {}),
      httpAgent: proxyAgent,
      httpsAgent: proxyAgent,
      adapter: async (config) => {
        observed.push(config);
        return response(config);
      },
    });

    await withSearchRequestDeadline(undefined, async () => {
      await request("/paper", "https://bypass.test");
      await request("https://proxied.test/paper");
    }, {
      timeoutMs: 1_000,
      requestRouting,
    });
    await request("https://bypass.test/outside-scope");

    expect(observed[0]?.httpAgent).toBe(directHttpAgent);
    expect(observed[0]?.httpsAgent).toBe(directHttpsAgent);
    expect(observed[1]?.httpAgent).toBe(proxyAgent);
    expect(observed[1]?.httpsAgent).toBe(proxyAgent);
    expect(observed[2]?.httpAgent).toBe(proxyAgent);
    expect(observed[2]?.httpsAgent).toBe(proxyAgent);
  });

  it("distinguishes the internal deadline from Pi Stop", async () => {
    const timedOut = await withSearchRequestDeadline(undefined, async (signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return "deadline";
    }, { timeoutMs: 5 });
    expect(timedOut).toEqual({ timedOut: true });

    const controller = new AbortController();
    const stoppedPromise = withSearchRequestDeadline(controller.signal, async (signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return "stop";
    }, { timeoutMs: 1_000 });
    controller.abort();
    await expect(stoppedPromise).resolves.toEqual({ value: "stop", timedOut: false });
  });
});
