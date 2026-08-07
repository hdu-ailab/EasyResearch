import { useEffect, useState } from "react";
import mermaid from "mermaid";

export interface MermaidDiagramProps {
  source: string;
}

let initialized = false;

export function MermaidDiagram({ source }: MermaidDiagramProps) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!initialized) {
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
      initialized = true;
    }
    const id = `mermaid-${crypto.randomUUID()}`;
    mermaid
      .render(id, source)
      .then(({ svg: rendered }) => {
        if (!cancelled) setSvg(rendered);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [source]);

  if (error) {
    return <pre className="whitespace-pre-wrap font-mono text-[12px] text-v2-text-text-muted">{source}</pre>;
  }
  if (!svg) {
    return <div className="v2-md animate-pulse text-v2-text-text-faint">…</div>;
  }
  return <div className="v2-md" dangerouslySetInnerHTML={{ __html: svg }} />;
}
