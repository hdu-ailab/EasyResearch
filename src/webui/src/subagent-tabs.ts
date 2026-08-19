import type { SubagentSessionSummaryDto } from "../../web/contracts";
import type { ToolView } from "./session-reducer";

export interface SubagentTabState {
  key: string;
  ownerSessionId: string;
  toolCallId: string;
  agent: string;
  step?: number;
  sessionId?: string;
  /** Opaque, user-facing Agent invocation id supplied by the supervisor. */
  agentId?: string;
  retained: boolean;
  running: boolean;
  error: boolean;
  latestMessage?: string;
}

export interface SubagentTabsState {
  tabs: SubagentTabState[];
  hiddenRunningToolCalls: string[];
}

function invocationKey(ownerSessionId: string, toolCallId: string, step?: number): string {
  return JSON.stringify(step === undefined ? [ownerSessionId, toolCallId] : [ownerSessionId, toolCallId, step]);
}

export function temporarySubagentTabKey(ownerSessionId: string, toolCallId: string, step?: number): string {
  const owner = encodeURIComponent(ownerSessionId);
  const tool = encodeURIComponent(toolCallId);
  return step === undefined ? `tool:${owner}:${tool}` : `tool:${owner}:${tool}:${step}`;
}

function sameInvocation(
  tab: Pick<SubagentTabState, "ownerSessionId" | "toolCallId" | "step">,
  ownerSessionId: string,
  toolCallId: string,
  step?: number,
): boolean {
  return tab.ownerSessionId === ownerSessionId && tab.toolCallId === toolCallId && tab.step === step;
}

function toolCallIdOf(tool: ToolView): string {
  return tool.toolCallId ?? tool.key;
}

function ownerSessionIdOf(tool: ToolView, fallbackOwnerSessionId: string): string {
  return tool.ownerSessionId ?? fallbackOwnerSessionId;
}

function isWorking(tool: ToolView): boolean {
  return tool.running && !tool.done;
}

function isSupervisorTerminal(tool: ToolView): boolean {
  return tool.supervised === true && tool.done;
}

function isUnmappedLaunchFailure(tool: ToolView): boolean {
  return tool.done && tool.error && tool.sessionId === undefined;
}

function withStep<T extends { step?: number }>(value: T, step?: number): T {
  const { step: _previous, ...rest } = value;
  return (step === undefined ? rest : { ...rest, step }) as T;
}

function updateTabFromTool(tab: SubagentTabState, tool: ToolView, step = tool.step): SubagentTabState {
  return withStep(
    {
      ...tab,
      agent: tool.agentName ?? tab.agent,
      ...(tool.agentId !== undefined ? { agentId: tool.agentId } : {}),
      ...(tool.latestMessage !== undefined ? { latestMessage: tool.latestMessage } : {}),
    },
    step,
  );
}

