import { X } from "lucide-react";
import { useRef } from "react";
import { useModalLayer } from "../hooks/useModalLayer";
import { useI18n } from "../i18n/useI18n";

export interface AgentResourceDetailsDialogProps {
  agentName: string;
  tools: string[];
  skills: string[];
  onClose: () => void;
}

export function AgentResourceDetailsDialog({ agentName, tools, skills, onClose }: AgentResourceDetailsDialogProps) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDivElement>(null);
  const { zIndex, dialogProps } = useModalLayer(onClose, dialogRef);
  return (
    <div
      className="fixed inset-0 flex items-center justify-center bg-v2-grey-1200/30 p-0 min-[820px]:p-4"
      style={{ zIndex }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        {...dialogProps}
        aria-label={t("settings.resources.detailsTitle").replace("{name}", agentName)}
        className="flex h-full w-full flex-col overflow-hidden bg-v2-background-bg-base shadow-[var(--v2-elevation-overlay)] min-[820px]:h-auto min-[820px]:max-w-[520px] min-[820px]:rounded-[10px]"
      >
        <header className="flex items-center gap-3 border-b border-v2-grey-200 px-4 py-3">
          <h2 className="min-w-0 truncate text-[14px] font-semibold text-v2-text-text-base">
            {t("settings.resources.detailsTitle").replace("{name}", agentName)}
          </h2>
          <button
            type="button"
            aria-label={t("settings.resources.closeDetails")}
            className="ml-auto flex size-7 shrink-0 items-center justify-center rounded-md text-v2-icon-icon-muted hover:bg-v2-grey-100 hover:text-v2-icon-icon-base"
            onClick={onClose}
          >
            <X size={15} aria-hidden />
          </button>
        </header>
        <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto p-4 sm:grid-cols-2">
          <ResourceList title={t("settings.resources.tools")} items={tools} empty={t("settings.resources.noTools")} />
          <ResourceList
            title={t("settings.resources.skills")}
            items={skills}
            empty={t("settings.resources.noSkills")}
          />
        </div>
      </div>
    </div>
  );
}

function ResourceList({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return (
    <section aria-label={title}>
      <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.08em] text-v2-text-text-muted">{title}</h3>
      {items.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {items.map((item) => (
            <li key={item} className="rounded-md bg-v2-grey-100 px-2 py-1 font-mono text-[11px] text-v2-text-text-base">
              {item}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12px] text-v2-text-text-faint">{empty}</p>
      )}
    </section>
  );
}
