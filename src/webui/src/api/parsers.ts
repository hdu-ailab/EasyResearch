import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { privateSubagentEventDataReason } from "../../../subagent/notifications";
import { isThinkingLevel } from "../../../thinking-levels";
import type {
  ActiveSessionDto,
  AgentDto,
  AgentResourceDto,
  ApiUsageChangedEventDto,
  ApiUsageDto,
  ApiUsageModelSummaryDto,
  ApiUsageRecordDto,
  ApiUsageSessionSummaryDto,
  ApiUsageSettingsDto,
  ApiUsageStatisticsDto,
  ApiUsageTotalsDto,
  AuthFlowEventDto,
  AuthProviderInfoDto,
  ChildSessionSnapshotDto,
  CompactionPolicyDto,
  CompactionRequestResultDto,
  CompactionSettingsDto,
  CompactionStateChangedEventDto,
  CompactionStateDto,
  ConfigEntryDto,
  ConfigurationEvent,
  ContextUsageDto,
  DirectoryEntryDto,
  DirectoryListingDto,
  FileContentDto,
  FileEntryDto,
  SessionSnapshotDto,
  SessionStatsChangedEventDto,
  SessionSummaryDto,
  SessionTreeDto,
  SkillCommandDto,
  StatusDto,
  SubagentSessionSummaryDto,
  SubagentSupervisorEventDto,
  TreeNavigationResultDto,
  UpdateCheckDto,
  WebTreeEntryDto,
} from "../../../web/contracts";
import type { ConfigFileDto, ConfigProjectsDto } from "../types";

export interface ModelOption {
  provider: string;
  id: string;
  reasoning: boolean;
  thinkingLevelMap?: Record<string, string | null>;
}

type RecordValue = Record<string, unknown>;

function record(value: unknown, label: string): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid API response: ${label} must be an object`);
  }
  return value as RecordValue;
}

function requiredString(source: RecordValue, key: string): string {
  const value = source[key];
  if (typeof value !== "string") throw new Error(`Invalid API response: ${key} must be a string`);
  return value;
}

function optionalString(source: RecordValue, key: string): string | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`Invalid API response: ${key} must be a string`);
  return value;
}

function requiredIdentityString(source: RecordValue, key: string): string {
  const value = requiredString(source, key);
  if (!value.trim()) throw new Error(`Invalid API response: ${key} must not be empty`);
  return value;
}

function optionalIdentityString(source: RecordValue, key: string): string | undefined {
  const value = optionalString(source, key);
  if (value !== undefined && !value.trim()) {
    throw new Error(`Invalid API response: ${key} must not be empty`);
  }
  return value;
}

function rejectSessionPath(source: RecordValue, label: string): void {
  if ("sessionPath" in source || "session_path" in source) {
    throw new Error(`Invalid API response: ${label} must not contain a session path`);
  }
}

function requiredBoolean(source: RecordValue, key: string): boolean {
  const value = source[key];
  if (typeof value !== "boolean") throw new Error(`Invalid API response: ${key} must be a boolean`);
  return value;
}

function requiredNumber(source: RecordValue, key: string): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid API response: ${key} must be a number`);
  }
  return value;
}

function optionalNumber(source: RecordValue, key: string): number | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid API response: ${key} must be a number`);
  }
  return value;
}

function nullableNumber(source: RecordValue, key: string): number | null {
  const value = source[key];
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid API response: ${key} must be a number or null`);
  }
  return value;
}

function parseContextUsage(value: unknown): ContextUsageDto {
  const source = record(value, "context usage");
  return {
    tokens: nullableNumber(source, "tokens"),
    contextWindow: requiredNumber(source, "contextWindow"),
    percent: nullableNumber(source, "percent"),
  };
}

function parseCompactionState(value: unknown): CompactionStateDto {
  if (value !== "idle" && value !== "queued" && value !== "running") {
    throw new Error("Invalid API response: compactionState must be idle, queued, or running");
  }
  return value;
}

function parseCompactionPolicy(value: unknown): CompactionPolicyDto {
  const source = record(value, "compaction policy");
  const triggerPercent = requiredNumber(source, "triggerPercent");
  if (!Number.isSafeInteger(triggerPercent) || triggerPercent < 10 || triggerPercent > 90) {
    throw new Error("Invalid API response: triggerPercent must be an integer from 10 through 90");
  }
  return {
    triggerPercent,
    enabled: requiredBoolean(source, "enabled"),
  };
}

