import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
  SubagentJobStatus,
  SubagentSupervisorEvent,
} from "../subagent/contracts";

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
  /** Pending steer messages not yet delivered into the agent context
   * (ADR-083); omitted or empty for historical/stopped sessions. */
  steering?: string[];
}

export interface SkillCommandDto {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
}

export interface WebTreeEntryDto {
  id: string;
  parentId: string | null;
  /** Mirrors the transcript bubble roles; non-bubble entries map to `other`. */
  role: "user" | "assistant" | "other";
  text: string;
  /** Compaction entries only: the kept context starts at this entry. */
  firstKeptEntryId?: string;
}

export interface SessionTreeDto {
  tree: WebTreeEntryDto[];
  leafId: string | null;
}

export interface SubagentSessionSummaryDto {
  ownerSessionId: string;
  toolCallId: string;
  agent: string;
  childSessionId: string;
  status: SubagentJobStatus;
  /** Absent only for persisted links created before ADR-087. */
  launchId?: string;
  /** Absent only when persisted legacy history has no alias. */
  agentId?: string;
  latestMessage?: string;
  /** Persisted legacy chain display only; new jobs omit it. */
  step?: number;
}

export type SubagentSupervisorEventDto = SubagentSupervisorEvent;

export interface ChildSessionSnapshotDto {
  session: {
    id: string;
    cwd: string;
    sessionName?: string;
  };
  messages: AgentMessage[];
  subagents: SubagentSessionSummaryDto[];
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

export interface ConfigurationUpdatedEvent {
  type: "config.updated";
  generation: number;
  agentsChanged: boolean;
  modelsChanged: boolean;
}

export interface ConfigurationErrorEvent {
  type: "config.error";
  generation: number;
  message: string;
}

export type ConfigurationEvent = ConfigurationUpdatedEvent | ConfigurationErrorEvent;

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
  source: "global" | "bundled";
  filePath: string;
  model?: string;
  effectiveModel?: string;
  thinking?: ThinkingLevel;
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

export type AgentConfigurationPatch = {
  model?: string | null;
  thinking?: ThinkingLevel | null;
};

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

// ---- Provider auth gateway (ADR-065) --------------------------------------

export interface AuthProviderInfoDto {
  id: string;
  name: string;
  authMethods: ("api_key" | "oauth")[];
  connectable: boolean;
  authStatus: { configured: boolean; source?: string };
  source?: string;
  hint?: string;
  /** True when the provider is declared in `models.json` (custom provider). */
  modelsJson: boolean;
}

export interface AuthProvidersResponseDto {
  providers: AuthProviderInfoDto[];
}

export interface AuthLoginRequestDto {
  providerId: string;
  type: "api_key" | "oauth";
}

export interface AuthLoginResponseDto {
  flowId: string;
}

export interface AuthLogoutRequestDto {
  providerId: string;
}

export interface AuthRespondRequestDto {
  value: string;
}

export type AuthFlowEventDto =
  | {
      type: "prompt";
      kind: "text" | "secret" | "select" | "manual_code";
      message: string;
      placeholder?: string;
      options?: { id: string; label: string; description?: string }[];
    }
  | {
      type: "notify";
      event:
        | { kind: "info"; message: string; links?: { url: string; label?: string }[] }
        | { kind: "auth_url"; url: string; instructions?: string }
        | {
            kind: "device_code";
            userCode: string;
            verificationUri: string;
            intervalSeconds?: number;
            expiresInSeconds?: number;
          }
        | { kind: "progress"; message: string };
    }
  | {
      type: "done";
      credential: { type: "api_key" } | { type: "oauth"; expires: number };
      warning?: string;
    }
  | { type: "error"; message: string; reason?: "aborted" | "timeout" | "reject" };
