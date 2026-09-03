import { createRequire } from "node:module";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyNetworkPolicyEnvironment,
  captureInheritedProxyEnvironment,
  parseNetworkProxySettings,
  resolveNetworkPolicy,
  type EnvironmentMap,
  type NetworkPolicy,
} from "./network-policy";
import {
  createAppliedSearchRoute,
  installNetworkRouter,
  type AppliedSearchRoute,
  type InstalledNetworkRouter,
} from "./network-routing";

interface FetchCall {
  input: Parameters<typeof fetch>[0];
  init: Parameters<typeof fetch>[1];
}

const platformFetch = globalThis.fetch;
let installedRouters: InstalledNetworkRouter[] = [];

afterEach(() => {
  for (const router of installedRouters.reverse()) router.restore();
  installedRouters = [];
  globalThis.fetch = platformFetch;
});

function policy(
  settings: unknown = {},
  environment: Readonly<EnvironmentMap> = {},
): NetworkPolicy {
  return resolveNetworkPolicy(
    parseNetworkProxySettings(settings),
    captureInheritedProxyEnvironment(environment),
  );
}

function inputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function proxyFrom(init: Parameters<typeof fetch>[1]): string | undefined {
  return (init as (RequestInit & { proxy?: string }) | undefined)?.proxy;
}

function headersFrom(call: FetchCall): Headers {
  const headers = new Headers(call.input instanceof Request ? call.input.headers : undefined);
  new Headers(call.init?.headers).forEach((value, name) => headers.set(name, value));
  return headers;
}

function trackedRequestBody(): {
  body: ReadableStream<Uint8Array>;
  cancelled: Promise<void>;
} {
  let resolveCancelled!: () => void;
  const cancelled = new Promise<void>((resolve) => {
    resolveCancelled = resolve;
  });
  return {
    body: new ReadableStream<Uint8Array>({
      cancel() {
        resolveCancelled();
      },
    }),
    cancelled,
  };
}

function requestWithStreamBody(
  url: string,
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Request {
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    body,
    duplex: "half",
    ...(signal ? { signal } : {}),
  };
  return new Request(url, init);
}

async function settlesSoon(promise: Promise<unknown>): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 20)),
  ]);
}

function releaseDelegatedRequestBody(input: Parameters<typeof fetch>[0]): void {
  if (input instanceof Request && input.body) void input.body.cancel().catch(() => {});
}

function currentGaxiosRequest(): Function {
  const { OAuth2Client } = createRequire(import.meta.url)("google-auth-library") as {
    OAuth2Client: new () => { transporter: object };
  };
  return Object.getPrototypeOf(new OAuth2Client().transporter).request as Function;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  });
}

function requestHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) result.append(name, item);
    } else if (value !== undefined) {
      result.set(name, value);
    }
  }
  return result;
}

function installRecorder(
  networkPolicy: NetworkPolicy,
  implementation?: (
    input: Parameters<typeof fetch>[0],
    init: Parameters<typeof fetch>[1],
  ) => Promise<Response>,
): {
  router: InstalledNetworkRouter;
  delegate: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const delegate = (async (input, init) => {
    calls.push({ input, init });
    return implementation
      ? implementation(input, init)
      : new Response("ok", { status: 200 });
  }) as typeof fetch;
  globalThis.fetch = delegate;
  const router = installNetworkRouter(networkPolicy);
  installedRouters.push(router);
  return { router, delegate, calls };
}