export function parseCompactionSettings(value: unknown): CompactionSettingsDto {
  const source = record(value, "compaction settings");
  const triggerPercent = requiredNumber(source, "triggerPercent");
  if (!Number.isSafeInteger(triggerPercent) || triggerPercent < 10 || triggerPercent > 90) {
    throw new Error("Invalid API response: triggerPercent must be an integer from 10 through 90");
  }
  return {
    triggerPercent,
    globalEnabled: requiredBoolean(source, "globalEnabled"),
  };
}

export function parseCompactionRequestResult(value: unknown): CompactionRequestResultDto {
  const source = record(value, "compaction result");
  const state = parseCompactionState(source.state);
  if (state === "idle") throw new Error("Invalid API response: accepted compaction state cannot be idle");
  return { state };
}

export function parseApiUsageSettings(value: unknown): ApiUsageSettingsDto {
  const source = record(value, "API usage settings");
  return { showApiUsageDetails: requiredBoolean(source, "showApiUsageDetails") };
}

function parseApiUsage(value: unknown): ApiUsageDto {
  const source = record(value, "API usage");
  const cost = record(source.cost, "API usage cost");
  const cacheWrite1h = optionalNumber(source, "cacheWrite1h");
  const reasoning = optionalNumber(source, "reasoning");
  return {
    input: requiredNumber(source, "input"),
    output: requiredNumber(source, "output"),
    cacheRead: requiredNumber(source, "cacheRead"),
    cacheWrite: requiredNumber(source, "cacheWrite"),
    ...(cacheWrite1h === undefined ? {} : { cacheWrite1h }),
    ...(reasoning === undefined ? {} : { reasoning }),
    totalTokens: requiredNumber(source, "totalTokens"),
    cacheHitRate: nullableNumber(source, "cacheHitRate"),
    cost: {
      input: requiredNumber(cost, "input"),
      output: requiredNumber(cost, "output"),
      cacheRead: requiredNumber(cost, "cacheRead"),
      cacheWrite: requiredNumber(cost, "cacheWrite"),
      total: requiredNumber(cost, "total"),
    },
  };
}

function parseApiUsageTotals(value: unknown): ApiUsageTotalsDto {
  const source = record(value, "API usage totals");
  const cost = record(source.cost, "API usage total cost");
  return {
    records: requiredNumber(source, "records"),
    input: requiredNumber(source, "input"),
    output: requiredNumber(source, "output"),
    cacheRead: requiredNumber(source, "cacheRead"),
    cacheWrite: requiredNumber(source, "cacheWrite"),
    cacheWrite1h: requiredNumber(source, "cacheWrite1h"),
    reasoning: requiredNumber(source, "reasoning"),
    totalTokens: requiredNumber(source, "totalTokens"),
    cacheHitRate: nullableNumber(source, "cacheHitRate"),
    cost: {
      input: requiredNumber(cost, "input"),
      output: requiredNumber(cost, "output"),
      cacheRead: requiredNumber(cost, "cacheRead"),
      cacheWrite: requiredNumber(cost, "cacheWrite"),
      total: requiredNumber(cost, "total"),
    },
  };
}

export function parseApiUsageRecord(value: unknown): ApiUsageRecordDto {
  const source = record(value, "API usage record");
  const recordSource = source.source;
  if (
    recordSource !== "assistant" &&
    recordSource !== "tool" &&
    recordSource !== "compaction" &&
    recordSource !== "branch-summary"
  )
    throw new Error("Invalid API response: API usage source is invalid");
  const rawAnchor = record(source.anchor, "API usage anchor");
  let anchor: ApiUsageRecordDto["anchor"];
  if (rawAnchor.kind === "message") {
    anchor = { kind: "message", messageEntryId: requiredIdentityString(rawAnchor, "messageEntryId") };
  } else if (rawAnchor.kind === "tool") {
    anchor = { kind: "tool", toolCallId: requiredIdentityString(rawAnchor, "toolCallId") };
  } else if (rawAnchor.kind === "standalone") {
    const afterEntryId = optionalIdentityString(rawAnchor, "afterEntryId");
    anchor = { kind: "standalone", ...(afterEntryId === undefined ? {} : { afterEntryId }) };
  } else {
    throw new Error("Invalid API response: API usage anchor kind is invalid");
  }
  const provider = optionalIdentityString(source, "provider");
  const model = optionalIdentityString(source, "model");
  return {
    id: requiredIdentityString(source, "id"),
    sessionId: requiredIdentityString(source, "sessionId"),
    source: recordSource,
    timestamp: requiredString(source, "timestamp"),
    anchor,
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    usage: parseApiUsage(source.usage),
  };
}

