import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  NetworkProxyScopeDto,
  NetworkProxyTestOutcomeDto,
  NetworkProxyTestRequestDto,
} from "./contracts";
import { ConfigServiceError } from "./config-files";
import { createNetworkProxyProbe } from "./network-proxy-probe";

function fakeFetch(
  implementation: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>,
): typeof fetch {
  return implementation as typeof fetch;
}

function abortingFetch(onSignal?: (signal: AbortSignal) => void): typeof fetch {
  return fakeFetch(async (_input, init) => {
    const signal = init?.signal;
    if (!signal) throw new Error("missing signal");
    onSignal?.(signal);
    return await new Promise<Response>((_resolve, reject) => {
      const rejectAbort = () => reject(new DOMException("raw abort detail", "AbortError"));
      if (signal.aborted) rejectAbort();
      else signal.addEventListener("abort", rejectAbort, { once: true });
    });
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("network proxy candidate probe", () => {
  it("reaches the candidate proxy despite ambient wildcard and fixed-target bypass entries", async () => {
    const connectedTargets: string[] = [];
    const proxy = createServer();
    proxy.on("connect", (request, socket) => {
      connectedTargets.push(request.url ?? "");
      socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("recording proxy did not bind");
    const previousUpper = process.env.NO_PROXY;
    const previousLower = process.env.no_proxy;
    process.env.NO_PROXY = "*,example.com,auth.openai.com,duckduckgo.com";
    process.env.no_proxy = "*";
    const ambient = { NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };

    try {
      const probe = createNetworkProxyProbe(undefined as never, { timeoutMs: 2_000 });
      const result = await probe.test({
        scope: "all",
        proxyUrl: `http://127.0.0.1:${address.port}`,
      });

      expect(connectedTargets).toEqual(["example.com:443"]);
      expect(result.ok).toBe(false);
      expect(["proxy-response", "proxy-connect"]).toContain(result.outcome);
      expect(JSON.stringify(result)).not.toContain(String(address.port));
      expect({ NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy }).toEqual(ambient);
    } finally {
      if (previousUpper === undefined) delete process.env.NO_PROXY;
      else process.env.NO_PROXY = previousUpper;
      if (previousLower === undefined) delete process.env.no_proxy;
      else process.env.no_proxy = previousLower;
      await new Promise<void>((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
    }
  });

  it.each([
    ["all", "https://example.com/"],
    ["llm", "https://auth.openai.com/.well-known/openid-configuration"],
    ["search", "https://duckduckgo.com/robots.txt"],
  ] as const)("routes %s through the candidate to its fixed target", async (scope, target) => {
    const response = new Response("private target body", { status: 302 });
    const cancel = vi.spyOn(response.body!, "cancel");
    const request: NetworkProxyTestRequestDto = {
      scope,
      proxyUrl: " HTTP://Candidate.Proxy.Example:80/ ",
    };
    const fetchBeforeRouter = vi.fn(fakeFetch(async () => response));
    const probe = createNetworkProxyProbe(fetchBeforeRouter, { timeoutMs: 5_000 });

    const result = await probe.test(request);

    expect(result).toEqual({
      ok: true,
      outcome: "success",
      status: 302,
      elapsedMs: expect.any(Number),
    });
    expect(fetchBeforeRouter).toHaveBeenCalledTimes(1);
    const [input, init] = fetchBeforeRouter.mock.calls[0]!;
    expect(input).toBe(target);
    expect(init).toMatchObject({
      proxy: "http://candidate.proxy.example",
      redirect: "manual",
      signal: expect.any(AbortSignal),
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    null,
    [],
    {},
    { scope: "all" },
    { proxyUrl: "http://proxy.example" },
    { scope: "other", proxyUrl: "http://proxy.example" },
    { scope: "all", proxyUrl: 42 },
    { scope: "all", proxyUrl: "http://proxy.example", extra: true },
  ])("rejects a non-exact request body with 400: %j", async (body) => {
    const fetchBeforeRouter = vi.fn(fakeFetch(async () => new Response(null, { status: 204 })));
    const probe = createNetworkProxyProbe(fetchBeforeRouter);

    await expect(probe.test(body)).rejects.toEqual(expect.objectContaining({
      status: 400,
    } satisfies Partial<ConfigServiceError>));
    expect(fetchBeforeRouter).not.toHaveBeenCalled();
  });

  it.each([
    ["all", "not a URL"],
    ["llm", "ftp://proxy.example"],
    ["search", "http://user:secret@proxy.example"],
    ["all", "   "],
  ] as const)("returns a safe invalid-config result for %s without fetching", async (scope, proxyUrl) => {
    const fetchBeforeRouter = vi.fn(fakeFetch(async () => new Response(null, { status: 204 })));
    const probe = createNetworkProxyProbe(fetchBeforeRouter);

    const result = await probe.test({ scope, proxyUrl });

    expect(result).toEqual({
      ok: false,
      outcome: "invalid-config",
      elapsedMs: expect.any(Number),
    });
    const visible = JSON.stringify(result);
    if (proxyUrl.trim()) expect(visible).not.toContain(proxyUrl.trim());
    expect(visible).not.toContain("secret");
    expect(fetchBeforeRouter).not.toHaveBeenCalled();
  });

  it("distinguishes caller cancellation from the internal deadline", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    let callerFetchSignal: AbortSignal | undefined;
    const callerProbe = createNetworkProxyProbe(abortingFetch((signal) => {
      callerFetchSignal = signal;
    }), { timeoutMs: 100 });

    const cancelled = callerProbe.test(
      { scope: "all", proxyUrl: "http://proxy.example" },
      caller.signal,
    );
    caller.abort(new DOMException("caller raw reason", "AbortError"));

    await expect(cancelled).resolves.toMatchObject({ ok: false, outcome: "cancelled" });
    expect(callerFetchSignal?.aborted).toBe(true);

    let timeoutFetchSignal: AbortSignal | undefined;
    const timeoutFetch = vi.fn(abortingFetch((signal) => {
      timeoutFetchSignal = signal;
    }));
    const timeoutProbe = createNetworkProxyProbe(timeoutFetch, { timeoutMs: 25 });
    const timedOut = timeoutProbe.test({ scope: "search", proxyUrl: "http://proxy.example" });

    await vi.advanceTimersByTimeAsync(25);

    await expect(timedOut).resolves.toMatchObject({ ok: false, outcome: "timeout" });
    expect(timeoutFetch).toHaveBeenCalledOnce();
    expect(timeoutFetchSignal?.aborted).toBe(true);
  });

  it("classifies a non-success target response and cancels its body", async () => {
    const response = new Response("do not expose this body", { status: 503 });
    const cancel = vi.spyOn(response.body!, "cancel");
    const probe = createNetworkProxyProbe(fakeFetch(async () => response));

    const result = await probe.test({ scope: "llm", proxyUrl: "http://proxy.example" });

    expect(result).toEqual({
      ok: false,
      outcome: "target-response",
      status: 503,
      elapsedMs: expect.any(Number),
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain("do not expose");
  });

  it.each([
    ["tls", Object.assign(new Error("CERT failure at private.dns.example token-123"), { code: "CERT_HAS_EXPIRED" })],
    ["timeout", Object.assign(new Error("socket private.dns.example token-123"), { code: "ETIMEDOUT" })],
    ["proxy-connect", Object.assign(new Error("connect private.dns.example token-123"), { code: "ECONNREFUSED" })],
    [
      "proxy-response",
      Object.assign(new Error("proxy http 407 from private.dns.example token-123"), {
        code: "ERR_PROXY_RESPONSE",
        statusCode: 407,
      }),
    ],
    [
      "proxy-response",
      Object.assign(new Error("request failed at private.dns.example token-123"), {
        cause: { status: 502 },
      }),
    ],
  ] satisfies Array<[NetworkProxyTestOutcomeDto, Error]>)("classifies %s without leaking raw failures", async (outcome, failure) => {
    const candidate = "http://sensitive-proxy.internal:8123";
    const probe = createNetworkProxyProbe(fakeFetch(async () => {
      throw failure;
    }));

    const result = await probe.test({ scope: "all", proxyUrl: candidate });

    expect(result).toMatchObject({ ok: false, outcome });
    const visible = JSON.stringify(result);
    expect(visible).not.toContain(candidate);
    expect(visible).not.toContain("private.dns.example");
    expect(visible).not.toContain("token-123");
    expect(visible).not.toContain("407");
  });

  it("uses only declared scope values", async () => {
    const scopes: NetworkProxyScopeDto[] = ["all", "llm", "search"];
    const outcomes = new Set<NetworkProxyTestOutcomeDto>();
    const probe = createNetworkProxyProbe(fakeFetch(async () => new Response(null, { status: 204 })));

    for (const scope of scopes) {
      outcomes.add((await probe.test({ scope, proxyUrl: "http://proxy.example" })).outcome);
    }

    expect(outcomes).toEqual(new Set(["success"]));
  });
});
