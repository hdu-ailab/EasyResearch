import { unified } from "unified";
import remarkParse from "remark-parse";
import type { KeylessWebClient } from "../keyless-web/client";

type RemoteProvider = "firecrawl" | "tavily";
type RemoteFormat = "markdown" | "text";
type RecordValue = Record<string, unknown>;
const MAX_URL_BYTES = 8192;
const PROVENANCE_STRING_LIMIT = 512;
const PROVENANCE_COLLECTION_LIMIT = 4;
const CACHE_FIELDS = ["cacheState", "cachedAt", "cached", "cache", "status", "statusCode", "warning", "request_id"] as const;

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue : undefined;
}

function failed(value: RecordValue): boolean {
  return value.success === false || Boolean(value.error)
    || (Array.isArray(value.errors) ? value.errors.length > 0 : Boolean(value.errors)) || Boolean(record(value.detail)?.error)
    || (typeof value.statusCode === "number" && value.statusCode >= 400)
    || (typeof value.status === "number" && value.status >= 400)
    || (typeof value.status === "string" && ["error", "failed", "failure"].includes(value.status.toLowerCase()));
}

function documentMetadata(value: unknown): RecordValue {
  if (value === undefined || value === null) return {};
  const metadata = record(value);
  if (!metadata || (metadata.statusCode !== undefined
    && (!Number.isInteger(metadata.statusCode) || (metadata.statusCode as number) < 100 || (metadata.statusCode as number) > 599))) {
    throw new Error("Invalid provider metadata");
  }
  return metadata;
}

function sourceUrl(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  // URL identities are never truncated into a different URL. Reject an oversized
  // identity instead of allowing it to bypass bounded tool-result details.
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_URL_BYTES) throw new Error("Invalid or oversized provider source URL");
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error();
    return value;
  } catch {
    throw new Error("Invalid provider source URL");
  }
}

function sameUrl(left: string, right: string): boolean {
  const requested = new URL(left);
  const returned = new URL(right);
  requested.hash = "";
  returned.hash = "";
  return requested.href === returned.href;
}

function boundedProvenanceValue(value: unknown): string | number | boolean | null | Array<string | number | boolean | null> | undefined {
  const scalar = (item: unknown) => {
    if (typeof item === "string") return item.length > PROVENANCE_STRING_LIMIT
      ? `${item.slice(0, PROVENANCE_STRING_LIMIT)}…` : item;
    if (item === null || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) return item;
    return undefined;
  };
  return Array.isArray(value)
    ? value.slice(0, PROVENANCE_COLLECTION_LIMIT).map(scalar).filter((item) => item !== undefined)
    : scalar(value);
}

function projectedMetadata(metadata: RecordValue): RecordValue {
  const projected: RecordValue = {};
  for (const key of ["title", "description", "language", "keywords", "contentType", ...CACHE_FIELDS]) {
    const value = boundedProvenanceValue(metadata[key]);
    if (value !== undefined) projected[key] = value;
  }
  for (const key of ["sourceURL", "url"]) {
    const value = sourceUrl(metadata[key]);
    if (value !== undefined) projected[key] = value;
  }
  return projected;
}

// Parse Markdown as Markdown: HTML-looking code, math and angle brackets must
// never pass through an HTML parser merely because plain text was requested.
function markdownText(markdown: string): string {
  const tree = unified().use(remarkParse).parse(markdown);
  function text(node: { type: string; value?: string; alt?: string | null; children?: typeof tree.children }): string {
    if (node.type === "image") return node.alt ?? "";
    if (node.type === "break") return "\n";
    if (node.value !== undefined) return node.value;
    const children = node.children?.map(text) ?? [];
    return children.join(["root", "blockquote", "list", "listItem"].includes(node.type) ? "\n\n" : "");
  }
  return text(tree);
}

