import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  formatSize,
  keyHint,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { load } from "cheerio";
import { mkdtemp, writeFile } from "node:fs/promises";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

/**
 * ADR-031 (amended by ADR-038): the bundled web-search tool (registered as
 * `web-search`), ported verbatim from the upstream Pi duckduckgo-search
 * extension (the user's `~/.pi` copy is the sole source). Registration happens
 * in the two bundled extension surfaces (assistant + subagent); pure
 * helpers are exported for tests.
 */
export const DEFAULT_RESULT_COUNT = 5;
export const COLLAPSED_LINE_MAX_CHARS = 200;
export const RETRY_DELAYS_MS = [0, 5_000, 5_000] as const;
export const REQUEST_TIMEOUT_MS = 30_000;

let searchQueue: Promise<void> = Promise.resolve();

export type SearchResult = {
  title: string;
  url: string;
  abstract: string;
};

export type SearchArgs = {
  query: string;
  num: number;
  site?: string;
  time?: "d" | "w" | "m" | "y";
};

export function abortError(): Error {
  const error = new Error("Search cancelled");
  error.name = "AbortError";
  return error;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms === 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitFor(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await previous;
    return;
  }

  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }

    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    previous.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}

export async function serialize<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const previous = searchQueue;
  let release!: () => void;
  searchQueue = new Promise<void>((resolve) => {
    release = resolve;
  });

  try {
    await waitFor(previous, signal);
    throwIfAborted(signal);
    return await operation();
  } finally {
    release();
  }
}

export function decodeResultUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl, "https://duckduckgo.com");
    return url.searchParams.get("uddg") || url.href;
  } catch {
    return rawUrl;
  }
}

export function parseResults(html: string, limit: number): SearchResult[] {
  const $ = load(html);
  const results: SearchResult[] = [];

  $(".links_main").each((_, element) => {
    if (results.length >= limit) return false;

    const link = $(element).find("h2.result__title a").first();
    const rawUrl = link.attr("href");
    if (!rawUrl) return;

    results.push({
      title: link.text().replace(/\s+/g, " ").trim(),
      url: decodeResultUrl(rawUrl),
      abstract: $(element)
        .find("a.result__snippet")
        .first()
        .text()
        .replace(/\s+/g, " ")
        .trim(),
    });
  });

  return results;
}

export function looksBlocked(status: number, html: string): boolean {
  return (
    status === 202 ||
    /captcha|anomaly-modal|challenge-form|unusual (?:activity|traffic)|verify (?:you are|that you are) human/i.test(
      html,
    )
  );
}

export function fetchHtml(
  form: URLSearchParams,
  signal?: AbortSignal,
): Promise<{ status: number; html: string }> {
  throwIfAborted(signal);
  const body = form.toString();

  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: "html.duckduckgo.com",
        port: 443,
        path: "/html",
        method: "POST",
        agent: false,
        signal,
        headers: {
          "Accept-Encoding": "gzip",
          "User-Agent": "",
          DNT: "1",
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          try {
            let content = Buffer.concat(chunks);
            if (response.headers["content-encoding"] === "gzip") content = gunzipSync(content);
            resolve({ status: response.statusCode || 0, html: content.toString("utf8") });
          } catch (error) {
            reject(error);
          }
        });
      },
    );

    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error(`request timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds`));
    });
    request.on("error", reject);
    request.end(body);
  });
}

