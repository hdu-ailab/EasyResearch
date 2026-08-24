import {
  WEB_SEARCH_ENGINES,
  type EngineReliability,
  type WebSearchEngine,
  type WebSearchPartialFailure,
  type WebSearchResult,
} from "./contracts";

const supportedEngines = new Set<string>(WEB_SEARCH_ENGINES);
const lowReliabilityEngines = new Set<WebSearchEngine>(["baidu", "sogou"]);

export function engineReliability(engine: WebSearchEngine): EngineReliability {
  return lowReliabilityEngines.has(engine) ? "low" : "high";
}

export function normalizeSite(site: string): string {
  const trimmed = site.trim();
  if (!trimmed || /\s/u.test(trimmed)) throw new Error("Site must be a valid domain");

  let parsed: URL;
  try {
    const value = /^[a-z][a-z\d+.-]*:/iu.test(trimmed) ? trimmed : `https://${trimmed}`;
    parsed = new URL(value);
  } catch {
    throw new Error("Site must be a valid domain");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username
    || parsed.password
    || !parsed.hostname.includes(".")
  ) {
    throw new Error("Site must be a valid domain");
  }
  return parsed.hostname.toLowerCase();
}

export function buildEffectiveQuery(query: string, site?: string): string {
  const trimmed = query.trim();
  if (!trimmed) throw new Error("Search query cannot be empty");
  return site === undefined ? trimmed : `${trimmed} site:${normalizeSite(site)}`;
}

export function canonicalizeResultUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequestedEngine(value: unknown, requested: ReadonlySet<WebSearchEngine>): value is WebSearchEngine {
  return typeof value === "string" && supportedEngines.has(value) && requested.has(value as WebSearchEngine);
}

export function normalizeSearchResults(
  rows: readonly unknown[],
  requestedEngines: readonly WebSearchEngine[],
  limit: number,
): WebSearchResult[] {
  const requested = new Set(requestedEngines);
  const grouped = new Map<WebSearchEngine, Array<Record<string, unknown>>>(
    requestedEngines.map((engine) => [engine, []]),
  );

  for (const row of rows) {
    if (!isRecord(row) || !isRequestedEngine(row.engine, requested)) continue;
    grouped.get(row.engine)?.push(row);
  }

  const results: WebSearchResult[] = [];
  const byUrl = new Map<string, WebSearchResult>();
  for (const engine of requestedEngines) {
    for (const row of grouped.get(engine) ?? []) {
      if (
        typeof row.title !== "string"
        || !row.title.trim()
        || typeof row.url !== "string"
        || typeof row.description !== "string"
        || typeof row.source !== "string"
      ) {
        continue;
      }
      const canonicalUrl = canonicalizeResultUrl(row.url);
      if (!canonicalUrl) continue;
      const existing = byUrl.get(canonicalUrl);
      if (existing) {
        if (!existing.matchedEngines.includes(engine)) existing.matchedEngines.push(engine);
        continue;
      }
      if (results.length >= limit) continue;
      const result: WebSearchResult = {
        title: row.title.trim(),
        url: row.url,
        abstract: row.description.trim(),
        source: row.source.trim(),
        engine,
        engineReliability: engineReliability(engine),
        matchedEngines: [engine],
      };
      byUrl.set(canonicalUrl, result);
      results.push(result);
    }
  }
  return results;
}

export function normalizePartialFailures(
  failures: readonly unknown[],
  requestedEngines: readonly WebSearchEngine[],
): WebSearchPartialFailure[] {
  const requested = new Set(requestedEngines);
  const byEngine = new Map<WebSearchEngine, WebSearchPartialFailure>();
  for (const failure of failures) {
    if (
      !isRecord(failure)
      || !isRequestedEngine(failure.engine, requested)
      || typeof failure.code !== "string"
      || !failure.code.trim()
      || typeof failure.message !== "string"
      || !failure.message.trim()
      || byEngine.has(failure.engine)
    ) {
      continue;
    }
    byEngine.set(failure.engine, {
      engine: failure.engine,
      code: failure.code.trim(),
      message: failure.message.trim(),
      engineReliability: engineReliability(failure.engine),
    });
  }
  return requestedEngines.flatMap((engine) => {
    const failure = byEngine.get(engine);
    return failure ? [failure] : [];
  });
}

export function addOperationTimeoutFailures(
  results: readonly WebSearchResult[],
  failures: readonly WebSearchPartialFailure[],
  requestedEngines: readonly WebSearchEngine[],
): WebSearchPartialFailure[] {
  const resolved = new Set(results.flatMap((result) => result.matchedEngines));
  const byEngine = new Map(failures.map((failure) => [failure.engine, failure]));
  for (const engine of requestedEngines) {
    if (!resolved.has(engine) && !byEngine.has(engine)) {
      byEngine.set(engine, {
        engine,
        code: "operation_timeout",
        message: "The search operation deadline expired before this engine produced a result or failure.",
        engineReliability: engineReliability(engine),
      });
    }
  }
  return requestedEngines.flatMap((engine) => {
    const failure = byEngine.get(engine);
    return failure ? [failure] : [];
  });
}
