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
  homeDir: string;
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

export interface FileEntryDto extends DirectoryEntryDto {
  kind: "file" | "directory";
}

export interface FileContentDto {
  path: string;
  content: string;
  byteCount: number;
  truncated: boolean;
  /** True when content is binary or non-UTF-8; `content` is then empty. */
  binary: boolean;
}

export interface AgentDto {
  name: string;
  description: string;
  tools?: string[];
  subagents?: string[];
  skills?: string[];
}

export type ConfigScope = "global" | "project";

export interface ConfigEntryDto {
  name: string;
  path: string;
  type: "file" | "directory";
}

export interface AgentEffectiveModelDto {
  name: string;
  model: string | null;
  source: "override" | "project" | "global" | "inherit";
}

export interface WebuiSettingsDto {
  agentModels: Record<string, string>;
  orchestratorModel: string | null;
  effectiveOrchestratorModel: string | null;
}

export interface WebuiSettingsUpdate {
  agentModels?: Record<string, string>;
  orchestratorModel?: string | null;
}
