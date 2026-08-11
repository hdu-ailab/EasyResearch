import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import { rawFileUrl } from "../../api";
import { MermaidDiagram } from "../MermaidDiagram";
import { resolveLocalPreviewPath } from "./preview-paths";

export interface MarkdownPreviewProps {
  path: string;
  content: string;
  onOpenFile: (path: string) => void;
}

/**
 * Safe document Markdown preview: GFM, math (KaTeX), fenced code, tables, and
 * task lists. Raw HTML is never rendered (no `rehype-raw`). Relative links and
 * images resolve against the document's directory and stream through the raw
 * bytes endpoint; internal links dispatch through `onOpenFile` and external
 * links open in a new tab.
 */
export function MarkdownPreview({ path, content, onOpenFile }: MarkdownPreviewProps) {
  const components = useMemo(
    () => ({
      a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
        if (href?.startsWith("#")) {
          return <a href={href}>{children}</a>;
        }
        const local = href ? resolveLocalPreviewPath(path, href) : null;
        if (local) {
          return (
            <a
              href={rawFileUrl(local)}
              onClick={(event) => {
                event.preventDefault();
                onOpenFile(local);
              }}
            >
              {children}
            </a>
          );
        }
        return (
          <a href={href} target="_blank" rel="noreferrer noopener">
            {children}
          </a>
        );
      },
      img: ({ src, alt }: { src?: string; alt?: string }) => {
        const local = src ? resolveLocalPreviewPath(path, src) : null;
        return <img src={local ? rawFileUrl(local) : src} alt={alt ?? ""} />;
      },
      code: ({ className: codeClassName, children }: { className?: string; children?: React.ReactNode }) => {
        const language = codeClassName?.match(/language-(\w+)/)?.[1];
        if (language === "mermaid") {
          const source = String(children ?? "").replace(/\n$/, "");
          return <MermaidDiagram source={source} />;
        }
        return <code className={codeClassName}>{children}</code>;
      },
    }),
    [path, onOpenFile],
  );

  return (
    <div className="v2-document min-h-0 flex-1 overflow-auto p-4">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
