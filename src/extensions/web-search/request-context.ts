import { AsyncLocalStorage } from "node:async_hooks";
import axios, { type InternalAxiosRequestConfig } from "axios";

export const WEB_SEARCH_OPERATION_TIMEOUT_MS = 30_000;

interface SearchRequestScope {
  signal: AbortSignal;
  deadlineAt: number;
  now: () => number;
}

export interface SearchDeadlineResult<T> {
  value: T;
  timedOut: boolean;
}

const searchRequestScope = new AsyncLocalStorage<SearchRequestScope>();
let interceptorInstalled = false;

function combineSignals(signals: readonly AbortSignal[]): AbortSignal {
  const unique = [...new Set(signals)];
  return unique.length === 1 ? unique[0]! : AbortSignal.any(unique);
}

export function ensureSearchAxiosInterceptorInstalled(): void {
  if (interceptorInstalled) return;
  axios.interceptors.request.use((config: InternalAxiosRequestConfig) => {
    const scope = searchRequestScope.getStore();
    if (!scope) return config;
    const remaining = Math.max(1, Math.floor(scope.deadlineAt - scope.now()));
    const timeout = typeof config.timeout === "number" && config.timeout > 0
      ? Math.min(config.timeout, remaining)
      : remaining;
    const signals = [scope.signal];
    if (config.signal) signals.unshift(config.signal as AbortSignal);
    return {
      ...config,
      timeout,
      signal: combineSignals(signals),
    };
  });
  interceptorInstalled = true;
}

export async function withSearchRequestDeadline<T>(
  piSignal: AbortSignal | undefined,
  operation: (combinedSignal: AbortSignal) => Promise<T>,
  options: { timeoutMs?: number; now?: () => number } = {},
): Promise<SearchDeadlineResult<T>> {
  ensureSearchAxiosInterceptorInstalled();
  const timeoutMs = options.timeoutMs ?? WEB_SEARCH_OPERATION_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const deadline = new AbortController();
  let timedOut = false;
  const deadlineAt = now() + timeoutMs;
  const timer = setTimeout(() => {
    timedOut = true;
    deadline.abort();
  }, timeoutMs);
  const combinedSignal = combineSignals([
    deadline.signal,
    ...(piSignal ? [piSignal] : []),
  ]);
  try {
    const value = await searchRequestScope.run(
      { signal: combinedSignal, deadlineAt, now },
      () => operation(combinedSignal),
    );
    return { value, timedOut };
  } finally {
    clearTimeout(timer);
  }
}
