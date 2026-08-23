import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useModalLayer } from "../hooks/useModalLayer";
import { useI18n } from "../i18n/useI18n";

export interface MarkdownEditorModalProps {
  title: string;
  filePath: string;
  content: string;
  saveLabel: string;
  busy?: boolean;
  onSave: (content: string) => void | Promise<void>;
  onClose: () => void;
  editorLabel?: string;
}

export function MarkdownEditorModal({
  title,
  filePath,
  content,
  saveLabel,
  busy = false,
  onSave,
  onClose,
  editorLabel,
}: MarkdownEditorModalProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(content);
  const close = () => {
    if (draft !== content && !window.confirm(t("settings.editor.discardConfirm"))) return;
    onClose();
  };
  const dialogRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const zIndex = useModalLayer(close, dialogRef);
  useEffect(() => editorRef.current?.focus(), []);

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-v2-grey-1200/30 p-3 sm:p-6" style={{ zIndex }}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-[min(900px,calc(100vh-24px))] w-full max-w-[1000px] flex-col overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-overlay)]"
      >
        <header className="flex items-center gap-3 border-b border-v2-grey-200 px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-[14px] font-semibold text-v2-text-text-base">{title}</h2>
            <p className="mt-0.5 truncate font-mono text-[11px] text-v2-text-text-muted">{filePath}</p>
          </div>
          <button
            type="button"
            aria-label={t("settings.editor.close")}
            className="ml-auto flex size-7 shrink-0 items-center justify-center rounded-md text-v2-icon-icon-muted hover:bg-v2-grey-100 hover:text-v2-icon-icon-base"
            onClick={close}
          >
            <X size={15} aria-hidden />
          </button>
        </header>
        <div className="min-h-0 flex-1 p-3 sm:p-4">
          <textarea
            ref={editorRef}
            aria-label={editorLabel ?? t("settings.editor.markdown")}
            className="h-[min(68vh,680px)] min-h-[320px] w-full resize-none rounded-md border border-v2-grey-200 bg-v2-background-bg-deep p-3 font-mono text-[12px] leading-[1.6] text-v2-text-text-base outline-none focus:border-v2-blue-600"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
          />
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-v2-grey-200 px-4 py-3">
          <button
            type="button"
            className="rounded-md px-3 py-1.5 text-[12px] text-v2-text-text-muted hover:bg-v2-grey-100"
            onClick={close}
          >
            {t("settings.editor.cancel")}
          </button>
          <button
            type="button"
            className="rounded-md bg-v2-grey-1100 px-3 py-1.5 text-[12px] text-v2-grey-50 disabled:opacity-50"
            disabled={busy}
            onClick={() => void onSave(draft)}
          >
            {busy ? t("settings.editor.saving") : saveLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}
