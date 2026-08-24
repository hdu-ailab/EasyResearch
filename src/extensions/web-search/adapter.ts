import {
  WEB_SEARCH_ENGINES,
  type OpenWebSearchService,
  type WebSearchExecution,
  type WebSearchInput,
} from "./contracts";
import {
  addOperationTimeoutFailures,
  buildEffectiveQuery,
  normalizePartialFailures,
  normalizeSearchResults,
} from "./normalization";
import { withSearchRequestDeadline } from "./request-context";

const DEFAULT_RESULT_COUNT = 10;
const supportedEngines = new Set<string>(WEB_SEARCH_ENGINES);
let searchTail: Promise<void> = Promise.resolve();

export interface WebSearchAdapter {
  search(input: WebSearchInput, signal?: AbortSignal): Promise<WebSearchExecution>;
}

export function createAbortError(message = "Search cancelled"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function raceWithAbort<T>(run: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return run;
  if (signal.aborted) return Promise.reject(createAbortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(createAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    run.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function serializeWebSearch<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const run = searchTail.then(async () => {
    if (signal?.aborted) throw createAbortError();
    return operation();
  });
  searchTail = run.then(() => undefined, () => undefined);
  return raceWithAbort(run, signal);
}

function validateInput(input: WebSearchInput): {
  engines: WebSearchInput["engines"];
  effectiveQuery: string;
  limit: number;
} {
  if (!Array.isArray(input.engines) || input.engines.length < 1 || input.engines.length > WEB_SEARCH_ENGINES.length) {
    throw new Error("Select between 1 and 6 search engines");
  }
  const engines = input.engines;
  if (engines.some((engine) => typeof engine !== "string" || !supportedEngines.has(engine))) {
    throw new Error("Every search engine must be supported");
  }
  if (new Set(engines).size !== engines.length) {
    throw new Error("Search engines must be unique");
  }
  const limit = input.num ?? DEFAULT_RESULT_COUNT;
  if (!Number.isInteger(limit)) throw new Error("Search result limit must be an integer");
  if (limit < 1 || limit > 25) throw new Error("Search result limit must be between 1 and 25");
  if (limit < engines.length) {
    throw new Error("Search result limit must be at least the number of selected engines");
  }
  return {
    engines,
    effectiveQuery: buildEffectiveQuery(input.query, input.site),
    limit,
  };
}

export function createWebSearchAdapter(service: OpenWebSearchService): WebSearchAdapter {
  return {
    async search(input, signal) {
      const { engines, effectiveQuery, limit } = validateInput(input);
      return serializeWebSearch(async () => {
        try {
          const { value: response, timedOut } = await withSearchRequestDeadline(
            signal,
            () => service.execute({
              query: effectiveQuery,
              engines,
              limit,
              searchMode: "request",
            }),
          );
          if (signal?.aborted) throw createAbortError();
          const results = normalizeSearchResults(response.results, engines, limit);
          let partialFailures = normalizePartialFailures(response.partialFailures, engines);
          if (timedOut) {
            partialFailures = addOperationTimeoutFailures(results, partialFailures, engines);
          }
          return {
            engines: [...engines],
            effectiveQuery,
            results,
            partialFailures,
            allEnginesFailed: results.length === 0 && partialFailures.length === engines.length,
          };
        } catch (error) {
          if (signal?.aborted) throw createAbortError();
          throw error;
        }
      }, signal);
    },
  };
}
