import { useState } from "react";
import type { FileLineRange } from "../../../../web/file-reference-contracts";
import { useI18n } from "../../i18n/useI18n";
import { previewButtonClass } from "./PreviewToolbar";

export type PreviewMode = "preview" | "source";

/** A new explicit locator wins over the last manual mode, without replaying it on ordinary renders. */
export function usePreviewMode(selection?: FileLineRange, selectionKey?: number) {
  const token = JSON.stringify([selection?.start, selection?.end, selectionKey]);
  const [state, setState] = useState({ token, mode: selection ? ("source" as const) : ("preview" as PreviewMode) });
  const mode = state.token === token ? state.mode : selection ? "source" : state.mode;
  if (state.token !== token) setState({ token, mode });
  return [mode, (value: PreviewMode) => setState({ token, mode: value })] as const;
}

export function PreviewModeButtons({ mode, onChange }: { mode: PreviewMode; onChange: (mode: PreviewMode) => void }) {
  const { t } = useI18n();
  return (["preview", "source"] as const).map((value) => (
    <button
      key={value}
      type="button"
      className={`${previewButtonClass} aria-pressed:underline underline-offset-4`}
      aria-pressed={mode === value}
      onClick={() => onChange(value)}
    >
      {t(value === "preview" ? "preview.mode.preview" : "preview.mode.source")}
    </button>
  ));
}
