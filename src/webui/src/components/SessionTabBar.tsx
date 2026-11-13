import { Plus, X } from "lucide-react";
import {
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n/useI18n";
import { type SessionTabItem, sessionPanelDomId, sessionTabDomId } from "../session-tabs";
import "./SessionTabBar.css";

export interface SessionTabBarProps {
  tabs: readonly SessionTabItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onReorder?: (fromId: string, toId: string) => void;
  disabled?: boolean;
  newDisabled?: boolean;
  newPending?: boolean;
  newLabel?: string;
  idPrefix?: string;
}

interface Drag {
  id: string;
  to: string;
  pointerId: number;
  startX: number;
  dragging: boolean;
  element: HTMLButtonElement;
}

/** Adjust only this strip, never scrollIntoView's document/chat ancestors. */
function reveal(strip: HTMLDivElement | null, element: HTMLElement | undefined) {
  if (!strip || !element) return;
  const viewport = strip.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  if (viewport.width <= 0) return;
  if (rect.width > viewport.width) {
    strip.scrollLeft += rect.left - viewport.left;
    return;
  }
  if (rect.left < viewport.left) strip.scrollLeft += rect.left - viewport.left;
  else if (rect.right > viewport.right) strip.scrollLeft += rect.right - viewport.right;
}

function TabTooltip({
  id,
  name,
  cwd,
  anchor,
  strip,
  onHide,
  popupRef: ref,
  onPointerEnter,
  onPointerLeave,
}: {
  id: string;
  name: string;
  cwd: string;
  anchor: HTMLElement;
  strip: HTMLElement;
  onHide: () => void;
  popupRef: RefObject<HTMLDivElement | null>;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}) {
  const [position, setPosition] = useState<{ left: number; top: number; maxWidth: number; maxHeight: number } | null>(
    null,
  );
  const initial = useRef(anchor.getBoundingClientRect());
  const hideRef = useRef(onHide);
  hideRef.current = onHide;

  useLayoutEffect(() => {
    const popup = ref.current;
    if (!popup) return;
    const rect = anchor.getBoundingClientRect();
    const viewport = window.visualViewport;
    const x = viewport?.offsetLeft ?? 0;
    const y = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? window.innerWidth;
    const height = viewport?.height ?? window.innerHeight;
    const maxWidth = Math.max(0, Math.min(480, width - 16));
    popup.style.maxWidth = `${maxWidth}px`;
    popup.style.maxHeight = `${Math.max(0, height - 16)}px`;
    const below = Math.max(y + 8, Math.min(rect.bottom + 6, y + height - 8));
    const above = Math.max(y + 8, Math.min(rect.top - 6, y + height - 8));
    const belowSpace = y + height - 8 - below;
    const aboveSpace = above - y - 8;
    const placeBelow = popup.getBoundingClientRect().height <= belowSpace || belowSpace >= aboveSpace;
    const maxHeight = Math.max(0, placeBelow ? belowSpace : aboveSpace);
    popup.style.maxHeight = `${maxHeight}px`;
    const size = popup.getBoundingClientRect();
    const left = Math.max(x + 8, Math.min(rect.left, x + width - Math.min(size.width, maxWidth) - 8));
    const top = placeBelow ? below : above - Math.min(size.height, maxHeight);
    setPosition((current) =>
      current?.left === left && current.top === top && current.maxWidth === maxWidth && current.maxHeight === maxHeight
        ? current
        : { left, top, maxWidth, maxHeight },
    );
  });

  useLayoutEffect(() => {
    const rect = anchor.getBoundingClientRect();
    const previous = initial.current;
    if (rect.left !== previous.left || rect.top !== previous.top || rect.width !== previous.width) onHide();
  });

  useEffect(() => {
    const hide = () => hideRef.current();
    const onScroll = (event: Event) => {
      // Scrolling long metadata is local reading, not strip/document movement.
      if (event.target instanceof Node && ref.current?.contains(event.target)) return;
      hide();
    };
    // The first ResizeObserver delivery is not a reflow. Compare the measured
    // geometry, including siblings that can move the hovered tab without resizing it.
    const geometry = [strip, ...strip.children].map((element) => ({ element, rect: element.getBoundingClientRect() }));
    const observer = new ResizeObserver(() => {
      if (
        geometry.some(({ element, rect }) => {
          const next = element.getBoundingClientRect();
          return (
            next.left !== rect.left || next.top !== rect.top || next.width !== rect.width || next.height !== rect.height
          );
        })
      )
        hide();
    });
    observer.observe(strip);
    for (const { element } of geometry) observer.observe(element);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", hide);
    window.addEventListener("blur", hide);
    window.visualViewport?.addEventListener("resize", hide);
    window.visualViewport?.addEventListener("scroll", hide);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("blur", hide);
      window.visualViewport?.removeEventListener("resize", hide);
      window.visualViewport?.removeEventListener("scroll", hide);
    };
  }, [strip, ref]);

  return createPortal(
    <div
      ref={ref}
      id={id}
      role="tooltip"
      className="er-session-tab-tooltip"
      style={{
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        maxWidth: position?.maxWidth,
        maxHeight: position?.maxHeight,
        visibility: position ? "visible" : "hidden",
      }}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <div className="er-session-tab-tooltip-name">{name}</div>
      <div className="er-session-tab-tooltip-cwd">{cwd}</div>
    </div>,
    document.body,
  );
}

