import { AsyncLocalStorage } from "node:async_hooks";
import axios, { type InternalAxiosRequestConfig } from "axios";

export const WEB_SEARCH_OPERATION_TIMEOUT_MS = 30_000;

interface SearchRequestScope {
  signal: AbortSignal;
  deadlineAt: number;
  now: () => number;
  requestRouting?: SearchRequestRouting;
  sanitizeConsoleError?: (error: unknown) => string;
}

export interface SearchRequestRouting {
  bypasses(url: string): boolean;
  directAgentsFor(
    httpAgent: unknown,
    httpsAgent: unknown,
  ): Readonly<{ httpAgent: unknown; httpsAgent: unknown }> | undefined;
}

export type SearchDeadlineResult<T> =
  | { value: T; timedOut: false }
  | { timedOut: true };

export type SearchDeadlinePromise<T> = Promise<SearchDeadlineResult<T>> & {
  readonly settled: Promise<void>;
};

const searchRequestScope = new AsyncLocalStorage<SearchRequestScope>();
let interceptorInstalled = false;
const SEARCH_CONSOLE_METHODS = ["error", "warn"] as const;

type SearchConsoleMethod = (this: Console, ...args: unknown[]) => void;
interface SearchConsolePatch {
  original: SearchConsoleMethod;
  wrapped: SearchConsoleMethod;
}

let activeConsoleScopes = 0;
let consolePatches: Readonly<Record<(typeof SEARCH_CONSOLE_METHODS)[number], SearchConsolePatch>> | undefined;

function combineSignals(signals: readonly AbortSignal[]): AbortSignal {
  const unique = [...new Set(signals)];
  return unique.length === 1 ? unique[0]! : AbortSignal.any(unique);
}

function sanitizedConsoleArgument(
  value: unknown,
  sanitize: (error: unknown) => string,
): unknown {
  try {
    if (typeof value === "string") return sanitize(value);
    if (value instanceof Error) {
      const code = "code" in value && (typeof value.code === "string" || typeof value.code === "number")
        ? ` [${sanitize(String(value.code))}]`
        : "";
      return `${value.name || "Error"}${code}: ${sanitize(value)}`;
    }
    if (typeof value === "object" && value !== null) {
      const source = value as Record<string, unknown>;
      const diagnostic: Record<string, string | number> = {};
      for (const key of ["name", "code", "status", "statusCode", "message"] as const) {
        const item = source[key];
        if (typeof item === "string") diagnostic[key] = sanitize(item);
        else if (typeof item === "number") diagnostic[key] = item;
      }
      return Object.keys(diagnostic).length > 0 ? diagnostic : "[object omitted]";
    }
    return value;
  } catch {
    return "Network diagnostic unavailable.";
  }
}

function acquireSearchConsoleSanitizer(): () => void {
  const target = console as unknown as Record<(typeof SEARCH_CONSOLE_METHODS)[number], SearchConsoleMethod>;
  if (activeConsoleScopes === 0) {
    const next = {} as Record<(typeof SEARCH_CONSOLE_METHODS)[number], SearchConsolePatch>;
    try {
      for (const name of SEARCH_CONSOLE_METHODS) {
        const original = target[name];
        const wrapped: SearchConsoleMethod = function (...args) {
          const sanitize = searchRequestScope.getStore()?.sanitizeConsoleError;
          return Reflect.apply(
            original,
            console,
            sanitize ? args.map((value) => sanitizedConsoleArgument(value, sanitize)) : args,
          );
        };
        next[name] = { original, wrapped };
        target[name] = wrapped;
      }
      consolePatches = next;
    } catch (error) {
      for (const name of SEARCH_CONSOLE_METHODS) {
        const patch = next[name];
        if (patch && target[name] === patch.wrapped) target[name] = patch.original;
      }
      throw error;
    }
  }
  activeConsoleScopes += 1;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeConsoleScopes -= 1;
    if (activeConsoleScopes !== 0) return;
    const patches = consolePatches;
    consolePatches = undefined;
    if (!patches) return;
    for (const name of SEARCH_CONSOLE_METHODS) {
      const patch = patches[name];
      if (target[name] === patch.wrapped) target[name] = patch.original;
    }
  };
}

export function ensureSearchAxiosInterceptorInstalled(): void {
  if (!interceptorInstalled) {
    axios.interceptors.request.use((config: InternalAxiosRequestConfig) => {
      const scope = searchRequestScope.getStore();
      if (!scope) return config;
      const remaining = Math.max(1, Math.floor(scope.deadlineAt - scope.now()));
      const timeout = typeof config.timeout === "number" && config.timeout > 0
        ? Math.min(config.timeout, remaining)
        : remaining;
      const signals = [scope.signal];
      if (config.signal) signals.unshift(config.signal as AbortSignal);
      let routed = {
        ...config,
        timeout,
        signal: combineSignals(signals),
      };
      const requestRouting = scope.requestRouting;
      if (requestRouting) {
        let url: string | undefined;
        try {
          url = axios.getUri(routed);
        } catch {
          url = undefined;
        }
        if (url && requestRouting.bypasses(url)) {
          const directAgents = requestRouting.directAgentsFor(
            routed.httpAgent,
            routed.httpsAgent,
          );
          if (directAgents) {
            routed = {
              ...routed,
              httpAgent: directAgents.httpAgent,
              httpsAgent: directAgents.httpsAgent,
            };
          }
        }
      }
      return routed;
    });
    interceptorInstalled = true;
  }
}

export function withSearchRequestDeadline<T>(
  piSignal: AbortSignal | undefined,
  operation: (combinedSignal: AbortSignal) => Promise<T>,
  options: {
    timeoutMs?: number;
    now?: () => number;
    requestRouting?: SearchRequestRouting;
    sanitizeConsoleError?: (error: unknown) => string;
  } = {},
): SearchDeadlinePromise<T> {
  ensureSearchAxiosInterceptorInstalled();
  const timeoutMs = options.timeoutMs ?? WEB_SEARCH_OPERATION_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const deadline = new AbortController();
  const deadlineAt = now() + timeoutMs;
  const combinedSignal = combineSignals([
    deadline.signal,
    ...(piSignal ? [piSignal] : []),
  ]);
  const releaseConsole = options.sanitizeConsoleError
    ? acquireSearchConsoleSanitizer()
    : undefined;
  let operationPromise: Promise<T>;
  try {
    operationPromise = searchRequestScope.run(
      {
        signal: combinedSignal,
        deadlineAt,
        now,
        requestRouting: options.requestRouting,
        sanitizeConsoleError: options.sanitizeConsoleError,
      },
      () => operation(combinedSignal),
    );
  } catch (error) {
    operationPromise = Promise.reject(error);
  }

  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<SearchDeadlineResult<T>>((resolve) => {
    timer = setTimeout(() => {
      deadline.abort();
      resolve({ timedOut: true });
    }, timeoutMs);
  });
  const settled = operationPromise.then(
    () => undefined,
    () => undefined,
  ).finally(() => {
    clearTimeout(timer);
    releaseConsole?.();
  });
  const completed = operationPromise.then(
    (value) => settled.then((): SearchDeadlineResult<T> => ({ value, timedOut: false })),
    (error) => settled.then(() => { throw error; }),
  );
  const result = Promise.race([completed, timeout]) as SearchDeadlinePromise<T>;
  Object.defineProperty(result, "settled", {
    configurable: false,
    enumerable: false,
    value: settled,
    writable: false,
  });
  return result;
}
