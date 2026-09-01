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

export interface UpdateCheckDto {
  /** Non-null only when npm's latest dist-tag is newer than this build. */
  latestVersion: string | null;
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
  runtimeConfigurationGeneration: number;
  timeline: TranscriptTimelineEntryDto[];
  subagents: SubagentSessionSummaryDto[];
  /** Present only on an SSE snapshot; scoped to that exact EventSource. */
  fileWatchLeaseId?: string;
  contextUsage?: ContextUsageDto;
  inlineUsage?: ApiUsageRecordDto[];
  apiUsage?: ApiUsageStatisticsDto;
  compactionPolicy: CompactionPolicyDto;
  compactionState?: CompactionStateDto;
  /** Pending steer messages not yet delivered into the agent context
   * (ADR-083); omitted or empty for historical/stopped sessions. */
  steering?: string[];
}

export type TranscriptTimelineEntryDto =
  | { kind: "message"; entryId: string; message: AgentMessage }
  | { kind: "compaction"; entryId: string; timestamp: string; summary?: string }
  | { kind: "branch-summary"; entryId: string; timestamp: string; summary?: string };

export interface TimelineEntryAppendedEventDto {
  type: "timeline_entry_appended";
  entry: Exclude<TranscriptTimelineEntryDto, { kind: "message" }>;
  apiUsageRecord?: ApiUsageRecordDto;
}

export interface ContextUsageDto {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface ApiUsageDto {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  reasoning?: number;
  totalTokens: number;
  cacheHitRate: number | null;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export interface ApiUsageTotalsDto {
  records: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  reasoning: number;
  totalTokens: number;
  cacheHitRate: number | null;
  cost: ApiUsageDto["cost"];
}

export type ApiUsageAnchorDto =
  | { kind: "message"; messageEntryId: string }
  | { kind: "tool"; toolCallId: string }
  | { kind: "standalone"; afterEntryId?: string };

export interface ApiUsageRecordDto {
  id: string;
  sessionId: string;
  source: "assistant" | "tool" | "compaction" | "branch-summary";
  timestamp: string;
  anchor: ApiUsageAnchorDto;
  provider?: string;
  model?: string;
  usage: ApiUsageDto;
}

export interface ApiUsageModelSummaryDto {
  key: string;
  provider?: string;
  model?: string;
  kind: "model" | "internal";
  totals: ApiUsageTotalsDto;
}

export interface ApiUsageSessionSummaryDto {
  sessionId: string;
  parentSessionId?: string;
  agent?: string;
  agentId?: string;
  direct: ApiUsageTotalsDto;
  subtree: ApiUsageTotalsDto;
  models: ApiUsageModelSummaryDto[];
}

export interface ApiUsageStatisticsDto {
  rootSessionId: string;
  total: ApiUsageTotalsDto;
  sessions: ApiUsageSessionSummaryDto[];
  partial: boolean;
  warnings: Array<{
    sessionId: string;
    agentId?: string;
    reason: "unreadable-descendant";
  }>;
}

export type CompactionStateDto = "idle" | "queued" | "running";

export interface CompactionPolicyDto {
  triggerPercent: number;
  enabled: boolean;
}

export interface CompactionSettingsDto {
  triggerPercent: number;
  globalEnabled: boolean;
}

export interface CompactionSettingsPatchDto {
  triggerPercent: number;
}

export interface ApiUsageSettingsDto {
  showApiUsageDetails: boolean;
}

export type ApiUsageSettingsPatchDto = ApiUsageSettingsDto;

export interface CompactionRequestResultDto {
  state: "queued" | "running";
}

export interface SessionStatsChangedEventDto {
  type: "session_stats_changed";
  contextUsage?: ContextUsageDto;
  compactionPolicy: CompactionPolicyDto;
}

export interface RuntimeConfigurationAppliedEvent {
  type: "runtime_configuration_applied";
  generation: number;
}

export interface ApiUsageChangedEventDto {
  type: "api_usage_changed";
  statistics: ApiUsageStatisticsDto;
}

export interface CompactionStateChangedEventDto {
  type: "compaction_state_changed";
  state: CompactionStateDto;
}

export interface SkillCommandDto {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  /** Skills only: use `/skill:<name>` because another command owns the short form. */
  requiresPrefix?: boolean;
}

export interface WebTreeEntryDto {
  id: string;
  parentId: string | null;
  /** Mirrors the transcript bubble roles; non-bubble entries map to `other`. */
  role: "user" | "assistant" | "other";
  kind:
    | "user"
    | "assistant"
    | "tool"
    | "bash"
    | "message"
    | "custom-message"
    | "compaction"
    | "branch-summary"
    | "model-change"
    | "thinking-change"
    | "session-info"
    | "custom"
    | "label"
    | "other";
  text: string;
  label?: string;
  labelTimestamp?: string;
  stopReason?: string;
  errorMessage?: string;
  tokensBefore?: number;
  /** Compaction entries only: the kept context starts at this entry. */
  firstKeptEntryId?: string;
}

export interface SessionTreeDto {
  tree: WebTreeEntryDto[];
  leafId: string | null;
  filterMode: "default" | "no-tools" | "user-only" | "labeled-only" | "all";
  skipBranchSummaryPrompt: boolean;
}

export interface TreeNavigationOptionsDto {
  summarize?: boolean;
  customInstructions?: string;
}

export interface TreeNavigationResultDto {
  cancelled: boolean;
  editorText?: string;
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
  timeline: TranscriptTimelineEntryDto[];
  inlineUsage?: ApiUsageRecordDto[];
  subagents: SubagentSessionSummaryDto[];
}

export interface DirectoryEntryDto {
  name: string;
  path: string;
}

export interface DirectoryListingDto {
  path: string;
  entries: DirectoryEntryDto[];
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
  skillsChanged: boolean;
  runtimeChanged: boolean;
  availabilityEpoch?: number;
  availabilityChanged?: true;
  /** Present only when ADR-098 display state changed after startup. */
  apiUsageChanged?: true;
  projectWatchLeaseId?: string;
}

export interface ConfigurationErrorEvent {
  type: "config.error";
  generation: number;
  availabilityEpoch?: number;
  message: string;
  projectWatchLeaseId?: string;
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
  modelRepair?: {
    requested: string;
    applied?: string;
    inherited: boolean;
  };
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
  available: boolean;
  authRequired: boolean;
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
  noAuth?: true;
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
