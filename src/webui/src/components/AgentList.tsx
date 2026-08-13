import { Bot } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentDto, AgentEffectiveModelDto, AgentEffectiveThinkingDto } from "../../../web/contracts";
import { PAPER_ASSISTANT_AGENT } from "../agent-identity";
import {
  getEffectiveModels,
  getEffectiveThinking,
  listAgents,
  listModels,
  setAgentModel,
  setAgentThinking,
} from "../api";
import type { ModelOption } from "../api/parsers";
import { agentDescription, agentDisplayName, type Translate } from "../i18n/agents";
import { useI18n } from "../i18n/useI18n";
import { ThinkingLevelSelect, thinkingLevelsForModel } from "./ThinkingLevelSelect";

export type AgentStatus = "idle" | "working" | "error";

const BUILTIN_ORDER = [PAPER_ASSISTANT_AGENT, "search", "experiment", "writing", "figures"];

export interface AgentListProps {
  cwd: string;
  statusByAgent: Record<string, AgentStatus>;
  sessionId: string;
}

function dotClass(status: AgentStatus): string {
  return status === "working" ? "bg-v2-status-success" : status === "error" ? "bg-v2-status-warning" : "bg-v2-grey-400";
}

export function AgentList({ cwd, statusByAgent, sessionId }: AgentListProps) {
  const { t } = useI18n();
  const [roster, setRoster] = useState<AgentDto[] | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [effective, setEffective] = useState<AgentEffectiveModelDto[] | null>(null);
  const [thinking, setThinking] = useState<AgentEffectiveThinkingDto[] | null>(null);
  const [busy, setBusy] = useState(false);
  const requestGeneration = useRef(0);

  useEffect(() => {
    const generation = ++requestGeneration.current;
    setRoster(null);
    setModels([]);
    setEffective(null);
    setThinking(null);
    setBusy(true);
    Promise.all([listAgents(cwd), listModels(), getEffectiveModels(sessionId), getEffectiveThinking(sessionId)])
      .then(([agents, catalog, eff, thin]) => {
        if (generation !== requestGeneration.current) return;
        setRoster(agents);
        setModels(catalog);
        setEffective(eff);
        setThinking(thin);
        setBusy(false);
      })
      .catch(() => {
        if (generation !== requestGeneration.current) return;
        setRoster([]);
        setModels([]);
        setEffective(null);
        setThinking(null);
        setBusy(false);
      });
    return () => {
      if (generation === requestGeneration.current) requestGeneration.current += 1;
    };
  }, [cwd, sessionId]);

  const applyModel = useCallback(
    async (agentName: string, model: string | null) => {
      const ownedSession = sessionId;
      const generation = ++requestGeneration.current;
      setBusy(true);
      try {
        await setAgentModel(ownedSession, agentName, model);
        const [next, thin] = await Promise.all([getEffectiveModels(ownedSession), getEffectiveThinking(ownedSession)]);
        if (generation === requestGeneration.current) {
          setEffective(next);
          setThinking(thin);
        }
      } catch {
        // Keep the last known models; the next interaction can retry.
      } finally {
        if (generation === requestGeneration.current) setBusy(false);
      }
    },
    [sessionId],
  );

  const applyThinking = useCallback(
    async (agentName: string, thinking: string | null) => {
      const ownedSession = sessionId;
      const generation = ++requestGeneration.current;
      setBusy(true);
      try {
        await setAgentThinking(ownedSession, agentName, thinking);
        const [next, thin] = await Promise.all([getEffectiveThinking(ownedSession), getEffectiveModels(ownedSession)]);
        if (generation === requestGeneration.current) {
          setThinking(next);
          setEffective(thin);
        }
      } catch {
        // Keep the last known levels; the next interaction can retry.
      } finally {
        if (generation === requestGeneration.current) setBusy(false);
      }
    },
    [sessionId],
  );

  const agents = roster ?? [];
  const paperAssistant = agents.find((agent) => agent.name === PAPER_ASSISTANT_AGENT);
  const subagents = agents
    .filter((agent) => agent.name !== PAPER_ASSISTANT_AGENT)
    .sort((a, b) => {
      if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
      if (a.builtin) return BUILTIN_ORDER.indexOf(a.name) - BUILTIN_ORDER.indexOf(b.name);
      return a.name.localeCompare(b.name);
    });

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-v2-grey-200 px-3 py-2">
        <Bot size={14} className="text-v2-icon-icon-muted" />
        <span className="text-[13px] font-semibold text-v2-text-text-base">{t("work.agentsTab")}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <AgentCard
          agent={paperAssistant}
          fallbackName={PAPER_ASSISTANT_AGENT}
          fallbackDescription={t("work.paperAssistantFallback")}
          status={statusByAgent[PAPER_ASSISTANT_AGENT] ?? "idle"}
          entry={effective?.find((item) => item.name === PAPER_ASSISTANT_AGENT)}
          thinkingEntry={thinking?.find((item) => item.name === PAPER_ASSISTANT_AGENT)}
          models={models}
          disabled={false}
          busy={busy || effective === null}
          onApply={(model) => applyModel(PAPER_ASSISTANT_AGENT, model)}
          onApplyThinking={(level) => applyThinking(PAPER_ASSISTANT_AGENT, level)}
        />
        {subagents.map((agent) => (
          <AgentCard
            key={agent.name}
            agent={agent}
            status={statusByAgent[agent.name] ?? "idle"}
            entry={effective?.find((item) => item.name === agent.name)}
            thinkingEntry={thinking?.find((item) => item.name === agent.name)}
            models={models}
            disabled={!agent.enabled}
            busy={busy || effective === null}
            onApply={(model) => applyModel(agent.name, model)}
            onApplyThinking={(level) => applyThinking(agent.name, level)}
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
  entry: AgentEffectiveModelDto | undefined;
  thinkingEntry: AgentEffectiveThinkingDto | undefined;
  models: ModelOption[];
  disabled: boolean;
  busy: boolean;
  onApply: (model: string | null) => void;
  onApplyThinking: (thinking: string | null) => void;
}

function AgentCard({
  agent,
  fallbackName,
  fallbackDescription,
  status,
  entry,
  thinkingEntry,
  models,
  disabled,
  busy,
  onApply,
  onApplyThinking,
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
        entry={entry}
        thinkingEntry={thinkingEntry}
        models={models}
        disabled={disabled || busy}
        onApply={onApply}
        onApplyThinking={onApplyThinking}
      />
    </div>
  );
}

function statusLabel(t: Translate, status: AgentStatus): string {
  return status === "working" ? t("work.working") : status === "error" ? t("work.error") : t("work.idle");
}

interface ModelRowProps {
  entry: AgentEffectiveModelDto | undefined;
  thinkingEntry: AgentEffectiveThinkingDto | undefined;
  models: ModelOption[];
  disabled: boolean;
  onApply: (model: string | null) => void;
  onApplyThinking: (thinking: string | null) => void;
}

function ModelRow({ entry, thinkingEntry, models, disabled, onApply, onApplyThinking }: ModelRowProps) {
  const { t } = useI18n();
  const current = entry?.model ?? "";
  const slash = current.indexOf("/");
  const options: ModelOption[] =
    current !== "" && slash > 0 && !models.some((model) => `${model.provider}/${model.id}` === current)
      ? [{ provider: current.slice(0, slash), id: current.slice(slash + 1), reasoning: false }, ...models]
      : models;
  const effectiveModel = models.find((model) => `${model.provider}/${model.id}` === current);
  const thinking = thinkingEntry?.thinking ?? "";
  const levels = thinkingLevelsForModel(effectiveModel, thinking || undefined);

  return (
    <div className="mt-2 flex items-center gap-1.5">
      <select
        aria-label={t("work.selectModel")}
        value={current}
        onChange={(event) => onApply(event.target.value === "" ? null : event.target.value)}
        disabled={disabled}
        className="h-6 min-w-0 flex-1 rounded-md border border-v2-grey-200 bg-v2-background-bg-base px-1 text-[11px] text-v2-text-text-base outline-none focus:border-v2-blue-600"
      >
        <option value="">{t("work.models")}</option>
        {options.map((model) => {
          const key = `${model.provider}/${model.id}`;
          return (
            <option key={key} value={key}>
              {key}
            </option>
          );
        })}
      </select>
      <ThinkingLevelSelect
        ariaLabel={t("work.selectThinking")}
        value={thinking}
        levels={levels}
        emptyLabel={thinkingDefaultLabel(t, thinkingEntry)}
        disabled={disabled}
        onChange={(level) => onApplyThinking(level === "" ? null : level)}
      />
    </div>
  );
}

function thinkingDefaultLabel(t: Translate, entry: AgentEffectiveThinkingDto | undefined): string {
  if (!entry || entry.source === "override") return `${t("work.defaultThinking")}`;
  return `${t("work.defaultThinking")} (${entry.thinking ?? "off"})`;
}
