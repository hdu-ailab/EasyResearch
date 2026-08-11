import type { ConfigScope } from "../../../web/contracts";

const API_ROOT = "/api";

const session = (id: string) => `${API_ROOT}/sessions/${encodeURIComponent(id)}`;

export const routes = {
  status: () => `${API_ROOT}/status`,
  agents: () => `${API_ROOT}/agents`,
  models: () => `${API_ROOT}/models`,
  webuiSettings: () => `${API_ROOT}/webui-settings`,
  effectiveModels: (sessionId: string) => `${session(sessionId)}/agents/effective-models`,
  agentModel: (sessionId: string, agentName: string) =>
    `${session(sessionId)}/agents/${encodeURIComponent(agentName)}/model`,
  directories: (path: string) => `${API_ROOT}/directories?${new URLSearchParams({ path }).toString()}`,
  entries: (path: string) => `${API_ROOT}/entries?${new URLSearchParams({ path }).toString()}`,
  file: (path: string) => `${API_ROOT}/file?${new URLSearchParams({ path }).toString()}`,
  rawFile: (path: string) => `${API_ROOT}/file/raw?${new URLSearchParams({ path }).toString()}`,
  createSession: () => `${API_ROOT}/sessions`,
  openSession: () => `${API_ROOT}/sessions/open`,
  snapshot: (id: string) => `${session(id)}/snapshot`,
  childSnapshot: (parentId: string, childId: string) =>
    `${session(parentId)}/subagents/${encodeURIComponent(childId)}/snapshot`,
  messages: (id: string) => `${session(id)}/messages`,
  abort: (id: string) => `${session(id)}/abort`,
  stop: (id: string) => `${session(id)}/stop`,
  touch: (id: string) => `${session(id)}/touch`,
  restart: (id: string) => `${session(id)}/restart`,
  events: (id: string) => `${session(id)}/events`,
  config: (scope: ConfigScope, cwd?: string, path?: string) => {
    const params = new URLSearchParams({ scope });
    if (cwd) params.set("cwd", cwd);
    if (path) params.set("path", path);
    return `${API_ROOT}/config?${params.toString()}`;
  },
  configProjects: () => `${API_ROOT}/config/projects`,
  configFile: (scope: ConfigScope, cwd?: string, path?: string) => {
    const params = new URLSearchParams({ scope });
    if (cwd) params.set("cwd", cwd);
    if (path) params.set("path", path);
    return `${API_ROOT}/config/file?${params.toString()}`;
  },
  writeConfigFile: () => `${API_ROOT}/config/file`,
  createConfigDirectory: () => `${API_ROOT}/config/directory`,
};
