import type { ConfigScope } from "../../../web/contracts";

const API_ROOT = "/api";

const session = (id: string) => `${API_ROOT}/sessions/${encodeURIComponent(id)}`;

export const routes = {
  status: () => `${API_ROOT}/status`,
  updateCheck: () => `${API_ROOT}/update-check`,
  agents: (cwd?: string) => {
    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    return `${API_ROOT}/agents${query}`;
  },
  agentConfiguration: (name: string) => `${API_ROOT}/agents/${encodeURIComponent(name)}`,
  agentResources: () => `${API_ROOT}/agent-resources`,
  agentResource: (name: string) => `${API_ROOT}/agent-resources/${encodeURIComponent(name)}`,
  skillResources: () => `${API_ROOT}/skill-resources`,
  skillResource: (name: string) => `${API_ROOT}/skill-resources/${encodeURIComponent(name)}`,
  models: () => `${API_ROOT}/models`,
  configurationEvents: () => `${API_ROOT}/config/events`,
  compactionSettings: () => `${API_ROOT}/settings/compaction`,
  apiUsageSettings: () => `${API_ROOT}/settings/api-usage`,
  sessionName: (id: string) => `${session(id)}/name`,
  directories: (path: string) => `${API_ROOT}/directories?${new URLSearchParams({ path }).toString()}`,
  createDirectory: () => `${API_ROOT}/directories`,
  entries: (path: string) => `${API_ROOT}/entries?${new URLSearchParams({ path }).toString()}`,
  file: (path: string) => `${API_ROOT}/file?${new URLSearchParams({ path }).toString()}`,
  rawFile: (path: string) => `${API_ROOT}/file/raw?${new URLSearchParams({ path }).toString()}`,
  createSession: () => `${API_ROOT}/sessions`,
  openSession: () => `${API_ROOT}/sessions/open`,
  snapshot: (id: string) => `${session(id)}/snapshot`,
  statistics: (id: string) => `${session(id)}/statistics`,
  childSnapshot: (parentId: string, childId: string) =>
    `${session(parentId)}/subagents/${encodeURIComponent(childId)}/snapshot`,
  messages: (id: string) => `${session(id)}/messages`,
  commands: (id: string) => `${session(id)}/commands`,
  tree: (id: string) => `${session(id)}/tree`,
  treeNavigate: (id: string) => `${session(id)}/tree/navigate`,
  compact: (id: string) => `${session(id)}/compact`,
  abort: (id: string) => `${session(id)}/abort`,
  stop: (id: string) => `${session(id)}/stop`,
  touch: (id: string) => `${session(id)}/touch`,
  restart: (id: string) => `${session(id)}/restart`,
  events: (id: string) => `${session(id)}/events`,
  fileWatches: (id: string, leaseId: string) => `${session(id)}/file-watches/${encodeURIComponent(leaseId)}`,
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
  authProviders: () => `${API_ROOT}/auth/providers`,
  authLogin: () => `${API_ROOT}/auth/login`,
  authFlowEvents: (flowId: string) => `${API_ROOT}/auth/flows/${encodeURIComponent(flowId)}/events`,
  authFlowRespond: (flowId: string) => `${API_ROOT}/auth/flows/${encodeURIComponent(flowId)}/respond`,
  authFlowCancel: (flowId: string) => `${API_ROOT}/auth/flows/${encodeURIComponent(flowId)}/cancel`,
  authLogout: () => `${API_ROOT}/auth/logout`,
};
