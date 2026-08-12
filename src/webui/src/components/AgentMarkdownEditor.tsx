import type { AgentResourceDto } from "../../../web/contracts";
import { useI18n } from "../i18n/useI18n";

export interface AgentMarkdownEditorProps {
  resource: AgentResourceDto;
  busy?: boolean;
  onChange: (content: string) => void;
  onSave: () => void;
  onClose: () => void;
}

export function AgentMarkdownEditor({ resource, busy = false, onChange, onSave, onClose }: AgentMarkdownEditorProps) {
  const { t } = useI18n();
  return (
    <div className="mt-3 rounded-md border border-v2-blue-200 bg-v2-background-bg-deep p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[12px] font-medium text-v2-text-text-base">{resource.filePath}</span>
        <button
          type="button"
          className="ml-auto text-[12px] text-v2-text-text-muted hover:text-v2-text-text-base"
          onClick={onClose}
        >
          {t("settings.agents.closeEditor")}
        </button>
      </div>
      <textarea
        aria-label={t("settings.agents.agentMarkdown")}
        className="min-h-[220px] w-full resize-y rounded-md border border-v2-grey-200 bg-v2-background-bg-base p-2 font-mono text-[12px] leading-[1.5] outline-none focus:border-v2-blue-600"
        value={resource.content ?? ""}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
      />
      <div className="mt-2 flex justify-end">
        <button
          type="button"
          className="rounded-md bg-v2-grey-1100 px-3 py-1.5 text-[12px] text-v2-grey-50 disabled:opacity-50"
          disabled={busy}
          onClick={onSave}
        >
          {t("settings.agents.saveAgent")}
        </button>
      </div>
    </div>
  );
}
