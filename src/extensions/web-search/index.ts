import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  formatSize,
  truncateHead,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { createLogger } from "../../runtime/logger";
import type { AppliedSearchRoute } from "../../runtime/network-routing";
import { createAbortError, createWebSearchAdapter, type WebSearchAdapter } from "./adapter";
import {
  WEB_SEARCH_ENGINES,
  type WebSearchDetails,
  type WebSearchPartialFailure,
  type WebSearchResult,
} from "./contracts";
import {
  initializeOpenWebSearchRuntime,
  initializeOpenWebSearchRuntimeForRoute,
  type InitializedOpenWebSearchRuntime,
} from "./runtime";

const logger = createLogger("web-search");

export const COLLAPSED_LINE_MAX_CHARS = 200;

export function compactLine(value: unknown): string {
  const line = String(value ?? "").replace(/\s+/gu, " ").trim();
  const characters = Array.from(line);
  if (characters.length <= COLLAPSED_LINE_MAX_CHARS) return line;
  return `${characters.slice(0, COLLAPSED_LINE_MAX_CHARS - 3).join("")}...`;
}

export function textContent(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((item) => item.type === "text" && item.text)
    .map((item) => item.text)
    .join("\n");
}

export function formatResults(results: readonly WebSearchResult[]): string {
  return results.map((result, index) => [
    `Result ${index + 1}`,
    `Title: ${result.title}`,
    `URL: ${result.url}`,
    `Abstract: ${result.abstract}`,
    `Source: ${result.source}`,
    `Engine: ${result.engine}`,
    `Engine reliability: ${result.engineReliability}`,
    `Matched engines: ${result.matchedEngines.join(", ")}`,
  ].join("\n")).join("\n\n");
}

export function formatPartialFailures(failures: readonly WebSearchPartialFailure[]): string {
  if (failures.length === 0) return "";
  return [
    "Partial engine failures",
    ...failures.map((failure) => (
      `- ${failure.engine} [${failure.engineReliability}] ${failure.code}: ${failure.message}`
    )),
  ].join("\n");
}

