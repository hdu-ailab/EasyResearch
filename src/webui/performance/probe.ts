import type { MarkdownRuntimeMetrics } from "../src/components/markdown/client";

export interface WorkProbeSamples {
  frameGaps: number[];
  longTasks: number[];
  blankSamples: number;
  mountedRows: number[];
  stableRowReplacements: number;
  stableMarkdownReplacements: number;
}

export interface WorkBenchmarkMetrics {
  rafP50Ms: number;
  rafP95Ms: number;
  rafP99Ms: number;
  rafGapsOver33Ms: number;
  rafGapsOver50Ms: number;
  longTaskCount: number;
  longTaskTimeMs: number;
  blankSamples: number;
  maxMountedRows: number;
  stableRowReplacements: number;
  stableMarkdownReplacements: number;
  finalTextExact?: boolean;
  markdownRuntime?: MarkdownRuntimeMetrics;
}

function percentile(values: number[], value: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * value))] ?? 0;
}

export function summarizeWorkSamples(samples: WorkProbeSamples): WorkBenchmarkMetrics {
  return {
    rafP50Ms: percentile(samples.frameGaps, 0.5),
    rafP95Ms: percentile(samples.frameGaps, 0.95),
    rafP99Ms: percentile(samples.frameGaps, 0.99),
    rafGapsOver33Ms: samples.frameGaps.filter((value) => value > 33.34).length,
    rafGapsOver50Ms: samples.frameGaps.filter((value) => value > 50).length,
    longTaskCount: samples.longTasks.length,
    longTaskTimeMs: samples.longTasks.reduce((total, value) => total + value, 0),
    blankSamples: samples.blankSamples,
    maxMountedRows: Math.max(0, ...samples.mountedRows),
    stableRowReplacements: samples.stableRowReplacements,
    stableMarkdownReplacements: samples.stableMarkdownReplacements,
  };
}

interface Probe {
  sample(): void;
  finish(): WorkBenchmarkMetrics;
}

function visibleRows(viewport: HTMLElement): HTMLElement[] {
  return [...viewport.querySelectorAll<HTMLElement>("[data-row-key]")].filter((row) => {
    const wrapper = row.parentElement;
    const top = wrapper ? Number.parseFloat(wrapper.style.top) : Number.NaN;
    if (!Number.isFinite(top)) return false;
    const height = row.getBoundingClientRect().height;
    return top + height > viewport.scrollTop && top < viewport.scrollTop + viewport.clientHeight;
  });
}

export function createWorkProbe(viewport: HTMLElement): Probe {
  const samples: WorkProbeSamples = {
    frameGaps: [],
    longTasks: [],
    blankSamples: 0,
    mountedRows: [],
    stableRowReplacements: 0,
    stableMarkdownReplacements: 0,
  };
  let previousRows = new Map<string, HTMLElement>();
  let previousMarkdown = new Map<string, Element>();
  let previousFrame: number | undefined;
  let running = true;
  let frame = 0;

  const observer =
    typeof PerformanceObserver === "undefined"
      ? undefined
      : new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) samples.longTasks.push(entry.duration);
        });
  try {
    observer?.observe({ type: "longtask", buffered: false });
  } catch {
    observer?.disconnect();
  }

  const tick = (now: number) => {
    if (!running) return;
    if (previousFrame !== undefined) samples.frameGaps.push(now - previousFrame);
    previousFrame = now;
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);

  return {
    sample() {
      const mounted = [...viewport.querySelectorAll<HTMLElement>("[data-row-key]")];
      const visible = visibleRows(viewport);
      samples.mountedRows.push(mounted.length);
      if (visible.length === 0) samples.blankSamples += 1;

      const nextRows = new Map<string, HTMLElement>();
      const nextMarkdown = new Map<string, Element>();
      for (const row of visible) {
        const key = row.dataset.rowKey;
        if (!key) continue;
        nextRows.set(key, row);
        const prior = previousRows.get(key);
        if (prior && prior !== row) samples.stableRowReplacements += 1;
        const markdown = row.querySelector(".v2-md > div, .v2-md[data-component='markdown'], [data-markdown-root]");
        if (!markdown) continue;
        nextMarkdown.set(key, markdown);
        const previous = previousMarkdown.get(key);
        if (previous && previous !== markdown) samples.stableMarkdownReplacements += 1;
      }
      previousRows = nextRows;
      previousMarkdown = nextMarkdown;
    },
    finish() {
      running = false;
      cancelAnimationFrame(frame);
      observer?.disconnect();
      return summarizeWorkSamples(samples);
    },
  };
}
