import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  ActiveSessionDto,
  AgentDto,
  AgentEffectiveModelDto,
  AgentEffectiveThinkingDto,
  AgentResourceDto,
  AuthFlowEventDto,
  AuthProviderInfoDto,
  ChildSessionSnapshotDto,
  ConfigEntryDto,
  DirectoryEntryDto,
  FileContentDto,
  FileEntryDto,
  SessionSnapshotDto,
  SessionSummaryDto,
  SessionTreeDto,
  SkillCommandDto,
  StatusDto,
  SubagentSessionSummaryDto,
  WebTreeEntryDto,
  WebuiSettingsDto,
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
  const effectiveTools =
    source.effectiveTools === undefined ? (tools ?? []) : stringArray(source.effectiveTools, "effectiveTools");
  const effectiveSkills =
    source.effectiveSkills === undefined ? (skills ?? []) : stringArray(source.effectiveSkills, "effectiveSkills");
  const missingSkills = stringArray(source.missingSkills, "missingSkills");
  return {
    name: requiredString(source, "name"),
    description: requiredString(source, "description"),
    enabled: source.enabled !== false,
    builtin: source.builtin === true,
    source:
      source.source === "project" || source.source === "global" || source.source === "bundled"
        ? source.source
        : "global",
    filePath: typeof source.filePath === "string" ? source.filePath : "",
    ...(typeof source.model === "string" ? { model: source.model } : {}),
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

export function parseAgents(value: unknown): AgentDto[] {
  return arrayOf(value, "agents", parseAgent);
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

export function parseWebuiSettings(value: unknown): WebuiSettingsDto {
  const source = record(value, "Web UI settings");
  const models = record(source.agentModels, "agentModels");
  const agentModels: Record<string, string> = {};
  for (const [name, model] of Object.entries(models)) {
    if (typeof model !== "string") throw new Error(`Invalid API response: agentModels.${name} must be a string`);
    agentModels[name] = model;
  }
  const thinking = record(source.agentThinking, "agentThinking");
  const agentThinking: Record<string, string> = {};
  for (const [name, level] of Object.entries(thinking)) {
    if (typeof level !== "string") throw new Error(`Invalid API response: agentThinking.${name} must be a string`);
    agentThinking[name] = level;
  }
  const paperAssistantModel = source.paperAssistantModel;
  const effectivePaperAssistantModel = source.effectivePaperAssistantModel;
  const paperAssistantThinking = source.paperAssistantThinking;
  if (paperAssistantModel !== null && typeof paperAssistantModel !== "string") {
    throw new Error("Invalid API response: paperAssistantModel must be a string or null");
  }
  if (effectivePaperAssistantModel !== null && typeof effectivePaperAssistantModel !== "string") {
    throw new Error("Invalid API response: effectivePaperAssistantModel must be a string or null");
  }
  if (paperAssistantThinking !== null && typeof paperAssistantThinking !== "string") {
    throw new Error("Invalid API response: paperAssistantThinking must be a string or null");
  }
  return {
    agentModels,
    paperAssistantModel,
    effectivePaperAssistantModel,
    agentThinking,
    paperAssistantThinking,
  };
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

export function parseEffectiveThinking(value: unknown): AgentEffectiveThinkingDto[] {
  return arrayOf(value, "effective thinking", (item) => {
    const source = record(item, "effective thinking");
    const thinking = source.thinking;
    if (thinking !== null && typeof thinking !== "string")
      throw new Error("Invalid API response: thinking must be a string or null");
    if (source.source !== "override" && source.source !== "default" && source.source !== "inherit") {
      throw new Error("Invalid API response: thinking source is invalid");
    }
    return { name: requiredString(source, "name"), thinking, source: source.source };
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
    out.push({ name: entry.name, ...(description !== undefined ? { description } : {}) });
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
      const text = entry.text;
      if (typeof text !== "string") continue;
      const firstKeptEntryId = entry.firstKeptEntryId;
      if (firstKeptEntryId !== undefined && typeof firstKeptEntryId !== "string") continue;
      tree.push({
        id: entry.id,
        parentId: parentId as string | null,
        role,
        text,
        ...(typeof firstKeptEntryId === "string" ? { firstKeptEntryId } : {}),
      });
    }
  }
  const leafId = body.leafId;
  return { tree, leafId: typeof leafId === "string" ? leafId : null };
}
