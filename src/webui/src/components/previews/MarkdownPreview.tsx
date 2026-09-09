import type { Element, Nodes, Root } from "hast";
import { type ComponentPropsWithoutRef, useId, useMemo, useRef } from "react";
import ReactMarkdown, { type ExtraProps } from "react-markdown";
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

function previewIds({ prefix }: { prefix: string }) {
  return (tree: Root) => {
    const used = new Map<string, number>();
    const elements: Element[] = [];
    const text = (node: Nodes): string =>
      node.type === "text" ? node.value : "children" in node ? node.children.map(text).join("") : "";
    const visit = (node: Nodes) => {
      if (node.type === "element") {
        elements.push(node);
        if (typeof node.properties.id === "string") used.set(node.properties.id, 0);
      }
      if ("children" in node) node.children.forEach(visit);
    };
    visit(tree);
    for (const node of elements) {
      if (typeof node.properties.id === "string") {
        node.properties.id = `${prefix}${node.properties.id}`;
      } else if (/^h[1-6]$/.test(node.tagName)) {
        const base = text(node)
          .toLowerCase()
          .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
          .replace(/\s/g, "-");
        let id = base;
        while (used.has(id)) {
          const suffix = (used.get(base) ?? 0) + 1;
          used.set(base, suffix);
          id = `${base}-${suffix}`;
        }
        used.set(id, 0);
        node.properties.id = `${prefix}${id}`;
      }
      for (const property of ["ariaDescribedBy", "ariaLabelledBy"]) {
        const ids = node.properties[property];
        if (Array.isArray(ids)) node.properties[property] = ids.map((id) => `${prefix}${id}`);
      }
    }
  };
}

/**
 * Safe document Markdown preview: GFM, math (KaTeX), fenced code, tables, and
 * task lists. Raw HTML is never rendered (no `rehype-raw`). Relative links and
 * images resolve against the document's directory and stream through the raw
 * bytes endpoint; internal links dispatch through `onOpenFile` and external
 * links open in a new tab.
 */
export function MarkdownPreview({ path, content, onOpenFile }: MarkdownPreviewProps) {
  const documentRef = useRef<HTMLDivElement>(null);
  const prefix = `preview-${useId()}-`;
  const components = useMemo(
    () => ({
      a: ({ href, children, node: _node, ...props }: ComponentPropsWithoutRef<"a"> & ExtraProps) => {
        const local = href ? resolveLocalPreviewPath(path, href) : null;
        if (href?.startsWith("#") || (local === path && href?.includes("#"))) {
          const fragment = href.slice(href.indexOf("#") + 1);
          return (
            <a
              {...props}
              href={`#${prefix}${fragment}`}
              onClick={(event) => {
                event.preventDefault();
                const document = documentRef.current;
                if (!document) return;
                if (!fragment) {
                  document.scrollTop = 0;
                  return;
                }
                // Search only this preview, without interpolating untrusted selector text.
                const targets = Array.from(document.querySelectorAll<HTMLElement>("[id]"));
                // GFM IDs can contain literal escapes or %, so pipeline identity wins.
                let target = targets.find((node) => node.id === prefix + fragment);
                if (!target) {
                  try {
                    const id = prefix + decodeURIComponent(fragment);
                    target = targets.find((node) => node.id === id);
                  } catch {
                    return;
                  }
                }
                if (target)
                  document.scrollTop +=
                    target.getBoundingClientRect().top - document.getBoundingClientRect().top - document.clientTop;
              }}
            >
              {children}
            </a>
          );
        }
        if (local) {
          return (
            <a
              {...props}
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
          <a {...props} href={href} target="_blank" rel="noreferrer noopener">
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
    [path, onOpenFile, prefix],
  );

  return (
    <div ref={documentRef} className="v2-document min-h-0 flex-1 overflow-auto p-4">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[previewIds, { prefix }], rehypeKatex]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
