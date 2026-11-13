import { ChevronDown, Search } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { canFocusElement } from "../hooks/useModalLayer";
import { useViewActivityRef } from "../view-activity";

export interface SearchableSelectOption {
  value: string;
  label: string;
}

export interface SearchableSelectProps {
  value: string;
  options: readonly SearchableSelectOption[];
  onSelect: (value: string) => void;
  ariaLabel: string;
  placeholder?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
}

const PANEL_MAX_HEIGHT = 168;
const FLIP_MARGIN = 8;

export function filterOptions(query: string, options: readonly SearchableSelectOption[]): SearchableSelectOption[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...options];
  return options.filter((option) => option.label.toLowerCase().includes(needle));
}

export function flipDirection(
  rect: { top: number; bottom: number },
  panelHeight: number,
  viewportHeight: number,
  margin = FLIP_MARGIN,
): "up" | "down" {
  const need = panelHeight + margin;
  const below = viewportHeight - rect.bottom;
  const above = rect.top;
  if (below >= need) return "down";
  if (above >= need) return "up";
  return below >= above ? "down" : "up";
}

export function SearchableSelect({
  value,
  options,
  onSelect,
  ariaLabel,
  placeholder,
  id,
  disabled,
  className,
  searchPlaceholder,
  emptyMessage,
}: SearchableSelectProps) {
  const activity = useViewActivityRef();
  const { interactive } = activity.current;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [direction, setDirection] = useState<"up" | "down">("down");
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const composing = useRef(false);
  const closeAfterTab = useRef(false);
  const hoverPosition = useRef<{ x: number; y: number } | null>(null);
  const hoverMove = useRef<MouseEvent | null>(null);
  const generatedId = useId().replaceAll(":", "");
  const panelId = `${id ?? `searchable-select-${generatedId}`}-listbox`;

  const current = options.find((option) => option.value === value);
  const shown = useMemo(() => filterOptions(query, options), [query, options]);
  const effectiveActiveIndex = Math.min(activeIndex, shown.length - 1);
  const activeOption = shown[effectiveActiveIndex];

  useLayoutEffect(() => {
    if (!open || !interactive) {
      composing.current = false;
      closeAfterTab.current = false;
      hoverPosition.current = null;
      hoverMove.current = null;
    }
    if (!interactive) {
      setOpen(false);
      return;
    }
    if (!open || !triggerRef.current) return;
    setDirection(flipDirection(triggerRef.current.getBoundingClientRect(), PANEL_MAX_HEIGHT, window.innerHeight));
    if (canFocusElement(inputRef.current)) inputRef.current.focus();
  }, [open, interactive]);

  useLayoutEffect(() => {
    const next = Math.max(0, effectiveActiveIndex);
    if (activeIndex !== next) setActiveIndex(next);
  }, [activeIndex, effectiveActiveIndex]);

  useLayoutEffect(() => {
    if (!open || !interactive || !shown[effectiveActiveIndex]) return;
    const list = listRef.current;
    const option = list?.children.item(effectiveActiveIndex);
    if (!list || !option || list.clientHeight === 0) return;
    const listRect = list.getBoundingClientRect();
    const optionRect = option.getBoundingClientRect();
    const top = listRect.top + list.clientTop;
    const bottom = top + list.clientHeight;
    // Adjust only the options scroller; scrollIntoView can also move the dialog/document.
    if (optionRect.top < top && optionRect.bottom > bottom) return;
    if (optionRect.top < top) list.scrollTop += optionRect.top - top;
    else if (optionRect.bottom > bottom) list.scrollTop += optionRect.bottom - bottom;
  }, [open, interactive, effectiveActiveIndex, shown]);

  useEffect(() => {
    if (!open || !interactive) return;
    const onPointerDown = (event: PointerEvent) => {
      if (triggerRef.current?.contains(event.target as Node)) return;
      if (panelRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (composing.current || event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") {
        setOpen(false);
        if (activity.current.interactive && canFocusElement(triggerRef.current)) triggerRef.current.focus();
      }
    };
    const onMouseMove = (event: MouseEvent) => {
      if (!activity.current.interactive) return;
      const previous = hoverPosition.current;
      hoverPosition.current = { x: event.clientX, y: event.clientY };
      hoverMove.current = !previous || previous.x !== event.clientX || previous.y !== event.clientY ? event : null;
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    // Observe outside movement too, before option handlers, so re-entry has a current baseline.
    document.addEventListener("mousemove", onMouseMove, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousemove", onMouseMove, true);
    };
  }, [open, interactive, activity]);

  const openPanel = (position: { x: number; y: number } | null = null) => {
    if (!activity.current.interactive) return;
    composing.current = false;
    closeAfterTab.current = false;
    hoverPosition.current = position;
    hoverMove.current = null;
    setQuery("");
    setActiveIndex(
      Math.max(
        0,
        options.findIndex((option) => option.value === value),
      ),
    );
    setOpen(true);
  };

  const choose = (option: SearchableSelectOption) => {
    if (!activity.current.interactive) return;
    setOpen(false);
    onSelect(option.value);
    if (canFocusElement(triggerRef.current)) triggerRef.current.focus();
  };

  const triggerRect = triggerRef.current?.getBoundingClientRect();

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={panelId}
        aria-haspopup="listbox"
        disabled={disabled}
        onClick={(event) => {
          if (open) setOpen(false);
          else openPanel(event.detail > 0 ? { x: event.clientX, y: event.clientY } : null);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openPanel();
          }
        }}
        className={`flex h-6 min-w-0 items-center gap-1 rounded-md border border-v2-grey-200 bg-v2-background-bg-base px-1 text-[11px] text-v2-text-text-base outline-none focus:border-v2-blue-600 disabled:opacity-50 ${className ?? ""}`}
      >
        <span className="min-w-0 flex-1 truncate text-left">{current?.label ?? placeholder ?? ""}</span>
        <ChevronDown size={12} className="shrink-0 text-v2-icon-icon-muted" aria-hidden />
      </button>

      {open && interactive && triggerRect ? (
        <div
          ref={panelRef}
          style={{
            position: "fixed",
            width: triggerRect.width,
            top: direction === "down" ? triggerRect.bottom + 4 : undefined,
            bottom: direction === "up" ? window.innerHeight - triggerRect.top + 4 : undefined,
            left: triggerRect.left,
          }}
          className="z-50 flex max-h-[168px] flex-col rounded-md bg-v2-background-bg-base p-1 shadow-[var(--v2-elevation-raised)]"
        >
          <div className="relative mb-1 flex shrink-0 items-center">
            <Search size={12} className="pointer-events-none absolute left-2 text-v2-icon-icon-muted" aria-hidden />
            <input
              ref={inputRef}
              type="search"
              aria-label="Search"
              aria-autocomplete="list"
              aria-controls={panelId}
              aria-activedescendant={activeOption ? `${panelId}-option-${effectiveActiveIndex}` : undefined}
              placeholder={searchPlaceholder}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(0);
              }}
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={() => {
                composing.current = false;
              }}
              onBlur={() => {
                composing.current = false;
                if (closeAfterTab.current) {
                  closeAfterTab.current = false;
                  setOpen(false);
                }
              }}
              onKeyUp={(event) => {
                if (event.key === "Tab") closeAfterTab.current = false;
              }}
              onKeyDown={(event) => {
                if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) {
                  event.stopPropagation();
                  return;
                }
                // Keep this input mounted until native Tab or the modal boundary handler moves focus.
                closeAfterTab.current = event.key === "Tab";
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  if (shown.length === 0) return;
                  const next = effectiveActiveIndex + (event.key === "ArrowDown" ? 1 : -1);
                  setActiveIndex((next + shown.length) % shown.length);
                } else if (event.key === "Home" || event.key === "End") {
                  event.preventDefault();
                  setActiveIndex(event.key === "Home" ? 0 : Math.max(0, shown.length - 1));
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  if (activeOption) choose(activeOption);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  setOpen(false);
                  if (canFocusElement(triggerRef.current)) triggerRef.current.focus();
                }
              }}
              className="h-6 w-full rounded-md border border-v2-grey-200 bg-v2-background-bg-base pl-6 pr-2 text-[12px] text-v2-text-text-base outline-none focus:border-v2-blue-600"
            />
          </div>
          <div
            ref={listRef}
            id={panelId}
            role="listbox"
            tabIndex={-1}
            aria-label={ariaLabel}
            className="min-h-0 overflow-y-auto"
          >
            {shown.length === 0 ? (
              <p className="px-2 py-1 text-[12px] text-v2-text-text-faint">{emptyMessage ?? "No matches"}</p>
            ) : (
              shown.map((option, index) => (
                <div
                  key={option.value}
                  id={`${panelId}-option-${index}`}
                  role="option"
                  tabIndex={-1}
                  aria-selected={effectiveActiveIndex === index}
                  className={`cursor-pointer rounded-md px-2 py-1 text-[12px] text-v2-text-text-base ${
                    effectiveActiveIndex === index ? "bg-v2-blue-100" : ""
                  }`}
                  onMouseMove={(event) => {
                    if (activity.current.interactive && hoverMove.current === event.nativeEvent) setActiveIndex(index);
                  }}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    choose(option);
                  }}
                >
                  {option.label}
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
