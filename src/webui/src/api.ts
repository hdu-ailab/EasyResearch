import type {
  ActiveSessionDto,
  AgentConfigurationPatch,
  AgentDto,
  AgentResourceDto,
  AuthProviderInfoDto,
  ChildSessionSnapshotDto,
  ConfigEntryDto,
  ConfigScope,
  ConfigurationEvent,
  DirectoryEntryDto,
  FileContentDto,
  FileEntryDto,
  SessionSnapshotDto,
  SessionTreeDto,
  SkillCommandDto,
  StatusDto,
  UpdateCheckDto,
} from "../../web/contracts";
import {
  type ModelOption,
  parseActiveSession,
  parseAgentResource,
  parseAgentResources,
  parseAgents,
  parseAuthLoginResponse,
  parseAuthProviderList,
  parseChildSnapshot,
  parseConfigEntries,
  parseConfigFile,
  parseConfigProjects,
  parseConfigurationEvent,
  parseDirectories,
  parseEntries,
  parseFileContent,
  parseModels,
  parseSessionSnapshot,
  parseSessionTree,
  parseSkillCommands,
  parseSkillResource,
  parseSkillResources,
  parseStatus,
  parseUpdateCheck,
} from "./api/parsers";
import { routes } from "./api/routes";
import {
  ApiError,
  type AuthFlowHandlers,
  connectAuthFlow,
  connectEventStream,
  requestJson,
  requestVoid,
  type SessionEventHandlers,
} from "./api/transport";

export type { AuthFlowHandlers, SessionEventHandlers } from "./api/transport";
export { ApiError } from "./api/transport";