function parseApiUsageModelSummary(value: unknown): ApiUsageModelSummaryDto {
  const source = record(value, "API usage model summary");
  if (source.kind !== "model" && source.kind !== "internal") {
    throw new Error("Invalid API response: API usage model kind is invalid");
  }
  const provider = optionalIdentityString(source, "provider");
  const model = optionalIdentityString(source, "model");
  return {
    key: requiredIdentityString(source, "key"),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    kind: source.kind,
    totals: parseApiUsageTotals(source.totals),
  };
}

function parseApiUsageSessionSummary(value: unknown): ApiUsageSessionSummaryDto {
  const source = record(value, "API usage session summary");
  const parentSessionId = optionalIdentityString(source, "parentSessionId");
  const agent = optionalIdentityString(source, "agent");
  const agentId = optionalIdentityString(source, "agentId");
  return {
    sessionId: requiredIdentityString(source, "sessionId"),
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    ...(agent === undefined ? {} : { agent }),
    ...(agentId === undefined ? {} : { agentId }),
    direct: parseApiUsageTotals(source.direct),
    subtree: parseApiUsageTotals(source.subtree),
    models: arrayOf(source.models, "API usage models", parseApiUsageModelSummary),
  };
}

export function parseApiUsageStatistics(value: unknown): ApiUsageStatisticsDto {
  const source = record(value, "API usage statistics");
  return {
    rootSessionId: requiredIdentityString(source, "rootSessionId"),
    total: parseApiUsageTotals(source.total),
    sessions: arrayOf(source.sessions, "API usage sessions", parseApiUsageSessionSummary),
    partial: requiredBoolean(source, "partial"),
    warnings: arrayOf(source.warnings, "API usage warnings", (warning) => {
      const item = record(warning, "API usage warning");
      rejectSessionPath(item, "API usage warning");
      if (item.reason !== "unreadable-descendant") {
        throw new Error("Invalid API response: API usage warning reason is invalid");
      }
      const agentId = optionalIdentityString(item, "agentId");
      return {
        sessionId: requiredIdentityString(item, "sessionId"),
        ...(agentId === undefined ? {} : { agentId }),
        reason: item.reason,
      };
    }),
  };
}

export function parseApiUsageChangedEvent(value: unknown): ApiUsageChangedEventDto {
  const source = record(value, "API usage changed event");
  if (source.type !== "api_usage_changed") {
    throw new Error("Invalid API response: API usage event type is invalid");
  }
  return { type: "api_usage_changed", statistics: parseApiUsageStatistics(source.statistics) };
}

export function parseSessionStatsChangedEvent(value: unknown): SessionStatsChangedEventDto {
  const source = record(value, "session stats event");
  if (source.type !== "session_stats_changed") {
    throw new Error("Invalid API response: session stats event type is invalid");
  }
  return {
    type: "session_stats_changed",
    ...(source.contextUsage !== undefined ? { contextUsage: parseContextUsage(source.contextUsage) } : {}),
    compactionPolicy: parseCompactionPolicy(source.compactionPolicy),
  };
}

