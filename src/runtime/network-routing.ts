import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import type {
  NetworkPolicy,
  NetworkProxyField,
} from "./network-policy";
import {
  networkPolicyProxySecrets,
  networkProviderEnvironment,
  networkProxyForTarget,
} from "./network-policy";

export type NetworkScope = "llm" | "search";
export type NetworkRouteClass = "all" | NetworkScope;

export interface SearchProxyConfiguration {
  proxyUrl: string;
  useProxy: boolean;
}

export interface AppliedSearchRoute {
  /** Safe identity for the immutable effective route; never contains its URL. */
  readonly policyFingerprint: string;
  applyProxyConfiguration(target: SearchProxyConfiguration): void;
  bypasses?(url: string | URL): boolean;
  invalidError(): Error | undefined;
  sanitizeError(error: unknown): string;
}

export interface InstalledNetworkRouter {
  /** The exact wrapper installed on `globalThis.fetch`. */
  readonly fetch: typeof globalThis.fetch;
  readonly appliedSearchRoute: AppliedSearchRoute;
  withScope<T>(scope: NetworkScope, operation: () => T): T;
  providerEnv(scope: NetworkRouteClass): Readonly<Record<string, string>>;
  decorateModelRuntime<T extends object>(runtime: T): T;
  restore(): void;
}

export type AgentSessionNetworkRouter = Pick<
  InstalledNetworkRouter,
  "appliedSearchRoute" | "decorateModelRuntime" | "withScope"
>;

interface RouteState {
  readonly scope: NetworkRouteClass;
  readonly httpProxy?: string;
  readonly httpsProxy?: string;
  readonly bypass: string;
  readonly invalidField?: NetworkProxyField;
  readonly providerEnv?: Readonly<Record<string, string>>;
}

type BunFetchInit = NonNullable<Parameters<typeof fetch>[1]> & {
  proxy?: string;
};

type ReplayableRequestBody = () => BodyInit;

interface GaxiosRequestOptions extends Record<string, unknown> {
  baseURL?: string | URL;
  fetchImplementation?: typeof globalThis.fetch;
  noProxy?: Array<string | URL | RegExp>;
  proxy?: string;
  url?: string | URL;
}

type GaxiosRequest = (
  this: object,
  options?: GaxiosRequestOptions,
) => Promise<unknown>;

interface GaxiosPrototype {
  request: GaxiosRequest;
}

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
] as const;
const BYPASS_ENV_KEYS = ["NO_PROXY", "no_proxy"] as const;
const ROUTING_ENV_KEYS = [...PROXY_ENV_KEYS, ...BYPASS_ENV_KEYS] as const;
const MANDATORY_BYPASS_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 20;
const CROSS_ORIGIN_CREDENTIAL_HEADERS = [
  "api-key",
  "authorization",
  "cf-aig-authorization",
  "cookie",
  "cookie2",
  "dpop",
  "proxy-authorization",
  "x-amz-s3session-token",
  "x-amz-security-token",
  "x-amz-sso_bearer_token",
  "x-api-key",
  "x-aws-ec2-metadata-token",
  "x-goog-api-key",
  "x-goog-iam-authorization-token",
] as const;
const REQUEST_OPTIONS_INDEX: Readonly<Record<string, number>> = Object.freeze({
  stream: 2,
  streamSimple: 2,
  complete: 2,
  completeSimple: 2,
  fetchDeferred: 2,
  cancelDeferred: 2,
});
let activeNetworkRouterOwner: object | undefined;

class InvalidNetworkProxyError extends Error {
  readonly code = "NETWORK_PROXY_INVALID" as const;

  constructor(
    readonly field: NetworkProxyField,
    readonly scope: NetworkRouteClass,
  ) {
    super(`Network proxy configuration is invalid for ${scope} traffic (${field}).`);
    this.name = "InvalidNetworkProxyError";
  }
}

