declare module "open-websearch/build/config.js" {
  export interface OpenWebSearchConfig {
    defaultSearchEngine: string;
    allowedSearchEngines: string[];
    searchMode: string;
    proxyUrl: string;
    useProxy: boolean;
    fakeIpCidrs: string[];
    fetchWebAllowInsecureTls: boolean;
    playwrightPackage: string;
    playwrightModulePath?: string;
    playwrightExecutablePath?: string;
    playwrightWsEndpoint?: string;
    playwrightCdpEndpoint?: string;
    playwrightHeadless: boolean;
    playwrightNavigationTimeoutMs: number;
    enableCors: boolean;
    corsOrigin: string;
    enableHttpServer: boolean;
  }

  export const config: OpenWebSearchConfig;
}

declare module "open-websearch/build/runtime/createRuntime.js" {
  import type { OpenWebSearchConfig } from "open-websearch/build/config.js";

  export interface PackageSearchResult {
    title: string;
    url: string;
    description: string;
    source: string;
    engine: string;
  }

  export interface PackageSearchResponse {
    query: string;
    engines: string[];
    totalResults: number;
    results: PackageSearchResult[];
    partialFailures: Array<{ engine: string; code: string; message: string }>;
  }

  export interface PackageSearchService {
    execute(input: {
      query: string;
      engines: string[];
      limit: number;
      searchMode?: "request" | "auto" | "playwright";
    }): Promise<PackageSearchResponse>;
  }

  export interface OpenWebSearchRuntime {
    config: OpenWebSearchConfig;
    services: {
      search: PackageSearchService;
    };
  }

  export type PackageSearchExecutor = (
    query: string,
    limit: number,
    context?: { searchMode?: "request" | "auto" | "playwright" },
  ) => Promise<PackageSearchResult[]>;

  export function createOpenWebSearchRuntime(options?: {
    config?: OpenWebSearchConfig;
    dependencies?: { searchExecutors?: Record<string, PackageSearchExecutor> };
  }): OpenWebSearchRuntime;
}
