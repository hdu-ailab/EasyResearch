import { useEffect, useState } from "react";

export interface MermaidDiagramProps {
  source: string;
}

type MermaidRuntime = typeof import("mermaid")["default"];

let mermaidPromise: Promise<MermaidRuntime> | null = null;
let initialized = false;

function loadMermaid(): Promise<MermaidRuntime> {
  mermaidPromise ??= import("mermaid").then((module) => module.default);
  return mermaidPromise;
}

export function MermaidDiagram({ source }: MermaidDiagramProps) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const id = `mermaid-${crypto.randomUUID()}`;
    loadMermaid()
      .then((mermaid) => {
        if (cancelled) return null;
        if (!initialized) {
          mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
          initialized = true;
        }
        return mermaid.render(id, source);
      })
      .then((result) => {
        if (!cancelled && result) setSvg(result.svg);
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