function invalidFieldFor(
  policy: NetworkPolicy,
  scope: NetworkRouteClass,
): NetworkProxyField | undefined {
  const fields = new Set(policy.errors.map((error) => error.field));
  if (fields.has("settings")) return "settings";
  if (scope === "llm" && fields.has("llm")) return "llm";
  if (scope === "search" && fields.has("search")) return "search";
  if (
    fields.has("all")
    && (scope === "all" || policy.configured[scope] === undefined)
  ) return "all";
  return undefined;
}

function createRouteState(policy: NetworkPolicy, scope: NetworkRouteClass): RouteState {
  const invalidField = invalidFieldFor(policy, scope);
  const httpProxy = networkProxyForTarget(policy, scope, "http:");
  const httpsProxy = networkProxyForTarget(policy, scope, "https:");
  const bypass = policy.bypass;
  return Object.freeze({
    scope,
    ...(httpProxy !== undefined ? { httpProxy } : {}),
    ...(httpsProxy !== undefined ? { httpsProxy } : {}),
    bypass,
    ...(invalidField
      ? { invalidField }
      : { providerEnv: networkProviderEnvironment(policy, scope) }),
  });
}

function normalizeHostname(hostname: string): string {
  let normalized = hostname.trim().toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1);
  }
  if (normalized.endsWith(".")) normalized = normalized.slice(0, -1);
  return normalized;
}

function targetUrl(input: Parameters<typeof fetch>[0]): URL | undefined {
  try {
    if (input instanceof URL) return input;
    if (typeof input === "string") return new URL(input);
    return new URL(input.url);
  } catch {
    return undefined;
  }
}

function gaxiosTargetUrl(options: GaxiosRequestOptions): URL | undefined {
  try {
    if (options.url instanceof URL) return options.url;
    if (typeof options.url !== "string") return undefined;
    if (options.baseURL instanceof URL) return new URL(options.url, options.baseURL);
    if (typeof options.baseURL === "string") return new URL(options.url, options.baseURL);
    return new URL(options.url);
  } catch {
    return undefined;
  }
}

function targetPort(url: URL): number {
  if (url.port) return Number.parseInt(url.port, 10);
  if (url.protocol === "http:") return 80;
  if (url.protocol === "https:") return 443;
  return 0;
}

function splitBypassHostAndPort(entry: string): { host: string; port?: number } {
  if (entry.startsWith("[")) {
    const closingBracket = entry.indexOf("]");
    if (closingBracket !== -1) {
      const host = entry.slice(1, closingBracket);
      const suffix = entry.slice(closingBracket + 1);
      if (/^:\d+$/u.test(suffix)) {
        return { host, port: Number.parseInt(suffix.slice(1), 10) };
      }
      return { host };
    }
  }

  const portMatch = entry.match(/^(.*):(\d+)$/u);
  if (portMatch && !portMatch[1]!.includes(":")) {
    return {
      host: portMatch[1]!,
      port: Number.parseInt(portMatch[2]!, 10),
    };
  }
  return { host: entry };
}

function bypassHostMatches(hostname: string, rawPattern: string): boolean {
  const pattern = normalizeHostname(rawPattern);
  if (pattern === "*") return true;
  if (pattern.startsWith("*.")) {
    return hostname.endsWith(pattern.slice(1));
  }
  if (pattern.startsWith(".")) {
    return hostname === pattern.slice(1) || hostname.endsWith(pattern);
  }
  if (pattern.startsWith("*")) return hostname.endsWith(pattern.slice(1));
  return hostname === pattern;
}

function bypassesTarget(input: Parameters<typeof fetch>[0], bypass: string): boolean {
  const url = targetUrl(input);
  if (!url) return false;
  if (url.protocol !== "http:" && url.protocol !== "https:") return true;

  const hostname = normalizeHostname(url.hostname);
  if (MANDATORY_BYPASS_HOSTS.has(hostname)) return true;
  const port = targetPort(url);
  for (const rawEntry of bypass.split(/[\s,]+/u)) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const candidate = splitBypassHostAndPort(entry);
    if (candidate.port !== undefined && candidate.port !== port) continue;
    if (bypassHostMatches(hostname, candidate.host)) return true;
  }
  return false;
}

