import type { ReactNode } from "react";
import { useStudioUi } from "../../ui-version";

/** Keep each existing action and accessible name while changing only its visible glyph. */
export function ActionGlyph({
  children,
  label,
  compact = false,
}: {
  children: ReactNode;
  label: string;
  compact?: boolean;
}) {
  const studio = useStudioUi();
  if (!studio) return children;
  return (
    <span className="er-action-label" data-compact={compact || undefined}>
      {compact ? "×" : label}
    </span>
  );
}
