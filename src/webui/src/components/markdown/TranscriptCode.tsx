import { Sparkles, Terminal } from "lucide-react";
import type { ComponentProps } from "react";
import { MermaidDiagram } from "../MermaidDiagram";

export function TranscriptCode({
  className,
  children,
  "data-inline-kind": kind,
}: ComponentProps<"code"> & { "data-inline-kind"?: string }) {
  if (className?.match(/language-(\w+)/)?.[1] === "mermaid") {
    return <MermaidDiagram source={String(children ?? "").replace(/\n$/, "")} />;
  }
  const Icon = kind === "skill" ? Sparkles : kind === "command" ? Terminal : null;
  return (
    <code className={className} data-inline-kind={kind}>
      {Icon ? <Icon size={12} className="mr-1 inline-block align-[-2px] text-v2-text-text-faint" aria-hidden /> : null}
      {children}
    </code>
  );
}