function routedInit(
  init: Parameters<typeof fetch>[1],
  proxy: string | undefined,
  direct: boolean,
): Parameters<typeof fetch>[1] {
  if (proxy !== undefined && !direct) return { ...(init ?? {}), proxy } as BunFetchInit;
  if (!init || !Object.hasOwn(init, "proxy")) return init;
  const result = { ...init } as BunFetchInit;
  delete result.proxy;
  return result;
}

function redirectMode(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
): RequestRedirect {
  return init?.redirect ?? (input instanceof Request ? input.redirect : "follow");
}

function redirectsAsGet(request: Request, status: number): boolean {
  return (status === 301 || status === 302) && request.method === "POST"
    || status === 303 && request.method !== "GET" && request.method !== "HEAD";
}

function replayableRequestBody(body: BodyInit | null | undefined): ReplayableRequestBody | undefined {
  if (typeof body === "string") return () => body;
  if (body instanceof URLSearchParams) {
    const value = body.toString();
    return () => new URLSearchParams(value);
  }
  if (body instanceof Blob) return () => body;
  if (body instanceof ArrayBuffer) {
    const value = body.slice(0);
    return () => value.slice(0);
  }
  if (ArrayBuffer.isView(body)) {
    const value = new Uint8Array(body.buffer, body.byteOffset, body.byteLength).slice();
    return () => value.slice();
  }
  return undefined;
}

function canDelegateRequestDirectly(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
): input is Request {
  if (!(input instanceof Request)) return false;
  if (!init) return true;
  return init.body === undefined
    && init.cache === undefined
    && init.credentials === undefined
    && init.headers === undefined
    && init.integrity === undefined
    && init.keepalive === undefined
    && init.method === undefined
    && init.mode === undefined
    && init.referrer === undefined
    && init.referrerPolicy === undefined
    && init.window === undefined
    && (init as RequestInit & { duplex?: "half" }).duplex === undefined;
}

function requestForRedirect(
  previous: Request,
  target: URL,
  status: number,
  replayBody: ReplayableRequestBody | undefined,
  signal: AbortSignal,
): Request {
  const headers = new Headers(previous.headers);
  if (new URL(previous.url).origin !== target.origin) {
    for (const name of CROSS_ORIGIN_CREDENTIAL_HEADERS) headers.delete(name);
  }

  const rewriteAsGet = redirectsAsGet(previous, status);
  if (rewriteAsGet) {
    for (const name of [...headers.keys()]) {
      if (name.startsWith("content-")) headers.delete(name);
    }
  }

  const init: RequestInit & { duplex?: "half" } = {
    cache: previous.cache,
    credentials: previous.credentials,
    headers,
    integrity: previous.integrity,
    keepalive: previous.keepalive,
    method: rewriteAsGet ? "GET" : previous.method,
    mode: previous.mode,
    redirect: previous.redirect,
    referrer: previous.referrer,
    referrerPolicy: previous.referrerPolicy,
    signal,
  };
  if (!rewriteAsGet && previous.body) {
    if (!replayBody) {
      throw new TypeError("Cannot replay the request body across this redirect.");
    }
    init.body = replayBody();
  }
  return new Request(target, init);
}

async function cancelRedirectBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The next hop must not retain a redirect response body connection.
  }
}

function markRedirectedResponse(response: Response, url: string, redirected: boolean): Response {
  if (!redirected) return response;
  try {
    Object.defineProperty(response, "redirected", { value: true });
    if (!response.url) Object.defineProperty(response, "url", { value: url });
  } catch {
    // A custom fetch implementation may return a non-extensible Response.
  }
  return response;
}

function proxySecrets(policy: NetworkPolicy): readonly string[] {
  return [...networkPolicyProxySecrets(policy)]
    .sort((left, right) => right.length - left.length);
}

