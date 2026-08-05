import type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface SessionSummaryDto {
  id: string;
  path: string;
  cwd: string;
  name?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
}

export interface StatusDto {
  agentDir: string;
  sessions: SessionSummaryDto[];
  activeSessions: ActiveSessionDto[];
}

export interface ActiveSessionDto {
  id: string;
  cwd: string;
  sessionFile?: string;
  sessionName?: string;
  isStreaming: boolean;
  status: "starting" | "ready" | "running" | "stopped" | "error";
  error?: string;
}

export interface SessionSnapshotDto {
  session: ActiveSessionDto;
  messages: AgentMessage[];
}

export interface DirectoryEntryDto {
  name: string;
  path: string;
}

export type ConfigScope = "global" | "project";

export interface ConfigEntryDto {
  name: string;
  path: string;
  type: "file" | "directory";
}