export async function truncateOutput(output: string): Promise<{ text: string; fullOutputPath?: string }> {
  const truncation = truncateHead(output, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  if (!truncation.truncated) return { text: output };

  const directory = await mkdtemp(join(tmpdir(), "easyresearch-web-search-"));
  const fullOutputPath = join(directory, "results.txt");
  await writeFile(fullOutputPath, output, "utf8");
  const notice =
    `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines `
    + `(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). `
    + `Full output saved to: ${fullOutputPath}]`;
  return { text: truncation.content + notice, fullOutputPath };
}

function detailsFor(
  engines: WebSearchDetails["engines"],
  results: WebSearchResult[],
  partialFailures: WebSearchPartialFailure[],
  extra: Pick<WebSearchDetails, "error" | "fullOutputPath"> = {},
): WebSearchDetails {
  return {
    engines,
    results,
    count: results.length,
    partialFailures,
    ...extra,
  };
}

export interface WebSearchToolOptions {
  sanitizeError?: (error: unknown) => string;
}

function rawErrorMessage(error: unknown): string {
  try {
    const message = error instanceof Error ? error.message : String(error);
    return message || "Search failed.";
  } catch {
    return "Search failed.";
  }
}

function redactUrlUserinfo(message: string): string {
  return message.replace(
    /\b(https?):\/\/[^\s/?#@]+@/giu,
    "$1://[redacted userinfo]@",
  );
}

function safeSearchErrorMessage(
  error: unknown,
  sanitizeError?: (error: unknown) => string,
): string {
  let message: string;
  try {
    message = sanitizeError ? sanitizeError(error) : rawErrorMessage(error);
  } catch {
    message = "Search failed.";
  }
  const redacted = redactUrlUserinfo(message || "Search failed.");
  const code = error && typeof error === "object" && "code" in error
    && error.code === "NETWORK_PROXY_INVALID"
    ? "NETWORK_PROXY_INVALID"
    : undefined;
  return code && !redacted.includes(code) ? `${code}: ${redacted}` : redacted;
}

export function createWebSearchTool(
  adapter: WebSearchAdapter,
  options: WebSearchToolOptions = {},
) {
  return defineTool({
    name: "web-search",
    label: "Web Search",
    description:
      "Search current Web sources with explicit engines. Start with DuckDuckGo first; use Bing, Brave, or Startpage next, and Baidu or Sogou only as fallback channels. Channel reliability is not factual verification.",
    promptSnippet: "Search the Web with explicit multi-engine selection and verify selected pages with webfetch",
    promptGuidelines: [
      "Start with DuckDuckGo first for general Web research.",
      "Use Bing, Brave, or Startpage as high-reliability international fallback channels.",
      "Use Baidu or Sogou only for Chinese coverage or as final fallback channels.",
      "Reliability describes the search channel, not factual trust in a returned page.",
      "An empty search response is inconclusive and may indicate throttling.",
      "Treat snippets as leads and inspect selected source URLs with webfetch before presenting claims as verified.",
      "Google is not a web-search engine; use the separately mounted Playwright Google workflow only as an external final fallback.",
    ],
    parameters: Type.Object({
      query: Type.String({ minLength: 1, description: "Search query, including quoted phrases when needed" }),
      engines: Type.Array(StringEnum(WEB_SEARCH_ENGINES), {
        minItems: 1,
        maxItems: WEB_SEARCH_ENGINES.length,
        uniqueItems: true,
        description: "Explicit search engines to query",
      }),
      num: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: 25,
        description: "Total results across engines; defaults to 10 and must cover every selected engine",
      })),
      site: Type.Optional(Type.String({
        minLength: 1,
        description: "Optional domain restriction, for example github.com",
      })),
    }),
    renderCall(args, theme) {
      const engines = args.engines.join(", ");
      return new Text(
        theme.fg("toolTitle", theme.bold("Web Search "))
        + theme.fg("accent", `"${compactLine(args.query)}"`)
        + theme.fg("dim", ` via ${engines}`),
        0,
        0,
      );
    },
    renderResult(result, { expanded, isPartial }, theme) {
      const details = result.details as WebSearchDetails | undefined;
      const output = textContent(result);
      if (isPartial) return new Text(theme.fg("warning", "Searching selected engines..."), 0, 0);
      if (details?.error) return new Text(theme.fg("error", output), 0, 0);
      if (expanded || !details?.results.length) return new Text(theme.fg("toolOutput", output), 0, 0);

      const lines: string[] = [];
      details.results.forEach((item, index) => {
        lines.push(theme.fg("toolOutput", `${index + 1}. ${compactLine(item.title)}`));
        lines.push(theme.fg("dim", `   ${compactLine(item.url)}`));
      });
      if (details.partialFailures.length > 0) {
        lines.push(theme.fg("warning", `${details.partialFailures.length} engine failure(s)`));
      }
      return new Text(lines.join("\n"), 0, 0);
    },
    async execute(_toolCallId, params, signal, onUpdate) {
      try {
        onUpdate?.({
          content: [{ type: "text", text: `Searching ${params.engines.join(", ")}...` }],
          details: { engines: params.engines, results: [], count: 0, partialFailures: [] },
        });
        const execution = await adapter.search({
          query: params.query,
          engines: [...params.engines],
          num: params.num,
          site: params.site,
        }, signal);
        const partialFailures = execution.partialFailures.map((failure) => ({
          ...failure,
          message: safeSearchErrorMessage(failure.message, options.sanitizeError),
        }));
        if (execution.allEnginesFailed) {
          const message = "Every selected search engine failed.";
          return {
            content: [{
              type: "text",
              text: `${message}\n\n${formatPartialFailures(partialFailures)}`,
            }],
            details: detailsFor(
              execution.engines,
              [],
              partialFailures,
              { error: message },
            ),
          };
        }
        if (execution.results.length === 0) {
          const message = partialFailures.length > 0
            ? "Search was inconclusive: some engines failed and the remaining engines returned no usable results."
            : "Search was inconclusive: selected engines returned no usable results, which may indicate throttling.";
          return {
            content: [{
              type: "text",
              text: [message, formatPartialFailures(partialFailures)].filter(Boolean).join("\n\n"),
            }],
            details: detailsFor(execution.engines, [], partialFailures),
          };
        }

        const formatted = [
          formatResults(execution.results),
          formatPartialFailures(partialFailures),
        ].filter(Boolean).join("\n\n");
        const output = await truncateOutput(formatted);
        return {
          content: [{ type: "text", text: output.text }],
          details: detailsFor(
            execution.engines,
            execution.results,
            partialFailures,
            { fullOutputPath: output.fullOutputPath },
          ),
        };
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        if (signal?.aborted) throw createAbortError();
        const message = safeSearchErrorMessage(error, options.sanitizeError);
        logger.error("search failed", { query: params.query, engines: params.engines, error: message });
        return {
          content: [{
            type: "text",
            text: `Search failed: ${message}\nSelected engines may be temporarily unavailable; try another explicit engine selection.`,
          }],
          details: detailsFor([...params.engines], [], [], { error: message }),
        };
      }
    },
  });
}

export interface WebSearchExtensionDependencies {
  initializeRuntime?: () => Promise<InitializedOpenWebSearchRuntime>;
  appliedSearchRoute?: AppliedSearchRoute;
}

export function createWebSearchExtension(
  dependencies: WebSearchExtensionDependencies = {},
): ExtensionFactory {
  return async (pi) => {
    const route = dependencies.appliedSearchRoute;
    const toolOptions: WebSearchToolOptions = route
      ? { sanitizeError: (error) => route.sanitizeError(error) }
      : {};
    const invalid = route?.invalidError();
    if (invalid) {
      pi.registerTool(createWebSearchTool({
        search: async () => {
          throw invalid;
        },
      }, toolOptions));
      return;
    }
    const initializeRuntime = dependencies.initializeRuntime
      ?? (route
        ? () => initializeOpenWebSearchRuntimeForRoute(route)
        : initializeOpenWebSearchRuntime);
    const runtime = await initializeRuntime();
    pi.registerTool(createWebSearchTool(createWebSearchAdapter(runtime.search, {
      ...toolOptions,
      requestRouting: runtime.requestRouting,
    }), toolOptions));
  };
}

export default createWebSearchExtension();