function replaceEvery(input: string, value: string, replacement: string): string {
  return value ? input.split(value).join(replacement) : input;
}

function redactErrorText(input: string, secrets: readonly string[]): string {
  let redacted = input;
  const variants = new Set<string>();
  for (const secret of secrets) {
    variants.add(secret);
    try {
      const parsed = new URL(secret);
      variants.add(parsed.href);
      variants.add(parsed.origin);
    } catch {
      // Effective inherited values may be malformed; the exact text is still redacted.
    }
  }
  for (const value of [...variants].sort((left, right) => right.length - left.length)) {
    redacted = replaceEvery(redacted, value, "[redacted proxy]");
  }
  return redacted.replace(
    /\b(https?):\/\/[^\s/?#@]+@/giu,
    "$1://[redacted userinfo]@",
  );
}

function safeErrorMessage(error: unknown): string {
  try {
    const message = error instanceof Error ? error.message : String(error);
    return message || "Network request failed.";
  } catch {
    return "Network request failed.";
  }
}

function redactedFetchError(error: unknown, secrets: readonly string[]): Error {
  const message = redactErrorText(safeErrorMessage(error), secrets);
  if (error instanceof DOMException && error.name === "AbortError") {
    return new DOMException(message, "AbortError");
  }
  const result = new Error(message);
  result.name = "NetworkRequestError";
  return result;
}

function normalizedProxyIdentity(proxy: string | undefined): string {
  if (proxy === undefined) return "direct";
  const candidate = proxy.trim();
  try {
    return new URL(candidate).href;
  } catch {
    return candidate;
  }
}

function searchPolicyFingerprint(route: RouteState): string {
  if (route.invalidField) return `invalid:${route.invalidField}`;
  if (route.httpsProxy === undefined) return "direct";
  return createHash("sha256")
    .update("easyresearch-applied-search-route-v2\0")
    .update(normalizedProxyIdentity(route.httpsProxy))
    .update("\0")
    .update(route.bypass)
    .digest("hex");
}

function buildAppliedSearchRoute(
  route: RouteState,
  secrets: readonly string[],
): AppliedSearchRoute {
  const invalidError = (): Error | undefined => route.invalidField
    ? new InvalidNetworkProxyError(route.invalidField, "search")
    : undefined;
  return Object.freeze({
    policyFingerprint: searchPolicyFingerprint(route),
    applyProxyConfiguration(target: SearchProxyConfiguration): void {
      const error = invalidError();
      if (error) throw error;
      if (route.httpsProxy === undefined) {
        target.useProxy = false;
        return;
      }
      target.proxyUrl = route.httpsProxy;
      target.useProxy = true;
    },
    bypasses(url: string | URL): boolean {
      return route.httpsProxy !== undefined && bypassesTarget(url, route.bypass);
    },
    invalidError,
    sanitizeError(error: unknown): string {
      return redactErrorText(safeErrorMessage(error), secrets);
    },
  });
}

export function createAppliedSearchRoute(policy: NetworkPolicy): AppliedSearchRoute {
  return buildAppliedSearchRoute(createRouteState(policy, "search"), proxySecrets(policy));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeProviderEnv(
  options: unknown,
  providerEnv: Readonly<Record<string, string>>,
  fetch: typeof globalThis.fetch | undefined,
): Record<string, unknown> {
  const original = isRecord(options) ? options : {};
  const originalEnv = isRecord(original.env) ? original.env : {};
  const env: Record<string, unknown> = { ...originalEnv };
  for (const key of ROUTING_ENV_KEYS) delete env[key];
  Object.assign(env, providerEnv);
  return {
    ...original,
    env,
    ...(fetch ? { fetch } : {}),
  };
}

/**
 * Installs the single process fetch router after Pi identity bootstrap. The
 * returned lifecycle owner restores the exact delegate it captured.
 */
export function installNetworkRouter(policy: NetworkPolicy): InstalledNetworkRouter {
  if (activeNetworkRouterOwner) {
    throw new Error("A network router is already installed in this process.");
  }
  const originalFetch = globalThis.fetch;
  if (typeof originalFetch !== "function") {
    throw new Error("Global fetch is unavailable.");
  }

  const scopeStorage = new AsyncLocalStorage<NetworkScope>();
  const decoratedRuntimes = new WeakMap<object, object>();
  const decoratedProxies = new WeakSet<object>();
  const routes: Readonly<Record<NetworkRouteClass, RouteState>> = Object.freeze({
    all: createRouteState(policy, "all"),
    llm: createRouteState(policy, "llm"),
    search: createRouteState(policy, "search"),
  });
  const secrets = proxySecrets(policy);
  const appliedSearchRoute = buildAppliedSearchRoute(routes.search, secrets);

  const requireRoute = (scope: NetworkRouteClass): RouteState => {
    if (scope !== "all" && scope !== "llm" && scope !== "search") {
      throw new TypeError("Network route class must be all, llm, or search.");
    }
    const route = routes[scope];
    if (route.invalidField) throw new InvalidNetworkProxyError(route.invalidField, scope);
    return route;
  };

  const routedFetch = (async (input, init) => {
    try {
      const scope = scopeStorage.getStore() ?? "all";
      const route = requireRoute(scope);
      if (redirectMode(input, init) !== "follow") {
        const url = targetUrl(input);
        const proxy = url?.protocol === "http:"
          ? route.httpProxy
          : url?.protocol === "https:"
            ? route.httpsProxy
            : undefined;
        return await originalFetch.call(
          globalThis,
          input,
          routedInit(init, proxy, bypassesTarget(input, route.bypass)),
        );
      }

      const replayBody = replayableRequestBody(init?.body);
      let request = canDelegateRequestDirectly(input, init)
        ? input
        : new Request(input, init);
      const signal = init?.signal === null
        ? new AbortController().signal
        : init?.signal ?? (input instanceof Request ? input.signal : request.signal);
      for (let redirects = 0; ; redirects += 1) {
        const url = new URL(request.url);
        const proxy = url.protocol === "http:"
          ? route.httpProxy
          : url.protocol === "https:"
            ? route.httpsProxy
            : undefined;
        const response = await originalFetch.call(
          globalThis,
          request,
          routedInit({ redirect: "manual", signal }, proxy, bypassesTarget(request, route.bypass)),
        );
        const location = REDIRECT_STATUSES.has(response.status)
          ? response.headers.get("location")
          : null;
        if (!location) return markRedirectedResponse(response, request.url, redirects > 0);
        await cancelRedirectBody(response);
        if (redirects >= MAX_REDIRECTS) {
          throw new TypeError(`Too many redirects (max ${MAX_REDIRECTS}).`);
        }
        const target = new URL(location, request.url);
        if (target.protocol !== "http:" && target.protocol !== "https:") {
          throw new TypeError("Redirect target must use HTTP or HTTPS.");
        }
        request = requestForRedirect(request, target, response.status, replayBody, signal);
      }
    } catch (error) {
      if (error instanceof InvalidNetworkProxyError) throw error;
      throw redactedFetchError(error, secrets);
    }
  }) as typeof globalThis.fetch;

  const gaxiosPrototype = Object.getPrototypeOf(new OAuth2Client().transporter) as GaxiosPrototype;
  if (!gaxiosPrototype || typeof gaxiosPrototype.request !== "function") {
    throw new Error("Google provider transport is unavailable.");
  }
  const originalGaxiosRequest = gaxiosPrototype.request;
  const routedGaxiosRequest: GaxiosRequest = function (options = {}) {
    if (scopeStorage.getStore() !== "llm") {
      return Reflect.apply(originalGaxiosRequest, this, [options]) as Promise<unknown>;
    }
    const route = requireRoute("llm");
    const url = gaxiosTargetUrl(options);
    const proxy = url?.protocol === "http:"
      ? route.httpProxy
      : url?.protocol === "https:"
        ? route.httpsProxy
        : undefined;
    const noProxy = [
      ...(Array.isArray(options.noProxy) ? options.noProxy : []),
      ...route.bypass.split(/\s*,\s*/u).filter(Boolean),
    ];
    if (!noProxy.includes("[::1]")) noProxy.push("[::1]");
    const routedOptions: GaxiosRequestOptions = {
      ...options,
      fetchImplementation: routedFetch,
      noProxy,
      ...(proxy !== undefined ? { proxy } : {}),
    };
    return Reflect.apply(originalGaxiosRequest, this, [routedOptions]) as Promise<unknown>;
  };
  const owner = {};
  try {
    gaxiosPrototype.request = routedGaxiosRequest;
    globalThis.fetch = routedFetch;
    if (
      gaxiosPrototype.request !== routedGaxiosRequest
      || globalThis.fetch !== routedFetch
    ) {
      throw new Error("Network router globals could not be installed.");
    }
  } catch (error) {
    if (globalThis.fetch === routedFetch) globalThis.fetch = originalFetch;
    if (gaxiosPrototype.request === routedGaxiosRequest) {
      gaxiosPrototype.request = originalGaxiosRequest;
    }
    throw error;
  }
  activeNetworkRouterOwner = owner;
  let restored = false;

  const withScope = <T>(scope: NetworkScope, operation: () => T): T => {
    if (scope !== "llm" && scope !== "search") {
      throw new TypeError("Network scope must be llm or search.");
    }
    return scopeStorage.run(scope, operation);
  };

  const providerEnv = (scope: NetworkRouteClass): Readonly<Record<string, string>> => {
    const route = requireRoute(scope);
    return route.providerEnv!;
  };

  const decorateModelRuntime = <T extends object>(runtime: T): T => {
    if (decoratedProxies.has(runtime)) return runtime;
    const existing = decoratedRuntimes.get(runtime);
    if (existing) return existing as T;
    const methodCache = new Map<PropertyKey, { source: Function; decorated: Function }>();
    const decoratedRuntime = new Proxy(runtime, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        const cached = methodCache.get(property);
        if (cached?.source === value) return cached.decorated;

        const methodName = typeof property === "string" ? property : undefined;
        const decorated = new Proxy(value, {
          apply(method, _thisArg, args: unknown[]) {
            const invoke = (): unknown => {
              let routedArgs = args;
              if (methodName === "getAuth") {
                routedArgs = [...args];
                routedArgs[1] = mergeProviderEnv(args[1], providerEnv("llm"), undefined);
              } else if (methodName !== undefined && REQUEST_OPTIONS_INDEX[methodName] !== undefined) {
                const optionsIndex = REQUEST_OPTIONS_INDEX[methodName];
                routedArgs = [...args];
                routedArgs[optionsIndex] = mergeProviderEnv(
                  args[optionsIndex],
                  providerEnv("llm"),
                  routedFetch,
                );
              }
              return Reflect.apply(method, target, routedArgs);
            };
            return withScope("llm", invoke);
          },
        });
        methodCache.set(property, { source: value, decorated });
        return decorated;
      },
      set(target, property, value) {
        return Reflect.set(target, property, value, target);
      },
    });
    decoratedRuntimes.set(runtime, decoratedRuntime);
    decoratedProxies.add(decoratedRuntime);
    return decoratedRuntime;
  };

  return Object.freeze({
    fetch: routedFetch,
    appliedSearchRoute,
    withScope,
    providerEnv,
    decorateModelRuntime,
    restore() {
      if (restored) return;
      restored = true;
      if (globalThis.fetch === routedFetch) globalThis.fetch = originalFetch;
      if (gaxiosPrototype.request === routedGaxiosRequest) {
        gaxiosPrototype.request = originalGaxiosRequest;
      }
      if (activeNetworkRouterOwner === owner) activeNetworkRouterOwner = undefined;
    },
  });
}
