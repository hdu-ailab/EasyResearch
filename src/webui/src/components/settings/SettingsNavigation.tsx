import { ChevronRight, FileJson } from "lucide-react";
import { type KeyboardEvent, useRef } from "react";
import type { MessageKey } from "../../i18n/messages";
import { useI18n } from "../../i18n/useI18n";

export type SettingsCategory = "general" | "network" | "conversation" | "providers" | "agents" | "resources";

export interface SettingsNavigationProps {
  active: SettingsCategory;
  mobileDetailOpen: boolean;
  onSelect(category: SettingsCategory): void;
  onOpenConfig(): void;
  registerMobileButton(category: SettingsCategory, element: HTMLButtonElement | null): void;
}

const categories: readonly { id: SettingsCategory; label: MessageKey }[] = [
  { id: "general", label: "settings.category.general" },
  { id: "network", label: "settings.category.network" },
  { id: "conversation", label: "settings.category.conversation" },
  { id: "providers", label: "settings.category.providers" },
  { id: "agents", label: "settings.category.agents" },
  { id: "resources", label: "settings.category.resources" },
];

export function SettingsNavigation({
  active,
  mobileDetailOpen,
  onSelect,
  onOpenConfig,
  registerMobileButton,
}: SettingsNavigationProps) {
  const { t } = useI18n();
  const desktopButtons = useRef<Partial<Record<SettingsCategory, HTMLButtonElement | null>>>({});
  const mobile = window.innerWidth < 820;

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, category: SettingsCategory) => {
    const current = categories.findIndex((item) => item.id === category);
    let next = current;
    if (event.key === "ArrowDown") next = (current + 1) % categories.length;
    else if (event.key === "ArrowUp") next = (current - 1 + categories.length) % categories.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = categories.length - 1;
    else return;

    event.preventDefault();
    const nextCategory = categories[next]?.id;
    if (!nextCategory) return;
    onSelect(nextCategory);
    desktopButtons.current[nextCategory]?.focus();
  };

  if (mobile) {
    return (
      <nav
        hidden={mobileDetailOpen}
        className="min-h-0 flex-1 overflow-y-auto bg-v2-background-bg-base p-3"
        aria-label={t("settings.title")}
      >
        <div className="flex flex-col gap-1">
          {categories.map((category) => (
            <button
              key={category.id}
              ref={(element) => registerMobileButton(category.id, element)}
              type="button"
              hidden={mobileDetailOpen}
              onClick={() => onSelect(category.id)}
              className="flex min-h-11 w-full items-center rounded-md px-3 text-left text-[13px] font-medium text-v2-text-text-base transition-colors hover:bg-v2-grey-100 focus:outline-2 focus:outline-offset-2 focus:outline-v2-blue-600"
            >
              <span className="min-w-0 flex-1 truncate">{t(category.label)}</span>
              <ChevronRight size={15} className="shrink-0 text-v2-icon-icon-muted" aria-hidden />
            </button>
          ))}
          <div className="my-1 border-t border-v2-grey-200" />
          <button
            type="button"
            hidden={mobileDetailOpen}
            onClick={onOpenConfig}
            className="flex min-h-11 w-full items-center gap-2 rounded-md px-3 text-left text-[13px] font-medium text-v2-text-text-base transition-colors hover:bg-v2-grey-100 focus:outline-2 focus:outline-offset-2 focus:outline-v2-blue-600"
          >
            <FileJson size={15} className="shrink-0 text-v2-icon-icon-muted" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{t("settings.config.entry")}</span>
          </button>
        </div>
      </nav>
    );
  }

  return (
    <nav className="flex w-[208px] shrink-0 flex-col border-r border-v2-grey-200 bg-v2-background-bg-deep p-2">
      <div role="tablist" aria-label={t("settings.title")} aria-orientation="vertical" className="flex flex-col gap-1">
        {categories.map((category) => {
          const selected = category.id === active;
          return (
            <button
              key={category.id}
              ref={(element) => {
                desktopButtons.current[category.id] = element;
              }}
              id={`settings-tab-${category.id}`}
              type="button"
              role="tab"
              tabIndex={selected ? 0 : -1}
              aria-selected={selected}
              aria-controls={`settings-panel-${category.id}`}
              onClick={() => onSelect(category.id)}
              onKeyDown={(event) => onTabKeyDown(event, category.id)}
              className={`flex h-9 w-full items-center rounded-md px-3 text-left text-[13px] transition-colors focus:outline-2 focus:outline-offset-2 focus:outline-v2-blue-600 ${
                selected ? "bg-v2-blue-100 font-medium text-v2-blue-600" : "text-v2-text-text-base hover:bg-v2-grey-100"
              }`}
            >
              {t(category.label)}
            </button>
          );
        })}
      </div>
      <div className="mt-auto border-t border-v2-grey-200 pt-2">
        <button
          type="button"
          onClick={onOpenConfig}
          className="flex min-h-9 w-full items-center gap-2 rounded-md px-3 text-left text-[12px] font-medium text-v2-text-text-base transition-colors hover:bg-v2-grey-100 focus:outline-2 focus:outline-offset-2 focus:outline-v2-blue-600"
        >
          <FileJson size={14} className="shrink-0 text-v2-icon-icon-muted" aria-hidden />
          <span className="min-w-0 truncate">{t("settings.config.entry")}</span>
        </button>
      </div>
    </nav>
  );
}
