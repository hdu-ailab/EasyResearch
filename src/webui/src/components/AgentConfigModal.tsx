import { AlertTriangle, Settings2, X } from "lucide-react";
import { useRef } from "react";
import type { AgentDto, AgentResourceDto } from "../../../web/contracts";
import type { ModelOption } from "../api/parsers";
import { useModalLayer } from "../hooks/useModalLayer";
import { agentDisplayName } from "../i18n/agents";
import { useI18n } from "../i18n/useI18n";
import { AgentMarkdownEditor } from "./AgentMarkdownEditor";
import { SearchableSelect } from "./SearchableSelect";
import { ThinkingLevelSelect } from "./ThinkingLevelSelect";

export interface AgentConfigModalProps {
  agent: AgentDto;
  busy: boolean;
  modelOptions: readonly ModelOption[];
  modelValue: string;
  modelError?: string;
  thinkingValue: string;
  thinkingLevels: readonly string[];
  isResearchAssistant: boolean;
  editorResource: AgentResourceDto | null;
  onClose: () => void;
  onToggle: () => void;
  onModelChange: (value: string) => void;
  onThinkingChange: (value: string) => void;
  onEditMarkdown: () => void;
  onSaveMarkdown: (content: string) => void;
  onCloseEditor: () => void;
  onShowDetails: () => void;
}

