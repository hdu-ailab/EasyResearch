import { X } from "lucide-react";
import { PAPER_ASSISTANT_AGENT } from "../agent-identity";
import { agentDisplayName } from "../i18n/agents";
import { useI18n } from "../i18n/useI18n";
import { childTabLabel, type SubagentTabState } from "../subagent-tabs";

export type AgentStatus = "idle" | "working" | "error";

export interface AgentTabBarProps {
  tabs: SubagentTabState[];
  activeKey: string;
  paperAssistantStatus: AgentStatus;
  onSelect(key: string): void;
  onClose(key: string): void;
  onStop(toolCallId: string): void;
}

function dotClass(status: AgentStatus): string {
  return status === "working" ? "bg-v2-status-success" : status === "error" ? "bg-v2-status-warning" : "bg-v2-grey-400";
}

function tabClass(focused: boolean): string {
  return focused
    ? "border-v2-blue-200 bg-v2-blue-100/50 text-v2-blue-600"
    : "border-v2-grey-200 text-v2-text-text-muted hover:bg-v2-grey-100";
}

/** `search_0` → `search_0: 检索_0` (raw id, then the id with its agent-name
 * part localized); custom agents without a translation show the id alone. */
function localizedSubagentId(id: string, localizedAgent: string, agent: string): string {
  const seq = id.slice(agent.length);
  const localizedId = `${localizedAgent}${seq}`;
  return localizedId === id ? id : `${id}: ${localizedId}`;
}

export function AgentTabBar({ tabs, activeKey, paperAssistantStatus, onSelect, onClose, onStop }: AgentTabBarProps) {
  const { t } = useI18n();
  const paperAssistantFocused = activeKey === PAPER_ASSISTANT_AGENT;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-v2-grey-200 px-3 py-2">
      <button
        type="button"
        aria-pressed={paperAssistantFocused}
        aria-label={`${t("work.agentChip")} ${agentDisplayName(t, PAPER_ASSISTANT_AGENT)}`}
        onClick={() => onSelect(PAPER_ASSISTANT_AGENT)}
        className={`flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition-colors ${tabClass(paperAssistantFocused)}`}
      >
        <span className={`size-2 shrink-0 rounded-full ${dotClass(paperAssistantStatus)}`} aria-hidden />
        <span className="truncate">{agentDisplayName(t, PAPER_ASSISTANT_AGENT)}</span>
      </button>
      {tabs.map((tab) => {
        const focused = activeKey === tab.key;
        const rawLabel = childTabLabel(tab, tabs);
        const localizedAgent = agentDisplayName(t, tab.agent);
        const label =
          tab.id !== undefined
            ? localizedSubagentId(tab.id, localizedAgent, tab.agent)
            : rawLabel === tab.agent
              ? localizedAgent
              : `${localizedAgent}${rawLabel.slice(tab.agent.length)}`;
        const closeLabel = `${t("work.closeAgentTab")}: ${label}`;
        return (
          <div
            key={tab.key}
            className={`flex max-w-full items-center rounded-full border transition-colors ${tabClass(focused)}`}
          >
            <button
              type="button"
              aria-pressed={focused}
              aria-label={`${t("work.agentChip")} ${label}`}
              onClick={() => onSelect(tab.key)}
              className="flex min-w-0 items-center gap-1.5 rounded-l-full py-1 pl-2.5 pr-1 text-[12px]"
            >
              <span
                className={`size-2 shrink-0 rounded-full ${dotClass(tab.running ? "working" : "idle")}`}
                aria-hidden
              />
              <span className="truncate">{label}</span>
            </button>
            {tab.sessionId ? (
              <button
                type="button"
                aria-label={closeLabel}
                title={closeLabel}
                onClick={() => onClose(tab.key)}
                className="mr-1 flex size-5 shrink-0 items-center justify-center rounded-full text-v2-text-text-faint hover:bg-v2-grey-200"
              >
                <X size={11} aria-hidden />
              </button>
            ) : tab.running ? (
              <button
                type="button"
                aria-label={t("work.stopAgent")}
                title={t("work.stopAgent")}
                onClick={() => onStop(tab.toolCallId)}
                className="mr-1 flex size-5 shrink-0 items-center justify-center rounded-full text-v2-text-text-faint hover:bg-v2-grey-200 hover:text-v2-status-error"
              >
                <X size={11} aria-hidden />
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
