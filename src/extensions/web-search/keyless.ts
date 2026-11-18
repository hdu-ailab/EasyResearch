import {
  KeylessWebError,
  type KeylessWebClient,
  type KeylessWebProvider,
} from "../keyless-web/client";
import { WEB_SEARCH_ENGINES, type WebSearchInput } from "./contracts";
import { canonicalizeResultUrl, normalizeSite } from "./normalization";

export const WEB_SEARCH_PROVIDERS = ["engines", "firecrawl", "tavily", "firecrawl-research"] as const;
export type WebSearchProvider = (typeof WEB_SEARCH_PROVIDERS)[number];
export interface WebSearchToolInput {
  query: string;
  provider?: WebSearchProvider;
  engines?: WebSearchInput["engines"];
  num?: number;
  site?: string;
  from?: string;
  to?: string;
}

export interface KeylessSearchResult {
  provider: KeylessWebProvider;
  channel: "web" | "paper-index";
  url?: string;
  title?: string;
  abstract?: string;
  source?: string;
  paperId?: string;
  primaryId?: string;
  ids?: Record<string, string[]>;
  authors?: string[];
  createdDate?: string;
  updateDate?: string;
  score?: number;
}

export interface KeylessSearchDetails {
  provider: KeylessWebProvider;
  channel: "web" | "paper-index";
  results: KeylessSearchResult[];
  count: number;
  limit: number;
  rejectedResults: number;
  warnings: string[];
  partial?: boolean;
  dateFilter?: { from?: string; to?: string; basis: "created/updated" };
  fullOutputPath?: string;
  error?: string;
  code?: string;
  status?: number;
  retryAfterSeconds?: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function validateSearchToolInput(input: WebSearchToolInput): void {
  if (!record(input) || Object.keys(input).some((key) => ![
    "query", "provider", "engines", "num", "site", "from", "to",
  ].includes(key))) throw new Error("Unsupported search option");
  const provider = input.provider ?? "engines";
  if (!WEB_SEARCH_PROVIDERS.includes(provider)) throw new Error("Select a supported search provider");
  if (typeof input.query !== "string" || !input.query.trim()) throw new Error("Search query cannot be empty");
  const limit = input.num ?? 10;
  const maximum = provider === "tavily" ? 20 : 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum) {
    throw new Error(`Search result limit must be an integer between 1 and ${maximum}`);
  }
  if (provider === "engines") {
    if (!Array.isArray(input.engines) || input.engines.length < 1
      || input.engines.length > WEB_SEARCH_ENGINES.length
      || input.engines.some((engine) => !WEB_SEARCH_ENGINES.includes(engine))
      || new Set(input.engines).size !== input.engines.length) {
      throw new Error("Select unique supported search engines for the engines provider");
    }
    if (limit < input.engines.length) throw new Error("Search result limit must cover every selected engine");
  } else if (input.engines !== undefined) {
    throw new Error("engines is supported only by the engines provider");
  }
  if (provider === "firecrawl-research") {
    if (input.site !== undefined) throw new Error("site is unavailable for the paper index");
    for (const date of [input.from, input.to]) {
      if (date !== undefined && !isIsoDate(date)) throw new Error("Paper date bounds must be valid YYYY-MM-DD dates");
    }
    if (input.from && input.to && input.from > input.to) throw new Error("Paper from date must not exceed to date");
  } else {
    if (input.from !== undefined || input.to !== undefined) throw new Error("Date bounds are supported only by the paper index");
    if (input.site !== undefined) {
      if (typeof input.site !== "string") throw new Error("Site must be a valid domain");
      normalizeSite(input.site);
    }
  }
}

function publicUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const canonical = canonicalizeResultUrl(value);
  if (!canonical) return undefined;
  const url = new URL(canonical);
  return url.username || url.password ? undefined : value;
}

