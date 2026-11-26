import { memo, useEffect, useEffectEvent } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import { canUseMarkdownWorker } from "./markdown/client";
import { rehypeFileReferences } from "./markdown/file-references";
import { MarkdownMotionSource, MarkdownSpan, MarkdownTextMotion, MarkdownTextOffset } from "./markdown/TextMotion";
import { TranscriptCode } from "./markdown/TranscriptCode";
import { FileReferenceSettledContext, TranscriptFileLink } from "./markdown/TranscriptFileLink";
import { rehypeTextMotion } from "./markdown/text-nodes";
import { usePreparedMarkdown } from "./markdown/usePreparedMarkdown";

export interface MarkdownBlockProps {
  text: string;
  className?: string;
  scope?: string;
  cacheKey?: string;
  streaming?: boolean;
  animateText?: boolean;
  onRendered?: () => void;
}

const remarkPlugins = [remarkGfm, remarkMath];
const rehypePlugins = [rehypeKatex, rehypeFileReferences, rehypeTextMotion];
const components = {
  a: TranscriptFileLink,
  code: TranscriptCode,
  span: MarkdownSpan,
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
  animateText = false,
  onRendered,
}: MarkdownBlockProps) {
  const { rendered, generation, failed } = usePreparedMarkdown(scope, cacheKey, text, streaming);
  const notifyRendered = useEffectEvent(() => onRendered?.());

  useEffect(() => {
    if (!rendered) return;
    const frame = requestAnimationFrame(() => notifyRendered());
    return () => cancelAnimationFrame(frame);
  }, [rendered]);

  if (!scope || !cacheKey || !canUseMarkdownWorker() || failed) {
    return (
      <FileReferenceSettledContext value={!streaming}>
        <MarkdownMotionSource
          key={`${scope ?? ""}\0${cacheKey ?? ""}\0${generation}`}
          value={{ source: text, generation, enabled: animateText, streaming }}
        >
          <SynchronousMarkdown text={text} className={className} />
        </MarkdownMotionSource>
      </FileReferenceSettledContext>
    );
  }
  let offset = 0;
  return (
    <FileReferenceSettledContext value={!streaming && rendered?.source === text}>
      <div className={className} data-markdown-root data-markdown-source-length={rendered?.source.length ?? 0}>
        {rendered ? (
          <MarkdownMotionSource
            key={`${scope}\0${cacheKey}\0${rendered.generation}`}
            value={{
              source: rendered.source,
              generation: rendered.generation,
              enabled: animateText,
              streaming,
              replacing: rendered.generation !== generation,
            }}
          >
            <MarkdownTextMotion prose={rendered.blocks.map((block) => block.prose).join("")}>
              {rendered.blocks.map((block) => {
                const start = offset;
                offset += block.prose.length;
                return (
                  <MarkdownTextOffset key={block.key} value={start}>
                    {block.node}
                  </MarkdownTextOffset>
                );
              })}
            </MarkdownTextMotion>
          </MarkdownMotionSource>
        ) : (
          <div className="whitespace-pre-wrap">{text}</div>
        )}
      </div>
    </FileReferenceSettledContext>
  );
}

export const MarkdownBlock = memo(MarkdownBlockComponent);
