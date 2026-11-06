import { ChevronRight, FileText, Folder, Sparkles, Terminal } from "lucide-react";
import { useEffect, useRef } from "react";
import { useI18n } from "../../i18n/useI18n";

export interface ComposerSuggestion {
  id: string;
  kind: "command" | "skill" | "file" | "directory";
  label: string;
  description?: string;
}

export function ComposerSuggestions({
  id,
  surface,
  items,
  activeIndex,
  status,
  onActive,
  onSelect,
}: {
  id: string;
  surface: "slash" | "files";
  items: ComposerSuggestion[];
  activeIndex: number;
  status?: "loading" | "ready" | "error";
  onActive: (index: number) => void;
  onSelect: (index: number) => void;
}) {
  const { t } = useI18n();
  const list = useRef<HTMLDivElement>(null);
  const activeId = items[activeIndex]?.id;
  useEffect(() => {
    if (activeId) list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [activeId]);
  const groups = surface === "files" ? (["files"] as const) : (["commands", "skills"] as const);
  return (
    <div
      ref={list}
      id={id}
      role="listbox"
      aria-label={surface === "files" ? t("composer.files") : t("composer.slashHint")}
      aria-busy={status === "loading"}
      className="absolute inset-x-0 bottom-full z-20 mb-2 max-h-64 overflow-y-auto overscroll-contain rounded-xl border border-v2-grey-200 bg-v2-background-bg-base p-1.5 shadow-lg"
    >
      {groups.map((group) => {
        const options = items
          .map((item, index) => ({ item, index }))
          .filter(({ item }) =>
            group === "files" ? true : group === "skills" ? item.kind === "skill" : item.kind === "command",
          );
        if (!options.length) return null;
        const label = t(
          group === "files" ? "composer.files" : group === "skills" ? "composer.skills" : "composer.commands",
        );
        return (
          <fieldset key={group} className="min-w-0" aria-label={label}>
            <legend className="px-2 py-1 text-[11px] font-medium text-v2-text-text-faint">{label}</legend>
            {options.map(({ item, index }) => {
              const Icon =
                item.kind === "skill"
                  ? Sparkles
                  : item.kind === "command"
                    ? Terminal
                    : item.kind === "directory"
                      ? Folder
                      : FileText;
              return (
                <button
                  key={item.id}
                  id={`${id}-option-${index}`}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={index === activeIndex}
                  className={`flex min-h-9 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] ${index === activeIndex ? "bg-v2-grey-100 text-v2-text-text-base" : "text-v2-text-text-muted"}`}
                  onPointerDown={(event) => event.preventDefault()}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onSelect(index)}
                  onMouseEnter={() => onActive(index)}
                >
                  <Icon size={15} className="shrink-0" aria-hidden />
                  <span className="min-w-0 truncate font-medium">{item.label}</span>
                  {item.description ? (
                    <span className="min-w-0 flex-1 truncate text-[12px] text-v2-text-text-faint">
                      {item.description}
                    </span>
                  ) : null}
                  {item.kind === "directory" ? (
                    <ChevronRight size={14} className="ml-auto shrink-0" aria-hidden />
                  ) : null}
                </button>
              );
            })}
          </fieldset>
        );
      })}
      {!items.length ? (
        <p className="px-2 py-2 text-[12px] text-v2-text-text-muted" role="status">
          {status === "loading"
            ? t("composer.filesLoading")
            : status === "error"
              ? t("composer.filesError")
              : t("composer.noMatches")}
        </p>
      ) : null}
    </div>
  );
}