function identifierUrl(namespace: string, id: string): string | undefined {
  if (namespace === "arxiv" && /^(?:\d{2}(?:0[1-9]|1[0-2])\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{2}(?:0[1-9]|1[0-2])\d{3})(?:v[1-9]\d*)?$/u.test(id)) {
    return `https://arxiv.org/abs/${id}`;
  }
  if (namespace === "doi" && /^10\.\d{4,9}\/[^\s?#]+$/iu.test(id)) {
    return `https://doi.org/${id.split("/").map(encodeURIComponent).join("/")}`;
  }
  if (namespace === "pmid" && /^[1-9]\d*$/u.test(id)) return `https://pubmed.ncbi.nlm.nih.gov/${id}/`;
  if (namespace === "pmcid" && /^PMC[1-9]\d*$/u.test(id)) return `https://pmc.ncbi.nlm.nih.gov/articles/${id}/`;
  return undefined;
}

function paperResult(row: Record<string, unknown>): KeylessSearchResult | undefined {
  if (typeof row.paperId !== "string" || !row.paperId.trim()
    || typeof row.title !== "string" || !row.title.trim()
    || typeof row.abstract !== "string") return undefined;
  const result: KeylessSearchResult = {
    provider: "firecrawl-research", channel: "paper-index",
    paperId: row.paperId, title: row.title, abstract: row.abstract,
  };
  let url: string | undefined;
  if (typeof row.primaryId === "string" && row.primaryId.trim()) {
    result.primaryId = row.primaryId;
    const split = row.primaryId.indexOf(":");
    const namespace = row.primaryId.slice(0, split);
    const resolved = split > 0 ? identifierUrl(namespace, row.primaryId.slice(split + 1)) : undefined;
    if (resolved) { url = resolved; result.source = namespace; }
  }
  if (record(row.ids)) {
    // Preserve returned identifier metadata, but only validated supported ids
    // may produce a canonical source URL. Unknown namespaces are not guessed.
    const ids = Object.fromEntries(Object.entries(row.ids).flatMap(([namespace, values]) => (
      Array.isArray(values) && values.every((id) => typeof id === "string")
        ? [[namespace, [...values] as string[]]]
        : []
    )));
    for (const namespace of ["arxiv", "doi", "pmid", "pmcid"]) {
      const values = row.ids[namespace];
      if (!Array.isArray(values)) continue;
      const valid = values.filter((id): id is string => typeof id === "string" && identifierUrl(namespace, id) !== undefined);
      if (valid.length > 0) {
        if (!url) { url = identifierUrl(namespace, valid[0]!); result.source = namespace; }
      }
    }
    if (Object.keys(ids).length > 0) result.ids = ids;
  }
  url ??= publicUrl(row.url);
  if (!url && row.paperId.startsWith("web:")) url = publicUrl(row.paperId.slice(4));
  if (url) result.url = url;
  if (Array.isArray(row.authors) && row.authors.every((author) => typeof author === "string")) {
    result.authors = [...row.authors] as string[];
  }
  if (isIsoDate(row.createdDate)) result.createdDate = row.createdDate;
  if (isIsoDate(row.updateDate)) result.updateDate = row.updateDate;
  if (typeof row.score === "number" && Number.isFinite(row.score)) result.score = row.score;
  return result;
}

export async function searchKeyless(
  client: KeylessWebClient,
  input: WebSearchToolInput & { provider: KeylessWebProvider },
  signal?: AbortSignal,
): Promise<KeylessSearchDetails> {
  validateSearchToolInput(input);
  const provider = input.provider;
  const limit = input.num ?? 10;
  const query = input.query.trim();
  const site = input.site !== undefined ? normalizeSite(input.site) : undefined;
  const common = { provider, signal, timeoutMs: 30_000, maxBytes: 256 * 1024 };
  let response: Awaited<ReturnType<KeylessWebClient["request"]>>;
  if (provider === "firecrawl-research") {
    const url = new URL("https://api.firecrawl.dev/v2/search/research/papers");
    url.searchParams.set("query", query);
    url.searchParams.set("k", String(limit));
    if (input.from) url.searchParams.set("from", input.from);
    if (input.to) url.searchParams.set("to", input.to);
    response = await client.request({ ...common, url: url.href, method: "GET" });
  } else if (provider === "firecrawl") {
    response = await client.request({ ...common, url: "https://api.firecrawl.dev/v2/search", method: "POST", body: {
      query, limit, sources: ["web"], domainTools: false, highlights: false,
      ...(site ? { includeDomains: [site] } : {}),
    } });
  } else {
    response = await client.request({ ...common, url: "https://api.tavily.com/search", method: "POST", body: {
      query, search_depth: "basic", max_results: limit,
      include_answer: false, include_raw_content: false, auto_parameters: false,
      ...(site ? { include_domains: [site] } : {}),
    } });
  }
  const data = response.data;
  if (!record(data)) throw new KeylessWebError(provider, "MALFORMED_RESPONSE");
  if (data.success === false || data.error || (record(data.detail) && data.detail.error)) {
    throw new KeylessWebError(provider, "PROVIDER_ERROR", { status: response.status });
  }
  if (Object.hasOwn(data, "partial") && typeof data.partial !== "boolean") {
    throw new KeylessWebError(provider, "MALFORMED_RESPONSE", { status: response.status });
  }
  const rows = provider === "firecrawl" ? (record(data.data) ? data.data.web : undefined) : data.results;
  if (!Array.isArray(rows) || (provider !== "tavily" && data.success !== true)) {
    throw new KeylessWebError(provider, "MALFORMED_RESPONSE", { status: response.status });
  }
  const results: KeylessSearchResult[] = [];
  let rejectedResults = 0;
  const seen = new Set<string>();
  for (const row of rows) {
    let result: KeylessSearchResult | undefined;
    if (record(row)) {
      if (provider === "firecrawl-research") result = paperResult(row);
      else {
        const url = publicUrl(row.url);
        if (url) {
          result = { provider, channel: "web", url, source: new URL(url).hostname };
          if (typeof row.title === "string") result.title = row.title;
          const abstract = provider === "tavily" ? row.content : row.description;
          if (typeof abstract === "string") result.abstract = abstract;
        }
      }
    }
    if (!result) { rejectedResults += 1; continue; }
    const key = result.url ? canonicalizeResultUrl(result.url)! : `paper:${result.paperId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (results.length < limit) results.push(result);
  }
  if (rows.length > 0 && results.length === 0) throw new KeylessWebError(provider, "MALFORMED_RESPONSE", { status: response.status });
  const unresolvedSources = provider === "firecrawl-research"
    ? results.filter((result) => !result.url).length
    : 0;
  return {
    provider, channel: provider === "firecrawl-research" ? "paper-index" : "web",
    results, count: results.length, limit, rejectedResults,
    ...(typeof data.partial === "boolean" ? { partial: data.partial } : {}),
    warnings: [
      ...(rejectedResults ? ["Some malformed provider records were omitted."] : []),
      ...(unresolvedSources ? [`${unresolvedSources} paper record(s) have no resolvable source URL; verify their identifiers before citation.`] : []),
      ...(data.partial === true || data.warning ? ["The provider reported partial availability; coverage may be incomplete."] : []),
    ],
    ...(provider === "firecrawl-research" && (input.from || input.to) ? {
      dateFilter: { from: input.from, to: input.to, basis: "created/updated" as const },
    } : {}),
  };
}

export function formatKeylessResults(details: KeylessSearchDetails): string {
  const introduction = [
    `Provider: ${details.provider}`,
    `Channel: ${details.channel}`,
    details.channel === "paper-index"
      ? "Paper metadata and abstracts are candidate evidence, not verified full text. Index dates are created/updated dates, not verified publication dates."
      : "Search snippets are leads; inspect the original sources before verifying claims.",
  ];
  const rows = details.results.map((result, index) => [
    `Result ${index + 1}`,
    ...Object.entries(result).filter(([key]) => key !== "provider" && key !== "channel").map(([key, value]) => (
      `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`
    )),
  ].join("\n"));
  return [...introduction, ...rows,
    ...(rows.length === 0 ? ["Search was inconclusive: the provider returned no usable results; this does not establish absence."] : []),
    ...details.warnings,
  ].join("\n\n");
}
