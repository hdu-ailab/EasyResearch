import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

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
}

export interface SubagentSupervisorEvent extends SubagentJobSummary {
  type: "subagent_supervisor";
  event?: JsonAgentSessionEvent;
}

export interface SubagentLaunchDetails {
  mode: "single";
  background: true;
  job: SubagentJobIdentity & { status: "working" };
}