export function parseCompactionStateChangedEvent(value: unknown): CompactionStateChangedEventDto {
  const source = record(value, "compaction state event");
  if (source.type !== "compaction_state_changed") {
    throw new Error("Invalid API response: compaction state event type is invalid");
  }
  return { type: "compaction_state_changed", state: parseCompactionState(source.state) };
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Invalid API response: ${label} must be an array of strings`);
  }
  return value;
}

function arrayOf<T>(value: unknown, label: string, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new Error(`Invalid API response: ${label} must be an array`);
  return value.map(parse);
}

function parseStatusValue(value: unknown): ActiveSessionDto["status"] {
  if (value === "starting" || value === "ready" || value === "running" || value === "stopped" || value === "error") {
    return value;
  }
  throw new Error("Invalid API response: status is invalid");
}

function parseSessionSummary(value: unknown): SessionSummaryDto {
  const source = record(value, "session");
  const name = optionalString(source, "name");
  return {
    id: requiredString(source, "id"),
    path: requiredString(source, "path"),
    cwd: requiredString(source, "cwd"),
    ...(name !== undefined ? { name } : {}),
    created: requiredString(source, "created"),
    modified: requiredString(source, "modified"),
    messageCount: requiredNumber(source, "messageCount"),
    firstMessage: requiredString(source, "firstMessage"),
  };
}

function parseActiveSessionValue(value: unknown): ActiveSessionDto {
  const source = record(value, "active session");
  const sessionFile = optionalString(source, "sessionFile");
  const sessionName = optionalString(source, "sessionName");
  const error = optionalString(source, "error");
  return {
    id: requiredString(source, "id"),
    cwd: requiredString(source, "cwd"),
    ...(sessionFile !== undefined ? { sessionFile } : {}),
    ...(sessionName !== undefined ? { sessionName } : {}),
    isStreaming: requiredBoolean(source, "isStreaming"),
    status: parseStatusValue(source.status),
    ...(error !== undefined ? { error } : {}),
  };
}

function parseDirectoryEntry(value: unknown): DirectoryEntryDto {
  const source = record(value, "directory entry");
  return { name: requiredString(source, "name"), path: requiredString(source, "path") };
}

function parseFileEntry(value: unknown): FileEntryDto {
  const source = record(value, "file entry");
  const entry = parseDirectoryEntry(source);
  if (source.kind !== "file" && source.kind !== "directory") {
    throw new Error("Invalid API response: file entry kind is invalid");
  }
  return { ...entry, kind: source.kind };
}

function parseSubagentSummary(value: unknown): SubagentSessionSummaryDto {
  const source = record(value, "subagent summary");
  rejectSessionPath(source, "subagent summary");
  const step = optionalNumber(source, "step");
  const latestMessage = optionalString(source, "latestMessage");
  const launchId = optionalIdentityString(source, "launchId");
  const agentId = optionalIdentityString(source, "agentId");
  return {
    ownerSessionId: requiredIdentityString(source, "ownerSessionId"),
    toolCallId: requiredIdentityString(source, "toolCallId"),
    childSessionId: requiredIdentityString(source, "childSessionId"),
    agent: requiredIdentityString(source, "agent"),
    status: parseSubagentStatus(source.status),
    ...(launchId !== undefined ? { launchId } : {}),
    ...(agentId !== undefined ? { agentId } : {}),
    ...(step !== undefined ? { step } : {}),
    ...(latestMessage !== undefined ? { latestMessage } : {}),
  };
}

function parseSubagentStatus(value: unknown): SubagentSessionSummaryDto["status"] {
  if (value === "working" || value === "complete" || value === "error") return value;
  throw new Error("Invalid API response: subagent status is invalid");
}

function parseNestedSessionEvent(value: unknown): NonNullable<SubagentSupervisorEventDto["event"]> {
  const source = record(value, "subagent event");
  const privateData = privateSubagentEventDataReason(source);
  if (privateData) throw new Error(`Invalid API response: nested subagent event must not contain a ${privateData}`);
  requiredIdentityString(source, "type");
  if (source.type === "message_update") {
    const update = record(source.assistantMessageEvent, "assistantMessageEvent");
    requiredIdentityString(update, "type");
    if ("partial" in update) {
      throw new Error("Invalid API response: nested message updates must be delta-only");
    }
  }
  return source as NonNullable<SubagentSupervisorEventDto["event"]>;
}

export function parseSubagentSupervisorEvent(value: unknown): SubagentSupervisorEventDto {
  const source = record(value, "subagent supervisor event");
  rejectSessionPath(source, "subagent supervisor event");
  if (source.type !== "subagent_supervisor") {
    throw new Error("Invalid API response: subagent supervisor event type is invalid");
  }
  const latestMessage = optionalString(source, "latestMessage");
  const event = source.event === undefined ? undefined : parseNestedSessionEvent(source.event);
  return {
    type: "subagent_supervisor",
    launchId: requiredIdentityString(source, "launchId"),
    ownerSessionId: requiredIdentityString(source, "ownerSessionId"),
    toolCallId: requiredIdentityString(source, "toolCallId"),
    agent: requiredIdentityString(source, "agent"),
    agentId: requiredIdentityString(source, "agentId"),
    childSessionId: requiredIdentityString(source, "childSessionId"),
    status: parseSubagentStatus(source.status),
    ...(latestMessage !== undefined ? { latestMessage } : {}),
    ...(event !== undefined ? { event } : {}),
  };
}

function parseMessages(value: unknown): AgentMessage[] {
  if (!Array.isArray(value) || value.some((item) => item === null || typeof item !== "object" || Array.isArray(item))) {
    throw new Error("Invalid API response: messages must be an array of objects");
  }
  return value as AgentMessage[];
}

export function parseAgent(value: unknown): AgentDto {
  const source = record(value, "agent");
  if (source.thinking !== undefined && !isThinkingLevel(source.thinking)) {
    throw new Error("Invalid API response: agent thinking is invalid");
  }
  if (source.effectiveModel !== undefined && typeof source.effectiveModel !== "string") {
    throw new Error("Invalid API response: agent effective model is invalid");
  }
  const tools = source.tools === undefined ? undefined : stringArray(source.tools, "tools");
  const subagents = source.subagents === undefined ? undefined : stringArray(source.subagents, "subagents");
  const skills = source.skills === undefined ? undefined : stringArray(source.skills, "skills");
  const effectiveTools =
    source.effectiveTools === undefined ? (tools ?? []) : stringArray(source.effectiveTools, "effectiveTools");
  const effectiveSkills =
    source.effectiveSkills === undefined ? (skills ?? []) : stringArray(source.effectiveSkills, "effectiveSkills");
  const missingSkills = stringArray(source.missingSkills, "missingSkills");
  if (source.source !== "global" && source.source !== "bundled") {
    throw new Error("Invalid API response: agent source is invalid");
  }
  return {
    name: requiredString(source, "name"),
    description: requiredString(source, "description"),
    enabled: source.enabled !== false,
    builtin: source.builtin === true,
    source: source.source,
    filePath: typeof source.filePath === "string" ? source.filePath : "",
    ...(typeof source.model === "string" ? { model: source.model } : {}),
    ...(typeof source.effectiveModel === "string" ? { effectiveModel: source.effectiveModel } : {}),
    ...(isThinkingLevel(source.thinking) ? { thinking: source.thinking } : {}),
    effectiveTools,
    effectiveSkills,
    missingSkills,
    ...(tools !== undefined ? { tools } : {}),
    ...(subagents !== undefined ? { subagents } : {}),
    ...(skills !== undefined ? { skills } : {}),
  };
}

export function parseStatus(value: unknown): StatusDto {
  const source = record(value, "status");
  return {
    agentDir: requiredString(source, "agentDir"),
    homeDir: requiredString(source, "homeDir"),
    sessions: arrayOf(source.sessions, "sessions", parseSessionSummary),
    activeSessions: arrayOf(source.activeSessions, "activeSessions", parseActiveSessionValue),
  };
}

export function parseUpdateCheck(value: unknown): UpdateCheckDto {
  const source = record(value, "update check");
  const latestVersion = source.latestVersion;
  if (latestVersion !== null && typeof latestVersion !== "string") {
    throw new Error("Invalid API response: latestVersion must be a string or null");
  }
  return { latestVersion };
}

export function parseAgents(value: unknown): AgentDto[] {
  return arrayOf(value, "agents", parseAgent);
}

export function parseConfigurationEvent(value: unknown): ConfigurationEvent {
  const source = record(value, "configuration event");
  const generation = requiredNumber(source, "generation");
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error("Invalid API response: generation must be a non-negative integer");
  }
  if (source.type === "config.updated") {
    return {
      type: "config.updated",
      generation,
      agentsChanged: requiredBoolean(source, "agentsChanged"),
      modelsChanged: requiredBoolean(source, "modelsChanged"),
    };
  }
  if (source.type === "config.error") {
    return { type: "config.error", generation, message: requiredString(source, "message") };
  }
  throw new Error("Invalid API response: configuration event type is invalid");
}

export function parseAgentResource(value: unknown): AgentResourceDto {
  const agent = parseAgent(value);
  const source = record(value, "agent resource");
  return { ...agent, ...(typeof source.content === "string" ? { content: source.content } : {}) };
}

export function parseAgentResources(value: unknown): AgentResourceDto[] {
  return arrayOf(value, "agent resources", parseAgentResource);
}

export function parseSkillResource(value: unknown) {
  const source = record(value, "skill resource");
  return {
    name: requiredString(source, "name"),
    source: requiredString(source, "source") as "bundled" | "global" | "project" | "home",
    path: requiredString(source, "path"),
    skillPath: requiredString(source, "skillPath"),
    ...(typeof source.content === "string" ? { content: source.content } : {}),
  };
}

export function parseSkillResources(value: unknown) {
  return arrayOf(value, "skill resources", parseSkillResource);
}

export function parseModels(value: unknown): ModelOption[] {
  const source = record(value, "models");
  return arrayOf(source.models, "models", (item) => {
    const model = record(item, "model");
    const thinkingLevelMap = optionalThinkingLevelMap(model.thinkingLevelMap);
    return {
      provider: requiredString(model, "provider"),
      id: requiredString(model, "id"),
      reasoning: requiredBoolean(model, "reasoning"),
      ...(thinkingLevelMap !== undefined ? { thinkingLevelMap } : {}),
    };
  });
}

function optionalThinkingLevelMap(value: unknown): Record<string, string | null> | undefined {
  if (value === undefined) return undefined;
  const source = record(value, "thinkingLevelMap");
  const map: Record<string, string | null> = {};
  for (const [level, mapped] of Object.entries(source)) {
    if (mapped !== null && typeof mapped !== "string") {
      throw new Error(`Invalid API response: thinkingLevelMap.${level} must be a string or null`);
    }
    map[level] = mapped;
  }
  return map;
}

export function parseDirectories(value: unknown): DirectoryListingDto {
  const source = record(value, "directories");
  return {
    path: requiredString(source, "path"),
    entries: arrayOf(source.entries, "directory entries", parseDirectoryEntry),
  };
}

export function parseDirectoryRoots(value: unknown): DirectoryEntryDto[] {
  const source = record(value, "directory roots");
  return arrayOf(source.roots, "directory roots", parseDirectoryEntry);
}

export function parseEntries(value: unknown): FileEntryDto[] {
  const source = record(value, "entries");
  return arrayOf(source.entries, "file entries", parseFileEntry);
}

export function parseFileContent(value: unknown): FileContentDto {
  const source = record(value, "file content");
  return {
    path: requiredString(source, "path"),
    content: requiredString(source, "content"),
    byteCount: requiredNumber(source, "byteCount"),
    truncated: requiredBoolean(source, "truncated"),
    binary: requiredBoolean(source, "binary"),
  };
}

export function parseActiveSession(value: unknown): ActiveSessionDto {
  return parseActiveSessionValue(value);
}

export function parseSessionSnapshot(value: unknown): SessionSnapshotDto {
  const source = record(value, "session snapshot");
  const steering = source.steering;
  const contextUsage = source.contextUsage;
  const compactionState = source.compactionState;
  const fileWatchLeaseId = optionalString(source, "fileWatchLeaseId");
  const inlineUsage = source.inlineUsage;
  const apiUsage = source.apiUsage;
  return {
    session: parseActiveSessionValue(source.session),
    messages: parseMessages(source.messages),
    subagents: arrayOf(source.subagents, "subagents", parseSubagentSummary),
    ...(inlineUsage === undefined
      ? {}
      : { inlineUsage: arrayOf(inlineUsage, "inline API usage", parseApiUsageRecord) }),
    ...(apiUsage === undefined ? {} : { apiUsage: parseApiUsageStatistics(apiUsage) }),
    ...(steering !== undefined ? { steering: stringArray(steering, "steering") } : {}),
    ...(contextUsage !== undefined ? { contextUsage: parseContextUsage(contextUsage) } : {}),
    compactionPolicy: parseCompactionPolicy(source.compactionPolicy),
    ...(compactionState !== undefined ? { compactionState: parseCompactionState(compactionState) } : {}),
    ...(fileWatchLeaseId !== undefined ? { fileWatchLeaseId } : {}),
  };
}

export function parseChildSnapshot(value: unknown): ChildSessionSnapshotDto {
  const source = record(value, "child session snapshot");
  const session = record(source.session, "child session");
  const sessionName = optionalString(session, "sessionName");
  return {
    session: {
      id: requiredString(session, "id"),
      cwd: requiredString(session, "cwd"),
      ...(sessionName !== undefined ? { sessionName } : {}),
    },
    messages: parseMessages(source.messages),
    ...(source.inlineUsage === undefined
      ? {}
      : { inlineUsage: arrayOf(source.inlineUsage, "inline API usage", parseApiUsageRecord) }),
    subagents: arrayOf(source.subagents, "subagents", parseSubagentSummary),
  };
}

export function parseConfigEntries(value: unknown): ConfigEntryDto[] {
  return arrayOf(value, "config entries", (item) => {
    const source = record(item, "config entry");
    if (source.type !== "file" && source.type !== "directory")
      throw new Error("Invalid API response: config entry type is invalid");
    return { name: requiredString(source, "name"), path: requiredString(source, "path"), type: source.type };
  });
}

export function parseConfigProjects(value: unknown): ConfigProjectsDto {
  const source = record(value, "config projects");
  return {
    home: requiredString(source, "home"),
    projects: arrayOf(source.projects, "projects", (item) => ({ cwd: requiredString(record(item, "project"), "cwd") })),
  };
}

export function parseConfigFile(value: unknown): ConfigFileDto {
  const source = record(value, "config file");
  return { path: requiredString(source, "path"), content: requiredString(source, "content") };
}

// ---- Provider auth (ADR-065) ---------------------------------------------

export function parseAuthProviderList(body: unknown): AuthProviderInfoDto[] {
  const obj = record(body, "authProviders");
  return arrayOf(obj.providers, "providers", (item) => {
    const r = record(item, "provider");
    const statusRecord = record(r.authStatus, "authStatus");
    const authMethods = arrayOf(r.authMethods, "authMethods", (m) => {
      if (m !== "api_key" && m !== "oauth") {
        throw new Error("Invalid API response: authMethods entry must be api_key or oauth");
      }
      return m;
    });
    return {
      id: requiredString(r, "id"),
      name: requiredString(r, "name"),
      authMethods,
      connectable: requiredBoolean(r, "connectable"),
      authStatus: {
        configured: requiredBoolean(statusRecord, "configured"),
        ...(typeof statusRecord.source === "string" ? { source: statusRecord.source } : {}),
      },
      ...(typeof r.source === "string" ? { source: r.source } : {}),
      ...(typeof r.hint === "string" ? { hint: r.hint } : {}),
      modelsJson: r.modelsJson === true,
    } satisfies AuthProviderInfoDto;
  });
}

export function parseAuthLoginResponse(body: unknown): { flowId: string } {
  const r = record(body, "authLogin");
  return { flowId: requiredString(r, "flowId") };
}

function parsePromptOptions(value: unknown): { id: string; label: string; description?: string }[] {
  return arrayOf(value, "prompt options", (item) => {
    const r = record(item, "prompt option");
    return {
      id: requiredString(r, "id"),
      label: requiredString(r, "label"),
      ...(typeof r.description === "string" ? { description: r.description } : {}),
    };
  });
}

export function parseAuthFlowEvent(body: unknown): AuthFlowEventDto {
  const r = record(body, "authFlowEvent");
  const t = requiredString(r, "type");
  if (t === "prompt") {
    const kind = requiredString(r, "kind");
    if (kind !== "text" && kind !== "secret" && kind !== "select" && kind !== "manual_code") {
      throw new Error("Invalid API response: prompt kind is invalid");
    }
    return {
      type: "prompt",
      kind,
      message: requiredString(r, "message"),
      ...(typeof r.placeholder === "string" ? { placeholder: r.placeholder } : {}),
      ...(kind === "select" ? { options: parsePromptOptions(r.options) } : {}),
    } as AuthFlowEventDto;
  }
  if (t === "notify") {
    const e = record(r.event, "notify.event");
    const kind = requiredString(e, "kind");
    if (kind === "info") {
      return {
        type: "notify",
        event: {
          kind: "info",
          message: requiredString(e, "message"),
          ...(Array.isArray(e.links)
            ? {
                links: arrayOf(e.links, "links", (link) => {
                  const lr = record(link, "link");
                  return {
                    url: requiredString(lr, "url"),
                    ...(typeof lr.label === "string" ? { label: lr.label } : {}),
                  };
                }),
              }
            : {}),
        },
      } as AuthFlowEventDto;
    }
    if (kind === "auth_url") {
      return {
        type: "notify",
        event: {
          kind: "auth_url",
          url: requiredString(e, "url"),
          ...(typeof e.instructions === "string" ? { instructions: e.instructions } : {}),
        },
      } as AuthFlowEventDto;
    }
    if (kind === "device_code") {
      return {
        type: "notify",
        event: {
          kind: "device_code",
          userCode: requiredString(e, "userCode"),
          verificationUri: requiredString(e, "verificationUri"),
          ...(typeof e.intervalSeconds === "number" ? { intervalSeconds: e.intervalSeconds } : {}),
          ...(typeof e.expiresInSeconds === "number" ? { expiresInSeconds: e.expiresInSeconds } : {}),
        },
      } as AuthFlowEventDto;
    }
    if (kind === "progress") {
      return {
        type: "notify",
        event: { kind: "progress", message: requiredString(e, "message") },
      } as AuthFlowEventDto;
    }
    throw new Error(`Invalid API response: unknown notify kind ${kind}`);
  }
  if (t === "done") {
    const c = record(r.credential, "done.credential");
    const cType = requiredString(c, "type");
    if (cType === "api_key") {
      return {
        type: "done",
        credential: { type: "api_key" },
        ...(typeof r.warning === "string" ? { warning: r.warning } : {}),
      } as AuthFlowEventDto;
    }
    if (cType === "oauth") {
      return {
        type: "done",
        credential: { type: "oauth", expires: requiredNumber(c, "expires") },
        ...(typeof r.warning === "string" ? { warning: r.warning } : {}),
      } as AuthFlowEventDto;
    }
    throw new Error(`Invalid API response: unknown credential type ${cType}`);
  }
  if (t === "error") {
    const reason = r.reason;
    if (reason !== undefined && reason !== "aborted" && reason !== "timeout" && reason !== "reject") {
      throw new Error("Invalid API response: error reason is invalid");
    }
    return {
      type: "error",
      message: requiredString(r, "message"),
      ...(typeof reason === "string" ? { reason: reason } : {}),
    } as AuthFlowEventDto;
  }
  throw new Error(`Invalid API response: unknown auth flow event type ${t}`);
}

export function parseSkillCommands(value: unknown): SkillCommandDto[] {
  const body = record(value, "commands");
  const list = body.commands;
  if (!Array.isArray(list)) return [];
  const out: SkillCommandDto[] = [];
  for (const item of list) {
    const entry = record(item, "command");
    if (typeof entry.name !== "string" || !entry.name) continue;
    const description = optionalString(entry, "description");
    const source = entry.source;
    if (entry.requiresPrefix !== undefined && typeof entry.requiresPrefix !== "boolean") {
      throw new Error("Invalid API response: command.requiresPrefix must be a boolean");
    }
    out.push({
      name: entry.name,
      source: source === "extension" || source === "prompt" || source === "skill" ? source : "skill",
      ...(description !== undefined ? { description } : {}),
      ...(typeof entry.requiresPrefix === "boolean" ? { requiresPrefix: entry.requiresPrefix } : {}),
    });
  }
  return out;
}

export function parseSessionTree(value: unknown): SessionTreeDto {
  const body = record(value, "tree");
  const list = body.tree;
  const tree: WebTreeEntryDto[] = [];
  if (Array.isArray(list)) {
    for (const item of list) {
      const entry = record(item, "tree entry");
      if (typeof entry.id !== "string" || !entry.id) continue;
      const parentId = entry.parentId;
      if (parentId !== null && typeof parentId !== "string") continue;
      const role = entry.role;
      if (role !== "user" && role !== "assistant" && role !== "other") continue;
      const kind = entry.kind;
      if (!isTreeEntryKind(kind)) continue;
      const text = entry.text;
      if (typeof text !== "string") continue;
      const firstKeptEntryId = entry.firstKeptEntryId;
      if (firstKeptEntryId !== undefined && typeof firstKeptEntryId !== "string") continue;
      const label = optionalString(entry, "label");
      const labelTimestamp = optionalString(entry, "labelTimestamp");
      const stopReason = optionalString(entry, "stopReason");
      const errorMessage = optionalString(entry, "errorMessage");
      const tokensBefore = optionalNumber(entry, "tokensBefore");
      tree.push({
        id: entry.id,
        parentId: parentId as string | null,
        role,
        kind,
        text,
        ...(label !== undefined ? { label } : {}),
        ...(labelTimestamp !== undefined ? { labelTimestamp } : {}),
        ...(stopReason !== undefined ? { stopReason } : {}),
        ...(errorMessage !== undefined ? { errorMessage } : {}),
        ...(tokensBefore !== undefined ? { tokensBefore } : {}),
        ...(typeof firstKeptEntryId === "string" ? { firstKeptEntryId } : {}),
      });
    }
  }
  const leafId = body.leafId;
  const filterMode = isTreeFilterMode(body.filterMode) ? body.filterMode : "default";
  return {
    tree,
    leafId: typeof leafId === "string" ? leafId : null,
    filterMode,
    skipBranchSummaryPrompt: body.skipBranchSummaryPrompt === true,
  };
}

export function parseTreeNavigationResult(value: unknown): TreeNavigationResultDto {
  const body = record(value, "tree navigation");
  const editorText = optionalString(body, "editorText");
  const leafId = body.leafId;
  if (leafId !== null && typeof leafId !== "string") {
    throw new Error("Invalid API response: tree navigation leafId is invalid");
  }
  return {
    cancelled: requiredBoolean(body, "cancelled"),
    ...(editorText !== undefined ? { editorText } : {}),
    leafId,
  };
}

function isTreeFilterMode(value: unknown): value is SessionTreeDto["filterMode"] {
  return (
    value === "default" || value === "no-tools" || value === "user-only" || value === "labeled-only" || value === "all"
  );
}

function isTreeEntryKind(value: unknown): value is WebTreeEntryDto["kind"] {
  return (
    value === "user" ||
    value === "assistant" ||
    value === "tool" ||
    value === "bash" ||
    value === "message" ||
    value === "custom-message" ||
    value === "compaction" ||
    value === "branch-summary" ||
    value === "model-change" ||
    value === "thinking-change" ||
    value === "session-info" ||
    value === "custom" ||
    value === "label" ||
    value === "other"
  );
}
