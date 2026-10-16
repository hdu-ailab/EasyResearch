import type { ReactNode } from "react";

/** Compact artwork with hover text; the enclosing control owns its accessible name. */
export function ActionGlyph({ children, label }: { children: ReactNode; label: string }) {
  return (
    <span className="er-action-glyph" title={label} aria-hidden>
      {children}
    </span>
  );
}