describe("installed fetch routing", () => {
  it("exposes the installed Search route without publishing its proxy URL", () => {
    const searchProxy = "http://search.proxy:8002";
    const { router } = installRecorder(policy({
      httpProxy: "http://all.proxy:8000",
      easyresearch: { network: { searchProxy } },
    }));
    const target = { useProxy: false, proxyUrl: "http://disabled.invalid" };

    router.appliedSearchRoute.applyProxyConfiguration(target);

    expect(target).toEqual({ useProxy: true, proxyUrl: searchProxy });
    expect(Object.isFrozen(router.appliedSearchRoute)).toBe(true);
    expect(router.appliedSearchRoute).not.toHaveProperty("proxyUrl");
    expect(JSON.stringify(router.appliedSearchRoute)).not.toContain(searchProxy);
    expect(JSON.stringify(router)).not.toContain(searchProxy);
  });

  it("keeps concurrent LLM and Search scopes isolated and defaults unscoped work to All", async () => {
    const { router, delegate, calls } = installRecorder(policy({
      httpProxy: "http://all.proxy:8000",
      easyresearch: {
        network: {
          llmProxy: "http://llm.proxy:8001",
          searchProxy: "http://search.proxy:8002",
        },
      },
    }));
    let releaseLlm!: () => void;
    const llmGate = new Promise<void>((resolve) => {
      releaseLlm = resolve;
    });

    expect(globalThis.fetch).toBe(router.fetch);
    expect(router.fetch).not.toBe(delegate);

    const llm = router.withScope("llm", async () => {
      await llmGate;
      await Promise.resolve();
      return globalThis.fetch("https://llm-target.example/");
    });
    const search = router.withScope("search", async () => {
      await Promise.resolve();
      return globalThis.fetch("https://search-target.example/");
    });
    const all = globalThis.fetch("https://all-target.example/");
    releaseLlm();
    await Promise.all([llm, search, all]);

    expect(Object.fromEntries(calls.map((call) => [inputUrl(call.input), proxyFrom(call.init)])))
      .toEqual({
        "https://all-target.example/": "http://all.proxy:8000",
        "https://search-target.example/": "http://search.proxy:8002",
        "https://llm-target.example/": "http://llm.proxy:8001",
      });
  });

  it("selects inherited HTTP and HTTPS routes independently", async () => {
    const { router, calls } = installRecorder(policy({}, {
      http_proxy: "http://lower-http.proxy:8010",
      HTTP_PROXY: "http://upper-http.proxy:8011",
      https_proxy: "http://lower-https.proxy:8020",
      HTTPS_PROXY: "http://upper-https.proxy:8021",
      all_proxy: "http://lower-all.proxy:8030",
      ALL_PROXY: "http://upper-all.proxy:8031",
    }));

    await Promise.all([
      globalThis.fetch("http://plain-target.example/"),
      globalThis.fetch("https://secure-target.example/"),
      router.withScope("llm", () => globalThis.fetch("http://llm-plain.example/")),
      router.withScope("search", () => globalThis.fetch("https://search-secure.example/")),
    ]);

    expect(Object.fromEntries(calls.map((call) => [inputUrl(call.input), proxyFrom(call.init)])))
      .toEqual({
        "http://plain-target.example/": "http://lower-http.proxy:8010",
        "https://secure-target.example/": "http://lower-https.proxy:8020",
        "http://llm-plain.example/": "http://lower-http.proxy:8010",
        "https://search-secure.example/": "http://lower-https.proxy:8020",
      });
  });

  it("reselects routing and strips credentials at every automatic redirect", async () => {
    const redirects = new Map([
      ["https://public.example/start", "http://[::1]:3000/callback"],
      ["http://[::1]:3000/callback", "http://public.example/final"],
    ]);
    const { calls } = installRecorder(policy({}, {
      http_proxy: "http://plain.proxy:8010",
      https_proxy: "http://secure.proxy:8020",
    }), async (input) => {
      const url = inputUrl(input);
      const location = redirects.get(url);
      return location
        ? new Response(null, { status: 302, headers: { location } })
        : new Response("ok", { status: 200 });
    });
    const init: RequestInit = {
      headers: {
        Authorization: "Bearer private-token",
        Cookie: "session=private-cookie",
        "X-Public": "kept",
      },
    };

    const response = await globalThis.fetch("https://public.example/start", init);

    expect(await response.text()).toBe("ok");
    expect(calls.map((call) => ({
      url: inputUrl(call.input),
      proxy: proxyFrom(call.init),
      redirect: call.init?.redirect,
    }))).toEqual([
      {
        url: "https://public.example/start",
        proxy: "http://secure.proxy:8020",
        redirect: "manual",
      },
      {
        url: "http://[::1]:3000/callback",
        proxy: undefined,
        redirect: "manual",
      },
      {
        url: "http://public.example/final",
        proxy: "http://plain.proxy:8010",
        redirect: "manual",
      },
    ]);
    expect(headersFrom(calls[0]!).get("authorization")).toBe("Bearer private-token");
    expect(headersFrom(calls[0]!).get("cookie")).toBe("session=private-cookie");
    for (const call of calls.slice(1)) {
      expect(headersFrom(call).get("authorization")).toBeNull();
      expect(headersFrom(call).get("cookie")).toBeNull();
      expect(headersFrom(call).get("x-public")).toBe("kept");
    }
    expect(init).toEqual({
      headers: {
        Authorization: "Bearer private-token",
        Cookie: "session=private-cookie",
        "X-Public": "kept",
      },
    });
  });

  it("strips every pinned provider credential header on a real cross-origin redirect", async () => {
    let sourceHeaders: Headers | undefined;
    let targetHeaders: Headers | undefined;
    const target = createServer((request, response) => {
      targetHeaders = requestHeaders(request.headers);
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("redirected");
    });
    const targetPort = await listen(target);
    const source = createServer((request, response) => {
      sourceHeaders = requestHeaders(request.headers);
      response.writeHead(302, {
        Location: `http://127.0.0.1:${targetPort}/target`,
      });
      response.end();
    });
    const sourcePort = await listen(source);
    const credentialHeaders = {
      Authorization: "Bearer provider-token",
      Cookie: "session=provider-cookie",
      Cookie2: "legacy=provider-cookie",
      DPoP: "signed-provider-proof",
      "Proxy-Authorization": "Basic proxy-token",
      "X-Api-Key": "anthropic-secret",
      "Api-Key": "azure-secret",
      "X-Goog-Api-Key": "google-secret",
      "X-Amz-Security-Token": "aws-session-secret",
      "CF-AIG-Authorization": "Bearer cloudflare-secret",
      "X-Goog-Iam-Authorization-Token": "google-iam-secret",
      "X-Aws-Ec2-Metadata-Token": "aws-imds-secret",
      "X-Amz-Sso_Bearer_Token": "aws-sso-secret",
      "X-Amz-S3session-Token": "aws-s3-session-secret",
    };
    const metadataHeaders = {
      "Anthropic-Version": "2023-06-01",
      "X-Goog-Api-Client": "gl-node/test",
      "X-Goog-Iam-Authority-Selector": "fixture-selector",
      "X-Amz-Date": "20260903T000000Z",
      "X-Aws-Ec2-Metadata-Token-Ttl-Seconds": "300",
    };
    const router = installNetworkRouter(policy({}));
    installedRouters.push(router);

    try {
      const response = await globalThis.fetch(`http://127.0.0.1:${sourcePort}/source`, {
        headers: { ...credentialHeaders, ...metadataHeaders },
      });

      expect(await response.text()).toBe("redirected");
      expect(sourceHeaders).toBeDefined();
      expect(targetHeaders).toBeDefined();
      for (const [name, value] of Object.entries(credentialHeaders)) {
        expect(sourceHeaders!.get(name), `${name} must reach only the original origin`).toBe(value);
        expect(targetHeaders!.get(name), `${name} leaked across the redirect`).toBeNull();
      }
      for (const [name, value] of Object.entries(metadataHeaders)) {
        expect(targetHeaders!.get(name), `${name} is non-secret provider metadata`).toBe(value);
      }
    } finally {
      await Promise.all([close(source), close(target)]);
    }
  });

  it.each([
    [301, "POST"],
    [302, "POST"],
    [303, "PATCH"],
  ] as const)("rewrites cross-origin %i %s redirects to credential-free GET requests", async (
    status,
    method,
  ) => {
    const observed: Array<{
      body: string;
      headers: Headers;
      method: string;
      url: string;
    }> = [];
    installRecorder(policy({}), async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      observed.push({
        body: request.body ? await request.text() : "",
        headers: new Headers(request.headers),
        method: request.method,
        url: request.url,
      });
      return observed.length === 1
        ? new Response("redirect", {
            status,
            headers: { Location: "https://redirected.example/final" },
          })
        : new Response("ok");
    });

    const response = await globalThis.fetch("https://source.example/start", {
      method,
      body: "private request body",
      headers: {
        Authorization: "Bearer private-token",
        Cookie: "session=private-cookie",
        "Proxy-Authorization": "Basic private-proxy-token",
        "Content-Type": "text/plain",
        "Content-Digest": "sha-256=:private-digest:",
        "X-Public": "kept",
      },
    });

    expect(await response.text()).toBe("ok");
    expect(observed).toHaveLength(2);
    expect(observed[1]).toMatchObject({
      body: "",
      method: "GET",
      url: "https://redirected.example/final",
    });
    expect(Object.fromEntries(observed[1]!.headers)).toEqual({ "x-public": "kept" });
  });

  it("keeps GET and its content headers across a 303 redirect", async () => {
    const observed: Array<{ headers: Headers; method: string; url: string }> = [];
    installRecorder(policy({}), async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      observed.push({
        headers: new Headers(request.headers),
        method: request.method,
        url: request.url,
      });
      return observed.length === 1
        ? new Response(null, { status: 303, headers: { Location: "/final" } })
        : new Response("ok");
    });

    await globalThis.fetch("https://same-origin.example/start", {
      headers: {
        "Content-Language": "en",
        "Content-Type": "application/json",
        "X-Public": "kept",
      },
    });

    expect(observed).toHaveLength(2);
    expect(observed[1]).toMatchObject({
      method: "GET",
      url: "https://same-origin.example/final",
    });
    expect(Object.fromEntries(observed[1]!.headers)).toEqual({
      "content-language": "en",
      "content-type": "application/json",
      "x-public": "kept",
    });
  });

  it("keeps same-origin credentials when a POST redirect is rewritten to GET", async () => {
    const observed: Array<{ body: string; headers: Headers; method: string }> = [];
    installRecorder(policy({}), async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      observed.push({
        body: request.body ? await request.text() : "",
        headers: new Headers(request.headers),
        method: request.method,
      });
      return observed.length === 1
        ? new Response(null, { status: 302, headers: { Location: "/final" } })
        : new Response("ok");
    });

    await globalThis.fetch("https://same-origin.example/start", {
      method: "POST",
      body: "discarded body",
      headers: {
        Authorization: "Bearer same-origin-token",
        Cookie: "same-origin-cookie=1",
        DPoP: "same-origin-signed-proof",
        "Proxy-Authorization": "Basic same-origin-proxy-token",
        "X-Api-Key": "same-origin-anthropic-key",
        "Api-Key": "same-origin-azure-key",
        "X-Goog-Api-Key": "same-origin-google-key",
        "X-Amz-Security-Token": "same-origin-aws-token",
        "CF-AIG-Authorization": "same-origin-cloudflare-key",
        "X-Goog-Iam-Authorization-Token": "same-origin-google-iam-token",
        "X-Aws-Ec2-Metadata-Token": "same-origin-imds-token",
        "X-Amz-Sso_Bearer_Token": "same-origin-sso-token",
        "X-Amz-S3session-Token": "same-origin-s3-session-token",
        "Content-Type": "text/plain",
        "Content-Digest": "sha-256=:discarded:",
        "X-Public": "kept",
      },
    });

    expect(observed).toHaveLength(2);
    expect(observed[1]).toMatchObject({ body: "", method: "GET" });
    expect(Object.fromEntries(observed[1]!.headers)).toEqual({
      authorization: "Bearer same-origin-token",
      "api-key": "same-origin-azure-key",
      "cf-aig-authorization": "same-origin-cloudflare-key",
      cookie: "same-origin-cookie=1",
      dpop: "same-origin-signed-proof",
      "proxy-authorization": "Basic same-origin-proxy-token",
      "x-amz-s3session-token": "same-origin-s3-session-token",
      "x-amz-security-token": "same-origin-aws-token",
      "x-amz-sso_bearer_token": "same-origin-sso-token",
      "x-api-key": "same-origin-anthropic-key",
      "x-aws-ec2-metadata-token": "same-origin-imds-token",
      "x-goog-api-key": "same-origin-google-key",
      "x-goog-iam-authorization-token": "same-origin-google-iam-token",
      "x-public": "kept",
    });
  });

  it.each([307, 308] as const)("replays a provider JSON POST across a %i redirect", async (status) => {
    const payload = JSON.stringify({ prompt: "body to replay" });
    const observed: Array<{ body: string; headers: Headers; method: string; url: string }> = [];
    installRecorder(policy({}), async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      observed.push({
        body: request.body ? await request.text() : "",
        headers: new Headers(request.headers),
        method: request.method,
        url: request.url,
      });
      return observed.length === 1
        ? new Response(null, {
            status,
            headers: { Location: "https://replay-target.example/final" },
          })
        : new Response("ok");
    });

    await globalThis.fetch("https://replay-source.example/start", {
      method: "POST",
      body: payload,
      headers: {
        Authorization: "Bearer private-token",
        Cookie: "private-cookie=1",
        "Proxy-Authorization": "Basic private-proxy-token",
        "Content-Type": "application/json",
        "X-Public": "kept",
      },
    });

    expect(observed).toHaveLength(2);
    expect(observed[1]).toMatchObject({
      body: payload,
      method: "POST",
      url: "https://replay-target.example/final",
    });
    expect(Object.fromEntries(observed[1]!.headers)).toEqual({
      "content-type": "application/json",
      "x-public": "kept",
    });
  });

  it("delegates an ordinary follow-mode streaming Request without cloning it", async () => {
    const tracked = trackedRequestBody();
    let delegated: Parameters<typeof fetch>[0] | undefined;
    installRecorder(policy({}), async (input) => {
      delegated = input;
      releaseDelegatedRequestBody(input);
      return new Response("ok");
    });
    const request = requestWithStreamBody("https://terminal.example/", tracked.body);

    const response = await globalThis.fetch(request);

    expect(await response.text()).toBe("ok");
    expect(delegated).toBe(request);
    expect(await settlesSoon(tracked.cancelled)).toBe(true);
  });

  it("follows a 303 rewrite to GET without replaying an opaque streaming body", async () => {
    const tracked = trackedRequestBody();
    const observed: Array<{ body: ReadableStream<Uint8Array> | null; method: string }> = [];
    installRecorder(policy({}), async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      observed.push({ body: request.body, method: request.method });
      releaseDelegatedRequestBody(input);
      return observed.length === 1
        ? new Response(null, { status: 303, headers: { Location: "/final" } })
        : new Response("ok");
    });

    const response = await globalThis.fetch(requestWithStreamBody(
      "https://rewrite.example/start",
      tracked.body,
    ));

    expect(await response.text()).toBe("ok");
    expect(observed).toHaveLength(2);
    expect(observed[0]).toMatchObject({ method: "POST" });
    expect(observed[0]!.body).not.toBeNull();
    expect(observed[1]).toEqual({ body: null, method: "GET" });
    expect(await settlesSoon(tracked.cancelled)).toBe(true);
  });

  it("fails a body-preserving redirect instead of replaying an opaque streaming body", async () => {
    const tracked = trackedRequestBody();
    let responseBodyCancelled = false;
    const { calls } = installRecorder(policy({}), async (input) => {
      releaseDelegatedRequestBody(input);
      return calls.length === 1
        ? new Response(new ReadableStream({
            cancel() {
              responseBodyCancelled = true;
            },
          }), {
            status: 307,
            headers: { Location: "/final" },
          })
        : new Response("unexpected replay");
    });

    await expect(globalThis.fetch(requestWithStreamBody(
      "https://opaque.example/start",
      tracked.body,
    ))).rejects.toThrow(/replay.*request body|request body.*replay/i);

    expect(calls).toHaveLength(1);
    expect(responseBodyCancelled).toBe(true);
    expect(await settlesSoon(tracked.cancelled)).toBe(true);
  });

  it("releases the retained request-body branch after a terminal response", async () => {
    const tracked = trackedRequestBody();
    installRecorder(policy({}), async (input) => {
      releaseDelegatedRequestBody(input);
      return new Response("ok");
    });

    const response = await globalThis.fetch(requestWithStreamBody(
      "https://terminal.example/",
      tracked.body,
    ));

    expect(await response.text()).toBe("ok");
    expect(await settlesSoon(tracked.cancelled)).toBe(true);
  });

  it("releases the retained request-body branch when the delegated request aborts", async () => {
    const tracked = trackedRequestBody();
    const controller = new AbortController();
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    installRecorder(policy({}), async (input, init) => {
      releaseDelegatedRequestBody(input);
      markEntered();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("delegated abort", "AbortError")),
          { once: true },
        );
      });
    });

    const pending = globalThis.fetch(requestWithStreamBody(
      "https://abort.example/",
      tracked.body,
      controller.signal,
    ));
    await entered;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(await settlesSoon(tracked.cancelled)).toBe(true);
  });

  it("cleans the response and retained request body before rejecting a malformed redirect", async () => {
    const tracked = trackedRequestBody();
    let responseBodyCancelled = false;
    installRecorder(policy({}), async (input) => {
      releaseDelegatedRequestBody(input);
      return new Response(new ReadableStream({
        cancel() {
          responseBodyCancelled = true;
        },
      }), {
        status: 302,
        headers: { Location: "http://[malformed" },
      });
    });

    const error = await globalThis.fetch(requestWithStreamBody(
      "https://redirect.example/",
      tracked.body,
    )).catch((cause) => {
      expect(responseBodyCancelled).toBe(true);
      return cause;
    });

    expect(error).toBeInstanceOf(Error);
    expect(await settlesSoon(tracked.cancelled)).toBe(true);
  });

  it("releases every redirect response body when the redirect limit is reached", async () => {
    let responseBodiesCancelled = 0;
    const { calls } = installRecorder(policy({}), async () => {
      return new Response(new ReadableStream({
        cancel() {
          responseBodiesCancelled += 1;
        },
      }), {
        status: 307,
        headers: { Location: "/again" },
      });
    });

    await expect(globalThis.fetch(
      "https://redirect-limit.example/start",
    )).rejects.toThrow("Too many redirects");

    expect(calls).toHaveLength(21);
    expect(responseBodiesCancelled).toBe(21);
  });

  it("applies an explicit category proxy to both HTTP and HTTPS targets", async () => {
    const { router, calls } = installRecorder(policy({
      easyresearch: { network: { llmProxy: "http://llm.proxy:8001" } },
    }, {
      http_proxy: "http://ambient-http.proxy:8010",
      https_proxy: "http://ambient-https.proxy:8020",
    }));

    await Promise.all([
      router.withScope("llm", () => globalThis.fetch("http://llm-plain.example/")),
      router.withScope("llm", () => globalThis.fetch("https://llm-secure.example/")),
    ]);

    expect(calls.map((call) => proxyFrom(call.init))).toEqual([
      "http://llm.proxy:8001",
      "http://llm.proxy:8001",
    ]);
  });

  it("uses one merged bypass and removes a wildcard when any product proxy is explicit", async () => {
    const { router, calls } = installRecorder(policy(
      { easyresearch: { network: { llmProxy: "http://llm.proxy:8001" } } },
      {
        HTTPS_PROXY: "http://inherited.proxy:8000",
        NO_PROXY: "*,.internal.example",
      },
    ));

    await Promise.all([
      globalThis.fetch("https://default.example/"),
      router.withScope("llm", () => globalThis.fetch("https://llm.example/")),
      router.withScope("search", () => globalThis.fetch("https://search.example/")),
      router.withScope("llm", () => globalThis.fetch("https://api.internal.example/")),
    ]);

    expect(Object.fromEntries(calls.map((call) => [inputUrl(call.input), proxyFrom(call.init)])))
      .toEqual({
        "https://default.example/": "http://inherited.proxy:8000",
        "https://llm.example/": "http://llm.proxy:8001",
        "https://search.example/": "http://inherited.proxy:8000",
        "https://api.internal.example/": undefined,
      });
  });

  it("bypasses mandatory loopback, domain suffix, and matching host ports", async () => {
    const { calls } = installRecorder(policy(
      { httpProxy: "http://all.proxy:8000" },
      { NO_PROXY: ".internal.example,port.example:8443" },
    ));

    await Promise.all([
      globalThis.fetch("http://localhost:3000/"),
      globalThis.fetch("http://127.0.0.1:3000/"),
      globalThis.fetch("http://[::1]:3000/"),
      globalThis.fetch("https://api.internal.example/"),
      globalThis.fetch("https://port.example:8443/"),
      globalThis.fetch("https://port.example/"),
      globalThis.fetch("https://public.example/"),
    ]);

    expect(Object.fromEntries(calls.map((call) => [inputUrl(call.input), proxyFrom(call.init)])))
      .toEqual({
        "http://localhost:3000/": undefined,
        "http://127.0.0.1:3000/": undefined,
        "http://[::1]:3000/": undefined,
        "https://api.internal.example/": undefined,
        "https://port.example:8443/": undefined,
        "https://port.example/": "http://all.proxy:8000",
        "https://public.example/": "http://all.proxy:8000",
      });
  });

  it("preserves Request input and init values while adding only the selected Bun proxy", async () => {
    const { router, calls } = installRecorder(policy({
      easyresearch: { network: { llmProxy: "http://llm.proxy:8001" } },
    }));
    const controller = new AbortController();
    const headers = new Headers({ "x-test": "kept" });
    const request = new Request("https://provider.example/v1", { method: "PUT" });
    const init: RequestInit = {
      body: "payload",
      headers,
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
    };

    await router.withScope("llm", () => globalThis.fetch(request, init));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toBe(request);
    expect(calls[0]!.init).toMatchObject({
      body: "payload",
      headers,
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      proxy: "http://llm.proxy:8001",
    });
    expect(calls[0]!.init?.signal).toBe(controller.signal);
    expect(Object.hasOwn(init, "proxy")).toBe(false);
  });

  it("uses explicit signal null without cloning a streaming input Request", async () => {
    const controller = new AbortController();
    const tracked = trackedRequestBody();
    let delegated: Parameters<typeof fetch>[0] | undefined;
    let delegatedSignal: AbortSignal | undefined;
    installRecorder(policy({}), async (input, init) => {
      delegated = input;
      delegatedSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      releaseDelegatedRequestBody(input);
      return new Response("ok");
    });
    const request = requestWithStreamBody(
      "https://detached-signal.example/",
      tracked.body,
      controller.signal,
    );

    const pending = globalThis.fetch(request, { signal: null });
    controller.abort();
    const response = await pending;

    expect(await response.text()).toBe("ok");
    expect(delegated).toBe(request);
    expect(request.signal.aborted).toBe(true);
    expect(delegatedSignal).not.toBe(request.signal);
    expect(delegatedSignal?.aborted).toBe(false);
    expect(await settlesSoon(tracked.cancelled)).toBe(true);
  });

  it("restores the captured fetch exactly and is idempotent", async () => {
    const { router, delegate } = installRecorder(policy({}));
    const wrapper = globalThis.fetch;

    router.restore();
    router.restore();

    expect(wrapper).toBe(router.fetch);
    expect(globalThis.fetch).toBe(delegate);
    await expect(globalThis.fetch("https://direct.example/").then((response) => response.text()))
       .resolves.toBe("ok");
  });

  it("rejects an overlapping install without replacing the active fetch or Gaxios patches", () => {
    const originalGaxiosRequest = currentGaxiosRequest();
    const { router, delegate } = installRecorder(policy({
      easyresearch: { network: { llmProxy: "http://first.proxy:8001" } },
    }));
    const activeFetch = globalThis.fetch;
    const activeGaxiosRequest = currentGaxiosRequest();
    let overlap: InstalledNetworkRouter | undefined;
    let overlapError: unknown;

    try {
      overlap = installNetworkRouter(policy({
        easyresearch: { network: { llmProxy: "http://second.proxy:8002" } },
      }));
    } catch (error) {
      overlapError = error;
    } finally {
      overlap?.restore();
    }

    expect(overlapError).toBeInstanceOf(Error);
    expect(String(overlapError)).toMatch(/already installed|active router/i);
    expect(globalThis.fetch).toBe(activeFetch);
    expect(currentGaxiosRequest()).toBe(activeGaxiosRequest);

    router.restore();
    expect(globalThis.fetch).toBe(delegate);
    expect(currentGaxiosRequest()).toBe(originalGaxiosRequest);
  });

  it("allows a fresh install after the prior router restores", () => {
    const originalGaxiosRequest = currentGaxiosRequest();
    const first = installRecorder(policy({}));
    first.router.restore();

    const second = installNetworkRouter(policy({
      easyresearch: { network: { llmProxy: "http://second.proxy:8002" } },
    }));
    installedRouters.push(second);

    expect(globalThis.fetch).toBe(second.fetch);
    expect(currentGaxiosRequest()).not.toBe(originalGaxiosRequest);
    second.restore();
    expect(globalThis.fetch).toBe(first.delegate);
    expect(currentGaxiosRequest()).toBe(originalGaxiosRequest);
  });

  it("rejects unsupported explicit scopes without running the operation", () => {
    const { router } = installRecorder(policy({}));
    let called = false;

    expect(() => router.withScope("all" as never, () => {
      called = true;
    })).toThrow(TypeError);
    expect(called).toBe(false);
  });
});

