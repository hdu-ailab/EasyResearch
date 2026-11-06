import { Bot, Files, MessageSquare } from "lucide-react";
import type { KeyboardEvent, RefObject } from "react";
import { useId, useRef } from "react";
import { useI18n } from "../i18n/useI18n";
import { useViewActivityRef } from "../view-activity";

export type WorkView = "chat" | "files" | "agents";

export interface WorkMobileTabsProps {
  active: WorkView;
  onChange: (view: WorkView) => void;
  idPrefix?: string;
  filesTabRef?: RefObject<HTMLButtonElement | null>;
}

const views = [
  { id: "chat", label: "work.chatTab", icon: MessageSquare },
  { id: "files", label: "work.filesTab", icon: Files },
  { id: "agents", label: "work.agentsTab", icon: Bot },
] as const;

export function WorkMobileTabs({ active, onChange, idPrefix, filesTabRef }: WorkMobileTabsProps) {
  const { t } = useI18n();
  const generatedId = useId();
  const prefix = idPrefix ?? `work-${generatedId}`;
  const activity = useViewActivityRef();
  const refs = useRef<Record<WorkView, HTMLButtonElement | null>>({
    chat: null,
    files: null,
    agents: null,
  });

  function select(view: WorkView) {
    if (!activity.current.interactive) return;
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
      className="grid h-12 shrink-0 grid-cols-3 border-b border-v2-grey-200/70 bg-v2-background-bg-base px-2 min-[820px]:hidden"
    >
      {views.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          ref={(node) => {
            refs.current[id] = node;
            if (id === "files" && filesTabRef) filesTabRef.current = node;
          }}
          id={`${prefix}-tab-${id}`}
          data-work-tab={id}
          role="tab"
          type="button"
          aria-selected={active === id}
          aria-controls={`${prefix}-panel-${id}`}
          tabIndex={active === id ? 0 : -1}
          onClick={() => select(id)}
          onKeyDown={(event) => handleKeyDown(event, id)}
          title={t(label)}
          className={`relative my-1 flex min-w-0 items-center justify-center gap-2 rounded-lg px-2 text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-v2-blue-600 ${
            active === id
              ? "bg-v2-blue-100/60 font-medium text-v2-blue-600"
              : "text-v2-text-text-muted hover:bg-v2-grey-100"
          }`}
        >
          <Icon size={14} aria-hidden="true" />
          <span className="truncate">{t(label)}</span>
        </button>
      ))}
    </div>
  );
}
