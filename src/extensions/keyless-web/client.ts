export type KeylessWebProvider = "firecrawl" | "tavily" | "firecrawl-research";

export interface KeylessWebClient {
  request(input: {
    provider: KeylessWebProvider;
    url: string;
    method: "GET" | "POST";
    body?: unknown;
    signal?: AbortSignal;
    timeoutMs: number;
    maxBytes: number;
  }): Promise<{ data: unknown; status: number; headers: Headers }>;
}

const DIAGNOSTICS: Readonly<Record<string, string>> = {
  INVALID_REQUEST: "Invalid provider request.",
  NETWORK_PROXY_INVALID: "The Search network proxy configuration is invalid.",
  NETWORK_ERROR: "The provider request failed before a usable response was received.",
  OPERATION_TIMEOUT: "The provider operation deadline expired.",
  RESPONSE_TOO_LARGE: "The provider response exceeds the configured byte limit.",
  MALFORMED_RESPONSE: "The provider returned an invalid response.",
  PROVIDER_ERROR: "The provider reported failure in its response.",
  HTTP_ERROR: "The provider returned an unsuccessful HTTP status.",
  RATE_LIMITED: "The provider rate limit was reached; wait before calling this provider again.",
  PROVIDER_COOLDOWN: "This provider is paused after a rate-limit response.",
};

export class KeylessWebError extends Error {
  readonly status?: number;
  readonly retryAfterSeconds?: number;

