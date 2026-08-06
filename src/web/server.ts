import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createRouteHandler, type RouteServices } from "./routes";
import { ActiveSessionRegistry } from "./active-sessions";
import { PiRpcSessionFactory } from "./rpc-session";
import { DirectoryService } from "./directories";
import { ConfigFileService } from "./config-files";
import type { SessionSummaryDto } from "./contracts";
import { discoverAgents } from "../subagent/agents";
import {
  readAgentModels,
  readOrchestratorDefaults,
  readSessionOverrides,
  resolveAgentModelsService,
  routeSetAgentModel,
} from "./agent-models";

export interface Server {
  port: number;
  stop: () => Promise<void>;
}

const WEBUI_DIST = join(fileURLToPath(new URL("..", import.meta.url)), "webui", "dist");

/**
 * The orchestrator is the agent whose session line the Web session runs. Its
 * name matches the hardcoded orchestrator definition file
 * (`<agent-dir>/agents/orchestrator.md`, orchestrator-extension.ts).
 */
const ORCHESTRATOR_AGENT = "orchestrator";

/**
 * Start the Web panel backend on 127.0.0.1:3000. The server owns the active
 * session registry and stops every Pi RPC child on shutdown.
 */
export async function startServer(): Promise<Server> {
  const { importPi } = await import("../runtime/pi-import");
  const { assertNoUserExtensions } = await import("../runtime/extensions-guard");
  assertNoUserExtensions();
  const registry = new ActiveSessionRegistry(await PiRpcSessionFactory.resolve());
  const { SessionManager, getAgentDir } = await importPi();
  const agentDir = getAgentDir();
  const config = new ConfigFileService(agentDir);
  const agentModels = resolveAgentModelsService({
    listAgents: async () => (await discoverAgents()).agents.map((a) => ({ name: a.name })),
    getSessionPath: (id) => registry.getSessionPath(id),
    readEntries: (sessionPath) => readSessionOverrides(sessionPath),
    projectAgentModels: (cwd) => readAgentModels(config, { scope: "project", cwd }),
    globalAgentModels: () => readAgentModels(config, { scope: "global" }),
    orchestratorModel: (id) => registry.getOrchestratorModel(id),
    getCwd: (id) => registry.getCwd(id),
  });
  const services: RouteServices = {
    webuiDist: WEBUI_DIST,
    listAllSessions: async () => {
      const sessions = await SessionManager.listAll(undefined);
      return sessions.map((s) => {
        const dto: SessionSummaryDto = {
          id: s.id,
          path: s.path,
          cwd: s.cwd,
          name: s.name,
          created: new Date(s.created).toISOString(),
          modified: new Date(s.modified).toISOString(),
          messageCount: s.messageCount,
          firstMessage: s.firstMessage,
        };
        return dto;
      });
    },
    listModels: async () => {
      const { ModelRuntime } = await importPi();
      const runtime = await ModelRuntime.create();
      const available = await runtime.getAvailable();
      return available.map((model) => ({ provider: model.provider, id: model.id }));
    },
    effectiveModels: (sessionId) => agentModels.effective(sessionId),
    setAgentModel: (sessionId, agentName, model) =>
      routeSetAgentModel(
        {
          isOrchestrator: (name) => name === ORCHESTRATOR_AGENT,
          isKnownAgent: (name) => discoverAgents().agents.some((a) => a.name === name),
          setOrchestrator: (provider, modelId) => registry.setModel(sessionId, provider, modelId),
          writeOverride: (agentName, model) => agentModels.set(sessionId, agentName, model),
          orchestratorDefaults: async () => readOrchestratorDefaults(config, await registry.getCwd(sessionId)),
        },
        agentName,
        model,
      ),
    listConfigProjects: async () => {
      const sessions = await SessionManager.listAll(undefined);
      const cwds = [...new Set(sessions.map((s) => s.cwd).filter(Boolean))];
      return { home: agentDir, projects: cwds.map((cwd) => ({ cwd })) };
    },
    directories: new DirectoryService(),
    registry,
    config,
    listAgents: async () =>
      discoverAgents().agents.map(({ name, description, tools, subagents }) => ({
        name,
        description,
        tools,
        subagents,
      })),
  };
  const handler = createRouteHandler(services);

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 3000,
    fetch: handler,
    idleTimeout: 0,
  });

  return {
    port: server.port ?? 3000,
    stop: async () => {
      await registry.shutdown();
      server.stop(true);
    },
  };
}
