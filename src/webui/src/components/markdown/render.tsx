import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { type ComponentProps, Fragment, type ReactNode } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
import { defaultUrlTransform } from "react-markdown";
import { recordMarkdownRuntimeMetric } from "./client";
import { LruCache } from "./lru";
import type { MarkdownWorkerBlock } from "./protocol";
import { MarkdownSpan } from "./TextMotion";
import { TranscriptCode } from "./TranscriptCode";
import { TranscriptFileLink } from "./TranscriptFileLink";
import { prepareTextNodes } from "./text-nodes";

export interface PreparedMarkdownBlock {
  key: string;
  signature: string;
  prose: string;
  node: ReactNode;
}

export interface CachedMarkdown {
  source: string;
  blocks: readonly PreparedMarkdownBlock[];
}

const completed = new LruCache<string, CachedMarkdown>(200, () => recordMarkdownRuntimeMetric("evictions"));

function TranscriptImage({ src, alt, ...props }: ComponentProps<"img">) {
  const safe = typeof src === "string" ? defaultUrlTransform(src) : undefined;
  return <img {...props} src={safe || undefined} alt={alt ?? ""} />;
}

const components = {
  a: TranscriptFileLink,
  code: TranscriptCode,
  img: TranscriptImage,
  span: MarkdownSpan,
};

export function prepareMarkdownBlocks(
  blocks: readonly MarkdownWorkerBlock[],
  previous: readonly PreparedMarkdownBlock[] = [],
): readonly PreparedMarkdownBlock[] {
  const reusable = new Map(previous.map((block) => [block.key, block]));
  return blocks.map((block, index) => {
    // Appending source keeps its structural slots. Signatures decide whether the
    // prepared value is reusable, never whether React must destroy the live slot.
    const key = `block:${index}`;
    const prior = reusable.get(key);
    if (prior?.signature === block.signature) return prior;
    const { tree, prose } = prepareTextNodes(block.tree);
    const rendered = toJsxRuntime(tree, {
      Fragment,
      jsx,
      jsxs,
      components,
      passKeys: true,
    });
    return { key, signature: block.signature, prose, node: <Fragment key={key}>{rendered}</Fragment> };
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