export function AgentConfigModal({
  agent,
  busy,
  modelOptions,
  modelValue,
  modelError,
  thinkingValue,
  thinkingLevels,
  isResearchAssistant,
  editorResource,
  onClose,
  onToggle,
  onModelChange,
  onThinkingChange,
  onEditMarkdown,
  onSaveMarkdown,
  onCloseEditor,
  onShowDetails,
}: AgentConfigModalProps) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDivElement>(null);
  const { zIndex, dialogProps } = useModalLayer(onClose, dialogRef);
  const name = agentDisplayName(t, agent.name);
  const tools = agent.effectiveTools ?? agent.tools ?? [];
  const skills = agent.effectiveSkills ?? agent.skills ?? [];
  const selectedModel = modelOptions.find((model) => `${model.provider}/${model.id}` === modelValue);
  return (
    <div
      className="fixed inset-0 flex items-center justify-center bg-v2-grey-1200/30 p-0 min-[820px]:p-6"
      style={{ zIndex }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        {...dialogProps}
        aria-label={t("settings.agents.title")}
        className="flex h-full w-full flex-col overflow-hidden bg-v2-background-bg-base shadow-[var(--v2-elevation-overlay)] min-[820px]:h-auto min-[820px]:max-h-[min(720px,calc(100vh-24px))] min-[820px]:max-w-[520px] min-[820px]:rounded-[10px]"
      >
        <header className="flex items-center gap-3 border-b border-v2-grey-200 px-4 py-3">
          <Settings2 size={14} className="shrink-0 text-v2-icon-icon-muted" aria-hidden />
          <div className="min-w-0">
            <h2 className="truncate text-[14px] font-semibold text-v2-text-text-base">{name}</h2>
            {agent.description && (
              <p className="mt-0.5 truncate text-[12px] text-v2-text-text-muted">{agent.description}</p>
            )}
          </div>
          <button
            type="button"
            aria-label={t("settings.editor.close")}
            className="ml-auto flex size-7 shrink-0 items-center justify-center rounded-md text-v2-icon-icon-muted hover:bg-v2-grey-100 hover:text-v2-icon-icon-base"
            onClick={onClose}
          >
            <X size={15} aria-hidden />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          {!isResearchAssistant && (
            <div className="flex items-center justify-between gap-4">
              <span className="text-[13px] text-v2-text-text-base">
                {t("settings.agents.enable").replace("{name}", name)}
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={agent.enabled !== false}
                aria-label={t("settings.agents.enable").replace("{name}", name)}
                onClick={onToggle}
                className={`relative h-[20px] w-[36px] shrink-0 overflow-hidden rounded-full transition-colors ${agent.enabled !== false ? "bg-v2-blue-600" : "bg-v2-grey-400"}`}
              >
                <span
                  aria-hidden
                  className={`absolute left-0 top-[2px] size-[16px] rounded-full bg-white transition-transform ${agent.enabled !== false ? "translate-x-[18px]" : "translate-x-[2px]"}`}
                />
              </button>
            </div>
          )}
          {isResearchAssistant && (
            <div className="flex items-center gap-2 rounded-md border border-v2-grey-200 px-3 py-2 text-[12px] text-v2-text-text-muted">
              <AlertTriangle size={12} className="shrink-0" aria-hidden />
              {t("settings.agents.researchAssistantHint")}
            </div>
          )}

          <div className="flex flex-col gap-2">
            <label className="text-[12px] font-medium text-v2-text-text-base" htmlFor={`model-${agent.name}`}>
              {t("settings.agents.model")}
            </label>
            <SearchableSelect
              id={`model-${agent.name}`}
              ariaLabel={`${t("settings.agents.selectModelFor")} ${name}`}
              value={modelValue}
              options={[
                ...(isResearchAssistant ? [] : [{ value: "", label: t("settings.agents.inherit") }]),
                ...modelOptions.map((m) => {
                  const reference = `${m.provider}/${m.id}`;
                  const status = m.authRequired
                    ? t("settings.agents.authenticationRequired")
                    : !m.available
                      ? t("settings.agents.modelUnavailable")
                      : undefined;
                  return { value: reference, label: status ? `${reference} · ${status}` : reference };
                }),
              ]}
              placeholder={isResearchAssistant ? "" : t("settings.agents.inherit")}
              disabled={busy}
              onSelect={onModelChange}
              className="h-8 w-full text-[13px]"
            />
            {modelError && (
              <p role="alert" className="text-[12px] text-v2-status-error">
                {modelError}
              </p>
            )}
            {!modelError && selectedModel && !selectedModel.available && (
              <p role="status" className="text-[12px] text-v2-status-warning">
                {selectedModel.authRequired
                  ? t("settings.agents.authenticationRequired")
                  : t("settings.agents.modelUnavailable")}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-[12px] font-medium text-v2-text-text-base" htmlFor={`thinking-${agent.name}`}>
              {t("settings.agents.thinking")}
            </label>
            <ThinkingLevelSelect
              id={`thinking-${agent.name}`}
              ariaLabel={`${t("settings.agents.selectThinkingFor")} ${name}`}
              value={thinkingValue}
              levels={thinkingLevels}
              emptyLabel={
                isResearchAssistant ? t("settings.agents.automaticThinking") : t("settings.agents.inheritThinking")
              }
              disabled={busy}
              onChange={onThinkingChange}
              className="h-8 w-full rounded-md border border-v2-grey-200 bg-v2-background-bg-base px-2 text-[13px] text-v2-text-text-base outline-none focus:border-v2-blue-600 disabled:opacity-50"
            />
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-[12px] font-medium text-v2-text-text-base">
              {t("settings.agents.toolsSkills")
                .replace("{tools}", String(tools.length))
                .replace("{skills}", String(skills.length))}
            </span>
            <button
              type="button"
              className="rounded-md border border-v2-grey-200 px-3 py-2 text-left text-[12px] text-v2-text-text-muted transition-colors hover:bg-v2-grey-100"
              onClick={onShowDetails}
            >
              {t("settings.agents.viewDetails")}
            </button>
          </div>

          <button
            type="button"
            className="rounded-md border border-v2-grey-200 px-3 py-2 text-left text-[12px] text-v2-text-text-base transition-colors hover:bg-v2-grey-100 disabled:opacity-50"
            onClick={onEditMarkdown}
            disabled={busy}
          >
            {t("settings.agents.edit").replace("{name}", name)}
          </button>
        </div>
      </div>
      {editorResource && (
        <AgentMarkdownEditor resource={editorResource} busy={busy} onSave={onSaveMarkdown} onClose={onCloseEditor} />
      )}
    </div>
  );
}
