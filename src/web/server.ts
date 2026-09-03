import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isThinkingLevel } from "../thinking-levels";
import { createRouteHandler, type DaemonControl, type RouteServices } from "./routes";
import { ActiveSessionRegistry } from "./active-sessions";
import { PiSessionFactory } from "./session-adapter";
import { DirectoryService } from "./directories";
import { ConfigFileService, ConfigServiceError } from "./config-files";
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
import { embeddedPackageVersion } from "../runtime/bundled-assets";
import { checkNpmUpdate } from "./update-check";
import { createCompactionSettingsService } from "./compaction-settings";
import { createApiUsageSettingsService } from "./api-usage-settings";
import {
  createConfigurationProjectWatches,
  type ConfigurationProjectWatches,
} from "./configuration-project-watches";
import { repairDanglingAgentDefaults } from "../runtime/agent-default-repair";
import { createProviderDeletionService } from "./provider-deletion";
import type { NetworkPolicy } from "../runtime/network-policy";
import type { InstalledNetworkRouter } from "../runtime/network-routing";
import { NetworkProxySettingsService } from "./network-proxy-settings";
import { createNetworkProxyProbe, type NetworkProxyProbe } from "./network-proxy-probe";
import { RuntimeRestartCoordinator } from "./runtime-restart";
import { localInterfaceIpAddresses, rejectDisallowedWebRequest } from "./request-admission";

export interface Server {
  port: number;
  stop: () => Promise<void>;
}

