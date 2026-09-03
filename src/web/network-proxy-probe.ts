import { ProxyAgent, fetch as undiciFetch } from "undici/index.js";
import { parseNetworkProxySettings } from "../runtime/network-policy";
import { ConfigServiceError } from "./config-files";
import type {
  NetworkProxyScopeDto,
  NetworkProxyTestOutcomeDto,
  NetworkProxyTestRequestDto,
  NetworkProxyTestResultDto,
} from "./contracts";

const DEFAULT_TIMEOUT_MS = 10_000;
const TARGETS: Readonly<Record<NetworkProxyScopeDto, string>> = Object.freeze({
  all: "https://example.com/",
  llm: "https://auth.openai.com/.well-known/openid-configuration",
  search: "https://duckduckgo.com/robots.txt",
});

type BunProxyFetchInit = NonNullable<Parameters<typeof fetch>[1]> & { proxy: string };

async function isolatedProxyFetch(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> {
  const proxy = (init as BunProxyFetchInit | undefined)?.proxy;
  if (!proxy) throw new TypeError("Candidate proxy transport requires an explicit proxy.");
  const dispatcher = new ProxyAgent(proxy);
  try {
    const response = await undiciFetch(String(input), {
      dispatcher,
      redirect: init?.redirect,
      signal: init?.signal,
    } as Parameters<typeof undiciFetch>[1]);
    try {
      await response.body?.cancel();
    } catch {
      // Only status is observable; body cleanup cannot alter the safe result.
    }
    return new Response(null, { status: response.status, statusText: response.statusText });
  } finally {
    await dispatcher.close();
  }
}

export interface NetworkProxyProbe {
  test(value: unknown, callerSignal?: AbortSignal): Promise<NetworkProxyTestResultDto>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScope(value: unknown): value is NetworkProxyScopeDto {
  return value === "all" || value === "llm" || value === "search";
}

function validateRequest(value: unknown): NetworkProxyTestRequestDto {
  if (!isRecord(value)) {
    throw new ConfigServiceError(400, "Network proxy test request must be an object");
  }
  const fields = Object.keys(value);
  if (
    fields.length !== 2
    || !Object.hasOwn(value, "scope")
    || !Object.hasOwn(value, "proxyUrl")
    || fields.some((field) => field !== "scope" && field !== "proxyUrl")
    || !isScope(value.scope)
    || typeof value.proxyUrl !== "string"
  ) {
    throw new ConfigServiceError(400, "Network proxy test request must contain only scope and proxyUrl");
  }
  return { scope: value.scope, proxyUrl: value.proxyUrl };
}

function normalizedCandidate(request: NetworkProxyTestRequestDto): string | undefined {
  const settings = request.scope === "all"
    ? { httpProxy: request.proxyUrl }
    : {
        easyresearch: {
          network: {
            [request.scope === "llm" ? "llmProxy" : "searchProxy"]: request.proxyUrl,
          },
        },
      };
  const parsed = parseNetworkProxySettings(settings);
  if (parsed.errors.length > 0) return undefined;
  return parsed.configured[request.scope];
}

function elapsedSince(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function safeResult(
  startedAt: number,
  ok: boolean,
  outcome: NetworkProxyTestOutcomeDto,
  status?: number,
): NetworkProxyTestResultDto {
  return {
    ok,
    outcome,
    ...(status !== undefined ? { status } : {}),
    elapsedMs: elapsedSince(startedAt),
  };
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current !== undefined && current !== null && !seen.has(current) && chain.length < 4) {
    chain.push(current);
    seen.add(current);
    current = isRecord(current) ? current.cause : undefined;
  }
  return chain;
}

function errorTokens(error: unknown): string {
  return errorChain(error)
    .flatMap((candidate) => {
      if (!isRecord(candidate)) return [String(candidate)];
      return [candidate.name, candidate.code, candidate.message]
        .filter((value): value is string => typeof value === "string");
    })
    .join(" ")
    .toUpperCase();
}

function hasObservableHttpStatus(error: unknown): boolean {
  for (const candidate of errorChain(error)) {
    if (!isRecord(candidate)) continue;
    const response = isRecord(candidate.response) ? candidate.response : undefined;
    for (const status of [candidate.status, candidate.statusCode, response?.status]) {
      if (Number.isInteger(status) && (status as number) >= 100 && (status as number) <= 599) {
        return true;
      }
    }
  }
  return false;
}

function classifyFailure(error: unknown): NetworkProxyTestOutcomeDto {
  const tokens = errorTokens(error);
  if (
    tokens.includes("TIMEOUT")
    || tokens.includes("TIMED_OUT")
    || tokens.includes("TIMEDOUT")
    || tokens.includes("TIMED OUT")
  ) return "timeout";
  if (
    hasObservableHttpStatus(error)
    || tokens.includes("PROXY_RESPONSE")
    || tokens.includes("PROXY AUTH")
    || tokens.includes("PROXY_AUTH")
    || tokens.includes("HTTP PROXY")
  ) return "proxy-response";
  if (
    tokens.includes("CERT_")
    || tokens.includes("TLS")
    || tokens.includes("SSL")
    || tokens.includes("CERTIFICATE")
    || tokens.includes("SELF_SIGNED")
    || tokens.includes("UNABLE_TO_VERIFY")
  ) return "tls";
  return "proxy-connect";
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The probe never exposes body-stream failures or target content.
  }
}

export function createNetworkProxyProbe(
  fetchBeforeRouter: typeof fetch = isolatedProxyFetch as typeof fetch,
  options: { timeoutMs?: number } = {},
): NetworkProxyProbe {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    async test(value, callerSignal) {
      const startedAt = performance.now();
      const request = validateRequest(value);
      const proxy = normalizedCandidate(request);
      if (proxy === undefined) return safeResult(startedAt, false, "invalid-config");

      const combined = new AbortController();
      let abortKind: "caller" | "timeout" | undefined;
      const abort = (kind: "caller" | "timeout", reason?: unknown): void => {
        if (combined.signal.aborted) return;
        abortKind = kind;
        combined.abort(reason);
      };
      const onCallerAbort = (): void => abort("caller", callerSignal?.reason);
      if (callerSignal?.aborted) onCallerAbort();
      else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
      const timer = setTimeout(
        () => abort("timeout", new DOMException("Network proxy probe timed out", "TimeoutError")),
        timeoutMs,
      );

      try {
        const response = await fetchBeforeRouter(TARGETS[request.scope], {
          proxy,
          redirect: "manual",
          signal: combined.signal,
        } as BunProxyFetchInit);
        const result = response.status >= 200 && response.status < 400
          ? safeResult(startedAt, true, "success", response.status)
          : safeResult(startedAt, false, "target-response", response.status);
        await cancelBody(response);
        return result;
      } catch (error) {
        if (abortKind === "caller") return safeResult(startedAt, false, "cancelled");
        if (abortKind === "timeout") return safeResult(startedAt, false, "timeout");
        return safeResult(startedAt, false, classifyFailure(error));
      } finally {
        clearTimeout(timer);
        callerSignal?.removeEventListener("abort", onCallerAbort);
      }
    },
  };
}
