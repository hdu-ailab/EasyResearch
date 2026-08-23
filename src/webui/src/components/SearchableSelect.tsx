import { ChevronDown, Search } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

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
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [direction, setDirection] = useState<"up" | "down">("down");
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const generatedId = useId().replaceAll(":", "");
  const panelId = `${id ?? `searchable-select-${generatedId}`}-listbox`;

  const current = options.find((option) => option.value === value);
  const shown = filterOptions(query, options);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    setDirection(flipDirection(triggerRef.current.getBoundingClientRect(), PANEL_MAX_HEIGHT, window.innerHeight));
    inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (triggerRef.current?.contains(event.target as Node)) return;
      if (panelRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const openPanel = () => {
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
    setOpen(false);
    onSelect(option.value);
    triggerRef.current?.focus();
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
        onClick={() => (open ? setOpen(false) : openPanel())}
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

      {open && triggerRect ? (
        <div
          ref={panelRef}
          id={panelId}
          role="listbox"
          aria-label={ariaLabel}
          style={{
            position: "fixed",
            width: triggerRect.width,
            top: direction === "down" ? triggerRect.bottom + 4 : undefined,
            bottom: direction === "up" ? window.innerHeight - triggerRect.top + 4 : undefined,
            left: triggerRect.left,
          }}
          className="z-50 max-h-[168px] overflow-y-auto rounded-md bg-v2-background-bg-base p-1 shadow-[var(--v2-elevation-raised)]"
        >
          <div className="relative mb-1 flex items-center">
            <Search size={12} className="pointer-events-none absolute left-2 text-v2-icon-icon-muted" aria-hidden />
            <input
              ref={inputRef}
              type="search"
              aria-label="Search"
              aria-autocomplete="list"
              aria-controls={panelId}
              aria-activedescendant={
                shown.length > 0 ? `${panelId}-option-${Math.min(activeIndex, shown.length - 1)}` : undefined
              }
              placeholder={searchPlaceholder}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  setActiveIndex((index) => {
                    const count = shown.length;
                    if (count === 0) return index;
                    const next = event.key === "ArrowDown" ? index + 1 : index - 1;
                    return ((next % count) + count) % count;
                  });
                } else if (event.key === "Home" || event.key === "End") {
                  event.preventDefault();
                  setActiveIndex(event.key === "Home" ? 0 : Math.max(0, shown.length - 1));
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  const target = shown[Math.min(activeIndex, shown.length - 1)];
                  if (target !== undefined) choose(target);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  setOpen(false);
                  triggerRef.current?.focus();
                } else if (event.key === "Tab") {
                  setOpen(false);
                }
              }}
              className="h-6 w-full rounded-md border border-v2-grey-200 bg-v2-background-bg-base pl-6 pr-2 text-[12px] text-v2-text-text-base outline-none focus:border-v2-blue-600"
            />
          </div>
          {shown.length === 0 ? (
            <p className="px-2 py-1 text-[12px] text-v2-text-text-faint">{emptyMessage ?? "No matches"}</p>
          ) : (
            shown.map((option, index) => (
              <div
                key={option.value}
                id={`${panelId}-option-${index}`}
                role="option"
                tabIndex={-1}
                aria-selected={activeIndex === index}
                className={`cursor-pointer rounded-md px-2 py-1 text-[12px] text-v2-text-text-base ${
                  activeIndex === index ? "bg-v2-blue-100" : ""
                }`}
                onMouseEnter={() => setActiveIndex(index)}
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
      ) : null}
    </div>
  );
}
