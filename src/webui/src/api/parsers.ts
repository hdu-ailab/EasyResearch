import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  ActiveSessionDto,
  AgentDto,
  AgentEffectiveModelDto,
  ChildSessionSnapshotDto,
  ConfigEntryDto,
  DirectoryEntryDto,
  FileContentDto,
  FileEntryDto,
  SessionSnapshotDto,
  SessionSummaryDto,
  StatusDto,
  SubagentSessionSummaryDto,
  WebuiSettingsDto,
} from "../../../web/contracts";
import type { ConfigFileDto, ConfigProjectsDto } from "../types";

export interface ModelOption {
  provider: string;
  id: string;
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
  const step = optionalNumber(source, "step");
  const latestMessage = optionalString(source, "latestMessage");
  return {
    toolCallId: requiredString(source, "toolCallId"),
    childSessionId: requiredString(source, "childSessionId"),
    agent: requiredString(source, "agent"),
    ...(step !== undefined ? { step } : {}),
    ...(latestMessage !== undefined ? { latestMessage } : {}),
  };
}

function parseMessages(value: unknown): AgentMessage[] {
  if (!Array.isArray(value) || value.some((item) => item === null || typeof item !== "object" || Array.isArray(item))) {
    throw new Error("Invalid API response: messages must be an array of objects");
  }
  return value as AgentMessage[];
}

function parseAgent(value: unknown): AgentDto {
  const source = record(value, "agent");
  const tools = source.tools === undefined ? undefined : stringArray(source.tools, "tools");
  const subagents = source.subagents === undefined ? undefined : stringArray(source.subagents, "subagents");
  const skills = source.skills === undefined ? undefined : stringArray(source.skills, "skills");
  return {
    name: requiredString(source, "name"),
    description: requiredString(source, "description"),
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

export function parseAgents(value: unknown): AgentDto[] {
  return arrayOf(value, "agents", parseAgent);
}

export function parseModels(value: unknown): ModelOption[] {
  const source = record(value, "models");
  return arrayOf(source.models, "models", (item) => {
    const model = record(item, "model");
    return { provider: requiredString(model, "provider"), id: requiredString(model, "id") };
  });
}

export function parseWebuiSettings(value: unknown): WebuiSettingsDto {
  const source = record(value, "Web UI settings");
  const models = record(source.agentModels, "agentModels");
  const agentModels: Record<string, string> = {};
  for (const [name, model] of Object.entries(models)) {
    if (typeof model !== "string") throw new Error(`Invalid API response: agentModels.${name} must be a string`);
    agentModels[name] = model;
  }
  const orchestratorModel = source.orchestratorModel;
  const effectiveOrchestratorModel = source.effectiveOrchestratorModel;
  if (orchestratorModel !== null && typeof orchestratorModel !== "string") {
    throw new Error("Invalid API response: orchestratorModel must be a string or null");
  }
  if (effectiveOrchestratorModel !== null && typeof effectiveOrchestratorModel !== "string") {
    throw new Error("Invalid API response: effectiveOrchestratorModel must be a string or null");
  }
  return { agentModels, orchestratorModel, effectiveOrchestratorModel };
}

export function parseEffectiveModels(value: unknown): AgentEffectiveModelDto[] {
  return arrayOf(value, "effective models", (item) => {
    const source = record(item, "effective model");
    const model = source.model;
    if (model !== null && typeof model !== "string")
      throw new Error("Invalid API response: model must be a string or null");
    if (
      source.source !== "override" &&
      source.source !== "project" &&
      source.source !== "global" &&
      source.source !== "inherit"
    ) {
      throw new Error("Invalid API response: model source is invalid");
    }
    return { name: requiredString(source, "name"), model, source: source.source };
  });
}

export function parseDirectories(value: unknown): DirectoryEntryDto[] {
  const source = record(value, "directories");
  return arrayOf(source.entries, "directory entries", parseDirectoryEntry);
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
  return {
    session: parseActiveSessionValue(source.session),
    messages: parseMessages(source.messages),
    subagents: arrayOf(source.subagents, "subagents", parseSubagentSummary),
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
