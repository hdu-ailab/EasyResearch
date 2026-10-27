import { Download, Ellipsis, Pencil, Upload } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { FileEntryDto } from "../../../web/contracts";
import { downloadFileUrl } from "../api";
import { useI18n } from "../i18n/useI18n";

export function FileActionMenu({
  entry,
  onRename,
  onUpload,
}: {
  entry: FileEntryDto;
  onRename(): void;
  onUpload(): void;
}) {
  const { t } = useI18n();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const bounds = menu.current.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(rect.right - bounds.width, window.innerWidth - bounds.width - 8)),
      top: Math.max(8, Math.min(rect.bottom, window.innerHeight - bounds.height - 8)),
    });
    menu.current.querySelector<HTMLElement>("[role=menuitem]")?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node))
        setOpen(false);
    };
    const hide = () => setOpen(false);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", hide);
    // The anchor can move in either scrolling pane.
    window.addEventListener("scroll", hide, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", hide);
      window.removeEventListener("scroll", hide, true);
    };
  }, [open]);
  const itemClass = "flex w-full items-center gap-2 rounded px-3 py-2 text-left text-[13px] hover:bg-v2-grey-100";
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="er-icon-button shrink-0"
        aria-label={t("files.actions").replace("{name}", entry.name)}
        title={t("files.actions").replace("{name}", entry.name)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <Ellipsis size={14} aria-hidden />
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            id={id}
            role="menu"
            aria-label={t("files.actions").replace("{name}", entry.name)}
            className="fixed z-40 min-w-40 rounded-md border border-v2-grey-200 bg-v2-background-bg-base p-1 shadow-[var(--v2-elevation-overlay)]"
            style={position}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                close();
                return;
              }
              if (event.key === "Tab") {
                close();
                return;
              }
              const items = Array.from(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? []);
              const index = items.indexOf(document.activeElement as HTMLElement);
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? items.length - 1
                    : event.key === "ArrowDown"
                      ? (index + 1) % items.length
                      : event.key === "ArrowUp"
                        ? (index + items.length - 1) % items.length
                        : null;
              if (next !== null) {
                event.preventDefault();
                items[next]?.focus();
              }
            }}
          >
            {entry.kind === "directory" ? (
              <button
                type="button"
                role="menuitem"
                className={itemClass}
                onClick={() => {
                  close();
                  onUpload();
                }}
              >
                <Upload size={14} aria-hidden />
                {t("files.uploadHere")}
              </button>
            ) : (
              <>
                <a
                  role="menuitem"
                  className={itemClass}
                  href={downloadFileUrl(entry.path)}
                  download={entry.name}
                  onClick={close}
                >
                  <Download size={14} aria-hidden />
                  {t("files.download")}
                </a>
                <button
                  type="button"
                  role="menuitem"
                  className={itemClass}
                  onClick={() => {
                    close();
                    onRename();
                  }}
                >
                  <Pencil size={14} aria-hidden />
                  {t("files.rename")}
                </button>
              </>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
