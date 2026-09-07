import { memo, useEffect, useEffectEvent, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import { MermaidDiagram } from "./MermaidDiagram";
import { cancelMarkdown, canUseMarkdownWorker, requestMarkdown } from "./markdown/client";
import {
  getCompletedMarkdown,
  type PreparedMarkdownBlock,
  prepareMarkdownBlocks,
  setCompletedMarkdown,
} from "./markdown/render";

export interface MarkdownBlockProps {
  text: string;
  className?: string;
  scope?: string;
  cacheKey?: string;
  streaming?: boolean;
  onRendered?: () => void;
}

const remarkPlugins = [remarkGfm, remarkMath];
const rehypePlugins = [rehypeKatex];
const components = {
  a: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  code: ({ className: codeClassName, children }: React.ComponentProps<"code">) => {
    const language = codeClassName?.match(/language-(\w+)/)?.[1];
    if (language === "mermaid") {
      const source = String(children ?? "").replace(/\n$/, "");
      return <MermaidDiagram source={source} />;
    }
    return <code className={codeClassName}>{children}</code>;
  },
};

function SynchronousMarkdown({ text, className }: Pick<MarkdownBlockProps, "text" | "className">) {
  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

function MarkdownBlockComponent({
  text,
  className,
  scope,
  cacheKey,
  streaming = false,
  onRendered,
}: MarkdownBlockProps) {
  const markdownScope = scope;
  const markdownKey = cacheKey;
  const [rendered, setRendered] = useState<{ source: string; blocks: readonly PreparedMarkdownBlock[] } | null>(() =>
    markdownScope && markdownKey ? (getCompletedMarkdown(markdownScope, markdownKey, text) ?? null) : null,
  );
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const previous = useRef<readonly PreparedMarkdownBlock[]>(rendered?.blocks ?? []);
  const latestRevision = useRef(0);
  const notifyRendered = useEffectEvent(() => onRendered?.());

  useEffect(() => {
    if (!markdownScope || !markdownKey || !canUseMarkdownWorker()) return;
    const cached = getCompletedMarkdown(markdownScope, markdownKey, text);
    if (cached) {
      previous.current = cached.blocks;
      setRendered(cached);
      setFailedSource(null);
      return;
    }
    const request = requestMarkdown({ scope: markdownScope, key: markdownKey, source: text });
    latestRevision.current = request.revision;
    let active = true;
    void request.promise.then(
      (result) => {
        if (!active || latestRevision.current !== result.revision || result.source !== text) return;
        const blocks = prepareMarkdownBlocks(result.blocks, previous.current);
        previous.current = blocks;
        if (!streaming) setCompletedMarkdown(markdownScope, markdownKey, text, blocks);
        setRendered({ source: text, blocks });
        setFailedSource(null);
      },
      () => {
        if (active && latestRevision.current === request.revision) setFailedSource(text);
      },
    );
    return () => {
      active = false;
    };
  }, [markdownKey, markdownScope, streaming, text]);

  useEffect(() => {
    if (!markdownScope || !markdownKey) return;
    return () => cancelMarkdown(markdownScope, markdownKey);
  }, [markdownKey, markdownScope]);

  useEffect(() => {
    if (rendered?.source !== text) return;
    const frame = requestAnimationFrame(() => notifyRendered());
    return () => cancelAnimationFrame(frame);
  }, [rendered, text]);

  if (!markdownScope || !markdownKey || !canUseMarkdownWorker() || failedSource === text) {
    return <SynchronousMarkdown text={text} className={className} />;
  }
  const canReuse = rendered && (rendered.source === text || (streaming && text.startsWith(rendered.source)));
  const pendingText = canReuse ? text.slice(rendered.source.length) : text;
  return (
    <div className={className} data-markdown-root data-markdown-source-length={canReuse ? rendered.source.length : 0}>
      {canReuse ? rendered.blocks.map((block) => block.node) : null}
      {pendingText ? <div className="whitespace-pre-wrap">{pendingText}</div> : null}
    </div>
  );
}

export const MarkdownBlock = memo(MarkdownBlockComponent);