export function isUnknownSession(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

function json(method: "POST" | "PUT" | "PATCH", body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export function listStatus(): Promise<StatusDto> {
  return requestJson(routes.status(), parseStatus);
}

export function checkForUpdate(): Promise<UpdateCheckDto> {
  return requestJson(routes.updateCheck(), parseUpdateCheck);
}

export function listAgents(cwd?: string): Promise<AgentDto[]> {
  return requestJson(routes.agents(cwd), parseAgents);
}

export function patchAgent(name: string, patch: AgentConfigurationPatch): Promise<AgentDto> {
  return requestJson(routes.agentConfiguration(name), parseAgentResource, json("PATCH", patch));
}

export function listAgentResources(): Promise<AgentResourceDto[]> {
  return requestJson(routes.agentResources(), parseAgentResources);
}
export function readAgentResource(name: string): Promise<AgentResourceDto> {
  return requestJson(routes.agentResource(name), parseAgentResource);
}
export function writeAgentResource(name: string, content: string): Promise<AgentResourceDto> {
  return requestJson(routes.agentResource(name), parseAgentResource, json("PUT", { content }));
}
export function createAgentResource(name: string): Promise<AgentResourceDto> {
  return requestJson(routes.agentResources(), parseAgentResource, json("POST", { name }));
}
export function listSkillResources() {
  return requestJson(routes.skillResources(), parseSkillResources);
}
export function readSkillResource(name: string) {
  return requestJson(routes.skillResource(name), parseSkillResource);
}
export function writeSkillResource(name: string, content: string) {
  return requestJson(routes.skillResource(name), parseSkillResource, json("PUT", { content }));
}

export function listModels(): Promise<ModelOption[]> {
  return requestJson(routes.models(), parseModels);
}

export function renameSession(id: string, name: string): Promise<void> {
  return requestVoid(routes.sessionName(id), json("PUT", { name }));
}

export function listDirectories(path: string): Promise<DirectoryEntryDto[]> {
  return requestJson(routes.directories(path), parseDirectories);
}

export function createDirectory(path: string): Promise<{ path: string }> {
  return requestJson(
    routes.createDirectory(),
    (value) => {
      if (!value || typeof value !== "object" || typeof (value as { path?: unknown }).path !== "string") {
        throw new Error("Invalid API response: created directory");
      }
      return value as { path: string };
    },
    json("POST", { path }),
  );
}

export function listEntries(path: string): Promise<FileEntryDto[]> {
  return requestJson(routes.entries(path), parseEntries);
}

export function readFileContent(path: string): Promise<FileContentDto> {
  return requestJson(routes.file(path), parseFileContent);
}

/** URL for the MIME-correct, Range-capable raw bytes endpoint. */
export function rawFileUrl(path: string): string {
  return routes.rawFile(path);
}

export function createSession(cwd: string): Promise<ActiveSessionDto> {
  return requestJson(routes.createSession(), parseActiveSession, json("POST", { cwd }));
}

export function openSession(path: string): Promise<ActiveSessionDto> {
  return requestJson(routes.openSession(), parseActiveSession, json("POST", { path }));
}

export function getSnapshot(id: string): Promise<SessionSnapshotDto> {
  return requestJson(routes.snapshot(id), parseSessionSnapshot);
}

export function getChildSnapshot(parentId: string, childId: string): Promise<ChildSessionSnapshotDto> {
  return requestJson(routes.childSnapshot(parentId, childId), parseChildSnapshot);
}

export function sendPrompt(id: string, message: string): Promise<void> {
  return requestVoid(routes.messages(id), json("POST", { message }));
}

export function getSessionCommands(id: string): Promise<SkillCommandDto[]> {
  return requestJson(routes.commands(id), parseSkillCommands);
}

export function getSessionTree(id: string): Promise<SessionTreeDto> {
  return requestJson(routes.tree(id), parseSessionTree);
}

export function navigateSessionTree(id: string, entryId: string): Promise<void> {
  return requestVoid(routes.treeNavigate(id), json("POST", { entryId }));
}

export function abortSession(id: string): Promise<void> {
  return requestVoid(routes.abort(id), { method: "POST" });
}

export function stopSession(id: string): Promise<void> {
  return requestVoid(routes.stop(id), { method: "POST" });
}

export function touchSession(id: string): Promise<void> {
  return requestVoid(routes.touch(id), { method: "POST" });
}

export function restartSession(id: string): Promise<ActiveSessionDto> {
  return requestJson(routes.restart(id), parseActiveSession, { method: "POST" });
}

export function listConfig(scope: ConfigScope, cwd?: string, path?: string): Promise<ConfigEntryDto[]> {
  return requestJson(routes.config(scope, cwd, path), parseConfigEntries);
}

export function listConfigProjects() {
  return requestJson(routes.configProjects(), parseConfigProjects);
}

export function readConfigFile(scope: ConfigScope, cwd?: string, path?: string) {
  return requestJson(routes.configFile(scope, cwd, path), parseConfigFile);
}

export function writeConfigFile(
  scope: ConfigScope,
  cwd: string | undefined,
  path: string,
  content: string,
): Promise<void> {
  return requestVoid(routes.writeConfigFile(), json("PUT", { scope, cwd, path, content }));
}

export function createConfigDirectory(scope: ConfigScope, cwd: string | undefined, path: string): Promise<void> {
  return requestVoid(routes.createConfigDirectory(), json("POST", { scope, cwd, path }));
}

export function connectSessionEvents(id: string, handlers: SessionEventHandlers): () => void {
  return connectEventStream(routes.events(id), handlers);
}

export interface ConfigurationEventHandlers {
  onEvent: (event: ConfigurationEvent) => void;
  onError: () => void;
}

export function connectConfigurationEvents(handlers: ConfigurationEventHandlers): () => void {
  return connectEventStream(routes.configurationEvents(), {
    onEvent: (value) => {
      try {
        handlers.onEvent(parseConfigurationEvent(value));
      } catch {
        handlers.onError();
      }
    },
    onError: handlers.onError,
  });
}

// ---- Provider auth (ADR-065) ---------------------------------------------

export function listAuthProviders(): Promise<AuthProviderInfoDto[]> {
  return requestJson(routes.authProviders(), parseAuthProviderList);
}

export function startAuthFlow(req: { providerId: string; type: "api_key" | "oauth" }): Promise<{ flowId: string }> {
  return requestJson(routes.authLogin(), parseAuthLoginResponse, json("POST", req));
}

export function respondAuthFlow(flowId: string, value: string): Promise<void> {
  return requestVoid(routes.authFlowRespond(flowId), json("POST", { value }));
}

export function cancelAuthFlow(flowId: string): Promise<void> {
  return requestVoid(routes.authFlowCancel(flowId), { method: "POST" });
}

export function logoutProvider(providerId: string): Promise<void> {
  return requestVoid(routes.authLogout(), json("POST", { providerId }));
}

export function authFlowEventSource(flowId: string, handlers: AuthFlowHandlers): () => void {
  return connectAuthFlow(flowId, handlers);
}