describe("malformed-policy isolation", () => {
  it("blocks every route class for a settings error", async () => {
    const { router, calls } = installRecorder(policy(null, {
      HTTPS_PROXY: "http://ambient-user:ambient-secret@ambient.proxy:9000",
    }));

    await expect(globalThis.fetch("https://all.example/"))
      .rejects.toMatchObject({ code: "NETWORK_PROXY_INVALID", field: "settings", scope: "all" });
    await expect(router.withScope("llm", () => globalThis.fetch("https://llm.example/")))
      .rejects.toMatchObject({ code: "NETWORK_PROXY_INVALID", field: "settings", scope: "llm" });
    await expect(router.withScope("search", () => globalThis.fetch("https://search.example/")))
      .rejects.toMatchObject({ code: "NETWORK_PROXY_INVALID", field: "settings", scope: "search" });
    expect(calls).toEqual([]);
  });

  it("lets a valid category override bypass an All error but blocks classes that inherit All", async () => {
    const { router, calls } = installRecorder(policy({
      httpProxy: "not-a-proxy",
      easyresearch: { network: { llmProxy: "http://llm.proxy:8001" } },
    }, {
      HTTPS_PROXY: "http://ambient-user:ambient-secret@ambient.proxy:9000",
    }));

    await router.withScope("llm", () => globalThis.fetch("https://llm.example/"));
    await expect(globalThis.fetch("https://all.example/"))
      .rejects.toMatchObject({ code: "NETWORK_PROXY_INVALID", field: "all", scope: "all" });
    await expect(router.withScope("search", () => globalThis.fetch("https://search.example/")))
      .rejects.toMatchObject({ code: "NETWORK_PROXY_INVALID", field: "all", scope: "search" });

    expect(calls.map((call) => proxyFrom(call.init))).toEqual(["http://llm.proxy:8001"]);
  });

  it("keeps a valid explicit LLM route usable while the daemon environment fails malformed All traffic closed", async () => {
    const networkPolicy = policy({
      httpProxy: "not-a-proxy",
      easyresearch: { network: { llmProxy: "http://llm.proxy:8001" } },
    }, {
      HTTPS_PROXY: "http://ambient.proxy:9000",
      NO_PROXY: "*",
    });
    const daemonEnvironment: Record<string, string | undefined> = {};
    applyNetworkPolicyEnvironment(networkPolicy, captureInheritedProxyEnvironment({
      HTTPS_PROXY: "http://ambient.proxy:9000",
      NO_PROXY: "*",
    }), daemonEnvironment);
    const { router, calls } = installRecorder(networkPolicy);

    await router.withScope("llm", () => globalThis.fetch("https://llm.example/"));

    expect(daemonEnvironment.HTTPS_PROXY).toBe("http://127.0.0.1:0");
    expect(daemonEnvironment.NO_PROXY).toBe("localhost,127.0.0.1,::1,localhost.,[::1]");
    expect(calls.map((call) => proxyFrom(call.init))).toEqual(["http://llm.proxy:8001"]);
  });

  it.each([
    ["llm", { easyresearch: { network: { llmProxy: "bad" } } }, "llm"],
    ["search", { easyresearch: { network: { searchProxy: "bad" } } }, "search"],
  ] as const)("blocks an invalid %s field without blocking sibling routes", async (
    scope,
    settings,
    field,
  ) => {
    const { router, calls } = installRecorder(policy({
      httpProxy: "http://all.proxy:8000",
      ...settings,
    }));
    const sibling = scope === "llm" ? "search" : "llm";

    await expect(router.withScope(scope, () => globalThis.fetch(`https://${scope}.example/`)))
      .rejects.toMatchObject({ code: "NETWORK_PROXY_INVALID", field, scope });
    await router.withScope(sibling, () => globalThis.fetch(`https://${sibling}.example/`));
    await globalThis.fetch("https://all.example/");

    expect(calls.map((call) => proxyFrom(call.init))).toEqual([
      "http://all.proxy:8000",
      "http://all.proxy:8000",
    ]);
  });
});

