import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import { MermaidDiagram } from "./MermaidDiagram";

export interface MarkdownBlockProps {
  text: string;
  className?: string;
}

export function MarkdownBlock({ text, className }: MarkdownBlockProps) {
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          a: ({ children }) => <span>{children}</span>,
          code: ({ className: codeClassName, children }) => {
            const language = codeClassName?.match(/language-(\w+)/)?.[1];
            if (language === "mermaid") {
              const source = String(children ?? "").replace(/\n$/, "");
              return <MermaidDiagram source={source} />;
            }
            return <code className={codeClassName}>{children}</code>;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
