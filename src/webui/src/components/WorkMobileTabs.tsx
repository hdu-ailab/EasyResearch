import { Bot, Files, MessageSquare } from "lucide-react";
import type { KeyboardEvent } from "react";
import { useRef } from "react";
import { useI18n } from "../i18n/useI18n";
import { useClassicUi } from "../ui-version";

export type WorkView = "chat" | "files" | "agents";

export interface WorkMobileTabsProps {
  active: WorkView;
  onChange: (view: WorkView) => void;
}

const views = [
  { id: "chat", label: "work.chatTab", icon: MessageSquare },
  { id: "files", label: "work.filesTab", icon: Files },
  { id: "agents", label: "work.agentsTab", icon: Bot },
] as const;

export function WorkMobileTabs({ active, onChange }: WorkMobileTabsProps) {
  const { t } = useI18n();
  const classic = useClassicUi();
  const refs = useRef<Record<WorkView, HTMLButtonElement | null>>({
    chat: null,
    files: null,
    agents: null,
  });

  function select(view: WorkView) {
    onChange(view);
    refs.current[view]?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, view: WorkView) {
    const index = views.findIndex(({ id }) => id === view);
    let next: WorkView | undefined;

    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = views[(index + 1) % views.length]?.id;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = views[(index - 1 + views.length) % views.length]?.id;
        break;
      case "Home":
        next = "chat";
        break;
      case "End":
        next = "agents";
        break;
      default:
        return;
    }

    if (next === undefined) return;
    event.preventDefault();
    select(next);
  }

  return (
    <div
      role="tablist"
      aria-label={t("work.views")}
      className={
        classic
          ? "grid h-10 grid-cols-3 border-b border-v2-grey-200 bg-v2-background-bg-base min-[820px]:hidden"
          : "grid h-12 shrink-0 grid-cols-3 border-b border-v2-grey-200/70 bg-v2-background-bg-base px-2 min-[820px]:hidden"
      }
    >
      {views.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          ref={(node) => {
            refs.current[id] = node;
          }}
          id={`work-tab-${id}`}
          role="tab"
          type="button"
          aria-selected={active === id}
          aria-controls={`work-panel-${id}`}
          tabIndex={active === id ? 0 : -1}
          onClick={() => select(id)}
          onKeyDown={(event) => handleKeyDown(event, id)}
          className={
            classic
              ? `relative flex min-w-0 items-center justify-center gap-1.5 px-2 text-[12px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-v2-blue-600 ${
                  active === id
                    ? "text-v2-blue-600 after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-v2-blue-600"
                    : "text-v2-text-text-muted hover:bg-v2-grey-100"
                }`
              : `relative my-1 flex min-w-0 items-center justify-center gap-2 rounded-lg px-2 text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-v2-blue-600 ${
                  active === id
                    ? "bg-v2-blue-100/60 font-medium text-v2-blue-600"
                    : "text-v2-text-text-muted hover:bg-v2-grey-100"
                }`
          }
        >
          <Icon size={14} aria-hidden="true" />
          <span className="truncate">{t(label)}</span>
        </button>
      ))}
    </div>
  );
}