describe("provider-scoped environment", () => {
  it("preserves exact inherited proxy keys for providers while normalizing only bypass", () => {
    const { router } = installRecorder(policy(
      { easyresearch: { network: { llmProxy: "http://llm.proxy:8001" } } },
      {
        http_proxy: "http://lower-http.proxy:8010",
        HTTP_PROXY: "http://upper-http.proxy:8011",
        https_proxy: "http://lower-https.proxy:8020",
        HTTPS_PROXY: "http://ambient-user:ambient-secret@ambient.proxy:9000",
        ALL_PROXY: "http://upper-all.proxy:8031",
        NO_PROXY: "*,corp.internal",
      },
    ));

    expect(router.providerEnv("all")).toEqual({
      http_proxy: "http://lower-http.proxy:8010",
      HTTP_PROXY: "http://upper-http.proxy:8011",
      https_proxy: "http://lower-https.proxy:8020",
      HTTPS_PROXY: "http://ambient-user:ambient-secret@ambient.proxy:9000",
      ALL_PROXY: "http://upper-all.proxy:8031",
      NO_PROXY: "corp.internal,localhost,127.0.0.1,::1,localhost.,[::1]",
      no_proxy: "corp.internal,localhost,127.0.0.1,::1,localhost.,[::1]",
    });
    expect(router.providerEnv("llm")).toEqual({
      HTTP_PROXY: "http://llm.proxy:8001",
      http_proxy: "http://llm.proxy:8001",
      HTTPS_PROXY: "http://llm.proxy:8001",
      https_proxy: "http://llm.proxy:8001",
      ALL_PROXY: "http://llm.proxy:8001",
      all_proxy: "http://llm.proxy:8001",
      NO_PROXY: "corp.internal,localhost,127.0.0.1,::1,localhost.,[::1]",
      no_proxy: "corp.internal,localhost,127.0.0.1,::1,localhost.,[::1]",
    });
    expect(router.providerEnv("search")).toEqual(router.providerEnv("all"));
  });

  it("keeps inherited URLs out of enumerable policy diagnostics", () => {
    const inherited = "http://ambient-user:ambient-secret@private.proxy:9000";
    const networkPolicy = policy({}, {
      HTTPS_PROXY: inherited,
      http_proxy: "http://other-user:other-secret@private-http.proxy:9001",
    });

    const visible = JSON.stringify(networkPolicy);

    expect(visible).not.toContain(inherited);
    expect(visible).not.toContain("ambient-user");
    expect(visible).not.toContain("other-user");
    expect(visible).not.toContain("private-http.proxy");
  });

  it("routes the exact Google Vertex ADC Gaxios transport through LLM while Search is concurrent", async () => {
    const { GoogleAuth } = createRequire(import.meta.url)("google-auth-library") as {
      GoogleAuth: new (options: Record<string, unknown>) => {
        getClient(): Promise<{
          transporter: {
            request(options: Record<string, unknown>): Promise<unknown>;
          };
        }>;
      };
    };
    const { router, calls } = installRecorder(policy({
      httpProxy: "http://all.proxy:8000",
      easyresearch: {
        network: {
          llmProxy: "http://llm.proxy:8001",
          searchProxy: "http://search.proxy:8002",
        },
      },
    }));
    const auth = new GoogleAuth({
      projectId: "fixture-project",
      credentials: {
        type: "authorized_user",
        client_id: "fixture-client",
        client_secret: "fixture-secret",
        refresh_token: "fixture-refresh",
      },
    });
    const client = await auth.getClient();
    let prepared: Record<string, unknown> | undefined;
    let releaseLlm!: () => void;
    let markLlmEntered!: () => void;
    const llmEntered = new Promise<void>((resolve) => {
      markLlmEntered = resolve;
    });
    const llmGate = new Promise<void>((resolve) => {
      releaseLlm = resolve;
    });

    const llm = router.withScope("llm", () => client.transporter.request({
      url: "https://oauth2.googleapis.com/token",
      method: "POST",
      data: "grant_type=refresh_token",
      adapter: async (
        config: Record<string, unknown>,
        defaultAdapter: (preparedConfig: Record<string, unknown>) => Promise<unknown>,
      ) => {
        prepared = config;
        markLlmEntered();
        await llmGate;
        return defaultAdapter(config);
      },
    }));
    await llmEntered;
    const search = router.withScope(
      "search",
      () => globalThis.fetch("https://search-target.example/"),
    );
    releaseLlm();
    await Promise.all([llm, search]);

    expect(prepared?.proxy).toBe("http://llm.proxy:8001");
    expect(prepared?.fetchImplementation).toBe(router.fetch);
    expect(prepared?.noProxy).toEqual(expect.arrayContaining([
      "localhost",
      "127.0.0.1",
      "::1",
    ]));
    expect(Object.fromEntries(calls.map((call) => [inputUrl(call.input), proxyFrom(call.init)])))
      .toEqual({
        "https://oauth2.googleapis.com/token": "http://llm.proxy:8001",
        "https://search-target.example/": "http://search.proxy:8002",
      });
  });

  it("keeps IPv6 loopback direct for the exact provider-native Gaxios hostname form", async () => {
    const { Gaxios } = createRequire(import.meta.url)("gaxios") as {
      Gaxios: new () => {
        request(options: Record<string, unknown>): Promise<unknown>;
      };
    };
    const { router } = installRecorder(policy({
      easyresearch: { network: { llmProxy: "http://llm.proxy:8001" } },
    }));
    const transport = new Gaxios();
    let prepared: Record<string, unknown> | undefined;

    await router.withScope("llm", () => transport.request({
      url: "http://[::1]:4321/token",
      adapter: async (config: Record<string, unknown>) => {
        prepared = config;
        return {
          config,
          data: "ok",
          headers: new Headers(),
          status: 200,
          statusText: "OK",
        };
      },
    }));

    expect(new URL("http://[::1]:4321/token").hostname).toBe("[::1]");
    expect(prepared?.noProxy).toEqual(expect.arrayContaining(["::1", "[::1]"]));
    expect(prepared?.agent).toBeUndefined();
  });
});

