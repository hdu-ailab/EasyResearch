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
import { Text } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { createLogger } from "../../runtime/logger";
import { getAgentDir } from "../../runtime/pi-import";

const logger = createLogger("web-search");

/**
 * ADR-079: the bundled web-search tool (registered as `web-search`) wraps the
 * Python `ddgr` CLI installed in the first-run skill venv (`<agentDir>/venv`,
 * see `src/setup-venv.ts`, ADR-071). Each attempt first runs ddgr with
 * `--noua` (no User-Agent); when that fails it retries the same attempt with
 * ddgr's default browser User-Agent; only when both fail is the attempt
 * counted and the 0/5s/5s retry loop continues. The agent-facing contract
 * (tool name, parameters, result text format, details) is unchanged from
 * ADR-031/038; the upstream `~/.pi` duckduckgo-search extension is not
 * synced. Registration happens in the two bundled extension surfaces
 * (assistant + subagent); pure helpers are exported for tests.
 */
export const DEFAULT_RESULT_COUNT = 5;
export const COLLAPSED_LINE_MAX_CHARS = 200;
export const RETRY_DELAYS_MS = [0, 5_000, 5_000] as const;
export const REQUEST_TIMEOUT_MS = 30_000;

export const DDGR_INSTALL_HINT =
  "web-search requires the ddgr CLI, which was not found. Initialize the EasyResearch skill venv by running easyresearch once, or install ddgr manually and add it to PATH (pip install ddgr, see https://github.com/jarun/ddgr).";

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

/**
 * Locate ddgr inside the skill venv (`<agentDir>/venv`, ADR-071/079). Falls
 * back to a bare `ddgr` on PATH when the venv binary is absent, so the tool
 * works as soon as ddgr is installable anywhere.
 */
export function resolveDdgrCommand(
  agentDir: string,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  const bin =
    platform === "win32"
      ? join(agentDir, "venv", "Scripts", "ddgr.exe")
      : join(agentDir, "venv", "bin", "ddgr");
  return exists(bin) ? bin : undefined;
}

/**
 * Build the ddgr argv. `masked` false adds `--noua` (no User-Agent); `masked`
 * true lets ddgr send its default browser User-Agent. `--json` implies `--np`
 * (non-interactive) and prints the results JSON to stdout.
 */
export function buildDdgrArgs(args: SearchArgs, masked: boolean): string[] {
  const argv = ["--json", "-n", String(args.num)];
  if (!masked) argv.push("--noua");
  if (args.site) argv.push("-w", args.site.replace(/^https?:\/\//, "").replace(/\/.*$/, ""));
  if (args.time) argv.push("-t", args.time);
  argv.push(args.query);
  return argv;
}

/** Parse ddgr `--json` output (`[{title,url,abstract}, …]`); undefined on unparseable or malformed output. */
export function parseDdgrJson(stdout: string): SearchResult[] | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return undefined;
    const results: SearchResult[] = [];
    for (const raw of parsed) {
      if (typeof raw !== "object" || raw === null) return undefined;
      const item = raw as Record<string, unknown>;
      if (typeof item.title !== "string" || typeof item.url !== "string" || typeof item.abstract !== "string") {
        return undefined;
      }
      results.push({ title: item.title, url: item.url, abstract: item.abstract });
    }
    return results;
  } catch {
    return undefined;
  }
}

export type SpawnResult = { status: number; stdout: string; stderr: string };
export type SpawnFn = (
  command: string,
  args: string[],
  options: { timeoutMs: number; signal?: AbortSignal },
) => Promise<SpawnResult>;

/** Spawn ddgr with a utf-8 stdout (ddgr refuses non-utf-8 encodings), 30s timeout and abort support. */
export function realSpawn(
  command: string,
  args: string[],
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const onAbort = () => {
      child.kill();
      reject(abortError());
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`ddgr timed out after ${options.timeoutMs / 1000} seconds`));
    }, options.timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("close", (code) => {
      cleanup();
      resolve({ status: code ?? 1, stdout, stderr });
    });
  });
}

export async function requestSearch(
  command: string,
  args: SearchArgs,
  signal?: AbortSignal,
  onAttempt?: (attempt: number) => void,
  spawnFn: SpawnFn = realSpawn,
  delays: readonly number[] = RETRY_DELAYS_MS,
): Promise<SearchResult[] | null> {
  let lastError = "DuckDuckGo returned no usable results";
  let failedAttempts = 0;
  for (let attempt = 0; attempt < delays.length; attempt++) {
    await sleep(delays[attempt]!, signal);
    throwIfAborted(signal);
    onAttempt?.(attempt + 1);

    // Plain (no User-Agent) first; masked (browser User-Agent) only when the
    // plain run failed. Only when both fail is the attempt counted as failed.
    for (let masked = 0; masked <= 1; masked++) {
      const ua = masked ? "browser UA" : "plain UA";
      try {
        const response = await spawnFn(command, buildDdgrArgs(args, masked === 1), {
          timeoutMs: REQUEST_TIMEOUT_MS,
          signal,
        });
        if (response.status !== 0) {
          lastError = `DuckDuckGo request failed (attempt ${attempt + 1}, ${ua}): ddgr exited with ${response.status}${response.stderr.trim() ? `: ${compactLine(response.stderr.trim())}` : ""}`;
          continue;
        }
        const results = parseDdgrJson(response.stdout);
        if (results === undefined) {
          lastError = `DuckDuckGo returned an unrecognized response (attempt ${attempt + 1}, ${ua})`;
          continue;
        }
        if (results.length > 0) return results;
        return null;
      } catch (error) {
        if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw abortError();
        if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(DDGR_INSTALL_HINT);
        }
        lastError = `DuckDuckGo request failed (attempt ${attempt + 1}, ${ua}): ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    failedAttempts += 1;
  }

  throw new Error(
    `${lastError}. ${failedAttempts} serial attempt${failedAttempts === 1 ? "" : "s"} failed.`,
  );
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
      const command = resolveDdgrCommand(getAgentDir()) ?? "ddgr";
      const results = await serialize(
        () =>
          requestSearch(
            command,
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
        logger.info("no results found", { query: params.query, site: params.site, time: params.time });
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
      logger.error("search failed", { query: params.query, error: message });
      const text =
        message === DDGR_INSTALL_HINT
          ? DDGR_INSTALL_HINT
          : `Search failed: ${message}\nDuckDuckGo is temporarily unavailable; use another search method if one is available.`;
      return {
        content: [{ type: "text", text }],
        details: { error: message },
      };
    }
  },
});

/** Extension factory kept for parity with the upstream duckduckgo-search extension shape. */
export default function duckDuckGoSearchExtension(pi: ExtensionAPI): void {
  pi.registerTool(webSearchTool);
}