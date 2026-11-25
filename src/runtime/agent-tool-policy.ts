import { selectAgentTools, type AgentConfig, type RegisteredAgentTool } from "../subagent/agents";

export interface ObservableToolRuntime {
  refreshTools(): void;
  setActiveTools(names: string[]): void;
}

interface ToolPolicySession {
  getAllTools?(): RegisteredAgentTool[];
  resourceLoader: { getExtensions?(): { runtime?: ObservableToolRuntime } };
}

/** Wrap public native registry actions, leaving registration/execution with Pi. */
export function installAgentToolPolicy(
  session: ToolPolicySession,
  agent: () => Pick<AgentConfig, "name" | "tools">,
  changed: () => void,
): () => void {
  const runtime = session.resourceLoader.getExtensions?.().runtime;
  if (!runtime || !session.getAllTools) return () => {};
  const originalRefresh = runtime.refreshTools;
  const originalSelect = runtime.setActiveTools;
  const allowed = () => selectAgentTools(agent(), session.getAllTools!());
  const notify = () => {
    try { changed(); } catch { /* Inventory observation cannot fail a tool operation. */ }
  };
  const refresh = () => {
    originalRefresh.call(runtime);
    originalSelect.call(runtime, allowed());
    notify();
  };
  const select = (names: string[]) => {
    const available = new Set(allowed());
    originalSelect.call(runtime, names.filter(name => available.has(name)));
    notify();
  };
  runtime.refreshTools = refresh;
  runtime.setActiveTools = select;
  originalSelect.call(runtime, allowed());
  notify();
  return () => {
    if (runtime.refreshTools === refresh) runtime.refreshTools = originalRefresh;
    if (runtime.setActiveTools === select) runtime.setActiveTools = originalSelect;
  };
}