describe("applied Search route", () => {
  it("applies direct, configured, and inherited proxy inputs without exposing the URL", () => {
    const direct = createAppliedSearchRoute(policy({}));
    const configured = createAppliedSearchRoute(policy({
      easyresearch: { network: { searchProxy: " HTTP://Proxy.Example:80/ " } },
    }));
    const inherited = createAppliedSearchRoute(policy({}, {
      HTTPS_PROXY: "http://proxy.example",
    }));
    const directConfig = { useProxy: true, proxyUrl: "http://disabled.invalid" };
    const configuredConfig = { useProxy: false, proxyUrl: "http://disabled.invalid" };
    const inheritedConfig = { useProxy: false, proxyUrl: "http://disabled.invalid" };

    direct.applyProxyConfiguration(directConfig);
    configured.applyProxyConfiguration(configuredConfig);
    inherited.applyProxyConfiguration(inheritedConfig);

    expect(directConfig).toEqual({ useProxy: false, proxyUrl: "http://disabled.invalid" });
    expect(configuredConfig).toEqual({ useProxy: true, proxyUrl: "http://proxy.example" });
    expect(inheritedConfig).toEqual({ useProxy: true, proxyUrl: "http://proxy.example" });
    expect(configured.policyFingerprint).toBe(inherited.policyFingerprint);
    expect(JSON.stringify(configured)).not.toContain("proxy.example");
    expect(JSON.stringify(inherited)).not.toContain("proxy.example");
  });

  it("reports an invalid Search policy without applying a fallback route", () => {
    const route = createAppliedSearchRoute(policy({
      httpProxy: "http://all.proxy:8000",
      easyresearch: { network: { searchProxy: "not-a-proxy" } },
    }));
    const target = { useProxy: false, proxyUrl: "http://unchanged.invalid" };

    expect(route.invalidError()).toMatchObject({
      code: "NETWORK_PROXY_INVALID",
      field: "search",
      scope: "search",
    });
    expect(() => route.applyProxyConfiguration(target)).toThrowError(expect.objectContaining({
      code: "NETWORK_PROXY_INVALID",
      field: "search",
      scope: "search",
    }));
    expect(target).toEqual({ useProxy: false, proxyUrl: "http://unchanged.invalid" });
  });

  it("sanitizes configured and inherited proxy URLs plus arbitrary URL userinfo", () => {
    const configuredProxy = "http://configured.proxy:8001";
    const inheritedProxy = "http://ambient-user:ambient-secret@ambient.proxy:9000";
    const route = createAppliedSearchRoute(policy({
      easyresearch: { network: { searchProxy: configuredProxy } },
    }, {
      HTTPS_PROXY: inheritedProxy,
    }));

    const message = route.sanitizeError(new Error(
      `failed through ${configuredProxy} after ${inheritedProxy}; retry https://other-user:other-secret@other.proxy/path`,
    ));

    expect(message).toContain("failed through");
    expect(message).not.toContain(configuredProxy);
    expect(message).not.toContain(inheritedProxy);
    expect(message).not.toContain("ambient-user");
    expect(message).not.toContain("ambient-secret");
    expect(message).not.toContain("other-user");
    expect(message).not.toContain("other-secret");
  });

  it("matches merged bypass targets and includes behavior-changing bypass in proxy identity", () => {
    const first = createAppliedSearchRoute(policy({
      easyresearch: { network: { searchProxy: "http://proxy.example:8000" } },
    }, {
      NO_PROXY: "*.first.example,port.example:8443",
    }));
    const second = createAppliedSearchRoute(policy({
      easyresearch: { network: { searchProxy: "http://proxy.example:8000" } },
    }, {
      NO_PROXY: "*.second.example,port.example:8443",
    }));
    const route = first as AppliedSearchRoute & {
      bypasses(url: string | URL): boolean;
    };

    expect(route.bypasses).toEqual(expect.any(Function));
    expect(route.bypasses("https://api.first.example/resource")).toBe(true);
    expect(route.bypasses("https://port.example:8443/resource")).toBe(true);
    expect(route.bypasses("https://port.example/resource")).toBe(false);
    expect(route.bypasses("https://public.example/resource")).toBe(false);
    expect(first.policyFingerprint).not.toBe(second.policyFingerprint);
  });
});

