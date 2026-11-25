import { ChevronDown, LoaderCircle } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { canFocusElement } from "../../hooks/useModalLayer";
import { useI18n } from "../../i18n/useI18n";

export function SkillActionMenu({
  name,
  enabled,
  canDelete,
  busy,
  active,
  onEdit,
  onToggle,
  onDelete,
}: {
  name: string;
  enabled: boolean;
  canDelete: boolean;
  busy: boolean;
  active: boolean;
  onEdit(): void;
  onToggle(): void;
  onDelete(): void;
}) {
  const { t } = useI18n();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const anchorBounds = useRef<DOMRectReadOnly | null>(null);
  const enter = useRef<"first" | "last" | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const close = (restore = true) => {
    if (restore && canFocusElement(trigger.current)) trigger.current.focus({ preventScroll: true });
    setOpen(false);
  };
  useLayoutEffect(() => {
    if (!active || busy) {
      setOpen(false);
      return;
    }
    if (!open || !trigger.current || !menu.current) return;
    const rect = trigger.current.getBoundingClientRect();
    anchorBounds.current = rect;
    const bounds = menu.current.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(rect.right - bounds.width, window.innerWidth - bounds.width - 8)),
      top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - bounds.height - 8)),
    });
    if (enter.current) {
      const items = menu.current.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
      (enter.current === "last" ? items.item(items.length - 1) : items.item(0))?.focus({ preventScroll: true });
      enter.current = null;
    }
  }, [active, open, busy]);
  useEffect(() => {
    if (!open || !active) return;
    const outside = (event: Event) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node))
        setOpen(false);
    };
    const hide = (event: Event) => {
      const anchor = trigger.current;
      const mayRestoreFocus = active && canFocusElement(anchor) && !anchor.disabled;
      if (event.type === "scroll" && mayRestoreFocus) {
        if (event.target instanceof Node && menu.current?.contains(event.target)) return;
        const rect = anchor.getBoundingClientRect();
        const positioned = anchorBounds.current;
        // A pre-open scroll can be delivered after positioning. Only actual
        // movement invalidates this menu, including size changes at its anchor.
        if (
          positioned &&
          rect.left === positioned.left &&
          rect.top === positioned.top &&
          rect.right === positioned.right &&
          rect.bottom === positioned.bottom
        )
          return;
      }
      if (menu.current?.contains(document.activeElement) && mayRestoreFocus) anchor.focus({ preventScroll: true });
      setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    window.addEventListener("resize", hide);
    window.addEventListener("scroll", hide, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
      window.removeEventListener("resize", hide);
      window.removeEventListener("scroll", hide, true);
    };
  }, [open, active]);
  const enterMenu = (last: boolean) => {
    enter.current = last ? "last" : "first";
    if (open) {
      const items = menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
      (last ? items?.item(items.length - 1) : items?.item(0))?.focus({ preventScroll: true });
      enter.current = null;
    } else setOpen(true);
  };
  const onDismissKey = (event: KeyboardEvent) => {
    if (!open || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Tab" && trigger.current) {
      // Exit at the trigger's ordinary tab position before removing the
      // focused menu item. Stay within the existing modal's focus boundary.
      const root = trigger.current?.closest('[role="dialog"]') ?? document;
      const candidates = Array.from(
        root.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, [tabindex]"),
      ).filter(
        (element) =>
          element.tabIndex >= 0 &&
          !element.matches(":disabled") &&
          !menu.current?.contains(element) &&
          canFocusElement(element),
      );
      const index = candidates.indexOf(trigger.current);
      const next = index + (event.shiftKey ? -1 : 1);
      const target = candidates[next] ?? (root !== document ? candidates.at(event.shiftKey ? -1 : 0) : undefined);
      if (target) {
        event.preventDefault();
        event.stopPropagation();
        target.focus({ preventScroll: true });
        setOpen(false);
      } else close();
    }
  };
  return (
    <div className="er-skill-actions">
      <button
        ref={trigger}
        type="button"
        className="er-skill-menu-trigger"
        aria-label={t("skills.actions").replace("{name}", name)}
        aria-haspopup="menu"
        aria-expanded={open && active}
        aria-controls={open && active ? id : undefined}
        aria-disabled={busy}
        onClick={(event) => {
          if (busy) return;
          enter.current = event.detail === 0 ? "first" : null;
          setOpen((value) => !value);
        }}
        onKeyDown={(event) => {
          onDismissKey(event);
          if (busy || event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            enterMenu(event.key === "ArrowUp");
          }
        }}
      >
        {busy ? <LoaderCircle size={16} aria-hidden /> : <ChevronDown size={16} aria-hidden />}
      </button>
      {open && active && (
        <div
          ref={menu}
          id={id}
          role="menu"
          aria-label={t("skills.actions").replace("{name}", name)}
          className="er-skill-menu"
          style={position}
          onKeyDown={(event) => {
            onDismissKey(event);
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
            const current = items.indexOf(document.activeElement as HTMLButtonElement);
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? items.length - 1
                  : event.key === "ArrowDown"
                    ? (current + 1) % items.length
                    : event.key === "ArrowUp"
                      ? (current + items.length - 1) % items.length
                      : null;
            if (next !== null) {
              event.preventDefault();
              event.stopPropagation();
              items[next]?.focus({ preventScroll: true });
            }
          }}
        >
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            aria-label={t("settings.resources.editSkill").replace("{name}", name)}
            onClick={() => {
              close();
              onEdit();
            }}
          >
            {t("studio.edit")}
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            onClick={() => {
              close();
              onToggle();
            }}
          >
            {t(enabled ? "skills.disable" : "skills.enable")}
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            disabled={!canDelete}
            aria-describedby={!canDelete ? `${id}-reason` : undefined}
            onClick={() => {
              close();
              onDelete();
            }}
          >
            {t("studio.delete")}
          </button>
          {!canDelete && <p id={`${id}-reason`}>{t("skills.deleteUnavailable")}</p>}
        </div>
      )}
    </div>
  );
}
