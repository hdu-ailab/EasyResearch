import { Bot, FolderOpen } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { AgentDto, AgentEffectiveModelDto } from "../../../web/contracts";
import { getEffectiveModels, listAgents, listModels, setAgentModel } from "../api";
import { agentDescription, agentDisplayName, type Translate } from "../i18n/agents";
import { useI18n } from "../i18n/useI18n";

export type AgentStatus = "idle" | "working" | "error";

export interface AgentListProps {
  statusByAgent: Record<string, AgentStatus>;
  sessionId: string;
}

function dotClass(status: AgentStatus): string {
  return status === "working" ? "bg-v2-status-success" : status === "error" ? "bg-v2-status-warning" : "bg-v2-grey-400";
}

export function AgentList({ statusByAgent, sessionId }: AgentListProps) {
  const { t } = useI18n();
  const [roster, setRoster] = useState<AgentDto[] | null>(null);
  const [models, setModels] = useState<Array<{ provider: string; id: string }>>([]);
  const [effective, setEffective] = useState<AgentEffectiveModelDto[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([listAgents(), listModels(), getEffectiveModels(sessionId)])
      .then(([agents, catalog, eff]) => {
        if (!alive) return;
        setRoster(agents);
        setModels(catalog);
        setEffective(eff);
      })
      .catch(() => {
        if (alive) setRoster([]);
      });
    return () => {
      alive = false;
    };
  }, [sessionId]);

  const applyModel = useCallback(
    async (agentName: string, model: string | null) => {
      setBusy(true);
      try {
        await setAgentModel(sessionId, agentName, model);
        setEffective(await getEffectiveModels(sessionId));
      } catch {
        // Keep the last known models; the next interaction can retry.
      } finally {
        setBusy(false);
      }
    },
    [sessionId],
  );

  const agents = roster ?? [];
  const assistant = agents.find((agent) => agent.name === "assistant");
  const subagents = agents.filter((agent) => agent.name !== "assistant");

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-v2-grey-200 px-3 py-2">
        <Bot size={14} className="text-v2-icon-icon-muted" />
        <span className="text-[13px] font-semibold text-v2-text-text-base">{t("work.agentsTab")}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <AgentCard
          agent={assistant}
          fallbackName="assistant"
          fallbackDescription={t("work.assistantFallback")}
          status={statusByAgent.assistant ?? "idle"}
          entry={effective?.find((item) => item.name === "assistant")}
          models={models}
          busy={busy}
          onApply={(model) => applyModel("assistant", model)}
        />
        {subagents.map((agent) => (
          <AgentCard
            key={agent.name}
            agent={agent}
            status={statusByAgent[agent.name] ?? "idle"}
            entry={effective?.find((item) => item.name === agent.name)}
            models={models}
            busy={busy}
            onApply={(model) => applyModel(agent.name, model)}
          />
        ))}
        <p className="mt-3 flex items-center gap-2 text-[12px] text-v2-text-text-faint">
          <FolderOpen size={12} />
          {t("work.strictlySerialNote")}
        </p>
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
  models: Array<{ provider: string; id: string }>;
  busy: boolean;
  onApply: (model: string | null) => void;
}

function AgentCard({ agent, fallbackName, fallbackDescription, status, entry, models, busy, onApply }: AgentCardProps) {
  const { t } = useI18n();
  const name = agent?.name ?? fallbackName ?? "agent";
  return (
    <div className="mt-3 rounded-md border border-v2-grey-200 bg-v2-background-bg-base p-3 first:mt-0">
      <div className="flex items-center gap-2">
        <span className={`size-2 rounded-full ${dotClass(status)}`} aria-hidden />
        <span className="text-[13px] font-medium text-v2-text-text-base">{agentDisplayName(t, name)}</span>
        <span className="ml-auto text-[12px] text-v2-text-text-faint">{statusLabel(t, status)}</span>
      </div>
      <p className="mt-2 text-[12px] text-v2-text-text-muted">
        {agentDescription(t, name, agent?.description ?? fallbackDescription ?? "")}
      </p>
      <ModelRow entry={entry} models={models} busy={busy} onApply={onApply} />
    </div>
  );
}

function statusLabel(t: Translate, status: AgentStatus): string {
  return status === "working" ? t("work.working") : status === "error" ? t("work.error") : t("work.idle");
}

interface ModelRowProps {
  entry: AgentEffectiveModelDto | undefined;
  models: Array<{ provider: string; id: string }>;
  busy: boolean;
  onApply: (model: string | null) => void;
}

function ModelRow({ entry, models, busy, onApply }: ModelRowProps) {
  const { t } = useI18n();
  const current = entry?.model ?? "";
  const slash = current.indexOf("/");
  const options =
    current !== "" && slash > 0 && !models.some((model) => `${model.provider}/${model.id}` === current)
      ? [{ provider: current.slice(0, slash), id: current.slice(slash + 1) }, ...models]
      : models;

  return (
    <div className="mt-2 flex items-center gap-1.5">
      <select
        aria-label={t("work.selectModel")}
        value={current}
        onChange={(event) => onApply(event.target.value === "" ? null : event.target.value)}
        disabled={busy}
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
    </div>
  );
}
