import type { SubagentSessionSummaryDto } from "../../web/contracts";
import type { ToolView } from "./session-reducer";

export interface SubagentTabState {
  key: string;
  toolCallId: string;
  agent: string;
  step?: number;
  sessionId?: string;
  /** Agent id (`<agent>_<seq>`, ADR-084) of the child within its main session. */
  id?: string;
  retained: boolean;
  running: boolean;
  latestMessage?: string;
}

function agentIdOf(sessionLinks: ToolView["sessionLinks"]): string | undefined {
  return sessionLinks?.find((link) => link.id !== undefined)?.id;
}

export interface SubagentTabsState {
  tabs: SubagentTabState[];
  hiddenRunningToolCalls: string[];
}

function invocationKey(toolCallId: string, step?: number): string {
  return step === undefined ? toolCallId : `${toolCallId}:${step}`;
}

export function temporarySubagentTabKey(toolCallId: string, step?: number): string {
  return `tool:${invocationKey(toolCallId, step)}`;
}

function sameInvocation(
  tab: Pick<SubagentTabState, "toolCallId" | "step">,
  toolCallId: string,
  step?: number,
): boolean {
  return tab.toolCallId === toolCallId && tab.step === step;
}

function runningSubagents(tools: ToolView[]): ToolView[] {
  return tools.filter((tool) => tool.name === "subagent" && tool.running && !tool.done);
}

function withStep<T extends { step?: number }>(value: T, step?: number): T {
  const { step: _previous, ...rest } = value;
  return (step === undefined ? rest : { ...rest, step }) as T;
}

export function syncRunningSubagentTabs(state: SubagentTabsState, tools: ToolView[]): SubagentTabsState {
  const running = runningSubagents(tools);
  const byInvocation = new Map(running.map((tool) => [invocationKey(tool.key, tool.step), tool]));
  const hiddenRunningToolCalls = state.hiddenRunningToolCalls.filter((key) => byInvocation.has(key));
  const hidden = new Set(hiddenRunningToolCalls);

  const tabs = state.tabs.flatMap((tab) => {
    const key = invocationKey(tab.toolCallId, tab.step);
    let tool = byInvocation.get(key);
    let migratedFirstStep = false;
    if (!tool && tab.step === undefined && !tab.sessionId) {
      const sameTool = running.filter((candidate) => candidate.key === tab.toolCallId);
      const onlyTool = sameTool.length === 1 ? sameTool[0] : undefined;
      if (onlyTool) {
        tool = onlyTool;
        migratedFirstStep = onlyTool.step !== undefined;
      }
    }
    if (!tool) return tab.sessionId || tab.retained ? [{ ...tab, running: false }] : [];
    const nextKey = invocationKey(tool.key, tool.step);
    if (hidden.has(nextKey)) return [];
    return [
      withStep(
        {
          ...tab,
          key: tab.sessionId || migratedFirstStep ? tab.key : temporarySubagentTabKey(tool.key, tool.step),
          agent: tool.agentName ?? tab.agent,
          ...(agentIdOf(tool.sessionLinks) !== undefined ? { id: agentIdOf(tool.sessionLinks) } : {}),
          running: true,
          ...(tool.latestMessage !== undefined ? { latestMessage: tool.latestMessage } : {}),
        },
        tool.step,
      ),
    ];
  });

  const represented = new Set(tabs.map((tab) => invocationKey(tab.toolCallId, tab.step)));
  for (const tool of running) {
    const key = invocationKey(tool.key, tool.step);
    if (represented.has(key) || hidden.has(key)) continue;
    tabs.push({
      key: temporarySubagentTabKey(tool.key, tool.step),
      toolCallId: tool.key,
      agent: tool.agentName ?? "subagent",
      ...(agentIdOf(tool.sessionLinks) !== undefined ? { id: agentIdOf(tool.sessionLinks) } : {}),
      ...(tool.step !== undefined ? { step: tool.step } : {}),
      retained: false,
      running: true,
      ...(tool.latestMessage !== undefined ? { latestMessage: tool.latestMessage } : {}),
    });
  }

  return { tabs, hiddenRunningToolCalls };
}

export function retainSubagentTab(state: SubagentTabsState, toolCallId: string, step?: number): SubagentTabsState {
  const key = invocationKey(toolCallId, step);
  return {
    tabs: state.tabs.map((tab) => (sameInvocation(tab, toolCallId, step) ? { ...tab, retained: true } : tab)),
    hiddenRunningToolCalls: state.hiddenRunningToolCalls.filter((id) => id !== key),
  };
}

export function promoteSubagentTab(state: SubagentTabsState, link: SubagentSessionSummaryDto): SubagentTabsState {
  const existingUuid = state.tabs.find((tab) => tab.sessionId === link.childSessionId);
  const matched = state.tabs.find((tab) => sameInvocation(tab, link.toolCallId, link.step));
  if (existingUuid) {
    if (!matched) return state;
    return {
      ...state,
      tabs: state.tabs.flatMap((tab) => {
        if (matched && tab === matched && tab !== existingUuid) return [];
        if (tab !== existingUuid) return [tab];
        return [
          withStep(
            {
              ...existingUuid,
              toolCallId: link.toolCallId,
              agent: link.agent,
              ...(link.id !== undefined ? { id: link.id } : {}),
              retained: true,
              running: matched?.running ?? existingUuid.running,
              latestMessage: link.latestMessage ?? matched?.latestMessage ?? existingUuid.latestMessage,
            },
            link.step,
          ),
        ];
      }),
    };
  }
  if (!matched?.retained) return state;
  return {
    ...state,
    tabs: state.tabs.map((tab) =>
      tab === matched
        ? withStep(
            {
              ...tab,
              key: `session:${link.childSessionId}`,
              sessionId: link.childSessionId,
              agent: link.agent,
              ...(link.id !== undefined ? { id: link.id } : {}),
            },
            link.step,
          )
        : tab,
    ),
  };
}

export function closeSubagentTab(state: SubagentTabsState, key: string): SubagentTabsState {
  const closed = state.tabs.find((tab) => tab.key === key);
  if (!closed) return state;
  return {
    tabs: state.tabs.filter((tab) => tab.key !== key),
    hiddenRunningToolCalls: closed.running
      ? [...new Set([...state.hiddenRunningToolCalls, invocationKey(closed.toolCallId, closed.step)])]
      : state.hiddenRunningToolCalls,
  };
}

export function childTabLabel(tab: SubagentTabState, allTabs: SubagentTabState[]): string {
  if (tab.id !== undefined) return tab.id;
  const duplicateAgent =
    tab.sessionId !== undefined &&
    allTabs.some((other) => other !== tab && other.sessionId !== undefined && other.agent === tab.agent);
  return duplicateAgent && tab.sessionId ? `${tab.agent} · ${tab.sessionId.slice(0, 8)}` : tab.agent;
}
