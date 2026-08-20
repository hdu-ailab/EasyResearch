import { X } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
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

export function AgentTabBar({ tabs, activeKey, paperAssistantStatus, onSelect, onClose, onStop }: AgentTabBarProps) {
  const { t } = useI18n();
  const paperAssistantFocused = activeKey === PAPER_ASSISTANT_AGENT;
  const tabButtons = useRef(new Map<string, HTMLButtonElement>());
  const focusedInvocation = useRef<string | null>(null);

  useLayoutEffect(() => {
    const active = tabs.find((tab) => tab.key === activeKey);
    if (!active) return;
    const invocation = JSON.stringify([active.ownerSessionId, active.toolCallId, active.step]);
    if (focusedInvocation.current !== invocation || document.activeElement !== document.body) return;
    tabButtons.current.get(activeKey)?.focus();
  }, [activeKey, tabs]);

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-v2-grey-200 px-3 py-2">
      <button
        type="button"
        aria-pressed={paperAssistantFocused}
        aria-label={`${t("work.agentChip")} ${agentDisplayName(t, PAPER_ASSISTANT_AGENT)}`}
        onClick={() => onSelect(PAPER_ASSISTANT_AGENT)}
        onFocus={() => {
          focusedInvocation.current = null;
        }}
        className={`flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v2-blue-600 ${tabClass(paperAssistantFocused)}`}
      >
        <span className={`size-2 shrink-0 rounded-full ${dotClass(paperAssistantStatus)}`} aria-hidden />
        <span className="truncate">{agentDisplayName(t, PAPER_ASSISTANT_AGENT)}</span>
      </button>
      {tabs.map((tab) => {
        const focused = activeKey === tab.key;
        const rawLabel = childTabLabel(tab, tabs);
        const localizedAgent = agentDisplayName(t, tab.agent);
        const label =
          tab.agentId !== undefined
            ? tab.agentId
            : rawLabel === tab.agent
              ? localizedAgent
              : `${localizedAgent}${rawLabel.slice(tab.agent.length)}`;
        const closeLabel = `${t("work.closeAgentTab")}: ${label}`;
        const stopLabel = `${t("work.stopAgent")}: ${label}`;
        const invocation = JSON.stringify([tab.ownerSessionId, tab.toolCallId, tab.step]);
        return (
          <div
            key={tab.key}
            className={`flex max-w-full items-center rounded-full border transition-colors ${tabClass(focused)}`}
          >
            <button
              type="button"
              ref={(node) => {
                if (node) tabButtons.current.set(tab.key, node);
                else tabButtons.current.delete(tab.key);
              }}
              aria-pressed={focused}
              aria-label={`${t("work.agentChip")} ${label}`}
              onClick={() => onSelect(tab.key)}
              onFocus={() => {
                focusedInvocation.current = invocation;
              }}
              className="flex min-w-0 items-center gap-1.5 rounded-l-full py-1 pl-2.5 pr-1 text-[12px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v2-blue-600"
            >
              <span
                className={`size-2 shrink-0 rounded-full ${dotClass(tab.error ? "error" : tab.running ? "working" : "idle")}`}
                aria-hidden
              />
              <span className="truncate">{label}</span>
              {tab.error ? <span className="text-v2-status-warning">{t("work.error")}</span> : null}
            </button>
            {tab.sessionId ? (
              <button
                type="button"
                aria-label={closeLabel}
                title={closeLabel}
                onClick={() => onClose(tab.key)}
                onFocus={() => {
                  focusedInvocation.current = null;
                }}
                className="mr-1 flex size-5 shrink-0 items-center justify-center rounded-full text-v2-text-text-faint hover:bg-v2-grey-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v2-blue-600"
              >
                <X size={11} aria-hidden />
              </button>
            ) : null}
            {tab.running ? (
              <button
                type="button"
                aria-label={stopLabel}
                title={stopLabel}
                onClick={() => onStop(tab.toolCallId)}
                onFocus={() => {
                  focusedInvocation.current = null;
                }}
                className="mr-1 flex size-5 shrink-0 items-center justify-center rounded-full text-v2-text-text-faint hover:bg-v2-grey-200 hover:text-v2-status-error focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v2-blue-600"
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
