import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { type ComponentProps, Fragment, type ReactNode } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
import { defaultUrlTransform } from "react-markdown";
import { MermaidDiagram } from "../MermaidDiagram";
import { recordMarkdownRuntimeMetric } from "./client";
import { LruCache } from "./lru";
import type { MarkdownWorkerBlock } from "./protocol";

export interface PreparedMarkdownBlock {
  signature: string;
  occurrence: number;
  node: ReactNode;
}

export interface CachedMarkdown {
  source: string;
  blocks: readonly PreparedMarkdownBlock[];
}

const completed = new LruCache<string, CachedMarkdown>(200, () => recordMarkdownRuntimeMetric("evictions"));

function TranscriptCode({ className, children, ...props }: ComponentProps<"code">) {
  const language = className?.match(/language-(\w+)/)?.[1];
  if (language === "mermaid") {
    const source = String(children ?? "").replace(/\n$/, "");
    return <MermaidDiagram source={source} />;
  }
  return (
    <code className={className} {...props}>
      {children}
    </code>
  );
}

function TranscriptImage({ src, alt, ...props }: ComponentProps<"img">) {
  const safe = typeof src === "string" ? defaultUrlTransform(src) : undefined;
  return <img {...props} src={safe || undefined} alt={alt ?? ""} />;
}

const components = {
  a: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  code: TranscriptCode,
  img: TranscriptImage,
};

function occurrenceKey(signature: string, occurrence: number): string {
  return `${signature}:${occurrence}`;
}

export function prepareMarkdownBlocks(
  blocks: readonly MarkdownWorkerBlock[],
  previous: readonly PreparedMarkdownBlock[] = [],
): readonly PreparedMarkdownBlock[] {
  const reusable = new Map(previous.map((block) => [occurrenceKey(block.signature, block.occurrence), block]));
  const occurrences = new Map<string, number>();
  return blocks.map((block) => {
    const occurrence = occurrences.get(block.signature) ?? 0;
    occurrences.set(block.signature, occurrence + 1);
    const key = occurrenceKey(block.signature, occurrence);
    const prior = reusable.get(key);
    if (prior) return prior;
    const rendered = toJsxRuntime(block.tree, {
      Fragment,
      jsx,
      jsxs,
      components,
      passKeys: true,
    });
    return { signature: block.signature, occurrence, node: <Fragment key={key}>{rendered}</Fragment> };
  });
}

const cacheKey = (scope: string, key: string) => `${scope}\0${key}`;

export function getCompletedMarkdown(scope: string, key: string, source: string): CachedMarkdown | undefined {
  const value = completed.get(cacheKey(scope, key));
  if (!value || value.source !== source) {
    recordMarkdownRuntimeMetric("cacheMisses");
    return undefined;
  }
  recordMarkdownRuntimeMetric("cacheHits");
  return value;
}

export function setCompletedMarkdown(
  scope: string,
  key: string,
  source: string,
  blocks: readonly PreparedMarkdownBlock[],
): void {
  completed.set(cacheKey(scope, key), { source, blocks });
}

export function clearCompletedMarkdownCacheForTests(): void {
  completed.clear();
}
