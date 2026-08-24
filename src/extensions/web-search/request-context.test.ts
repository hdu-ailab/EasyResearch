import axios, {
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from "axios";
import { describe, expect, it } from "vitest";
import {
  ensureSearchAxiosInterceptorInstalled,
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

  it("distinguishes the internal deadline from Pi Stop", async () => {
    const timedOut = await withSearchRequestDeadline(undefined, async (signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return "deadline";
    }, { timeoutMs: 5 });
    expect(timedOut).toEqual({ value: "deadline", timedOut: true });

    const controller = new AbortController();
    const stoppedPromise = withSearchRequestDeadline(controller.signal, async (signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return "stop";
    }, { timeoutMs: 1_000 });
    controller.abort();
    await expect(stoppedPromise).resolves.toEqual({ value: "stop", timedOut: false });
  });
});
