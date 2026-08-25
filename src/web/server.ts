import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { isThinkingLevel } from "../thinking-levels";
import { createRouteHandler, type DaemonControl, type RouteServices } from "./routes";
import { ActiveSessionRegistry } from "./active-sessions";
import { PiSessionFactory } from "./session-adapter";
import { DirectoryService } from "./directories";
import { ConfigFileService } from "./config-files";
import { readWebSessionIdleTimeout } from "./session-settings";
import type { AgentDto, SessionSummaryDto } from "./contracts";
import type { AgentConfig } from "../subagent/agents";
import { discoverAgents, discoverGlobalAgents, RESEARCH_ASSISTANT_AGENT } from "../subagent/agents";
import { createLogger } from "../runtime/logger";
import { SubagentSessionService } from "./subagent-sessions";
import { isSubagentSessionName } from "../subagent/session-links";
import { createFileWatcherFactory } from "./file-watcher";
import { createDaemonAuthRuntime } from "./auth-runtime";
import { resolveRenameSessionService } from "./session-rename";
import { createAgentPatchService } from "./agent-configuration";
import { createLiveConfiguration, type LiveConfiguration } from "../runtime/live-configuration";
import { resolvePiDefaultModel, type PiDefaultModelApi } from "../runtime/pi-default-model";
import { createSessionSettingsFacade } from "../runtime/session-settings-facade";
import { embeddedPackageVersion } from "../runtime/bundled-assets";
import { checkNpmUpdate } from "./update-check";
import { createCompactionSettingsService } from "./compaction-settings";
import { createApiUsageSettingsService } from "./api-usage-settings";

export interface Server {
  port: number;
  stop: () => Promise<void>;
}

export interface StartServerOptions {
  host?: string;
  port?: number;
  daemonControl?: DaemonControl;
  desktopAccess?: { token: string };
}

const WEBUI_DIST = join(fileURLToPath(new URL("..", import.meta.url)), "webui", "dist");

export function agentToDto(agent: AgentConfig, effectiveModel: string | undefined = agent.model): AgentDto {
  return {
    name: agent.name,
    description: agent.description,
    enabled: agent.enabled,
    builtin: agent.builtin,
    source: agent.source,
    filePath: agent.filePath,
    model: agent.model,
    effectiveModel,
    thinking: isThinkingLevel(agent.thinking) ? agent.thinking : undefined,
    tools: agent.tools,
    effectiveTools: agent.effectiveTools,
    subagents: agent.subagents,
    skills: agent.skills,
    effectiveSkills: agent.effectiveSkills,
    missingSkills: agent.missingSkills,
  };
}

export async function agentsToDtos(
  agents: AgentConfig[],
  cwd: string,
  resolveDefaultModel?: (cwd: string) => Promise<string | undefined>,
): Promise<AgentDto[]> {
  const researchAssistant = agents.find((agent) => agent.name === RESEARCH_ASSISTANT_AGENT);
  const researchAssistantModel = researchAssistant?.model ?? (
    researchAssistant ? await resolveDefaultModel?.(cwd) : undefined
  );
  return agents.map((agent) => agentToDto(agent, agent.model ?? researchAssistantModel));
}

