import { Ellipsis, Pencil, Trash2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { useI18n } from "../i18n/useI18n";

export function WorkspaceMenu({ cwd, onRename, onDelete }: { cwd: string; onRename(): void; onDelete(): void }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node) && ref.current) ref.current.open = false;
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  const select = (action: () => void) => {
    if (ref.current) {
      ref.current.open = false;
      ref.current.querySelector("summary")?.focus();
    }
    action();
  };
  return (
    <details
      ref={ref}
      className="er-workspace-menu relative shrink-0"
      onKeyDown={(event) => {
        if (event.key === "Escape" && ref.current?.open) {
          event.preventDefault();
          ref.current.open = false;
          ref.current.querySelector("summary")?.focus();
        }
      }}
    >
      <summary
        className="er-icon-button cursor-pointer list-none"
        aria-label={`${t("workspace.actions")}: ${cwd}`}
        title={t("workspace.actions")}
      >
        <Ellipsis size={16} aria-hidden />
      </summary>
      <div className="absolute right-0 top-full z-40 min-w-[180px] rounded-md border border-v2-grey-200 bg-v2-background-bg-base p-1 shadow-[var(--v2-elevation-overlay)]">
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-[13px] hover:bg-v2-grey-100"
          onClick={() => select(onRename)}
        >
          <Pencil size={14} aria-hidden />
          {t("workspace.rename")}
        </button>
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-[13px] text-v2-status-error hover:bg-v2-grey-100"
          onClick={() => select(onDelete)}
        >
          <Trash2 size={14} aria-hidden />
          {t("workspace.delete")}
        </button>
      </div>
    </details>
  );
}
