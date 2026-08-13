import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SubagentSessionLink } from "../subagent/session-links";

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
  subagents: SubagentSessionSummaryDto[];
}

export interface SubagentSessionSummaryDto extends SubagentSessionLink {
  latestMessage?: string;
}

export interface ChildSessionSnapshotDto {
  session: {
    id: string;
    cwd: string;
    sessionName?: string;
  };
  messages: AgentMessage[];
}

export interface DirectoryEntryDto {
  name: string;
  path: string;
}

export interface FileEntryDto extends DirectoryEntryDto {
  kind: "file" | "directory";
}

export type FileWatcherEventKind = "add" | "change" | "unlink";

export interface FileWatcherEvent {
  type: "file.watcher.updated";
  properties: { file: string; event: FileWatcherEventKind };
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
  enabled: boolean;
  builtin: boolean;
  source: "bundled" | "global" | "project";
  filePath: string;
  model?: string;
  tools?: string[];
  effectiveTools: string[];
  subagents?: string[];
  skills?: string[];
  effectiveSkills: string[];
  missingSkills: string[];
}

export interface AgentResourceDto extends AgentDto {
  content?: string;
}

export interface SkillResourceDto {
  name: string;
  source: "bundled" | "global" | "project" | "home";
  path: string;
  skillPath: string;
  content?: string;
}

export type ConfigScope = "global" | "project";

export interface ConfigEntryDto {
  name: string;
  path: string;
  type: "file" | "directory";
}

export interface ModelOptionDto {
  provider: string;
  id: string;
  reasoning: boolean;
  thinkingLevelMap?: Record<string, string | null>;
}

export interface AgentEffectiveModelDto {
  name: string;
  model: string | null;
  source: "override" | "project" | "global" | "inherit";
}

export interface AgentEffectiveThinkingDto {
  name: string;
  thinking: string | null;
  source: "override" | "default" | "inherit";
}

export interface WebuiSettingsDto {
  agentModels: Record<string, string>;
  paperAssistantModel: string | null;
  effectivePaperAssistantModel: string | null;
  agentThinking: Record<string, string>;
  paperAssistantThinking: string | null;
}

export interface WebuiSettingsUpdate {
  agentModels?: Record<string, string>;
  paperAssistantModel?: string | null;
  agentThinking?: Record<string, string>;
  paperAssistantThinking?: string | null;
}