export async function discoverAgentsForWeb(
  cwd: string | undefined,
  agentDir: string,
  resolveDefaultModel?: (cwd: string) => Promise<string | undefined>,
): Promise<AgentDto[]> {
  const result = cwd ? await discoverAgents({ cwd, agentDir }) : await discoverGlobalAgents({ agentDir });
  return agentsToDtos(result.agents, cwd ?? agentDir, resolveDefaultModel);
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
  const pi = await importPi();
  const { ModelRuntime, SessionManager, SettingsManager, getAgentDir } = pi;
  const agentDir = getAgentDir();
  let liveConfiguration: LiveConfiguration | undefined;
  const config = new ConfigFileService(agentDir, {
    onAuthoritativeWrite: (change) => liveConfiguration?.notify(change) ?? Promise.resolve(),
  });
  const authRuntime = await createDaemonAuthRuntime({
    config,
    logger,
    createModelRuntime: () => ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
      refreshOnCreate: false,
    }),
    synchronizeCatalog: () => liveConfiguration?.synchronize() ?? Promise.resolve(),
    onModelsChanged: () =>
      liveConfiguration?.notify({ modelsChanged: true, force: true }) ?? Promise.resolve(),
  });
  const auth = authRuntime.auth;
  try {
    liveConfiguration = createLiveConfiguration({
      agentDir,
      modelValidator: authRuntime.modelValidator,
    });
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      await auth.shutdown();
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    try {
      await authRuntime.dispose();
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "Web server startup cleanup failed");
    }
    throw error;
  }
  const live = liveConfiguration;
  let registry: ActiveSessionRegistry | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let sessionsStopped = false;
  let configurationClosed = false;
  let authStopped = false;
  let modelsDisposed = false;
  let serverStopped = false;

  const cleanup = async (): Promise<void> => {
    if (registry && !sessionsStopped) {
      await registry.shutdown();
      sessionsStopped = true;
    }
    if (!configurationClosed) {
      await live.close();
      configurationClosed = true;
    }
    if (!authStopped) {
      await auth.shutdown();
      authStopped = true;
    }
    if (!modelsDisposed) {
      await authRuntime.dispose();
      modelsDisposed = true;
    }
    if (server && !serverStopped) {
      server.stop(true);
      serverStopped = true;
    }
  };

  const failStartupAfterCleanup = async (startupError: unknown): Promise<never> => {
    let firstCleanupError: unknown;
    try {
      await cleanup();
    } catch (error) {
      firstCleanupError = error;
    }
    if (firstCleanupError !== undefined) {
      try {
        await cleanup();
      } catch (secondCleanupError) {
        throw new AggregateError(
          [startupError, firstCleanupError, secondCleanupError],
          "Web server startup cleanup failed",
        );
      }
    }
    throw startupError;
  };

  try {
    await live.start();
    const idleTimeoutMs = await readWebSessionIdleTimeout(config);
    registry = new ActiveSessionRegistry(
      await PiSessionFactory.resolve(live),
      logger,
      {
        idleTimeoutMs,
        resolveLaunchThinking: async (cwd) =>
          (await live.resolveAgents(cwd)).find((agent) => agent.name === RESEARCH_ASSISTANT_AGENT)?.thinking,
      },
      createFileWatcherFactory(logger),
    );
  } catch (error) {
    return failStartupAfterCleanup(error);
  }
  const activeRegistry = registry;
  const subagentSessions = new SubagentSessionService({
    open: (path) => SessionManager.open(path),
    listAll: async () => {
      const sessions = await SessionManager.listAll(undefined);
      return sessions.map(({ id, path, cwd }) => ({ id, path, cwd }));
    },
  });
  const renameSessions = resolveRenameSessionService({
    isConnected: (id) => Promise.resolve(activeRegistry.has(id)),
    setConnectedName: (id, name) => activeRegistry.prompt(id, `/name ${name}`),
    listAll: async () => {
      const sessions = await SessionManager.listAll(undefined);
      return toUserSessionSummaries(sessions);
    },
    openSessionManager: async (path) => SessionManager.open(path),
  });
  const listModels = () => auth.listModels();
  const compactionSettings = createCompactionSettingsService(config, live);
  const apiUsageSettings = createApiUsageSettingsService(config, live);
  const resolveDefaultModel = async (cwd: string): Promise<string | undefined> => {
    const settingsManager = createSessionSettingsFacade(
      SettingsManager.create(cwd, agentDir),
    );
    const model = await resolvePiDefaultModel({
      pi: pi as unknown as PiDefaultModelApi,
      cwd,
      agentDir,
      modelRuntime: authRuntime.modelRuntime,
      settingsManager,
    });
    return model ? `${model.provider}/${model.id}` : undefined;
  };
  const packageVersion = embeddedPackageVersion();
  const services: RouteServices = {
    webuiDist: WEBUI_DIST,
    listAllSessions: async () => {
      const sessions = await SessionManager.listAll(undefined);
      return toUserSessionSummaries(sessions);
    },
    listModels,
    checkForUpdate: () => checkNpmUpdate(packageVersion),
    patchAgent: createAgentPatchService(config, listModels),
    getCompactionSettings: () => compactionSettings.get(),
    patchCompactionSettings: (patch) => compactionSettings.patch(patch),
    getApiUsageSettings: () => apiUsageSettings.get(),
    patchApiUsageSettings: (patch) => apiUsageSettings.patch(patch),
    renameSession: (sessionId, name) => renameSessions.rename(sessionId, name),
    listConfigProjects: async () => {
      const sessions = await SessionManager.listAll(undefined);
      const cwds = [...new Set(sessions.map((s) => s.cwd).filter(Boolean))];
      return { home: agentDir, projects: cwds.map((cwd) => ({ cwd })) };
    },
    directories: new DirectoryService(),
    registry: activeRegistry,
    config,
    subagentSessions,
    auth,
    configuration: live,
    logger,
    daemonControl: options.daemonControl,
    desktopAccess: options.desktopAccess,
    listAgents: async (cwd) => agentsToDtos(await live.resolveAgents(cwd), cwd ?? agentDir, resolveDefaultModel),
  };
  const handler = createRouteHandler(services);

  try {
    server = Bun.serve({
      hostname: host,
      port,
      fetch: handler,
      idleTimeout: 0,
    });
  } catch (error) {
    return failStartupAfterCleanup(error);
  }

  logger.info("web server started", { host, port: server.port ?? port });

  return {
    port: server.port ?? port,
    stop: (() => {
      let attempt: Promise<void> | undefined;
      return () => {
        if (attempt) return attempt;
        logger.info("web server stopping");
        const current = cleanup();
        attempt = current;
        void current.catch(() => {}).finally(() => {
          if (attempt === current) attempt = undefined;
        });
        return current;
      };
    })(),
  };
}
