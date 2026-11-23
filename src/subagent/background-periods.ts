import type { BackgroundTask } from "../background/contracts";
import type { ManagedShellService } from "../background/shell";

/** The descriptor and execution claim are kept in the root's native JSONL. */
export interface BackgroundAdmission {
  cwd: string;
  callerAgent: string;
  description: string;
  model?: string;
  thinking?: string;
}

export interface BackgroundPeriodResult {
  state: "completed" | "cancelled" | "error";
  text?: string;
  outstanding: BackgroundTask[];
}

export interface SubagentShellService {
  execute?: ManagedShellService["execute"];
  executeRemote?: ManagedShellService["executeRemote"];
  flushNotifications?: ManagedShellService["flushNotifications"];
  recoveredCalls?: ManagedShellService["recoveredCalls"];
  attachOwner(owner: { sessionID: string; cwd: string; shell?: () => { path?: string; commandPrefix?: string }; notify(notice: { id: string; content: string; wake?: boolean; recovered?: boolean }): Promise<void> }): () => void;
  tasks(): BackgroundTask[];
  cancel(taskID: string): Promise<void>;
  hasWork(sessionID?: string): boolean;
  subscribe(listener: () => void): () => void;
}

export const BACKGROUND_INPUT = "easyresearch:subagent_input";
export const BACKGROUND_WAKE = "easyresearch:subagent_wake";
export const RESTART_PROMPT = "The server restarted while you were working. Continue from where you left off without repeating completed work.";

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function formatBackgroundResult(input: BackgroundPeriodResult & { sessionID: string; description: string }): string {
  const state = input.state === "completed" && input.outstanding.length ? "running" : input.state;
  return [
    `<background-result kind="subagent" sessionID="${escapeAttribute(input.sessionID)}" state="${state}" description="${escapeAttribute(input.description)}">`,
    input.text?.trim() || (input.state === "error" ? "Subagent failed" : input.state === "cancelled" ? "Subagent cancelled" : "Subagent completed without a text response."),
    ...(input.outstanding.length ? ["", "Background work still running:", ...input.outstanding.map((task) => {
      const clean = (value: string) => value.replace(/\s+/g, " ").trim();
      const location = task.sessionID !== input.sessionID ? `, in ${task.sessionID}` : "";
      return task.kind === "shell"
        ? `- shell (${task.shellID ?? task.id}${location}): ${clean(task.command ?? task.description)}`
        : `- subagent (${task.agent ?? "subagent"}, sessionID: ${task.sessionID}): ${clean(task.description)}`;
    })] : []),
    "</background-result>",
  ].join("\n");
}