export interface StartServerOptions {
  host?: string;
  port?: number;
  bootId?: string;
  daemonControl?: DaemonControl;
  desktopAccess?: { token: string };
  networkPolicy: NetworkPolicy;
  networkProxyProbe?: NetworkProxyProbe;
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
export async function startServer(options: StartServerOptions): Promise<Server> {
  if (!options?.networkPolicy || !Object.isFrozen(options.networkPolicy)) {
    throw new TypeError("An immutable host-applied network policy is required.");
  }
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 3000;
  const bootId = options.bootId ?? randomUUID();
  const { importPi } = await import("../runtime/pi-import");
  const logger = createLogger("web-server");
  const pi = await importPi();
  const { ModelRuntime, SessionManager, SettingsManager, getAgentDir } = pi;
  const agentDir = getAgentDir();
  const { assertSafeExtensionSources } = await import("../runtime/extensions-guard");
  assertSafeExtensionSources();
  let liveConfiguration: LiveConfiguration | undefined;
  const config = new ConfigFileService(agentDir, {
    onAuthoritativeWrite: async (change) => {
      if (!liveConfiguration) return;
      const outcome = await liveConfiguration.notify(change);
      if (outcome.status === "rejected" || outcome.status === "closed") {
        throw new ConfigServiceError(
          409,
          "Configuration was saved but could not be accepted.",
          "CONFIG_REJECTED",
        );
      }
      return outcome;
    },
    acquireProject: async (cwd) => {
      if (!liveConfiguration) throw new Error("Configuration monitoring is unavailable.");
      return liveConfiguration.acquireProject(cwd);
    },
    synchronizeProject: async (cwd) => {
      if (!liveConfiguration) throw new Error("Configuration monitoring is unavailable.");
      return liveConfiguration.synchronize({ projectCwds: [cwd] });
    },
  });
  const networkPolicy = options.networkPolicy;
  const { installNetworkRouter } = await import("../runtime/network-routing");
  const fetchBeforeRouter = globalThis.fetch;
  const networkProxySettings = new NetworkProxySettingsService(config, networkPolicy);
  const networkProxyProbe = options.networkProxyProbe ?? createNetworkProxyProbe();
  let networkRouter: InstalledNetworkRouter;
  try {
    networkRouter = installNetworkRouter(networkPolicy);
  } catch (error) {
    if (globalThis.fetch !== fetchBeforeRouter) globalThis.fetch = fetchBeforeRouter;
    throw error;
  }
  let routerRestored = false;
  const restoreNetworkRouter = (): void => {
    if (routerRestored) return;
    networkRouter.restore();
    routerRestored = true;
  };
  let authRuntime: Awaited<ReturnType<typeof createDaemonAuthRuntime>>;
  try {
    authRuntime = await createDaemonAuthRuntime({
      config,
      logger,
      createModelRuntime: async () => networkRouter.decorateModelRuntime(await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: join(agentDir, "models.json"),
        refreshOnCreate: false,
      })),
      synchronizeCatalog: async () => {
        await liveConfiguration?.synchronize();
      },
      onModelsChanged: async () => {
        if (!liveConfiguration) return;
        const outcome = await liveConfiguration.notify({ availabilityChanged: true });
        if (outcome.status === "closed" || outcome.status === "rejected") {
          throw new Error("Model availability could not be synchronized.");
        }
      },
      resolveFallbackModel: async (modelRuntime) => resolvePiDefaultModel({
        pi: pi as unknown as PiDefaultModelApi,
        cwd: agentDir,
        agentDir,
        modelRuntime,
        settingsManager: SettingsManager.create(agentDir, agentDir),
      }),
    });
  } catch (error) {
    try {
      restoreNetworkRouter();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Web server startup cleanup failed");
    }
    throw error;
  }
  const auth = authRuntime.auth;
  try {
    liveConfiguration = createLiveConfiguration({
      agentDir,
      modelValidator: authRuntime.modelValidator,
      repairAgentDefaults: (repairs) => repairDanglingAgentDefaults(config, repairs),
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
    try {
      restoreNetworkRouter();
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
  let configurationProjectWatches: ConfigurationProjectWatches | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let sessionsStopped = false;
  let projectWatchesClosed = false;
  let configurationClosed = false;
  let authStopped = false;
  let modelsDisposed = false;
  let serverStopped = false;

  const cleanup = async (): Promise<void> => {
    if (registry && !sessionsStopped) {
      await registry.shutdown();
      sessionsStopped = true;
    }
    if (configurationProjectWatches && !projectWatchesClosed) {
      await configurationProjectWatches.close();
      projectWatchesClosed = true;
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
      await server.stop(true);
      serverStopped = true;
    }
    restoreNetworkRouter();
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
      await PiSessionFactory.resolve(live, networkRouter),
      logger,
      {
        idleTimeoutMs,
        resolveLaunchThinking: async (cwd) =>
          (await live.resolveAgents(cwd)).find((agent) => agent.name === RESEARCH_ASSISTANT_AGENT)?.thinking,
      },
      createFileWatcherFactory(logger),
    );
    const activeRegistry = registry;
    const listConfigProjects = async () => {
      const sessions = await SessionManager.listAll(undefined);
      const cwds = [...new Set(sessions.map((session) => session.cwd).filter(Boolean))];
      return { home: agentDir, projects: cwds.map((cwd) => ({ cwd })) };
    };
    configurationProjectWatches = createConfigurationProjectWatches({
      live,
      isKnownCwd: async (cwd) => {
        if (activeRegistry.hasConnectedCwd(cwd)) return true;
        const { projects } = await listConfigProjects();
        return projects.some((project) => project.cwd === cwd);
      },
    });
    const projectWatches = configurationProjectWatches;
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
      const settingsManager = SettingsManager.create(cwd, agentDir);
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
    const reserveOwnerTransition = options.daemonControl?.reserveRestart?.bind(options.daemonControl);
    const runtimeRestart = reserveOwnerTransition
      ? new RuntimeRestartCoordinator({
        bootId,
        activeWorkCount: () => activeRegistry.activeWorkCount(),
        beginSessionShutdown: () => activeRegistry.beginShutdown(),
        activeAuthFlow: () => auth.activeFlow() !== null,
        beginAuthShutdown: () => auth.shutdown(),
        reserveOwnerTransition,
      })
      : undefined;
    const services: RouteServices = {
      bootId,
      webuiDist: WEBUI_DIST,
      listAllSessions: async () => {
        const sessions = await SessionManager.listAll(undefined);
        return toUserSessionSummaries(sessions);
      },
      listModels,
      checkForUpdate: () => checkNpmUpdate(packageVersion),
      patchAgent: createAgentPatchService(config, listModels, { repairUnknownModels: true }),
      getCompactionSettings: () => compactionSettings.get(),
      patchCompactionSettings: (patch) => compactionSettings.patch(patch),
      getApiUsageSettings: () => apiUsageSettings.get(),
      patchApiUsageSettings: (patch) => apiUsageSettings.patch(patch),
      getNetworkProxySettings: () => networkProxySettings.get(),
      patchNetworkProxySettings: (patch) => networkProxySettings.patch(patch),
      testNetworkProxy: (request, signal) => networkProxyProbe.test(request, signal),
      renameSession: (sessionId, name) => renameSessions.rename(sessionId, name),
      listConfigProjects,
      directories: new DirectoryService(),
      registry: activeRegistry,
      config,
      subagentSessions,
      auth,
      providerDeletion: createProviderDeletionService(config),
      configuration: live,
      configurationProjectWatches: projectWatches,
      logger,
      daemonControl: options.daemonControl,
      runtimeRestart,
      desktopAccess: options.desktopAccess,
      listAgents: async (cwd) => {
        const registration = cwd ? await live.acquireProject(cwd) : undefined;
        try {
          if (cwd) await live.synchronize({ projectCwds: [cwd] });
          return agentsToDtos(await live.resolveAgents(cwd), cwd ?? agentDir, resolveDefaultModel);
        } finally {
          await registration?.release();
        }
      },
    };
    const routeHandler = createRouteHandler(services);
    const localInterfaceAddresses = localInterfaceIpAddresses();
    const handler = (request: Request): Promise<Response> => {
      const actualPort = server?.port ?? port;
      const rejection = rejectDisallowedWebRequest(request, {
        host,
        port: actualPort,
        localInterfaceAddresses,
      });
      if (rejection) return Promise.resolve(rejection);
      return routeHandler(request);
    };
    server = Bun.serve({
      hostname: host,
      port,
      fetch: handler,
      idleTimeout: 0,
    });
    logger.info("web server started", { host, port: server.port ?? port });
  } catch (error) {
    return failStartupAfterCleanup(error);
  }

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