class FakeModelRuntime {
  readonly invocations: Array<{ name: string; args: unknown[]; bound: boolean }> = [];
  #label = "runtime";
  count = 2;

  get summary(): string {
    return `${this.#label}:${this.count}`;
  }

  set summary(value: string) {
    this.#label = value;
  }

  ordinary(suffix: string): string {
    return `${this.#label}:${this.count}:${suffix}`;
  }

  login(...args: unknown[]): Promise<Response> {
    return this.networkPromise("login", args);
  }

  getAuth(...args: unknown[]): Promise<Response> {
    return this.networkPromise("getAuth", args);
  }

  refresh(...args: unknown[]): Promise<Response | string> {
    this.record("refresh", args);
    const options = args[0] as { allowNetwork?: boolean } | undefined;
    return options?.allowNetwork === false
      ? Promise.resolve("local-only")
      : this.fetchLater("refresh");
  }

  stream(...args: unknown[]): { request: Promise<Response> } {
    return this.networkLazy("stream", args);
  }

  streamSimple(...args: unknown[]): { request: Promise<Response> } {
    return this.networkLazy("streamSimple", args);
  }

  complete(...args: unknown[]): Promise<Response> {
    return this.networkPromise("complete", args);
  }

  completeSimple(...args: unknown[]): Promise<Response> {
    return this.networkPromise("completeSimple", args);
  }

