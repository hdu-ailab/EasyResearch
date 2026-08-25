import { Ellipsis, Pencil, Power } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/useI18n";

export interface SessionRowActionsProps {
  title: string;
  onRename: () => void;
  onDisconnect?: () => void;
  disconnecting?: boolean;
}

export function SessionRowActions({ title, onRename, onDisconnect, disconnecting = false }: SessionRowActionsProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const label = `${t("home.sessionActions")}: ${title}`;

  return (
    <div ref={rootRef} className="relative flex w-12 shrink-0 items-center justify-center self-stretch">
      <button
        type="button"
        aria-label={label}
        title={t("home.sessionActions")}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex size-8 items-center justify-center rounded-md text-v2-text-text-faint transition-colors hover:bg-v2-grey-200 hover:text-v2-text-text-base"
        onClick={() => setOpen((value) => !value)}
      >
        <Ellipsis size={17} aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={label}
          className="absolute right-2 top-[calc(50%+16px)] z-20 min-w-36 overflow-hidden rounded-lg bg-v2-background-bg-base p-1 shadow-[var(--v2-elevation-floating)]"
        >
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] text-v2-text-text-base hover:bg-v2-grey-100"
            onClick={() => {
              setOpen(false);
              onRename();
            }}
          >
            <Pencil size={14} aria-hidden />
            {t("home.rename")}
          </button>
          {onDisconnect && (
            <button
              type="button"
              role="menuitem"
              disabled={disconnecting}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] text-v2-status-error hover:bg-v2-status-error/5 disabled:cursor-wait disabled:opacity-50"
              onClick={() => {
                setOpen(false);
                onDisconnect();
              }}
            >
              <Power size={14} aria-hidden />
              {disconnecting ? "…" : t("home.disconnect")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
