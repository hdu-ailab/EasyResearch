import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createRouteHandler, type RouteServices } from "./routes";
import { ActiveSessionRegistry } from "./active-sessions";
import { PiSessionFactory } from "./session-adapter";
import { DirectoryService } from "./directories";
import { ConfigFileService } from "./config-files";
import { readWebSessionIdleTimeout } from "./session-settings";
import type { AgentDto, SessionSummaryDto } from "./contracts";
import type { AgentConfig } from "../subagent/agents";
import { readEffectiveWebuiSettings, updateWebuiSettings } from "./webui-settings";
import { discoverAgents, discoverGlobalAgents, PAPER_ASSISTANT_AGENT } from "../subagent/agents";
import { clearFollowGlobalFlag, readFollowGlobalFlag, setFollowGlobalFlag } from "./agent-follow-global";
import {
  readAgentModels,
  readPaperAssistantDefaults,
  readSessionOverrides,
  resolveAgentModelsService,
  routeSetAgentModel,
} from "./agent-models";
import {
  readAgentThinking,
  readPaperAssistantThinkingDefault,
  resolveAgentThinkingService,
  routeSetAgentThinking,
} from "./agent-thinking";
import { createLogger } from "../runtime/logger";
import { DEFAULT_THINKING_LEVEL } from "../subagent/thinking-resolution";
import { SubagentSessionService } from "./subagent-sessions";
import { isSubagentSessionName } from "../subagent/session-links";
import { createFileWatcherFactory } from "./file-watcher";
import { getAuthGateway } from "./auth-runtime";
import { resolveRenameSessionService } from "./session-rename";

export interface Server {
  port: number;
  stop: () => Promise<void>;
}

export interface StartServerOptions {
  host?: string;
  port?: number;
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
 * Start the Web panel backend. Defaults to 127.0.0.1:3000; both are overridable.
 * The server owns the active session registry and disposes every Pi
 * AgentSession on shutdown.
 */
export async function startServer(options: StartServerOptions = {}): Promise<Server> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 3000;
  const { importPi } = await import("../runtime/pi-import");
  const { assertSafeExtensionSources } = await import("../runtime/extensions-guard");
  assertSafeExtensionSources();
  const logger = createLogger("web-server");
  const { SessionManager, getAgentDir } = await importPi();
  const agentDir = getAgentDir();
  const auth = await getAuthGateway(logger);
  const config = new ConfigFileService(agentDir);
  const idleTimeoutMs = await readWebSessionIdleTimeout(config);
  const registry = new ActiveSessionRegistry(
    await PiSessionFactory.resolve(),
    logger,
    {
      idleTimeoutMs,
      resolveLaunchThinking: async (cwd) =>
        (await discoverAgents({ cwd })).agents.find((agent) => agent.name === PAPER_ASSISTANT_AGENT)?.thinking,
    },
    createFileWatcherFactory(logger),
  );
  const prompt = registry.prompt.bind(registry);
  registry.prompt = async (id: string, message: string) => {
    const sessionPath = await registry.getSessionPath(id);
    const rows = sessionPath ? await readSessionOverrides(sessionPath) : [];
    if (readFollowGlobalFlag(rows)) {
      const cwd = await registry.getCwd(id);
      const defaults = await readPaperAssistantDefaults(config, cwd);
      if (defaults) {
        const current = await registry.getPaperAssistantModel(id);
        if (current !== `${defaults.provider}/${defaults.modelId}`) {
          await registry.setModel(id, defaults.provider, defaults.modelId);
        }
      }
      const thinkingDefault = await readPaperAssistantThinkingDefault(config, cwd);
      const targetThinking = thinkingDefault ?? DEFAULT_THINKING_LEVEL;
      if (targetThinking) {
        const current = await registry.getPaperAssistantThinking(id);
        if (current !== targetThinking) {
          await registry.setThinkingLevel(id, targetThinking);
        }
      }
    }
    await prompt(id, message);
  };
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
  const agentThinking = resolveAgentThinkingService({
    listAgents: async (cwd?: string) => (await discoverAgents({ cwd })).agents.map((a) => ({ name: a.name })),
    getSessionPath: (id) => registry.getSessionPath(id),
    readEntries: (sessionPath) => readSessionOverrides(sessionPath),
    projectAgentThinking: (cwd) => readAgentThinking(config, { scope: "project", cwd }),
    globalAgentThinking: () => readAgentThinking(config, { scope: "global" }),
    paperAssistantThinking: (id) => registry.getPaperAssistantThinking(id),
    getCwd: (id) => registry.getCwd(id),
  });
  const renameSessions = resolveRenameSessionService({
    isConnected: (id) => Promise.resolve(registry.has(id)),
    setConnectedName: (id, name) => registry.setSessionName(id, name),
    listAll: async () => {
      const sessions = await SessionManager.listAll(undefined);
      return toUserSessionSummaries(sessions);
    },
    openSessionManager: (path) => SessionManager.open(path),
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
      return available.map((model) => ({
        provider: model.provider,
        id: model.id,
        reasoning: model.reasoning,
        thinkingLevelMap: model.thinkingLevelMap ? { ...model.thinkingLevelMap } : undefined,
      }));
    },
    effectiveModels: (sessionId) => agentModels.effective(sessionId),
    setAgentModel: async (sessionId, agentName, model) => {
      await clearFollowGlobalFlag(await registry.getSessionPath(sessionId));
      await routeSetAgentModel(
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
      );
    },
    effectiveThinking: (sessionId) => agentThinking.effective(sessionId),
    clearAgentOverrides: async (sessionId) => {
      const cwd = await registry.getCwd(sessionId);
      const agents = (await discoverAgents({ cwd })).agents;
      for (const agent of agents) {
        if (agent.name === PAPER_ASSISTANT_AGENT) continue;
        await agentModels.set(sessionId, agent.name, null);
        await agentThinking.set(sessionId, agent.name, null);
      }
      await setFollowGlobalFlag(await registry.getSessionPath(sessionId));
    },
    setAgentThinking: async (sessionId, agentName, thinking) => {
      await clearFollowGlobalFlag(await registry.getSessionPath(sessionId));
      await routeSetAgentThinking(
        {
          isPaperAssistant: (name) => name === PAPER_ASSISTANT_AGENT,
          isKnownAgent: async (name) =>
            isKnownAgentName((await discoverAgents({ cwd: await registry.getCwd(sessionId) })).agents, name),
          setPaperAssistant: (level) => registry.setThinkingLevel(sessionId, level),
          writeOverride: (agentName, level) => agentThinking.set(sessionId, agentName, level),
          paperAssistantDefault: async () => readPaperAssistantThinkingDefault(config, await registry.getCwd(sessionId)),
        },
        agentName,
        thinking,
      );
    },
    renameSession: (sessionId, name) => renameSessions.rename(sessionId, name),
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
    auth,
    logger,
    listAgents: (cwd) => discoverAgentsForWeb(cwd, agentDir),
  };
  const handler = createRouteHandler(services);

  const server = Bun.serve({
    hostname: host,
    port,
    fetch: handler,
    idleTimeout: 0,
  });

  logger.info("web server started", { host, port: server.port ?? port });

  return {
    port: server.port ?? port,
    stop: async () => {
      logger.info("web server stopping");
      auth.shutdown();
      await registry.shutdown();
      server.stop(true);
    },
  };
}