export async function extractRemotePage(options: {
  client: KeylessWebClient;
  provider: RemoteProvider;
  url: string;
  format: RemoteFormat;
  signal: AbortSignal;
  timeoutMs: number;
  maxBytes: number;
  deadlineAt?: number;
}) {
  const { client, provider, url, format, signal, timeoutMs, maxBytes } = options;
  const deadlineAt = options.deadlineAt ?? performance.now() + timeoutMs;
  const checkActive = () => {
    signal.throwIfAborted();
    // Timers cannot run while Markdown parsing or projection occupies the thread.
    if (performance.now() >= deadlineAt) {
      throw Object.assign(new Error(`Request timed out after ${timeoutMs / 1000} seconds`), { name: "AbortError" });
    }
  };
  checkActive();
  sourceUrl(url);
  const response = await client.request({
    provider,
    url: provider === "firecrawl" ? "https://api.firecrawl.dev/v2/scrape" : "https://api.tavily.com/extract",
    method: "POST",
    body: provider === "firecrawl"
      ? { url, formats: ["markdown"], onlyMainContent: true, timeout: Math.round(timeoutMs) }
      : { urls: [url], extract_depth: "basic", format },
    signal,
    timeoutMs,
    maxBytes,
  });
  checkActive();
  const payload = record(response.data);
  // Never repeat upstream error bodies/instructions in diagnostics.
  if (response.status < 200 || response.status >= 300 || !payload || failed(payload)) {
    throw new Error(`${provider} extraction failed or returned an invalid response`);
  }
  let document: RecordValue;
  let metadata: RecordValue;
  let returnedSourceUrl: string | undefined;
  let finalUrl: string | undefined;
  let content: string;
  let actualFormat: RemoteFormat;
  if (provider === "firecrawl") {
    const data = record(payload.data);
    if (payload.success !== true || !data || failed(data)) throw new Error("firecrawl extraction failed or returned an invalid document");
    document = data;
    metadata = documentMetadata(data.metadata);
    if (failed(metadata)) throw new Error("firecrawl reported a source extraction failure");
    returnedSourceUrl = sourceUrl(metadata.sourceURL);
    finalUrl = sourceUrl(metadata.url);
    if ((returnedSourceUrl && !sameUrl(returnedSourceUrl, url))
      || (!returnedSourceUrl && finalUrl && !sameUrl(finalUrl, url))) {
      throw new Error("firecrawl returned a mismatched source URL");
    }
    if (typeof data.markdown === "string") {
      content = format === "text" ? markdownText(data.markdown) : data.markdown;
      actualFormat = format;
    } else if (typeof data.text === "string") {
      content = data.text;
      actualFormat = "text";
    } else throw new Error("firecrawl returned no extracted text");
  } else {
    if ((payload.failed_results !== undefined && (!Array.isArray(payload.failed_results) || payload.failed_results.length > 0))
      || !Array.isArray(payload.results) || payload.results.length !== 1) {
      throw new Error("tavily reported a failed or invalid single-URL extraction");
    }
    const data = record(payload.results[0]);
    if (!data || failed(data)) throw new Error("tavily extraction failed or returned an invalid document");
    document = data;
    metadata = documentMetadata(data.metadata);
    if (failed(metadata)) throw new Error("tavily reported a source extraction failure");
    returnedSourceUrl = sourceUrl(data.url);
    if (!returnedSourceUrl || !sameUrl(returnedSourceUrl, url)) throw new Error("tavily returned a mismatched source URL");
    const metadataSource = sourceUrl(metadata.sourceURL);
    if (metadataSource && !sameUrl(metadataSource, url)) throw new Error("tavily returned a mismatched source URL");
    finalUrl = sourceUrl(data.final_url ?? metadata.url);
    if (typeof data.raw_content === "string") {
      content = data.raw_content;
      actualFormat = format;
    } else if (typeof data.text === "string") {
      content = data.text;
      actualFormat = "text";
    } else throw new Error("tavily returned no extracted text");
  }
  if (!content.trim()) throw new Error(`${provider} returned empty extracted content`);
  // Keep provider-reported provenance without promoting it to origin verification.
  const provenance: RecordValue = { metadata: projectedMetadata(metadata) };
  for (const key of CACHE_FIELDS) {
    const value = boundedProvenanceValue(document[key] !== undefined ? document[key] : payload[key]);
    if (value !== undefined) provenance[key] = value;
  }
  const cacheHeaders: Record<string, string> = {};
  for (const key of ["age", "cache-control", "x-cache", "cf-cache-status"]) {
    const value = response.headers.get(key);
    if (value !== null) cacheHeaders[key] = value.length > PROVENANCE_STRING_LIMIT
      ? `${value.slice(0, PROVENANCE_STRING_LIMIT)}…` : value;
  }
  const result = {
    content,
    details: {
      provider,
      requestedUrl: url,
      sourceUrl: returnedSourceUrl,
      finalUrl,
      url: finalUrl ?? returnedSourceUrl ?? url,
      requestedFormat: format,
      format: actualFormat,
      contentType: actualFormat === "markdown" ? "text/markdown" : "text/plain",
      sizeBytes: Buffer.byteLength(content, "utf8"),
      providerStatus: response.status,
      provenance,
      providerCacheHeaders: cacheHeaders,
      providerCacheHeadersScope: "extraction-api-response",
      directOriginVerified: false,
    },
  };
  checkActive();
  return result;
}
