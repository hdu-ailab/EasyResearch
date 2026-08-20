import { Bot, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { isThinkingLevel } from "../../../thinking-levels";
import type { AgentConfigurationPatch, AgentDto } from "../../../web/contracts";
import { PAPER_ASSISTANT_AGENT } from "../agent-identity";
import { listAgents, listModels, patchAgent } from "../api";
import type { ModelOption } from "../api/parsers";
import { agentDescription, agentDisplayName, type Translate } from "../i18n/agents";
import { useI18n } from "../i18n/useI18n";
import { SearchableSelect } from "./SearchableSelect";
import { ThinkingLevelSelect, thinkingLevelsForModel } from "./ThinkingLevelSelect";

export type AgentStatus = "idle" | "working" | "error";

const BUILTIN_ORDER = [PAPER_ASSISTANT_AGENT, "search", "experiment", "writing", "figures"];

export interface AgentListProps {
  cwd: string;
  statusByAgent: Record<string, AgentStatus>;
  configurationGeneration: number;
  configurationError: string | null;
}

function dotClass(status: AgentStatus): string {
  return status === "working" ? "bg-v2-status-success" : status === "error" ? "bg-v2-status-warning" : "bg-v2-grey-400";
}

export function AgentList({ cwd, statusByAgent, configurationGeneration, configurationError }: AgentListProps) {
  const { t } = useI18n();
  const [roster, setRoster] = useState<AgentDto[] | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const request = useRef(0);

  const refresh = useCallback(async () => {
    const owner = ++request.current;
    setBusy(true);
    try {
      const [agents, catalog] = await Promise.all([listAgents(cwd), listModels()]);
      if (owner !== request.current) return;
      setRoster(agents);
      setModels(catalog);
      setLoadError(null);
    } catch (error) {
      if (owner !== request.current) return;
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      if (owner === request.current) setBusy(false);
    }
  }, [cwd]);

  useEffect(() => {
    // The revision triggers a refetch; the APIs remain the data authority.
    void configurationGeneration;
    void refresh();
    return () => {
      request.current += 1;
    };
  }, [configurationGeneration, refresh]);

  const applyPatch = async (name: string, patch: AgentConfigurationPatch) => {
    setBusy(true);
    try {
      const saved = await patchAgent(name, patch);
      setRoster((current) => current?.map((agent) => (agent.name === saved.name ? saved : agent)) ?? [saved]);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const agents = roster ?? [];
  const paperAssistant = agents.find((agent) => agent.name === PAPER_ASSISTANT_AGENT);
  const paperAssistantModel = paperAssistant?.model;
  const subagents = agents
    .filter((agent) => agent.name !== PAPER_ASSISTANT_AGENT)
    .sort((a, b) => {
      if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
      if (a.builtin) return BUILTIN_ORDER.indexOf(a.name) - BUILTIN_ORDER.indexOf(b.name);
      return a.name.localeCompare(b.name);
    });
  const visibleError = configurationError ?? loadError;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-v2-grey-200 px-3 py-2">
        <Bot size={14} className="text-v2-icon-icon-muted" />
        <span className="text-[13px] font-semibold text-v2-text-text-base">{t("work.agentsTab")}</span>
        <button
          type="button"
          aria-label={t("dialog.refresh")}
          disabled={busy}
          onClick={() => void refresh()}
          className="ml-auto flex h-7 items-center gap-1 rounded-md border border-v2-grey-200 px-2 text-[12px] text-v2-text-text-muted transition-colors hover:bg-v2-grey-100 disabled:opacity-50"
        >
          <RefreshCw size={12} aria-hidden />
          {t("dialog.refresh")}
        </button>
      </div>
      {visibleError && (
        <p role="alert" className="shrink-0 border-b border-v2-grey-200 px-3 py-2 text-[12px] text-v2-status-error">
          {visibleError}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <AgentCard
          agent={paperAssistant}
          fallbackName={PAPER_ASSISTANT_AGENT}
          fallbackDescription={t("work.paperAssistantFallback")}
          status={statusByAgent[PAPER_ASSISTANT_AGENT] ?? "idle"}
          models={models}
          paperAssistantModel={paperAssistantModel}
          disabled={false}
          busy={busy || roster === null}
          onPatch={(patch) => void applyPatch(PAPER_ASSISTANT_AGENT, patch)}
        />
        {subagents.map((agent) => (
          <AgentCard
            key={agent.name}
            agent={agent}
            status={statusByAgent[agent.name] ?? "idle"}
            models={models}
            paperAssistantModel={paperAssistantModel}
            disabled={!agent.enabled}
            busy={busy}
            onPatch={(patch) => void applyPatch(agent.name, patch)}
          />
        ))}
      </div>
    </div>
  );
}

interface AgentCardProps {
  agent: AgentDto | undefined;
  fallbackName?: string;
  fallbackDescription?: string;
  status: AgentStatus;
  models: ModelOption[];
  paperAssistantModel: string | undefined;
  disabled: boolean;
  busy: boolean;
  onPatch: (patch: AgentConfigurationPatch) => void;
}

function AgentCard({
  agent,
  fallbackName,
  fallbackDescription,
  status,
  models,
  paperAssistantModel,
  disabled,
  busy,
  onPatch,
}: AgentCardProps) {
  const { t } = useI18n();
  const name = agent?.name ?? fallbackName ?? "agent";
  return (
    <div className="mt-3 rounded-md border border-v2-grey-200 bg-v2-background-bg-base p-3 first:mt-0">
      <div className="flex items-center gap-2">
        <span className={`size-2 rounded-full ${dotClass(status)}`} aria-hidden />
        <span className="text-[13px] font-medium text-v2-text-text-base">{agentDisplayName(t, name)}</span>
        <span className="ml-auto flex items-center gap-2 text-[12px] text-v2-text-text-faint">
          {disabled ? t("work.disabled") : statusLabel(t, status)}
        </span>
      </div>
      <p className="mt-2 text-[12px] text-v2-text-text-muted">
        {agentDescription(t, name, agent?.description ?? fallbackDescription ?? "")}
      </p>
      {agent && (
        <p className="mt-1 text-[11px] text-v2-text-text-faint">
          {agent.effectiveTools.length} tools, {agent.effectiveSkills.length} skills
        </p>
      )}
      <ModelRow
        name={name}
        model={agent?.model}
        thinking={agent?.thinking}
        paperAssistantModel={paperAssistantModel}
        models={models}
        disabled={disabled || busy}
        onPatch={onPatch}
      />
    </div>
  );
}

function statusLabel(t: Translate, status: AgentStatus): string {
  return status === "working" ? t("work.working") : status === "error" ? t("work.error") : t("work.idle");
}

interface ModelRowProps {
  name: string;
  model: string | undefined;
  thinking: string | undefined;
  paperAssistantModel: string | undefined;
  models: ModelOption[];
  disabled: boolean;
  onPatch: (patch: AgentConfigurationPatch) => void;
}

function ModelRow({ name, model, thinking, paperAssistantModel, models, disabled, onPatch }: ModelRowProps) {
  const { t } = useI18n();
  const current = model ?? "";
  const slash = current.indexOf("/");
  const options =
    current !== "" && slash > 0 && !models.some((item) => `${item.provider}/${item.id}` === current)
      ? [{ provider: current.slice(0, slash), id: current.slice(slash + 1), reasoning: false }, ...models]
      : models;
  const effectiveModelRef = current || (name === PAPER_ASSISTANT_AGENT ? undefined : paperAssistantModel);
  const effectiveModel = models.find((item) => `${item.provider}/${item.id}` === effectiveModelRef);
  const levels = thinkingLevelsForModel(effectiveModel, thinking, effectiveModelRef === undefined);
  const emptyModelLabel = name === PAPER_ASSISTANT_AGENT ? t("work.automaticModel") : t("settings.agents.inherit");

  return (
    <div className="mt-2 flex items-center gap-1.5">
      <SearchableSelect
        ariaLabel={t("work.selectModel")}
        value={current}
        options={[
          { value: "", label: emptyModelLabel },
          ...options.map((item) => {
            const key = `${item.provider}/${item.id}`;
            return { value: key, label: key };
          }),
        ]}
        placeholder={emptyModelLabel}
        disabled={disabled}
        onSelect={(value) => onPatch({ model: value === "" ? null : value })}
        className="flex-1"
      />
      <ThinkingLevelSelect
        ariaLabel={t("work.selectThinking")}
        value={thinking ?? ""}
        levels={levels}
        emptyLabel={
          name === PAPER_ASSISTANT_AGENT ? t("settings.agents.automaticThinking") : t("settings.agents.inheritThinking")
        }
        disabled={disabled}
        onChange={(level) => onPatch({ thinking: level === "" ? null : isThinkingLevel(level) ? level : null })}
      />
    </div>
  );
}
