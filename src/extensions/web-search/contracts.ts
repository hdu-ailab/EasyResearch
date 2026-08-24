export const WEB_SEARCH_ENGINES = [
  "duckduckgo",
  "bing",
  "brave",
  "startpage",
  "baidu",
  "sogou",
] as const;

export type WebSearchEngine = (typeof WEB_SEARCH_ENGINES)[number];
export type EngineReliability = "high" | "low";

export interface WebSearchInput {
  query: string;
  engines: WebSearchEngine[];
  num?: number;
  site?: string;
}

export interface OpenWebSearchRequest {
  query: string;
  engines: WebSearchEngine[];
  limit: number;
  searchMode: "request";
}

export interface OpenWebSearchResult {
  title: string;
  url: string;
  description: string;
  source: string;
  engine: string;
}

export interface OpenWebSearchPartialFailure {
  engine: string;
  code: string;
  message: string;
}

export interface OpenWebSearchResponse {
  query: string;
  engines: string[];
  totalResults: number;
  results: OpenWebSearchResult[];
  partialFailures: OpenWebSearchPartialFailure[];
}

export interface OpenWebSearchService {
  execute(input: OpenWebSearchRequest): Promise<OpenWebSearchResponse>;
}

export interface WebSearchResult {
  title: string;
  url: string;
  abstract: string;
  source: string;
  engine: WebSearchEngine;
  engineReliability: EngineReliability;
  matchedEngines: WebSearchEngine[];
}

export interface WebSearchPartialFailure {
  engine: WebSearchEngine;
  code: string;
  message: string;
  engineReliability: EngineReliability;
}

export interface WebSearchExecution {
  engines: WebSearchEngine[];
  effectiveQuery: string;
  results: WebSearchResult[];
  partialFailures: WebSearchPartialFailure[];
  allEnginesFailed: boolean;
}

export interface WebSearchDetails {
  engines: WebSearchEngine[];
  results: WebSearchResult[];
  count: number;
  partialFailures: WebSearchPartialFailure[];
  fullOutputPath?: string;
  error?: string;
}