  fetchDeferred(...args: unknown[]): Promise<Response> {
    return this.networkPromise("fetchDeferred", args);
  }

  cancelDeferred(...args: unknown[]): Promise<Response> {
    return this.networkPromise("cancelDeferred", args);
  }

  checkAuth(...args: unknown[]): Promise<Response> {
    return this.networkPromise("checkAuth", args);
  }

  getAvailable(...args: unknown[]): Promise<Response> {
    return this.networkPromise("getAvailable", args);
  }

  logout(...args: unknown[]): Promise<Response> {
    return this.networkPromise("logout", args);
  }

  setRuntimeApiKey(...args: unknown[]): Promise<Response> {
    return this.networkPromise("setRuntimeApiKey", args);
  }

  registerNativeProvider(...args: unknown[]): Promise<Response> {
    return this.networkPromise("registerNativeProvider", args);
  }

  private record(name: string, args: unknown[]): void {
    this.invocations.push({ name, args, bound: this instanceof FakeModelRuntime });
  }

  private networkLazy(name: string, args: unknown[]): { request: Promise<Response> } {
    this.record(name, args);
    return { request: this.fetchLater(name) };
  }

  private networkPromise(name: string, args: unknown[]): Promise<Response> {
    this.record(name, args);
    return this.fetchLater(name);
  }

  private fetchLater(name: string): Promise<Response> {
    // Pi's lazyStream calls its async setup immediately before returning.
    return Promise.resolve().then(() => globalThis.fetch(`https://${name.toLowerCase()}.example/`));
  }
}

