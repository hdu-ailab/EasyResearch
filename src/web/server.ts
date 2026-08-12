import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createRouteHandler, type RouteServices } from "./routes";
import { ActiveSessionRegistry } from "./active-sessions";
import { PiRpcSessionFactory } from "./rpc-session";
import { DirectoryService } from "./directories";
import { ConfigFileService } from "./config-files";
import { readWebSessionIdleTimeout } from "./session-settings";
import type { AgentDto, SessionSummaryDto } from "./contracts";
import type { AgentConfig } from "../subagent/agents";
import { readEffectiveWebuiSettings, updateWebuiSettings } from "./webui-settings";
import { discoverAgents, discoverGlobalAgents, PAPER_ASSISTANT_AGENT } from "../subagent/agents";
import {
  readAgentModels,
  readPaperAssistantDefaults,
  readSessionOverrides,
  resolveAgentModelsService,
  routeSetAgentModel,
} from "./agent-models";
import { createLogger } from "../runtime/logger";
import { SubagentSessionService } from "./subagent-sessions";
import { isSubagentSessionName } from "../subagent/session-links";
import { createFileWatcherFactory } from "./file-watcher";

export interface Server {
  port: number;
  stop: () => Promise<void>;
}

const WEBUI_DIST = join(fileURLToPath(new URL("..", import.meta.url)), "webui", "dist");

export function agentToDto(agent: AgentConfig): AgentDto {
  return {
    name: agent.name,
    description: agent.description,
    enabled: agent.enabled,
    builtin: agent.builtin,
    source: agent.source,
    filePath: agent.filePath,
    model: agent.model,
    tools: agent.tools,
    effectiveTools: agent.effectiveTools,
    subagents: agent.subagents,
    skills: agent.skills,
    effectiveSkills: agent.effectiveSkills,
    missingSkills: agent.missingSkills,
  };
}

export async function discoverAgentsForWeb(cwd: string | undefined, agentDir: string): Promise<AgentDto[]> {
  const result = cwd ? await discoverAgents({ cwd, agentDir }) : await discoverGlobalAgents({ agentDir });
  return result.agents.map(agentToDto);
}

export function isKnownAgentName(agents: AgentConfig[], name: string): boolean {
  return agents.some((a) => a.name === name);
}

/**
 * Structural subset of Pi's SessionInfo used by the pure mapping helper so the
 * web layer can be tested without a static Pi import.
 */
interface SessionInfoLike {
  id: string;
  path: string;
  cwd: string;
  name?: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
}

/**
 * Home-list session summaries. Internal `easyresearch:` child session lines
 * are excluded: they are not user sessions and are browsed through their
 * parent's snapshot endpoint instead.
 */
export function toUserSessionSummaries(sessions: readonly SessionInfoLike[]): SessionSummaryDto[] {
  return sessions
    .filter((session) => !isSubagentSessionName(session.name))
    .map((session) => ({
      id: session.id,
      path: session.path,
      cwd: session.cwd,
      name: session.name,
      created: new Date(session.created).toISOString(),
      modified: new Date(session.modified).toISOString(),
      messageCount: session.messageCount,
      firstMessage: session.firstMessage,
    }));
}

/**
 * Start the Web panel backend on 127.0.0.1:3000. The server owns the active
 * session registry and stops every Pi RPC child on shutdown.
 */
export async function startServer(): Promise<Server> {
  const { importPi } = await import("../runtime/pi-import");
  const { assertSafeExtensionSources } = await import("../runtime/extensions-guard");
  assertSafeExtensionSources();
  const logger = createLogger("web-server");
  const { SessionManager, getAgentDir } = await importPi();
  const agentDir = getAgentDir();
  const config = new ConfigFileService(agentDir);
  const idleTimeoutMs = await readWebSessionIdleTimeout(config);
  const registry = new ActiveSessionRegistry(
    await PiRpcSessionFactory.resolve(),
    logger,
    { idleTimeoutMs },
    createFileWatcherFactory(logger),
  );
  const subagentSessions = new SubagentSessionService({
    open: (path) => SessionManager.open(path),
    listAll: async () => {
      const sessions = await SessionManager.listAll(undefined);
      return sessions.map(({ id, path, cwd }) => ({ id, path, cwd }));
    },
  });
  const agentModels = resolveAgentModelsService({
    listAgents: async (cwd?: string) => (await discoverAgents({ cwd })).agents.map((a) => ({ name: a.name })),
    getSessionPath: (id) => registry.getSessionPath(id),
    readEntries: (sessionPath) => readSessionOverrides(sessionPath),
    projectAgentModels: (cwd) => readAgentModels(config, { scope: "project", cwd }),
    globalAgentModels: () => readAgentModels(config, { scope: "global" }),
    paperAssistantModel: (id) => registry.getPaperAssistantModel(id),
    getCwd: (id) => registry.getCwd(id),
  });
  const services: RouteServices = {
    webuiDist: WEBUI_DIST,
    listAllSessions: async () => {
      const sessions = await SessionManager.listAll(undefined);
      return toUserSessionSummaries(sessions);
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
          isPaperAssistant: (name) => name === PAPER_ASSISTANT_AGENT,
          isKnownAgent: async (name) =>
            isKnownAgentName((await discoverAgents({ cwd: await registry.getCwd(sessionId) })).agents, name),
          setPaperAssistant: (provider, modelId) => registry.setModel(sessionId, provider, modelId),
          writeOverride: (agentName, model) => agentModels.set(sessionId, agentName, model),
          paperAssistantDefaults: async () => readPaperAssistantDefaults(config, await registry.getCwd(sessionId)),
        },
        agentName,
        model,
      ),
    listConfigProjects: async () => {
      const sessions = await SessionManager.listAll(undefined);
      const cwds = [...new Set(sessions.map((s) => s.cwd).filter(Boolean))];
      return { home: agentDir, projects: cwds.map((cwd) => ({ cwd })) };
    },
    getWebuiSettings: () => readEffectiveWebuiSettings(config),
    updateWebuiSettings: async (patch) => {
      await updateWebuiSettings(config, patch);
      return readEffectiveWebuiSettings(config);
    },
    directories: new DirectoryService(),
    registry,
    config,
    subagentSessions,
    logger,
    listAgents: (cwd) => discoverAgentsForWeb(cwd, agentDir),
  };
  const handler = createRouteHandler(services);

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 3000,
    fetch: handler,
    idleTimeout: 0,
  });

  logger.info("web server started", { port: server.port ?? 3000 });

  return {
    port: server.port ?? 3000,
    stop: async () => {
      logger.info("web server stopping");
      await registry.shutdown();
      server.stop(true);
    },
  };
}
