import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { SubagentCompletionEntry } from "./notifications";
import type { AutomaticRetryDto, LlmRecoveryDto, LlmRetryStateEventDto } from "../web/contracts";

export type SubagentProgressEvent = JsonAgentSessionEvent
  | LlmRetryStateEventDto
  | SubagentSupervisorEvent
  | { type: "timeline_entry_appended"; entry: SubagentCompletionEntry };

export type SubagentJobStatus = "working" | "complete" | "error";

export interface SubagentJobIdentity {
  launchId: string;
  ownerSessionId: string;
  toolCallId: string;
  agent: string;
  agentId: string;
  childSessionId: string;
}

export interface SubagentJobSummary extends SubagentJobIdentity {
  status: SubagentJobStatus;
  latestMessage?: string;
  automaticRetry?: AutomaticRetryDto | null;
  llmRecovery?: LlmRecoveryDto | null;
}

export interface SubagentSupervisorEvent extends SubagentJobSummary {
  type: "subagent_supervisor";
  event?: SubagentProgressEvent;
}

export interface SubagentLaunchDetails {
  mode: "single";
  background: true;
  job: SubagentJobIdentity & { status: "working" };
}