export async function requestSearch(
  args: SearchArgs,
  signal?: AbortSignal,
  onAttempt?: (attempt: number) => void,
): Promise<SearchResult[] | null> {
  const query = args.site
    ? `${args.query} site:${args.site.replace(/^https?:\/\//, "").replace(/\/.*$/, "")}`
    : args.query;
  const form = new URLSearchParams({
    q: query,
    b: "",
    df: args.time || "",
    kf: "-1",
    kh: "1",
    kl: "us-en",
    kp: "1",
    k1: "-1",
  });

  let lastError = "DuckDuckGo returned no usable results";
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    await sleep(RETRY_DELAYS_MS[attempt]!, signal);
    throwIfAborted(signal);
    onAttempt?.(attempt + 1);

    try {
      const response = await fetchHtml(form, signal);

      if (looksBlocked(response.status, response.html)) {
        lastError = `DuckDuckGo blocked attempt ${attempt + 1} with HTTP ${response.status}`;
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        lastError = `DuckDuckGo returned HTTP ${response.status}`;
        continue;
      }

      const results = parseResults(response.html, args.num);
      if (results.length > 0) return results;
      if (/No results\./i.test(response.html)) return null;

      lastError = `DuckDuckGo returned an empty or unrecognized response on attempt ${attempt + 1}`;
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw abortError();
      lastError = `DuckDuckGo request failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  throw new Error(`${lastError}. Three serial attempts failed.`);
}

export function formatResults(results: SearchResult[]): string {
  return results
    .map(
      (result, index) =>
        `Result ${index + 1}\nTitle: ${result.title}\nURL: ${result.url}\nAbstract: ${result.abstract}`,
    )
    .join("\n\n");
}

export function compactLine(value: unknown): string {
  const line = String(value ?? "").replace(/\s+/g, " ").trim();
  const characters = Array.from(line);
  if (characters.length <= COLLAPSED_LINE_MAX_CHARS) return line;
  return characters.slice(0, COLLAPSED_LINE_MAX_CHARS - 1).join("") + "…";
}

export function textContent(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((item) => item.type === "text" && item.text)
    .map((item) => item.text)
    .join("\n");
}

export async function truncateOutput(output: string): Promise<{ text: string; fullOutputPath?: string }> {
  const truncation = truncateHead(output, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  if (!truncation.truncated) return { text: output };

  const directory = await mkdtemp(join(tmpdir(), "pi-duckduckgo-search-"));
  const fullOutputPath = join(directory, "results.txt");
  await writeFile(fullOutputPath, output, "utf8");
  const notice =
    `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines ` +
    `(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). ` +
    `Full output saved to: ${fullOutputPath}]`;
  return { text: truncation.content + notice, fullOutputPath };
}

export const webSearchTool = defineTool({
  name: "web-search",
  label: "DuckDuckGo Search",
  description:
    "Use when you need current real-time information or must verify facts you cannot reliably know from training data.",
  promptSnippet: "Search the web with DuckDuckGo using optional domain and age filters",
  promptGuidelines: [
    "Use web-search when current external information or web discovery is required.",
    "Treat web-search snippets as leads, and inspect selected source URLs before presenting their claims as verified facts.",
  ],
  parameters: Type.Object({
    query: Type.String({ minLength: 1, description: "Search query, including quoted phrases when needed" }),
    num: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 25, description: "Maximum number of results (1-25); defaults to 5" }),
    ),
    site: Type.Optional(Type.String({ minLength: 1, description: "Optional domain restriction, for example github.com" })),
    time: Type.Optional(
      StringEnum(["d", "w", "m", "y"] as const, {
        description: "Optional age limit: day, week, month, or year",
      }),
    ),
  }),
  renderCall(args, theme) {
    return new Text(
      theme.fg("toolTitle", theme.bold("DuckDuckGo Search ")) +
        theme.fg("accent", `“${compactLine(args.query)}”`),
      0,
      0,
    );
  },
  renderResult(result, { expanded, isPartial }, theme) {
    const details = result.details as
      | { attempt?: number; results?: SearchResult[]; error?: string }
      | undefined;
    const output = textContent(result);

    if (isPartial) {
      const attempt = details?.attempt;
      return new Text(
        theme.fg("warning", attempt ? `Searching… attempt ${attempt}/3` : "Searching…"),
        0,
        0,
      );
    }

    if (details?.error) return new Text(theme.fg("error", output), 0, 0);
    if (expanded || !details?.results?.length) {
      return new Text(theme.fg("toolOutput", output), 0, 0);
    }

    const lines: string[] = [];
    details.results.forEach((item, index) => {
      lines.push(theme.fg("toolOutput", `${index + 1}. ${compactLine(item.title)}`));
      lines.push(theme.fg("dim", `   ${compactLine(item.url)}`));
    });
    lines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
    return new Text(lines.join("\n"), 0, 0);
  },
  async execute(_toolCallId, params, signal, onUpdate) {
    try {
      const results = await serialize(
        () =>
          requestSearch(
            {
              query: params.query,
              num: params.num ?? DEFAULT_RESULT_COUNT,
              site: params.site,
              time: params.time,
            },
            signal,
            (attempt) => {
              onUpdate?.({
                content: [{ type: "text", text: `Searching DuckDuckGo (attempt ${attempt}/3)...` }],
                details: { attempt },
              });
            },
          ),
        signal,
      );

      if (!results) {
        return {
          content: [{ type: "text", text: "No results found. Try a shorter query or remove the site/time filter." }],
          details: { results: [], count: 0 },
        };
      }

      const output = await truncateOutput(formatResults(results));
      return {
        content: [{ type: "text", text: output.text }],
        details: { results, count: results.length, fullOutputPath: output.fullOutputPath },
      };
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw abortError();
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text",
            text: `Search failed: ${message}\nDuckDuckGo is temporarily unavailable; use another search method if one is available.`,
          },
        ],
        details: { error: message },
      };
    }
  },
});

/** Extension factory kept for parity with the upstream duckduckgo-search extension shape. */
export function duckduckGoSearchExtension(pi: ExtensionAPI): void {
  pi.registerTool(webSearchTool);
}
