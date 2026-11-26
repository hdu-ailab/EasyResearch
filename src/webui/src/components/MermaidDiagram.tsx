import { useEffect, useState } from "react";

export interface MermaidDiagramProps {
  source: string;
}

type MermaidRuntime = typeof import("mermaid")["default"];

let mermaidPromise: Promise<MermaidRuntime> | null = null;
let initialized = false;
// Mermaid uses this as a DOM/render identity, not a capability. Each render needs
// a fresh ID even when an earlier async render for this component is still pending.
let diagramSequence = 0;

function loadMermaid(): Promise<MermaidRuntime> {
  mermaidPromise ??= import("mermaid").then((module) => module.default);
  return mermaidPromise;
}

export function MermaidDiagram({ source }: MermaidDiagramProps) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const id = `mermaid-${++diagramSequence}`;
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
        if (!cancelled && result) {
          setSvg(result.svg);
          setError(null);
        }
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
  // Mermaid is initialized with securityLevel="strict" above; its SVG output is the trusted render result.
  // biome-ignore lint/security/noDangerouslySetInnerHtml: Mermaid strict-mode output must be mounted as SVG markup.
  return <div className="er-rendered-diagram v2-md" dangerouslySetInnerHTML={{ __html: svg }} />;
}