  constructor(
    readonly provider: KeylessWebProvider,
    readonly code: string,
    options: { status?: number; retryAfterSeconds?: number } = {},
  ) {
    super(`${code}: ${DIAGNOSTICS[code] ?? "The provider operation failed."}${options.status !== undefined ? ` (HTTP ${options.status})` : ""}${options.retryAfterSeconds !== undefined ? ` Retry-After: ${options.retryAfterSeconds} seconds.` : ""}`);
    this.name = "KeylessWebError";
    this.status = options.status;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export interface KeylessWebClientOptions {
  fetch?: typeof globalThis.fetch;
  runRequest?: <T>(operation: () => Promise<T>) => Promise<T>;
  sanitizeError?: (error: unknown) => string;
  now?: () => number;
}

function stopError(): Error {
  const error = new Error("Web request cancelled");
  error.name = "AbortError";
  return error;
}

// An absent/malformed Retry-After still pauses immediate repeated calls. Values
// are bounded so untrusted headers cannot create permanent client state.
function retryDelay(value: string | null, now: number): number {
  const seconds = value !== null && /^\d+$/u.test(value.trim())
    ? Number(value.trim())
    : value !== null && /[a-z]/iu.test(value)
      ? Math.ceil((Date.parse(value) - now) / 1000)
      : NaN;
  return Number.isFinite(seconds) ? Math.max(1, Math.min(86_400, seconds)) : 60;
}

function cancelBody(response: Response): void {
  void response.body?.cancel().catch(() => {});
}

export function createKeylessWebClient(options: KeylessWebClientOptions = {}): KeylessWebClient {
  const now = options.now ?? Date.now;
  const runRequest = options.runRequest ?? (<T>(operation: () => Promise<T>) => operation());
  const cooldowns = new Map<KeylessWebProvider, number>();
  return {
    async request(input) {
      const { provider, signal, timeoutMs, maxBytes } = input;
      if (signal?.aborted) throw stopError();
      if (!["firecrawl", "tavily", "firecrawl-research"].includes(provider)
        || !Number.isFinite(timeoutMs) || timeoutMs <= 0
        || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
        throw new KeylessWebError(provider, "INVALID_REQUEST");
      }
      let url: URL;
      try {
        url = new URL(input.url);
        if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error();
      } catch {
        throw new KeylessWebError(provider, "INVALID_REQUEST");
      }
      const remaining = (cooldowns.get(provider) ?? 0) - now();
      if (remaining > 0) {
        throw new KeylessWebError(provider, "PROVIDER_COOLDOWN", {
          status: 429, retryAfterSeconds: Math.ceil(remaining / 1000),
        });
      }
      cooldowns.delete(provider);
      const deadlineAt = now() + timeoutMs;
      const controller = new AbortController();
      let timedOut = false;
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const checkActive = () => {
        if (signal?.aborted) throw stopError();
        if (timedOut || now() >= deadlineAt) throw new KeylessWebError(provider, "OPERATION_TIMEOUT");
      };
      let rejectInterrupted!: (error: unknown) => void;
      const interrupted = new Promise<never>((_resolve, reject) => { rejectInterrupted = reject; });
      const onAbort = () => rejectInterrupted(signal?.aborted
        ? stopError()
        : new KeylessWebError(provider, "OPERATION_TIMEOUT"));
      combined.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      try {
        const operation = Promise.resolve().then(() => runRequest(async () => {
          checkActive();
          const headers = new Headers({ Accept: "application/json", "User-Agent": "EasyResearch" });
          if (provider === "tavily") headers.set("X-Tavily-Access-Mode", "keyless");
          if (input.body !== undefined) headers.set("Content-Type", "application/json");
          const response = await (options.fetch ?? globalThis.fetch)(url.href, {
            method: input.method,
            headers,
            ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
            signal: combined,
            redirect: "follow",
          });
          try { checkActive(); } catch (error) { cancelBody(response); throw error; }
          if (!response.ok) {
            cancelBody(response);
            if (response.status === 429) {
              const observedAt = now();
              const retryAfter = retryDelay(response.headers.get("retry-after"), observedAt);
              // Already-admitted requests may settle out of order. A later 429
              // may extend this provider's pause, but must never shorten it.
              const expiresAt = Math.max(cooldowns.get(provider) ?? 0, observedAt + retryAfter * 1000);
              cooldowns.set(provider, expiresAt);
              const retryAfterSeconds = Math.ceil((expiresAt - observedAt) / 1000);
              throw new KeylessWebError(provider, "RATE_LIMITED", { status: 429, retryAfterSeconds });
            }
            throw new KeylessWebError(provider, "HTTP_ERROR", { status: response.status });
          }
          const declared = Number(response.headers.get("content-length"));
          if (Number.isFinite(declared) && declared > maxBytes) {
            cancelBody(response);
            throw new KeylessWebError(provider, "RESPONSE_TOO_LARGE", { status: response.status });
          }
          const reader = response.body?.getReader();
          if (!reader) throw new KeylessWebError(provider, "MALFORMED_RESPONSE", { status: response.status });
          const chunks: Uint8Array[] = [];
          let size = 0;
          let complete = false;
          const cancelReader = () => { void reader.cancel().catch(() => {}); };
          combined.addEventListener("abort", cancelReader, { once: true });
          try {
            while (true) {
              checkActive();
              const chunk = await reader.read();
              checkActive();
              if (chunk.done) { complete = true; break; }
              size += chunk.value.byteLength;
              if (size > maxBytes) throw new KeylessWebError(provider, "RESPONSE_TOO_LARGE", { status: response.status });
              chunks.push(chunk.value);
            }
          } finally {
            combined.removeEventListener("abort", cancelReader);
            if (!complete) cancelReader();
            reader.releaseLock();
          }
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
          let data: unknown;
          try { data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch {
            throw new KeylessWebError(provider, "MALFORMED_RESPONSE", { status: response.status });
          }
          checkActive();
          if (typeof data !== "object" || data === null || Array.isArray(data)) {
            throw new KeylessWebError(provider, "MALFORMED_RESPONSE", { status: response.status });
          }
          const record = data as Record<string, unknown>;
          if (record.success === false || (record.error !== undefined && record.error !== null && record.error !== "")
            || (typeof record.detail === "object" && record.detail !== null && "error" in record.detail)) {
            throw new KeylessWebError(provider, "PROVIDER_ERROR", { status: response.status });
          }
          return { data, status: response.status, headers: response.headers };
        }));
        return await Promise.race([operation, interrupted]);
      } catch (error) {
        checkActive();
        if (error instanceof KeylessWebError) throw error;
        // Never publish upstream exception messages, response bodies or actions.
        // Give the injected route a chance to sanitize diagnostics, but retain
        // only known classifications rather than forwarding its text.
        try { options.sanitizeError?.(error); } catch { /* fixed diagnostic below */ }
        const invalidProxy = typeof error === "object" && error !== null
          && "code" in error && error.code === "NETWORK_PROXY_INVALID";
        throw new KeylessWebError(provider, invalidProxy ? "NETWORK_PROXY_INVALID" : "NETWORK_ERROR");
      } finally {
        clearTimeout(timer);
        combined.removeEventListener("abort", onAbort);
      }
    },
  };
}
