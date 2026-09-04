import { isAbsolute, resolve } from "node:path";
import { chromium, type Page } from "@playwright/test";
import { createServer } from "vite";
import type { WorkBenchmarkMetrics } from "../src/webui/performance/probe";

interface Cli {
  output: string;
  repeats: number;
  cpu: number;
  compare?: string;
}

interface BenchmarkReport {
  schemaVersion: 1;
  context: { repeats: number; cpu: number; chrome: string };
  runs: WorkBenchmarkMetrics[];
  medians: WorkBenchmarkMetrics;
}

function parseArgs(args: string[]): Cli {
  const read = (name: string) => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  const output = read("--output");
  const compare = read("--compare");
  const repeats = Number(read("--repeats") ?? 3);
  const cpu = Number(read("--cpu") ?? 4);
  if (!output || !isAbsolute(output)) throw new Error("--output must be an absolute path");
  if (compare && !isAbsolute(compare)) throw new Error("--compare must be an absolute path");
  if (!Number.isSafeInteger(repeats) || repeats < 1) throw new Error("--repeats must be a positive integer");
  if (!Number.isFinite(cpu) || cpu < 1) throw new Error("--cpu must be at least 1");
  return { output, repeats, cpu, ...(compare ? { compare } : {}) };
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0);
}

function summarize(runs: WorkBenchmarkMetrics[]): WorkBenchmarkMetrics {
  const numberKeys = Object.keys(runs[0] ?? {}).filter(
    (key) => typeof runs[0]?.[key as keyof WorkBenchmarkMetrics] === "number",
  ) as (keyof WorkBenchmarkMetrics)[];
  const result: Record<string, unknown> = {};
  for (const key of numberKeys) {
    result[key] = median(runs.map((run) => run[key]).filter((value): value is number => typeof value === "number"));
  }
  result.finalTextExact = runs.every((run) => run.finalTextExact === true);
  const runtimeKeys = Object.keys(runs.find((run) => run.markdownRuntime)?.markdownRuntime ?? {}) as Array<
    keyof NonNullable<WorkBenchmarkMetrics["markdownRuntime"]>
  >;
  if (runtimeKeys.length > 0) {
    result.markdownRuntime = Object.fromEntries(
      runtimeKeys.map((key) => [
        key,
        median(
          runs
            .map((run) => run.markdownRuntime?.[key])
            .filter((value): value is number => typeof value === "number"),
        ),
      ]),
    );
  }
  return result as unknown as WorkBenchmarkMetrics;
}

function improvement(baseline: number, candidate: number): number {
  return baseline <= 0 ? 0 : ((baseline - candidate) / baseline) * 100;
}

async function runPage(page: Page, url: string) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.__easyresearchWorkBenchmark !== undefined);
    // A fresh Vite cache may optimize Worker-only dependencies and reload once.
    await page.waitForTimeout(4_000);
    await page.waitForFunction(() => window.__easyresearchWorkBenchmark !== undefined);
    try {
      return await page.evaluate(() => {
        const benchmark = window.__easyresearchWorkBenchmark;
        if (!benchmark) throw new Error("benchmark controller is missing");
        return benchmark.run();
      });
    } catch (error) {
      if (attempt === 0 && error instanceof Error && error.message.includes("Execution context was destroyed")) continue;
      throw error;
    }
  }
  throw new Error("benchmark page did not stabilize");
}

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  const configFile = resolve(import.meta.dir, "../src/webui/performance/vite.config.ts");
  const server = await createServer({ configFile });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("benchmark Vite server did not bind a TCP port");
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const runs: WorkBenchmarkMetrics[] = [];
  try {
    for (let index = 0; index < cli.repeats; index += 1) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: cli.cpu });
      runs.push(await runPage(page, `http://127.0.0.1:${address.port}`));
      await page.close();
    }
    const report: BenchmarkReport = {
      schemaVersion: 1,
      context: { repeats: cli.repeats, cpu: cli.cpu, chrome: browser.version() },
      runs,
      medians: summarize(runs),
    };
    await Bun.write(cli.output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`WORK_BENCHMARK ${JSON.stringify(report)}`);
    if (!cli.compare) return;
    const baseline = (await Bun.file(cli.compare).json()) as BenchmarkReport;
    const frameGain = improvement(baseline.medians.rafP95Ms, report.medians.rafP95Ms);
    const longTaskGain = improvement(baseline.medians.longTaskTimeMs, report.medians.longTaskTimeMs);
    console.log(`WORK_BENCHMARK_COMPARE ${JSON.stringify({ frameGain, longTaskGain })}`);
    if (!report.medians.finalTextExact) throw new Error("final streamed text did not match");
    if (report.medians.blankSamples !== 0) throw new Error("virtual transcript exposed a blank viewport");
    if (report.medians.stableRowReplacements !== 0) throw new Error("stable transcript rows were replaced");
    if (report.medians.stableMarkdownReplacements !== 0) throw new Error("stable Markdown subtrees were replaced");
    if (report.medians.maxMountedRows >= 80) throw new Error("virtual row bound was exceeded");
    if ((report.medians.markdownRuntime?.failures ?? 0) !== 0) throw new Error("Markdown worker degraded");
    if ((report.medians.markdownRuntime?.responses ?? 0) < 1) throw new Error("Markdown worker returned no results");
    if (frameGain < 30) throw new Error(`fast-scroll p95 improved only ${frameGain.toFixed(1)}%`);
    if (longTaskGain < 50) throw new Error(`Long Task time improved only ${longTaskGain.toFixed(1)}%`);
  } finally {
    await browser.close();
    await server.close();
  }
}

await main();