describe("ModelRuntime network decoration", () => {
  it("keeps every network-bearing operation in the LLM scope, including immediate lazy setup", async () => {
    const { router, calls } = installRecorder(policy({
      httpProxy: "http://all.proxy:8000",
      easyresearch: { network: { llmProxy: "http://llm.proxy:8001" } },
    }));
    const runtime = new FakeModelRuntime();
    const decorated = router.decorateModelRuntime(runtime);

    const stream = decorated.stream("model", "context");
    const simpleStream = decorated.streamSimple("model", "context");
    await Promise.all([
      decorated.login("provider", "oauth", {}),
      decorated.getAuth("provider"),
      decorated.refresh({ allowNetwork: true }),
      stream.request,
      simpleStream.request,
      decorated.complete("model", "context"),
      decorated.completeSimple("model", "context"),
      decorated.fetchDeferred("model", "handle"),
      decorated.cancelDeferred("model", "handle"),
      decorated.checkAuth("provider"),
      decorated.getAvailable(),
      decorated.logout("provider"),
      decorated.setRuntimeApiKey("provider", "runtime-key"),
      decorated.registerNativeProvider({ id: "provider" }),
    ]);

    expect(calls).toHaveLength(14);
    expect(calls.map((call) => proxyFrom(call.init)))
      .toEqual(Array.from({ length: 14 }, () => "http://llm.proxy:8001"));
    expect(runtime.invocations.every((invocation) => invocation.bound)).toBe(true);
  });

  it("scopes every runtime function without injecting options into unknown methods and stays isolated from Search", async () => {
    const { router, calls } = installRecorder(policy({
      httpProxy: "http://all.proxy:8000",
      easyresearch: {
        network: {
          llmProxy: "http://llm.proxy:8001",
          searchProxy: "http://search.proxy:8002",
        },
      },
    }));
    const runtime = new FakeModelRuntime();
    const decorated = router.decorateModelRuntime(runtime);
    const unknownOptions = { env: { SHOULD_STAY: "untouched" }, fetch: platformFetch };

    await Promise.all([
      decorated.checkAuth("provider", unknownOptions),
      decorated.getAvailable(unknownOptions),
      decorated.logout("provider", unknownOptions),
      decorated.setRuntimeApiKey("provider", "runtime-key", unknownOptions),
      decorated.registerNativeProvider({ id: "provider" }, unknownOptions),
      router.withScope("search", () => globalThis.fetch("https://concurrent-search.example/")),
    ]);

    const byTarget = Object.fromEntries(calls.map((call) => [inputUrl(call.input), proxyFrom(call.init)]));
    expect(byTarget["https://concurrent-search.example/"]).toBe("http://search.proxy:8002");
    for (const target of [
      "https://checkauth.example/",
      "https://getavailable.example/",
      "https://logout.example/",
      "https://setruntimeapikey.example/",
      "https://registernativeprovider.example/",
    ]) {
      expect(byTarget[target]).toBe("http://llm.proxy:8001");
    }
    for (const invocation of runtime.invocations.filter(({ name }) => [
      "checkAuth",
      "getAvailable",
      "logout",
      "setRuntimeApiKey",
      "registerNativeProvider",
    ].includes(name))) {
      expect(invocation.args.at(-1)).toBe(unknownOptions);
    }
    expect(unknownOptions).toEqual({ env: { SHOULD_STAY: "untouched" }, fetch: platformFetch });
  });

  it("returns the same decorated identity instead of nesting runtime proxies", () => {
    const { router } = installRecorder(policy({}));
    const runtime = new FakeModelRuntime();
    const decorated = router.decorateModelRuntime(runtime);

    expect(router.decorateModelRuntime(runtime)).toBe(decorated);
    expect(router.decorateModelRuntime(decorated)).toBe(decorated);
  });

  it("injects the exact installed fetch and LLM WebSocket environment without mutating options", async () => {
    const { router } = installRecorder(policy(
      { easyresearch: { network: { llmProxy: "http://llm.proxy:8001" } } },
      { NO_PROXY: "llm.internal" },
    ));
    const runtime = new FakeModelRuntime();
    const decorated = router.decorateModelRuntime(runtime);
    const signal = new AbortController().signal;
    const options = {
      env: { CUSTOM_PROVIDER_VALUE: "kept", HTTP_PROXY: "http://caller.proxy:9999" },
      fetch: platformFetch,
      signal,
    };

    const stream = decorated.stream("model", "context", options);
    const simpleStream = decorated.streamSimple("model", "context", options);
    await Promise.all([
      stream.request,
      simpleStream.request,
      decorated.complete("model", "context", options),
      decorated.completeSimple("model", "context", options),
      decorated.fetchDeferred("model", "handle", options),
      decorated.cancelDeferred("model", "handle", options),
      decorated.getAuth("provider", { env: { CUSTOM_AUTH_VALUE: "kept" }, signal }),
    ]);

    for (const invocation of runtime.invocations.filter(({ name }) => [
      "stream",
      "streamSimple",
      "complete",
      "completeSimple",
      "fetchDeferred",
      "cancelDeferred",
    ].includes(name))) {
      const injected = invocation.args[2] as {
        env: Record<string, string>;
        fetch: typeof fetch;
        signal: AbortSignal;
      };
      expect(injected.fetch).toBe(router.fetch);
      expect(injected.fetch).toBe(globalThis.fetch);
      expect(injected.signal).toBe(signal);
      expect(injected.env).toMatchObject({
        CUSTOM_PROVIDER_VALUE: "kept",
        HTTP_PROXY: "http://llm.proxy:8001",
        http_proxy: "http://llm.proxy:8001",
        HTTPS_PROXY: "http://llm.proxy:8001",
        https_proxy: "http://llm.proxy:8001",
        ALL_PROXY: "http://llm.proxy:8001",
        all_proxy: "http://llm.proxy:8001",
        NO_PROXY: "llm.internal,localhost,127.0.0.1,::1,localhost.,[::1]",
        no_proxy: "llm.internal,localhost,127.0.0.1,::1,localhost.,[::1]",
      });
    }
    const getAuth = runtime.invocations.find((invocation) => invocation.name === "getAuth")!;
    expect(getAuth.args[1]).toMatchObject({
      env: {
        CUSTOM_AUTH_VALUE: "kept",
        HTTP_PROXY: "http://llm.proxy:8001",
        HTTPS_PROXY: "http://llm.proxy:8001",
        ALL_PROXY: "http://llm.proxy:8001",
        NO_PROXY: "llm.internal,localhost,127.0.0.1,::1,localhost.,[::1]",
      },
      signal,
    });
    expect(options).toEqual({
      env: { CUSTOM_PROVIDER_VALUE: "kept", HTTP_PROXY: "http://caller.proxy:9999" },
      fetch: platformFetch,
      signal,
    });
  });

  it("preserves property access, setters, prototypes, and detached method binding", () => {
    const { router } = installRecorder(policy({}));
    const runtime = new FakeModelRuntime();
    const decorated = router.decorateModelRuntime(runtime);
    const ordinary = decorated.ordinary;

    decorated.count = 4;
    decorated.summary = "decorated";

    expect(decorated.summary).toBe("decorated:4");
    expect(runtime.summary).toBe("decorated:4");
    expect(ordinary("bound")).toBe("decorated:4:bound");
    expect(decorated).toBeInstanceOf(FakeModelRuntime);
    expect(Object.getPrototypeOf(decorated)).toBe(Object.getPrototypeOf(runtime));
  });

  it("allows local refresh with allowNetwork false", async () => {
    const { router, calls } = installRecorder(policy({
      easyresearch: { network: { llmProxy: "http://llm.proxy:8001" } },
    }));
    const runtime = new FakeModelRuntime();
    const decorated = router.decorateModelRuntime(runtime);
    const options = { allowNetwork: false as const };

    await expect(decorated.refresh(options)).resolves.toBe("local-only");

    expect(calls).toEqual([]);
    expect(runtime.invocations[0]!.args[0]).toBe(options);
  });
});

describe("routing error redaction", () => {
  it("preserves abort identity and signal while redacting the selected proxy", async () => {
    const selectedProxy = "http://configured.proxy:8001";
    const controller = new AbortController();
    const { router } = installRecorder(policy({
      easyresearch: { network: { llmProxy: selectedProxy } },
    }), async (_input, init) => {
      expect(init?.signal).toBe(controller.signal);
      throw new DOMException(`aborted through ${proxyFrom(init)}`, "AbortError");
    });

    const error = await router.withScope(
      "llm",
      () => globalThis.fetch("https://llm.example/", { signal: controller.signal }),
    ).catch((cause) => cause);

    expect(error).toBeInstanceOf(DOMException);
    expect(error).toMatchObject({ name: "AbortError" });
    expect(`${String(error)}\n${error.stack}`).not.toContain(selectedProxy);
  });

  it("removes effective proxy URLs and arbitrary URL userinfo from delegated fetch errors", async () => {
    const inheritedProxy = "http://ambient-user:ambient-secret@ambient.proxy:9000";
    const configuredProxy = "http://configured.proxy:8001";
    const { router } = installRecorder(policy({
      easyresearch: { network: { llmProxy: configuredProxy } },
    }, {
      HTTPS_PROXY: inheritedProxy,
    }), async (_input, init) => {
      const selectedProxy = proxyFrom(init);
      throw new Error(
        `connect through ${selectedProxy}/ failed via https://other-user:other-secret@other.proxy/path`,
      );
    });

    const inheritedError = await globalThis.fetch("https://all.example/").catch((error) => error);
    const configuredError = await router.withScope(
      "llm",
      () => globalThis.fetch("https://llm.example/"),
    ).catch((error) => error);

    for (const error of [inheritedError, configuredError]) {
      const visible = `${String(error)}\n${error instanceof Error ? error.stack : ""}\n${JSON.stringify(error)}`;
      expect(visible).toContain("connect through");
      expect(visible).not.toContain(inheritedProxy);
      expect(visible).not.toContain(configuredProxy);
      expect(visible).not.toContain("ambient-user");
      expect(visible).not.toContain("ambient-secret");
      expect(visible).not.toContain("other-user");
      expect(visible).not.toContain("other-secret");
      expect(error).not.toHaveProperty("cause");
    }
  });
});
