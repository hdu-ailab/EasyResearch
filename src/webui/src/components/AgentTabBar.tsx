import { X } from "lucide-react";
import { agentDisplayName } from "../i18n/agents";
import { useI18n } from "../i18n/useI18n";
import { childTabLabel, type SubagentTabState } from "../subagent-tabs";

export type AgentStatus = "idle" | "working" | "error";

export interface AgentTabBarProps {
  tabs: SubagentTabState[];
  activeKey: string;
  assistantStatus: AgentStatus;
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

export function AgentTabBar({ tabs, activeKey, assistantStatus, onSelect, onClose, onStop }: AgentTabBarProps) {
  const { t } = useI18n();
  const assistantFocused = activeKey === "assistant";

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-v2-grey-200 px-3 py-2">
      <button
        type="button"
        aria-pressed={assistantFocused}
        aria-label={`${t("work.agentChip")} ${agentDisplayName(t, "assistant")}`}
        onClick={() => onSelect("assistant")}
        className={`flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition-colors ${tabClass(assistantFocused)}`}
      >
        <span className={`size-2 shrink-0 rounded-full ${dotClass(assistantStatus)}`} aria-hidden />
        <span className="truncate">{agentDisplayName(t, "assistant")}</span>
      </button>
      {tabs.map((tab) => {
        const focused = activeKey === tab.key;
        const rawLabel = childTabLabel(tab, tabs);
        const localizedAgent = agentDisplayName(t, tab.agent);
        const label = rawLabel === tab.agent ? localizedAgent : `${localizedAgent}${rawLabel.slice(tab.agent.length)}`;
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
              {tab.latestMessage ? (
                <span className="max-w-64 truncate text-v2-text-text-faint" title={tab.latestMessage}>
                  {tab.latestMessage}
                </span>
              ) : tab.running ? (
                <span className="v2-spinner size-3" aria-hidden />
              ) : null}
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