export function syncRunningSubagentTabs(
  state: SubagentTabsState,
  tools: ToolView[],
  fallbackOwnerSessionId: string,
): SubagentTabsState {
  const subagents = tools.filter((tool) => tool.name === "subagent");
  const byInvocation = new Map(
    subagents.map((tool) => [
      invocationKey(ownerSessionIdOf(tool, fallbackOwnerSessionId), toolCallIdOf(tool), tool.step),
      tool,
    ]),
  );
  const hiddenRunningToolCalls = state.hiddenRunningToolCalls.filter((key) => {
    const tool = byInvocation.get(key);
    return !tool || (!isSupervisorTerminal(tool) && !isUnmappedLaunchFailure(tool));
  });
  const hidden = new Set(hiddenRunningToolCalls);

  const tabs = state.tabs.flatMap((tab) => {
    let tool = byInvocation.get(invocationKey(tab.ownerSessionId, tab.toolCallId, tab.step));
    let migratedFirstStep = false;
    if (!tool && tab.step === undefined && !tab.sessionId) {
      const sameTool = subagents.filter(
        (candidate) =>
          ownerSessionIdOf(candidate, fallbackOwnerSessionId) === tab.ownerSessionId &&
          toolCallIdOf(candidate) === tab.toolCallId,
      );
      if (sameTool.length === 1) {
        tool = sameTool[0];
        migratedFirstStep = tool?.step !== undefined;
      }
    }
    if (!tool) return [tab];

    const ownerSessionId = ownerSessionIdOf(tool, fallbackOwnerSessionId);
    const toolCallId = toolCallIdOf(tool);
    const key = invocationKey(ownerSessionId, toolCallId, tool.step);
    if (isUnmappedLaunchFailure(tool)) return [];
    if (isSupervisorTerminal(tool)) {
      if (!tab.retained || (!tab.sessionId && !tool.sessionId)) return [];
      return [
        {
          ...updateTabFromTool(tab, tool),
          running: false,
          error: tool.error,
        },
      ];
    }
    if (!isWorking(tool)) return [updateTabFromTool(tab, tool)];
    if (hidden.has(key)) return [];
    return [
      {
        ...updateTabFromTool(tab, tool),
        key:
          tab.sessionId || migratedFirstStep ? tab.key : temporarySubagentTabKey(ownerSessionId, toolCallId, tool.step),
        ownerSessionId,
        toolCallId,
        running: true,
        error: false,
      },
    ];
  });

  const represented = new Set(tabs.map((tab) => invocationKey(tab.ownerSessionId, tab.toolCallId, tab.step)));
  for (const tool of subagents) {
    if (!isWorking(tool)) continue;
    const ownerSessionId = ownerSessionIdOf(tool, fallbackOwnerSessionId);
    const toolCallId = toolCallIdOf(tool);
    const key = invocationKey(ownerSessionId, toolCallId, tool.step);
    if (represented.has(key) || hidden.has(key)) continue;
    tabs.push({
      key: temporarySubagentTabKey(ownerSessionId, toolCallId, tool.step),
      ownerSessionId,
      toolCallId,
      agent: tool.agentName ?? "subagent",
      ...(tool.agentId !== undefined ? { agentId: tool.agentId } : {}),
      ...(tool.step !== undefined ? { step: tool.step } : {}),
      retained: false,
      running: true,
      error: false,
      ...(tool.latestMessage !== undefined ? { latestMessage: tool.latestMessage } : {}),
    });
  }

  return { tabs, hiddenRunningToolCalls };
}

export function retainSubagentTab(
  state: SubagentTabsState,
  ownerSessionId: string,
  toolCallId: string,
  step?: number,
): SubagentTabsState {
  const key = invocationKey(ownerSessionId, toolCallId, step);
  return {
    tabs: state.tabs.map((tab) =>
      sameInvocation(tab, ownerSessionId, toolCallId, step) ? { ...tab, retained: true } : tab,
    ),
    hiddenRunningToolCalls: state.hiddenRunningToolCalls.filter((id) => id !== key),
  };
}

export function promoteSubagentTab(state: SubagentTabsState, link: SubagentSessionSummaryDto): SubagentTabsState {
  const existingUuid = state.tabs.find((tab) => tab.sessionId === link.childSessionId);
  const matched = state.tabs.find((tab) => sameInvocation(tab, link.ownerSessionId, link.toolCallId, link.step));
  if (existingUuid) {
    if (!matched) return state;
    return {
      ...state,
      tabs: state.tabs.flatMap((tab) => {
        if (tab === matched && tab !== existingUuid) return [];
        if (tab !== existingUuid) return [tab];
        return [
          withStep(
            {
              ...existingUuid,
              ownerSessionId: link.ownerSessionId,
              toolCallId: link.toolCallId,
              agent: link.agent,
              ...(link.agentId !== undefined ? { agentId: link.agentId } : {}),
              retained: true,
              running: link.status === "working",
              error: link.status === "error",
              latestMessage: link.latestMessage ?? matched.latestMessage ?? existingUuid.latestMessage,
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
              ownerSessionId: link.ownerSessionId,
              agent: link.agent,
              ...(link.agentId !== undefined ? { agentId: link.agentId } : {}),
              running: link.status === "working",
              error: link.status === "error",
              ...(link.latestMessage !== undefined ? { latestMessage: link.latestMessage } : {}),
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
      ? [
          ...new Set([
            ...state.hiddenRunningToolCalls,
            invocationKey(closed.ownerSessionId, closed.toolCallId, closed.step),
          ]),
        ]
      : state.hiddenRunningToolCalls,
  };
}

export function childTabLabel(tab: SubagentTabState, allTabs: SubagentTabState[]): string {
  if (tab.agentId !== undefined) return tab.agentId;
  const duplicateAgent =
    tab.sessionId !== undefined &&
    allTabs.some((other) => other !== tab && other.sessionId !== undefined && other.agent === tab.agent);
  return duplicateAgent && tab.sessionId ? `${tab.agent} · ${tab.sessionId.slice(0, 8)}` : tab.agent;
}
