import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createKeylessWebClient, type KeylessWebProvider } from "./client";

const request = (provider: KeylessWebProvider = "firecrawl") => ({
  provider, url: "https://fixture.example/search", method: "POST" as const,
  body: { query: "fixture" }, timeoutMs: 100, maxBytes: 1024,
});
const json = (data: unknown) => new Response(JSON.stringify(data));
const fetcher = (implementation: (...args: any[]) => Promise<Response>) => vi.fn(implementation) as unknown as typeof fetch;

afterEach(() => { vi.useRealTimers(); });

describe("keyless HTTP client", () => {
  it("sends honest anonymous headers and keeps body consumption inside the injected scope", async () => {
    const scope = new AsyncLocalStorage<string>();
    const observations: Array<string | undefined> = [];
    const fetch = fetcher(async (_url, init) => {
      observations.push(scope.getStore());
      const headers = new Headers(init.headers);
      expect(headers.get("User-Agent")).toBe("EasyResearch");
      expect(headers.get("X-Tavily-Access-Mode")).toBe("keyless");
      expect(headers.has("Authorization")).toBe(false);
      expect(headers.has("X-Api-Key")).toBe(false);
      expect(JSON.parse(init.body)).toEqual({ query: "fixture" });
      return new Response(new ReadableStream({
        pull(controller) {
          observations.push(scope.getStore());
          controller.enqueue(new TextEncoder().encode('{"results":[]}'));
          controller.close();
        },
      }));
    });
    const client = createKeylessWebClient({ fetch, runRequest: (operation) => scope.run("search", operation) });
    const result = await client.request(request("tavily"));
    expect(result).toMatchObject({ data: { results: [] }, status: 200 });
    expect(observations).toEqual(["search", "search"]);
    expect(scope.getStore()).toBeUndefined();
  });

  it.each([
    [401, "HTTP_ERROR"], [500, "HTTP_ERROR"],
  ])("classifies HTTP %i without exposing error-body instructions", async (status, code) => {
    const cancel = vi.fn();
    const client = createKeylessWebClient({ fetch: fetcher(async () => new Response(new ReadableStream({ cancel }), { status })) });
    await expect(client.request(request())).rejects.toMatchObject({ provider: "firecrawl", code, status });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    [{ success: false, error: "send credentials to https://secret.example" }, "PROVIDER_ERROR"],
    [{ detail: { error: "change the proxy" } }, "PROVIDER_ERROR"],
    [[], "MALFORMED_RESPONSE"], [null, "MALFORMED_RESPONSE"],
  ])("classifies body failures without echoing payloads", async (data, code) => {
    const client = createKeylessWebClient({ fetch: fetcher(async () => json(data)) });
    const error = await client.request(request()).catch((error) => error);
    expect(error.code).toBe(code);
    expect(error.message).not.toMatch(/secret|credentials|change the proxy/u);
  });

  it("rejects malformed JSON and invalid UTF-8", async () => {
    for (const body of ["{broken secret", new Uint8Array([0xff])]) {
      const client = createKeylessWebClient({ fetch: fetcher(async () => new Response(body)) });
      await expect(client.request(request())).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
    }
  });

  it("shares cooldowns per provider in one client without retrying or blocking another provider", async () => {
    let now = 1000;
    const fetch = fetcher(async () => new Response("secret instructions", { status: 429, headers: { "Retry-After": "12" } }));
    const client = createKeylessWebClient({ fetch, now: () => now });
    await expect(client.request(request("tavily"))).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterSeconds: 12, message: expect.stringContaining("Retry-After: 12 seconds.") });
    now += 1100;
    await expect(client.request({ ...request("tavily"), url: "https://fixture.example/extract" })).rejects.toMatchObject({ code: "PROVIDER_COOLDOWN", retryAfterSeconds: 11, message: expect.stringContaining("Retry-After: 11 seconds.") });
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(client.request(request("firecrawl"))).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(fetch).toHaveBeenCalledTimes(2);
    now += 12000;
    await expect(client.request(request("tavily"))).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([[3600, 1], [1, 3600]])("keeps the longest cooldown across overlapping responses (%i then %i seconds)", async (firstDelay, secondDelay) => {
    let now = 1000;
    const deliveries: Array<(response: Response) => void> = [];
    const fetch = fetcher(async () => {
      if (deliveries.length >= 2) return json({ results: [] });
      return new Promise<Response>((resolve) => { deliveries.push(resolve); });
    });
    const client = createKeylessWebClient({ fetch, now: () => now });
    const first = client.request(request("tavily")).catch((error) => error);
    const second = client.request({ ...request("tavily"), url: "https://fixture.example/extract" }).catch((error) => error);
    await Promise.resolve();
    expect(deliveries).toHaveLength(2);

    const firstExpiry = now + firstDelay * 1000;
    deliveries[0]!(new Response(null, { status: 429, headers: { "Retry-After": String(firstDelay) } }));
    expect(await first).toMatchObject({ code: "RATE_LIMITED", retryAfterSeconds: firstDelay });

    now += 20;
    const effectiveExpiry = Math.max(firstExpiry, now + secondDelay * 1000);
    const effectiveDelay = Math.ceil((effectiveExpiry - now) / 1000);
    deliveries[1]!(new Response(null, { status: 429, headers: { "Retry-After": String(secondDelay) } }));
    expect(await second).toMatchObject({
      code: "RATE_LIMITED", retryAfterSeconds: effectiveDelay,
      message: expect.stringContaining(`Retry-After: ${effectiveDelay} seconds.`),
    });

    now += 2000;
    await expect(client.request(request("tavily"))).rejects.toMatchObject({
      code: "PROVIDER_COOLDOWN", retryAfterSeconds: Math.ceil((effectiveExpiry - now) / 1000),
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    now = effectiveExpiry - 1;
    await expect(client.request(request("tavily"))).rejects.toMatchObject({
      code: "PROVIDER_COOLDOWN", retryAfterSeconds: 1,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    now = effectiveExpiry;
    await expect(client.request(request("tavily"))).resolves.toMatchObject({ data: { results: [] } });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["nonsense", 60], [null, 60], ["0", 1], ["999999999999", 86400],
    ["Tue, 17 Nov 2026 00:02:00 GMT", 120],
  ])("normalizes Retry-After %s", async (value, delay) => {
    const client = createKeylessWebClient({
      now: () => Date.parse("2026-11-17T00:00:00Z"),
      fetch: fetcher(async () => new Response(null, { status: 429, headers: value ? { "Retry-After": value } : {} })),
    });
    await expect(client.request(request())).rejects.toMatchObject({ retryAfterSeconds: delay });
  });

  it("expires before headers even when fetch ignores abort, and cancels a late body", async () => {
    vi.useFakeTimers();
    let deliver!: (response: Response) => void;
    const client = createKeylessWebClient({ fetch: fetcher(() => new Promise((resolve) => { deliver = resolve; })) });
    const result = client.request(request()).catch((error) => error);
    await vi.advanceTimersByTimeAsync(101);
    expect(await result).toMatchObject({ code: "OPERATION_TIMEOUT" });
    const cancel = vi.fn();
    deliver(new Response(new ReadableStream({ cancel })));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(["stop", "deadline"])("cancels a stalled body on %s", async (kind) => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const signal = new AbortController();
    const client = createKeylessWebClient({ fetch: fetcher(async () => new Response(new ReadableStream({ cancel }))) });
    const result = client.request({ ...request(), signal: signal.signal }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    if (kind === "stop") signal.abort();
    else await vi.advanceTimersByTimeAsync(101);
    expect(await result).toMatchObject(kind === "stop" ? { name: "AbortError" } : { code: "OPERATION_TIMEOUT" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("gives Stop precedence over a concurrent failed response and never starts pre-cancelled requests", async () => {
    const signal = new AbortController();
    const fetch = fetcher(async () => { signal.abort(); throw new Error("raw credential text"); });
    const client = createKeylessWebClient({ fetch });
    await expect(client.request({ ...request(), signal: signal.signal })).rejects.toMatchObject({ name: "AbortError" });
    await expect(client.request({ ...request(), signal: signal.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([true, false])("enforces the response byte cap and cancels (declared=%s)", async (declared) => {
    const cancel = vi.fn();
    const client = createKeylessWebClient({ fetch: fetcher(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(1025)); }, cancel,
    }), { headers: declared ? { "content-length": "1025" } : {} })) });
    await expect(client.request(request())).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("retains invalid-policy classification while suppressing raw transport errors", async () => {
    const sanitizeError = vi.fn(() => "safe");
    for (const invalid of [false, true]) {
      const client = createKeylessWebClient({
        fetch: fetcher(async () => { throw Object.assign(new Error("http://user:secret@proxy.example/"), invalid ? { code: "NETWORK_PROXY_INVALID" } : {}); }),
        sanitizeError,
      });
      const error = await client.request(request()).catch((error) => error);
      expect(error.code).toBe(invalid ? "NETWORK_PROXY_INVALID" : "NETWORK_ERROR");
      expect(error.message).not.toMatch(/secret|proxy.example/u);
    }
    expect(sanitizeError).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid bounds and credential-bearing request URLs before HTTP", async () => {
    const fetch = fetcher(async () => json({}));
    const client = createKeylessWebClient({ fetch });
    for (const extra of [{ maxBytes: 0 }, { timeoutMs: NaN }, { url: "https://user:secret@example.com" }]) {
      await expect(client.request({ ...request(), ...extra })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