export function SessionTabBar({
  tabs,
  activeId,
  onSelect,
  onClose,
  onNew,
  onReorder,
  disabled = false,
  newDisabled = false,
  newPending = false,
  newLabel,
  idPrefix,
}: SessionTabBarProps) {
  const { t } = useI18n();
  const strip = useRef<HTMLDivElement>(null);
  const plus = useRef<HTMLButtonElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const slots = useRef(new Map<string, HTMLDivElement>());
  const [focusId, setFocusId] = useState(activeId ?? tabs[0]?.id ?? null);
  const [tooltipId, setTooltipId] = useState<string | null>(null);
  const tooltipDomId = useId();
  const prefix = idPrefix ?? tooltipDomId;
  const popup = useRef<HTMLDivElement>(null);
  const tooltipHideTimer = useRef<number | undefined>(undefined);
  const focusedTooltipId = useRef<string | null>(null);
  const hoveredPopupId = useRef<string | null>(null);
  const pointerFocus = useRef(false);
  const pointerFocusTimer = useRef<number | undefined>(undefined);
  const pendingFocus = useRef<{ closedId: string; targetId: string | null } | null>(null);
  const drag = useRef<Drag | null>(null);
  const suppressClick = useRef(false);
  const [dragPreview, setDragPreview] = useState<{ id: string; to: string } | null>(null);
  const isDragging = dragPreview !== null;
  const activeExists = tabs.some((tab) => tab.id === activeId);
  const tabOrder = JSON.stringify(tabs.map((tab) => tab.id));
  const rovingId = tabs.some((tab) => tab.id === focusId) ? focusId : activeExists ? activeId : (tabs[0]?.id ?? null);

  const cancelTooltipHide = useCallback(() => {
    window.clearTimeout(tooltipHideTimer.current);
    tooltipHideTimer.current = undefined;
  }, []);
  const hideTooltip = useCallback(() => {
    cancelTooltipHide();
    focusedTooltipId.current = null;
    hoveredPopupId.current = null;
    setTooltipId(null);
  }, [cancelTooltipHide]);
  function showTooltip(id: string, keyboard = false) {
    cancelTooltipHide();
    if (keyboard) focusedTooltipId.current = id;
    setTooltipId(id);
  }
  function leaveTooltip(id: string) {
    cancelTooltipHide();
    if (disabled) return;
    if (focusedTooltipId.current === id && slots.current.get(id)?.contains(document.activeElement)) return;
    // Allow crossing the six-pixel gap into long, scrollable metadata. This timer
    // can only close its own disclosure and never opens a delayed portal.
    tooltipHideTimer.current = window.setTimeout(() => {
      tooltipHideTimer.current = undefined;
      setTooltipId((current) => (current === id ? null : current));
    }, 200);
  }

  useLayoutEffect(() => {
    if (tooltipId && !tabs.some((tab) => tab.id === tooltipId)) hideTooltip();
  }, [tooltipId, tabs, hideTooltip]);

  useLayoutEffect(() => {
    setFocusId(activeId);
    if (activeId && activeExists) reveal(strip.current, slots.current.get(activeId));
  }, [activeId, activeExists]);

  useLayoutEffect(() => {
    const viewport = strip.current;
    if (!viewport || disabled) return;
    const reconcile = () => {
      if (activeId) reveal(viewport, slots.current.get(activeId));
    };
    // Slot sizes/order and container size can change without selecting a tab.
    // Never subscribe to scrolling itself: manual strip scrolling stays native.
    const observer = new ResizeObserver(reconcile);
    observer.observe(viewport);
    for (const id of JSON.parse(tabOrder) as string[]) {
      const slot = slots.current.get(id);
      if (slot) observer.observe(slot);
    }
    window.addEventListener("resize", reconcile);
    window.visualViewport?.addEventListener("resize", reconcile);
    document.fonts?.addEventListener("loadingdone", reconcile);
    reconcile();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", reconcile);
      window.visualViewport?.removeEventListener("resize", reconcile);
      document.fonts?.removeEventListener("loadingdone", reconcile);
    };
  }, [activeId, tabOrder, disabled]);

  useLayoutEffect(() => {
    if (disabled) {
      pendingFocus.current = null;
      return;
    }
    const pending = pendingFocus.current;
    if (!pending || tabs.some((tab) => tab.id === pending.closedId)) return;
    pendingFocus.current = null;
    const target = pending.targetId ? buttons.current.get(pending.targetId) : undefined;
    if (target && pending.targetId) {
      target.focus({ preventScroll: true });
      reveal(strip.current, slots.current.get(pending.targetId));
    } else plus.current?.focus({ preventScroll: true });
  }, [tabs, disabled]);

  const cancelDrag = useCallback(() => {
    const current = drag.current;
    drag.current = null;
    if (current?.element.hasPointerCapture?.(current.pointerId))
      current.element.releasePointerCapture(current.pointerId);
    setDragPreview(null);
  }, []);

  useLayoutEffect(() => {
    if (!disabled) return;
    hideTooltip();
    window.clearTimeout(pointerFocusTimer.current);
    pointerFocus.current = false;
    suppressClick.current = false;
    cancelDrag();
  }, [disabled, cancelDrag, hideTooltip]);

  useLayoutEffect(() => {
    const current = drag.current;
    if (current && (!tabs.some((tab) => tab.id === current.id) || !tabs.some((tab) => tab.id === current.to)))
      cancelDrag();
  }, [tabs, cancelDrag]);

  useEffect(() => {
    if (!isDragging) return;
    const cancel = () => cancelDrag();
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") cancel();
    };
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", key);
    };
  }, [isDragging, cancelDrag]);

  useEffect(
    () => () => {
      window.clearTimeout(pointerFocusTimer.current);
      window.clearTimeout(tooltipHideTimer.current);
      const current = drag.current;
      if (current?.element.hasPointerCapture?.(current.pointerId))
        current.element.releasePointerCapture(current.pointerId);
      drag.current = null;
    },
    [],
  );

  function close(id: string) {
    if (disabled) return;
    hideTooltip();
    const index = tabs.findIndex((tab) => tab.id === id);
    if (activeId === id || slots.current.get(id)?.contains(document.activeElement)) {
      pendingFocus.current = { closedId: id, targetId: tabs[index + 1]?.id ?? tabs[index - 1]?.id ?? null };
    }
    onClose(id);
  }

  function keyDown(event: KeyboardEvent<HTMLButtonElement>, id: string) {
    if (disabled) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    pointerFocus.current = false;
    if (event.key === "Escape") {
      hideTooltip();
      cancelDrag();
      return;
    }
    const disclosure = tooltipId === id ? popup.current : null;
    if (
      disclosure &&
      disclosure.scrollHeight > disclosure.clientHeight &&
      ["ArrowDown", "ArrowUp", "PageDown", "PageUp"].includes(event.key)
    ) {
      event.preventDefault();
      cancelTooltipHide();
      const direction = event.key === "ArrowDown" || event.key === "PageDown" ? 1 : -1;
      const distance = event.key.startsWith("Page") ? Math.max(40, disclosure.clientHeight - 24) : 40;
      disclosure.scrollTop = Math.max(
        0,
        Math.min(disclosure.scrollHeight - disclosure.clientHeight, disclosure.scrollTop + direction * distance),
      );
      return;
    }
    if (event.key === "Delete") {
      event.preventDefault();
      close(id);
      return;
    }
    const index = tabs.findIndex((tab) => tab.id === id);
    const nextIndex =
      event.key === "ArrowRight"
        ? (index + 1) % tabs.length
        : event.key === "ArrowLeft"
          ? (index - 1 + tabs.length) % tabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? tabs.length - 1
              : null;
    if (nextIndex === null) return; // Native buttons own Enter/Space activation.
    event.preventDefault();
    const next = tabs[nextIndex];
    if (!next) return;
    setFocusId(next.id);
    buttons.current.get(next.id)?.focus({ preventScroll: true });
    reveal(strip.current, slots.current.get(next.id));
  }

  function pointerDown(event: PointerEvent<HTMLButtonElement>, id: string) {
    if (disabled) return;
    suppressClick.current = false;
    if (!onReorder || event.button !== 0 || event.pointerType === "touch" || event.isPrimary === false) return;
    drag.current = {
      id,
      to: id,
      pointerId: event.pointerId,
      startX: event.clientX,
      dragging: false,
      element: event.currentTarget,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function pointerMove(event: PointerEvent<HTMLButtonElement>) {
    if (disabled) return;
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (!current.dragging && Math.abs(event.clientX - current.startX) < 4) return;
    current.dragging = true;
    suppressClick.current = true;
    hideTooltip();
    event.preventDefault();
    const viewport = strip.current?.getBoundingClientRect();
    if (strip.current && viewport) {
      if (event.clientX < viewport.left + 24) strip.current.scrollLeft -= 24;
      else if (event.clientX > viewport.right - 24) strip.current.scrollLeft += 24;
    }
    for (const tab of tabs) {
      const rect = slots.current.get(tab.id)?.getBoundingClientRect();
      if (rect && event.clientX >= rect.left && event.clientX <= rect.right) {
        current.to = tab.id;
        break;
      }
    }
    setDragPreview({ id: current.id, to: current.to });
  }

  const label = (tab: SessionTabItem) => tab.name || t("sessionTabs.untitled");
  const tooltip = tabs.find((tab) => tab.id === tooltipId);
  const anchor = tooltip ? slots.current.get(tooltip.id) : undefined;

  return (
    <div className="er-session-tabs" data-disabled={disabled || undefined}>
      <div ref={strip} role="tablist" aria-label={t("sessionTabs.label")} className="er-session-tabs-strip">
        {tabs.map((tab) => {
          const name = label(tab);
          const status = tab.error
            ? t("sessionTabs.error")
            : tab.loading
              ? t("sessionTabs.loading")
              : tab.status === "running"
                ? t("work.running")
                : tab.status === "idle"
                  ? t("work.idle")
                  : tab.status === "stopped"
                    ? t("work.stopped")
                    : tab.status;
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: this wrapper delegates hover and middle-close; its native buttons and Delete provide keyboard activation/close.
            <div
              key={tab.id}
              role="presentation"
              ref={(element) => {
                if (element) slots.current.set(tab.id, element);
                else slots.current.delete(tab.id);
              }}
              className="er-session-tab"
              data-active={activeId === tab.id}
              data-dragging={dragPreview?.id === tab.id || undefined}
              data-drop-target={(dragPreview?.to === tab.id && dragPreview.id !== tab.id) || undefined}
              onPointerDownCapture={() => {
                if (disabled) return;
                window.clearTimeout(pointerFocusTimer.current);
                pointerFocus.current = true;
                hideTooltip();
              }}
              onPointerUpCapture={() => {
                if (disabled) return;
                pointerFocusTimer.current = window.setTimeout(() => {
                  pointerFocus.current = false;
                }, 0);
              }}
              onPointerCancel={() => {
                pointerFocus.current = false;
              }}
              onPointerEnter={(event) => {
                if (
                  disabled ||
                  event.pointerType === "touch" ||
                  drag.current?.dragging ||
                  window.matchMedia?.("(hover: none), (pointer: coarse)").matches
                )
                  return;
                showTooltip(tab.id);
              }}
              onPointerLeave={() => leaveTooltip(tab.id)}
              onFocus={() => {
                if (!disabled && !pointerFocus.current) showTooltip(tab.id, true);
              }}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) {
                  focusedTooltipId.current = null;
                  if (hoveredPopupId.current !== tab.id) hideTooltip();
                }
              }}
              onMouseDown={(event) => {
                if (event.button === 1) event.preventDefault();
              }}
              onAuxClick={(event) => {
                if (event.button === 1) {
                  event.preventDefault();
                  close(tab.id);
                }
              }}
            >
              <button
                ref={(element) => {
                  if (element) buttons.current.set(tab.id, element);
                  else buttons.current.delete(tab.id);
                }}
                type="button"
                role="tab"
                id={sessionTabDomId(prefix, tab.id)}
                aria-controls={sessionPanelDomId(prefix, tab.id)}
                disabled={disabled}
                data-session-tab-id={tab.id}
                data-loading={tab.loading || undefined}
                data-error={tab.error || undefined}
                className="er-session-tab-select"
                aria-label={name}
                aria-description={status}
                aria-describedby={tooltipId === tab.id ? tooltipDomId : undefined}
                aria-selected={activeId === tab.id}
                aria-keyshortcuts={tooltipId === tab.id ? "Delete ArrowUp ArrowDown PageUp PageDown" : "Delete"}
                tabIndex={rovingId === tab.id ? 0 : -1}
                onFocus={() => {
                  if (!disabled) setFocusId(tab.id);
                }}
                onKeyDown={(event) => keyDown(event, tab.id)}
                onClick={(event) => {
                  if (disabled) return;
                  if (suppressClick.current && event.detail > 0) {
                    suppressClick.current = false;
                    return;
                  }
                  suppressClick.current = false;
                  hideTooltip();
                  onSelect(tab.id);
                }}
                onPointerDown={(event) => pointerDown(event, tab.id)}
                onPointerMove={pointerMove}
                onPointerUp={(event) => {
                  if (disabled) return;
                  const current = drag.current;
                  if (!current || current.pointerId !== event.pointerId) return;
                  if (current.dragging && current.id !== current.to) onReorder?.(current.id, current.to);
                  cancelDrag();
                }}
                onPointerCancel={cancelDrag}
                onLostPointerCapture={cancelDrag}
              >
                <span
                  aria-hidden="true"
                  className="er-session-tab-dot"
                  data-status={tab.error ? "error" : tab.loading ? "loading" : tab.status}
                />
                <span className="er-session-tab-name">{name}</span>
              </button>
              <button
                type="button"
                className="er-session-tab-close"
                disabled={disabled}
                tabIndex={-1}
                aria-label={t("sessionTabs.close").replace("{name}", name)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => close(tab.id)}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
      <button
        ref={plus}
        type="button"
        className="er-session-tabs-new"
        disabled={disabled || newDisabled || newPending}
        aria-busy={newPending || undefined}
        aria-label={newLabel ?? t("sessionTabs.new")}
        title={newLabel ?? t("sessionTabs.new")}
        onClick={() => {
          if (!disabled && !newDisabled && !newPending) onNew();
        }}
      >
        <Plus size={15} aria-hidden="true" />
      </button>
      {!disabled && tooltip && anchor && strip.current && (
        <TabTooltip
          key={tooltip.id}
          id={tooltipDomId}
          name={label(tooltip)}
          cwd={tooltip.cwd}
          anchor={anchor}
          strip={strip.current}
          popupRef={popup}
          onHide={hideTooltip}
          onPointerEnter={() => {
            hoveredPopupId.current = tooltip.id;
            cancelTooltipHide();
          }}
          onPointerLeave={() => {
            hoveredPopupId.current = null;
            leaveTooltip(tooltip.id);
          }}
        />
      )}
    </div>
  );
}
