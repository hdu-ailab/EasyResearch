import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { bundledFilePath } from "../runtime/bundled-assets";
import type {
  ActiveSessionDto,
  AgentConfigurationPatch,
  AgentDto,
  AgentResourceDto,
  AuthFlowEventDto,
  AuthLoginRequestDto,
  AuthLogoutRequestDto,
  AuthProvidersResponseDto,
  AuthRespondRequestDto,
  ApiUsageSettingsDto,
  ApiUsageSettingsPatchDto,
  ApiUsageRecordDto,
  ConfigurationEvent,
  CompactionSettingsDto,
  CompactionSettingsPatchDto,
  ConfigScope,
  ModelOptionDto,
  SessionSummaryDto,
  UpdateCheckDto,
} from "./contracts";
import { createGlobalAgent, listGlobalAgents, readGlobalAgent, writeGlobalAgent, listGlobalSkills, readGlobalSkill, writeGlobalSkill } from "./agent-resources";
import type { DirectoryService } from "./directories";
import { DirectoryServiceError } from "./directories";
import { parseByteRange, RawFileRangeError, type ByteRange, type RawFileDescriptor } from "./raw-file";
import { UnknownSessionError, type ActiveSessionRegistry } from "./active-sessions";
import { flattenMessageTree } from "./session-tree";
import { ExtensionGuardError } from "../runtime/extensions-guard";
import type { ConfigFileService } from "./config-files";
import { ConfigPathError, ConfigServiceError } from "./config-files";
import type { Logger } from "../runtime/logger";
import { SubagentSessionNotFoundError, type SubagentSessionService } from "./subagent-sessions";
import { AuthGatewayError, type AuthGateway } from "./auth-gateway";
import { FileWatchPathError, UnknownFileWatchLeaseError } from "./file-watcher";
import {
  ConfigurationUnavailableError,
  type LiveConfiguration,
} from "../runtime/live-configuration";
import { DAEMON_CONTROL_PATH, DAEMON_TOKEN_HEADER } from "../cli/server-process";
import {
  rejectUnauthorizedDesktopRequest,
  type DesktopAccessControl,
} from "./desktop-access";
import { projectApiUsageRecord } from "./api-usage";

export interface DaemonControl {
  token: string;
  runtimeId: string;
  requestShutdown: () => void;
}

export interface RouteServices {
  webuiDist: string;
  listAllSessions: () => Promise<SessionSummaryDto[]>;
  listAgents: (cwd?: string) => Promise<AgentDto[]>;
  patchAgent: (name: string, patch: AgentConfigurationPatch) => Promise<AgentResourceDto>;
  getCompactionSettings: () => Promise<CompactionSettingsDto>;
  patchCompactionSettings: (patch: CompactionSettingsPatchDto) => Promise<CompactionSettingsDto>;
  getApiUsageSettings: () => Promise<ApiUsageSettingsDto>;
  patchApiUsageSettings: (patch: ApiUsageSettingsPatchDto) => Promise<ApiUsageSettingsDto>;
  listModels: () => Promise<ModelOptionDto[]>;
  checkForUpdate: () => Promise<UpdateCheckDto>;
  renameSession: (sessionId: string, name: string) => Promise<void>;
  listConfigProjects: () => Promise<{ home: string; projects: Array<{ cwd: string }> }>;
  directories: DirectoryService;
  registry: ActiveSessionRegistry;
  config: ConfigFileService;
  subagentSessions: Pick<SubagentSessionService, "summaries" | "snapshot" | "statistics" | "trackUsage">;
  auth?: AuthGateway;
  configuration: Pick<LiveConfiguration, "generation" | "error" | "subscribe">;
  logger: Logger;
  daemonControl?: DaemonControl;
  desktopAccess?: DesktopAccessControl;
}

export type RouteHandler = (request: Request) => Promise<Response>;

const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
};

/**
 * Pure request routing for the Web panel. All process/filesystem access goes
 * through injected services so vitest can run every route against fakes.
 */
export function createRouteHandler(services: RouteServices): RouteHandler {
  return async (req) => {
    try {
      const url = new URL(req.url);
      const path = url.pathname;

      if (path === DAEMON_CONTROL_PATH && (req.method === "GET" || req.method === "POST")) {
        const control = services.daemonControl;
        if (!control || req.headers.get(DAEMON_TOKEN_HEADER) !== control.token) {
          return errorResponse(404, "Not found");
        }
        if (req.method === "GET") return jsonResponse({ runtimeId: control.runtimeId });
        control.requestShutdown();
        return jsonResponse({ ok: true });
      }

      const unauthorized = rejectUnauthorizedDesktopRequest(req, services.desktopAccess);
      if (unauthorized) return unauthorized;

      if (req.method === "GET" && path === "/api/status") {
        return jsonResponse({
          agentDir: services.config.globalRoot,
          homeDir: services.directories.homeDir,
          sessions: await services.listAllSessions(),
          activeSessions: services.registry.listActive(),
        });
      }

      if (req.method === "GET" && path === "/api/update-check") {
        return jsonResponse(await services.checkForUpdate());
      }

      if (req.method === "GET" && path === "/api/agents") {
        return jsonResponse(await services.listAgents(url.searchParams.get("cwd") ?? undefined));
      }

      if (req.method === "GET" && path === "/api/settings/compaction") {
        return jsonResponse(await services.getCompactionSettings());
      }
      if (req.method === "PATCH" && path === "/api/settings/compaction") {
        return jsonResponse(await services.patchCompactionSettings(
          await jsonBody<CompactionSettingsPatchDto>(req),
        ));
      }
      if (req.method === "GET" && path === "/api/settings/api-usage") {
        return jsonResponse(await services.getApiUsageSettings());
      }
      if (req.method === "PATCH" && path === "/api/settings/api-usage") {
        return jsonResponse(await services.patchApiUsageSettings(
          await jsonBody<ApiUsageSettingsPatchDto>(req),
        ));
      }

      const agentConfigMatch = path.match(/^\/api\/agents\/([^/]+)$/);
      if (req.method === "PATCH" && agentConfigMatch) {
        const patch = await jsonBody<AgentConfigurationPatch>(req);
        return jsonResponse(await services.patchAgent(decodeURIComponent(agentConfigMatch[1]!), patch));
      }

      if (req.method === "GET" && path === "/api/agent-resources") {
        return jsonResponse(await listGlobalAgents(services.config));
      }

      const agentResourceMatch = path.match(/^\/api\/agent-resources\/([^/]+)$/);
      if (agentResourceMatch && req.method === "GET") {
        return jsonResponse(await readGlobalAgent(services.config, decodeURIComponent(agentResourceMatch[1]!)));
      }
      if (agentResourceMatch && req.method === "PUT") {
        const body = await jsonBody<{ content: string }>(req);
        return jsonResponse(await writeGlobalAgent(services.config, decodeURIComponent(agentResourceMatch[1]!), body.content));
      }

      if (req.method === "POST" && path === "/api/agent-resources") {
        const body = await jsonBody<{ name: string }>(req);
        return jsonResponse(await createGlobalAgent(services.config, body.name));
      }

      if (req.method === "GET" && path === "/api/skill-resources") {
        return jsonResponse(await listGlobalSkills(services.config));
      }
      const skillResourceMatch = path.match(/^\/api\/skill-resources\/([^/]+)$/);
      if (skillResourceMatch && req.method === "GET") {
        return jsonResponse(await readGlobalSkill(services.config, decodeURIComponent(skillResourceMatch[1]!)));
      }
      if (skillResourceMatch && req.method === "PUT") {
        const body = await jsonBody<{ content: string }>(req);
        return jsonResponse(await writeGlobalSkill(services.config, decodeURIComponent(skillResourceMatch[1]!), body.content));
      }

      if (req.method === "GET" && path === "/api/models") {
        return jsonResponse({ models: await services.listModels() });
      }

      if (req.method === "GET" && path === "/api/directories/roots") {
        return jsonResponse({ roots: services.directories.listRoots() });
      }

      if (req.method === "GET" && path === "/api/directories") {
        return jsonResponse(services.directories.list(url.searchParams.get("path") ?? undefined));
      }

      if (req.method === "POST" && path === "/api/directories") {
        const body = await jsonBody<{ path: string }>(req);
        if (typeof body.path !== "string" || !body.path) return errorResponse(400, "path is required");
        return jsonResponse({ path: services.directories.createDirectory(body.path) });
      }

      if (req.method === "GET" && path === "/api/entries") {
        return jsonResponse(services.directories.listEntries(url.searchParams.get("path") ?? undefined));
      }

      if (req.method === "GET" && path === "/api/file") {
        return jsonResponse(services.directories.readFile(requireQuery(url, "path")));
      }

      if (req.method === "GET" && path === "/api/file/raw") {
        return rawFileResponse(services.directories, requireQuery(url, "path"), req.headers.get("range"));
      }

      if (req.method === "POST" && path === "/api/sessions") {
        const body = await jsonBody<{ cwd: string }>(req);
        return await createSession(services, body);
      }

      if (req.method === "POST" && path === "/api/sessions/open") {
        const body = await jsonBody<{ path: string }>(req);
        return await openSession(services, body);
      }

      if (req.method === "GET" && path === "/api/active-sessions") {
        return jsonResponse({ sessions: services.registry.listActive() });
      }

      const touchMatch = path.match(/^\/api\/sessions\/([^/]+)\/touch$/);
      if (req.method === "POST" && touchMatch) {
        await services.registry.touch(touchMatch[1]!);
        return jsonResponse({ ok: true });
      }

      const statisticsMatch = path.match(/^\/api\/sessions\/([^/]+)\/statistics$/);
      if (req.method === "GET" && statisticsMatch) {
        return jsonResponse(await services.subagentSessions.statistics(statisticsMatch[1]!));
      }

      const childSnapshotMatch = path.match(/^\/api\/sessions\/([^/]+)\/subagents\/([^/]+)\/snapshot$/);
      if (req.method === "GET" && childSnapshotMatch) {
        return jsonResponse(await services.subagentSessions.snapshot(childSnapshotMatch[1]!, childSnapshotMatch[2]!));
      }

      const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)\/snapshot$/);
      if (req.method === "GET" && sessionMatch) {
        const sessionId = sessionMatch[1]!;
        const [snapshot, subagents, apiUsage] = await Promise.all([
          services.registry.snapshot(sessionId),
          services.subagentSessions.summaries(sessionId),
          services.subagentSessions.statistics(sessionId),
        ]);
        return jsonResponse({ ...snapshot, subagents, apiUsage });
      }

      const eventsMatch = path.match(/^\/api\/sessions\/([^/]+)\/events$/);
      if (req.method === "GET" && eventsMatch) {
        return sessionEvents(services, eventsMatch[1]!);
      }

      const fileWatchesMatch = path.match(/^\/api\/sessions\/([^/]+)\/file-watches\/([^/]+)$/);
      if (req.method === "PUT" && fileWatchesMatch) {
        const body = await jsonBody<{ revision: unknown; directories: unknown }>(req);
        if (!Number.isSafeInteger(body.revision) || (body.revision as number) < 0) {
          return errorResponse(400, "revision must be a non-negative safe integer");
        }
        if (!Array.isArray(body.directories) || !body.directories.every((directory) => typeof directory === "string")) {
          return errorResponse(400, "directories must be an array of paths");
        }
        const applied = services.registry.replaceFileWatchLease(
          fileWatchesMatch[1]!,
          fileWatchesMatch[2]!,
          body.revision as number,
          body.directories as string[],
        );
        return jsonResponse({ ok: true, applied });
      }

      const messagesMatch = path.match(/^\/api\/sessions\/([^/]+)\/messages$/);
      if (req.method === "POST" && messagesMatch) {
        const body = await jsonBody<{ message: string }>(req);
        if (!body.message || typeof body.message !== "string") {
          return errorResponse(400, "message is required");
        }
        await services.registry.prompt(messagesMatch[1]!, body.message);
        return jsonResponse({ ok: true });
      }

      const commandsMatch = path.match(/^\/api\/sessions\/([^/]+)\/commands$/);
      if (req.method === "GET" && commandsMatch) {
        const commands = await services.registry.getCommands(commandsMatch[1]!);
        return jsonResponse({
          commands: commands.map((command) => ({
            name: command.name.startsWith("skill:") ? command.name.slice("skill:".length) : command.name,
            source: command.source,
            ...(command.description !== undefined ? { description: command.description } : {}),
            ...(command.requiresPrefix !== undefined ? { requiresPrefix: command.requiresPrefix } : {}),
          })),
        });
      }

      const treeMatch = path.match(/^\/api\/sessions\/([^/]+)\/tree$/);
      if (req.method === "GET" && treeMatch) {
        const { tree, ...state } = await services.registry.getTree(treeMatch[1]!);
        return jsonResponse({ tree: flattenMessageTree(tree), ...state });
      }

      const treeNavigateMatch = path.match(/^\/api\/sessions\/([^/]+)\/tree\/navigate$/);
      if (req.method === "POST" && treeNavigateMatch) {
        const body = await jsonBody<{
          entryId: unknown;
          summarize?: unknown;
          customInstructions?: unknown;
        }>(req);
        if (typeof body.entryId !== "string" || !body.entryId) return errorResponse(400, "entryId is required");
        if (body.summarize !== undefined && typeof body.summarize !== "boolean") {
          return errorResponse(400, "summarize must be a boolean");
        }
        if (body.customInstructions !== undefined && typeof body.customInstructions !== "string") {
          return errorResponse(400, "customInstructions must be a string");
        }
        const options = {
          ...(body.summarize !== undefined ? { summarize: body.summarize } : {}),
          ...(body.customInstructions !== undefined ? { customInstructions: body.customInstructions } : {}),
        };
        return jsonResponse(await services.registry.navigateTree(
          treeNavigateMatch[1]!,
          body.entryId,
          Object.keys(options).length > 0 ? options : undefined,
        ));
      }

      const compactMatch = path.match(/^\/api\/sessions\/([^/]+)\/compact$/);
      if (req.method === "POST" && compactMatch) {
        const body = await jsonBody<{ customInstructions?: unknown }>(req);
        if (body.customInstructions !== undefined && typeof body.customInstructions !== "string") {
          return errorResponse(400, "customInstructions must be a string");
        }
        return jsonResponse(await services.registry.compact(compactMatch[1]!, body.customInstructions));
      }

      const sessionNameMatch = path.match(/^\/api\/sessions\/([^/]+)\/name$/);
      if (req.method === "PUT" && sessionNameMatch) {
        const body = await jsonBody<{ name: unknown }>(req);
        if (typeof body.name !== "string") return errorResponse(400, "name (string) is required");
        await services.renameSession(sessionNameMatch[1]!, body.name);
        return jsonResponse({ ok: true });
      }

      const actionMatch = path.match(/^\/api\/sessions\/([^/]+)\/(abort|stop|restart)$/);
      if (req.method === "POST" && actionMatch) {
        const id = actionMatch[1]!;
        const action = actionMatch[2]!;
        if (action === "abort") {
          await services.registry.abort(id);
        } else if (action === "stop") {
          await services.registry.stop(id);
        } else {
          return jsonResponse(await services.registry.restart(id));
        }
        return jsonResponse({ ok: true });
      }

      if (path === "/api/config" && req.method === "GET") {
        return jsonResponse(
          await services.config.list(configFileParams(url)),
        );
      }

      if (path === "/api/config/events" && req.method === "GET") {
        return configurationEvents(services.configuration);
      }

      if (path === "/api/config/file" && req.method === "GET") {
        const params = configFileParams(url);
        return jsonResponse({
          path: params.path,
          content: await services.config.read({ scope: params.scope, cwd: params.cwd, path: requireQuery(url, "path") }),
        });
      }

      if (path === "/api/config/file" && req.method === "PUT") {
        const body = await jsonBody<{ scope: ConfigScope; cwd?: string; path: string; content: string }>(req);
        await services.config.write(body);
        return jsonResponse({ ok: true });
      }

      if (path === "/api/config/directory" && req.method === "POST") {
        const body = await jsonBody<{ scope: ConfigScope; cwd?: string; path?: string }>(req);
        await services.config.createDirectory(body);
        return jsonResponse({ ok: true });
      }

      if (path === "/api/config/projects" && req.method === "GET") {
        return jsonResponse(await services.listConfigProjects());
      }

      if (services.auth) {
        if (req.method === "GET" && path === "/api/auth/providers") {
          const providers = await services.auth.listProviders();
          return jsonResponse({ providers } satisfies AuthProvidersResponseDto);
        }

        if (req.method === "POST" && path === "/api/auth/login") {
          const body = await jsonBody<AuthLoginRequestDto>(req);
          if (
            !body.providerId ||
            (body.type !== "api_key" && body.type !== "oauth")
          ) {
            return errorResponse(400, "providerId and type (api_key|oauth) are required");
          }
          const flowId = randomUUID();
          try {
            await services.auth.preflight({ flowId, providerId: body.providerId, type: body.type });
          } catch (err) {
            if (err instanceof AuthGatewayError) {
              if (err.status === 409) {
                return errorResponse(409, err.message, { activeFlowId: services.auth.activeFlow() });
              }
              return errorResponse(err.status, err.message);
            }
            throw err;
          }
          void services.auth
            .runFlow({ flowId, providerId: body.providerId, type: body.type })
            .catch((err) => {
              services.logger.error(`auth flow ${flowId} crashed`, { error: String(err) });
            });
          return jsonResponse({ flowId } as { flowId: string }, 202);
        }

        if (req.method === "GET" && path.startsWith("/api/auth/flows/") && path.endsWith("/events")) {
          const flowId = decodeURIComponent(
            path.slice("/api/auth/flows/".length, -"/events".length),
          );
          const store = services.auth.store();
          if (!store.get(flowId)) return errorResponse(404, `unknown flow: ${flowId}`);
          return authFlowSse(services, flowId);
        }

        if (req.method === "POST" && path.startsWith("/api/auth/flows/") && path.endsWith("/respond")) {
          const flowId = decodeURIComponent(
            path.slice("/api/auth/flows/".length, -"/respond".length),
          );
          const store = services.auth.store();
          const rec = store.get(flowId);
          if (!rec) return errorResponse(404, `unknown flow: ${flowId}`);
          if (rec.terminated) return errorResponse(410, "flow already terminated");
          if (!rec.pendingPrompt) {
            return errorResponse(409, "no prompt pending", { expected: null });
          }
          const body = await jsonBody<AuthRespondRequestDto>(req);
          if (typeof body.value !== "string") return errorResponse(400, "value (string) is required");
          const ok = store.resolveRespond(flowId, body.value);
          if (!ok) return errorResponse(409, "no prompt pending");
          return jsonResponse({ ok: true });
        }

        if (req.method === "POST" && path.startsWith("/api/auth/flows/") && path.endsWith("/cancel")) {
          const flowId = decodeURIComponent(
            path.slice("/api/auth/flows/".length, -"/cancel".length),
          );
          const store = services.auth.store();
          if (!store.get(flowId)) return errorResponse(404, `unknown flow: ${flowId}`);
          store.cancel(flowId);
          return jsonResponse({ ok: true });
        }

        if (req.method === "POST" && path === "/api/auth/logout") {
          const body = await jsonBody<AuthLogoutRequestDto>(req);
          if (!body.providerId) return errorResponse(400, "providerId is required");
          try {
            await services.auth.logout(body.providerId);
          } catch (err) {
            if (err instanceof AuthGatewayError) return errorResponse(err.status, err.message);
            throw err;
          }
          return jsonResponse({ ok: true });
        }
      }

      if (req.method === "GET") {
        const assetPath = path === "/" ? "index.html" : path.replace(/^\//, "");
        const file =
          bundledFilePath(`webui/dist/${assetPath}`) ?? join(services.webuiDist, assetPath);
        try {
          const content = readFileSync(file);
          return new Response(content, { headers: { "Content-Type": contentType(file) } });
        } catch {
          return new Response("Not found", { status: 404 });
        }
      }

      return new Response("Not found", { status: 404 });
    } catch (error) {
      if (error instanceof ConfigPathError) return errorResponse(403, error.message);
      if (error instanceof ConfigServiceError) {
        return errorResponse(error.status, error.message, error.code ? { code: error.code } : undefined);
      }
      if (error instanceof DirectoryServiceError) return errorResponse(error.status, error.message);
      if (error instanceof ExtensionGuardError) return errorResponse(400, error.message);
      if (error instanceof UnknownSessionError) return errorResponse(404, error.message);
      if (error instanceof UnknownFileWatchLeaseError) return errorResponse(404, error.message);
      if (error instanceof FileWatchPathError) return errorResponse(400, error.message);
      if (error instanceof SubagentSessionNotFoundError) return errorResponse(404, error.message);
      if (error instanceof BodyError) return errorResponse(400, error.message);
      if (error instanceof ConfigurationUnavailableError) {
        return configurationUnavailableResponse(error);
      }
      if (error instanceof SessionStartError) {
        const cause = error.originalError;
        services.logger.error("session start failed", {
          error: cause instanceof Error ? (cause.stack ?? cause.message) : String(cause),
        });
        return cause instanceof ConfigurationUnavailableError
          ? configurationUnavailableResponse(cause)
          : errorResponse(
          500,
          "Unable to start the session. Check the EasyResearch log and verify the project and model settings.",
          { code: "SESSION_START_FAILED" },
        );
      }
      return errorResponse(500, "Internal server error");
    }
  };
}

async function createSession(
  services: RouteServices,
  body: { cwd: string },
): Promise<Response> {
  if (!body.cwd) throw new BodyError("cwd is required");
  const cwd = services.directories.requireCwd(body.cwd);
  try {
    return jsonResponse(await services.registry.create({ cwd }));
  } catch (error) {
    if (error instanceof ExtensionGuardError) throw error;
    throw new SessionStartError(error);
  }
}

async function openSession(
  services: RouteServices,
  body: { path: string },
): Promise<Response> {
  if (!body.path) throw new BodyError("path is required");
  const sessions = await services.listAllSessions();
  const session = sessions.find((s) => s.path === body.path);
  if (!session) throw new UnknownSessionError(`Unknown session path: ${body.path}`);
  services.directories.requireCwd(session.cwd);
  try {
    const dto: ActiveSessionDto = await services.registry.open({
      cwd: session.cwd,
      sessionPath: session.path,
    });
    return jsonResponse(dto);
  } catch (error) {
    if (error instanceof ExtensionGuardError) throw error;
    throw new SessionStartError(error);
  }
}

class SessionStartError extends Error {
  constructor(readonly originalError: unknown) {
    super("Session runtime construction failed");
  }
}

/**
 * Serves canonicalized raw file bytes with MIME metadata and single-range
 * support. No Range header yields `200` with the full bytes; a valid range
 * yields `206` with a `Content-Range` header; an unsatisfiable or malformed
 * range yields `416` with `Content-Range` set to `bytes` star-slash `<size>`.
 * Both full and ranged bodies are streamed via {@link DirectoryService.readFileStream}
 * so only the requested bytes are read into memory.
 */
function rawFileResponse(directories: DirectoryService, path: string, rangeHeader: string | null): Response {
  const descriptor = directories.describeFile(path);
  try {
    const range = rangeHeader === null ? null : (parseByteRange(rangeHeader, descriptor.size) as ByteRange);
    const length = range === null ? descriptor.size : range.end - range.start + 1;
    const headers: Record<string, string> = {
      "Content-Type": descriptor.mimeType,
      "Content-Length": String(length),
      "Accept-Ranges": "bytes",
    };
    if (rangeHeader !== null) {
      headers["Content-Range"] = `bytes ${range!.start}-${range!.end}/${descriptor.size}`;
      return new Response(directories.readFileStream(path, range), { status: 206, headers });
    }
    return new Response(directories.readFileStream(path, null), { status: 200, headers });
  } catch (error) {
    if (error instanceof RawFileRangeError) return rangeErrorResponse(descriptor);
    throw error;
  }
}

function rangeErrorResponse(descriptor: RawFileDescriptor): Response {
  return new Response(JSON.stringify({ error: "Invalid byte range" }), {
    status: 416,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Range": `bytes */${descriptor.size}`,
    },
  });
}

function sessionEvents(services: RouteServices, id: string): Response {
  const { registry, logger, subagentSessions } = services;
  const encoder = new TextEncoder();
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  let unsubscribe: (() => void) | null = null;
  let fileWatchLeaseId: string | null = null;
  let snapshotAcquired = false;
  let initialized = false;
  let cancelled = false;
  const preBarrierSupplements: unknown[] = [];
  const postBarrierEvents: unknown[] = [];
  const send = (controller: ReadableStreamDefaultController<Uint8Array>, event: unknown): void => {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
  };
  const publishOrQueue = (event: unknown): void => {
    if (cancelled) return;
    if (!initialized) {
      if (snapshotAcquired) postBarrierEvents.push(event);
      else if (isPreBarrierSupplement(event)) preBarrierSupplements.push(event);
      return;
    }
    if (controllerRef) send(controllerRef, event);
  };
  let usageRefreshTail = Promise.resolve();
  const refreshUsage = (record: ApiUsageRecordDto): void => {
    usageRefreshTail = usageRefreshTail
      .then(async () => {
        const statistics = await subagentSessions.trackUsage(id, record);
        publishOrQueue({ type: "api_usage_changed", statistics });
      })
      .catch(() => {
        logger.warn("api usage projection refresh failed", { sessionId: id });
      });
  };
  const disconnect = (): void => {
    if (cancelled) return;
    cancelled = true;
    preBarrierSupplements.length = 0;
    postBarrierEvents.length = 0;
    const stopListening = unsubscribe;
    unsubscribe = null;
    const leaseId = fileWatchLeaseId;
    fileWatchLeaseId = null;
    if (leaseId) registry.releaseFileWatchLease(id, leaseId);
    stopListening?.();
    controllerRef = null;
    logger.info("sse disconnected", { sessionId: id });
  };
  try {
    unsubscribe = registry.subscribe(id, (event) => {
      if (cancelled) return;
      const publicEvent = publicSessionEvent(event);
      if (publicEvent === undefined) return;
      const enrichedEvent = withApiUsageRecord(publicEvent, id);
      publishOrQueue(enrichedEvent);
      const usageRecord = trackedUsageRecord(enrichedEvent);
      if (usageRecord !== undefined) refreshUsage(usageRecord);
    });
    fileWatchLeaseId = registry.acquireFileWatchLease(id);
  } catch {
    unsubscribe?.();
    unsubscribe = null;
    throw new UnknownSessionError(`Unknown session: ${id}`);
  }
  logger.info("sse connected", { sessionId: id });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      Promise.all([
        registry.snapshot(id, () => {
          snapshotAcquired = true;
        }),
        subagentSessions.summaries(id),
        subagentSessions.statistics(id),
      ]).then(
        ([snapshot, subagents, apiUsage]) => {
          if (cancelled) return;
          send(controller, { type: "snapshot", ...snapshot, subagents, apiUsage, fileWatchLeaseId });
          for (const event of preBarrierSupplements) send(controller, event);
          for (const event of postBarrierEvents) send(controller, event);
          preBarrierSupplements.length = 0;
          postBarrierEvents.length = 0;
          initialized = true;
        },
        (error) => {
          if (cancelled) return;
          send(controller, { type: "error", error: String(error) });
          disconnect();
          controller.close();
        },
      );
    },
    cancel() {
      // Browser disconnect only unsubscribes; the registry entry keeps running.
      disconnect();
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}

function trackedUsageRecord(event: unknown): ApiUsageRecordDto | undefined {
  if (!isObject(event)) return undefined;
  if (event.type === "entry_appended" && isObject(event.apiUsageRecord)) {
    return event.apiUsageRecord as unknown as ApiUsageRecordDto;
  }
  if (event.type !== "subagent_supervisor" || !isObject(event.event)) return undefined;
  const childEvent = event.event;
  return childEvent.type === "entry_appended" && isObject(childEvent.apiUsageRecord)
    ? childEvent.apiUsageRecord as unknown as ApiUsageRecordDto
    : undefined;
}

function withApiUsageRecord(event: unknown, rootSessionId: string): unknown {
  if (!isObject(event)) return event;
  if (event.type === "entry_appended") {
    const apiUsageRecord = projectApiUsageRecord(rootSessionId, event.entry);
    return apiUsageRecord === undefined ? event : { ...event, apiUsageRecord };
  }
  if (event.type !== "subagent_supervisor" || !isObject(event.event)) return event;
  const childEvent = event.event;
  if (childEvent.type !== "entry_appended") return event;
  const childSessionId = typeof event.childSessionId === "string" ? event.childSessionId : undefined;
  if (!childSessionId) return event;
  const apiUsageRecord = projectApiUsageRecord(childSessionId, childEvent.entry);
  return apiUsageRecord === undefined
    ? event
    : { ...event, event: { ...childEvent, apiUsageRecord } };
}

function authFlowSse(services: RouteServices, flowId: string): Response {
  const encoder = new TextEncoder();
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  let unsubscribe: (() => void) | null = null;
  let closed = false;
  const store = services.auth!.store();
  const rec = store.get(flowId);
  const send = (controller: ReadableStreamDefaultController<Uint8Array>, event: AuthFlowEventDto) => {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
  };
  const finish = (): void => {
    if (closed) return;
    closed = true;
    const stop = unsubscribe;
    unsubscribe = null;
    stop?.();
    try {
      controllerRef?.close();
    } catch {
      // already closed
    }
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      // `subscribe` replays buffered notifies + pending prompt + the terminal
      // event (when the flow already terminated), then forwards live. A
      // terminal `done`/`error` closes the stream.
      unsubscribe = store.subscribe(flowId, (event) => {
        if (closed) return;
        send(controller, event);
        if (event.type === "done" || event.type === "error") finish();
      });
      // Defensive: a terminated flow must close even without a terminal event.
      if (rec?.terminated) finish();
    },
    cancel() {
      finish();
      controllerRef = null;
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}

function configurationEvents(
  configuration: Pick<LiveConfiguration, "generation" | "error" | "subscribe">,
): Response {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let initialized = false;
  let cancelled = false;
  const send = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    event: ConfigurationEvent,
  ): void => {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      unsubscribe = configuration.subscribe((event) => {
        if (cancelled || !initialized) return;
        send(controller, event);
      });
      const error = configuration.error;
      if (error !== null) {
        send(controller, {
          type: "config.error",
          generation: configuration.generation,
          message: error,
        });
      } else {
        send(controller, {
          type: "config.updated",
          generation: configuration.generation,
          agentsChanged: true,
          modelsChanged: true,
        });
      }
      initialized = true;
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      const stop = unsubscribe;
      unsubscribe = null;
      stop?.();
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}

function isPreBarrierSupplement(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  const value = event as { type?: unknown };
  if (
    value.type === "file.watcher.updated" ||
    value.type === "agent_start" ||
    value.type === "agent_settled" ||
    value.type === "session_deactivated" ||
    value.type === "api_usage_changed" ||
    value.type === "error"
  ) {
    return true;
  }
  return isSubagentSupervisorEvent(event);
}

function publicSessionEvent(event: unknown): unknown | undefined {
  if (!event || typeof event !== "object" || (event as { type?: unknown }).type !== "subagent_supervisor") {
    return event;
  }
  if (!isSubagentSupervisorEvent(event)) return undefined;
  const value = event as Record<string, unknown>;
  return {
    type: "subagent_supervisor",
    launchId: value.launchId,
    ownerSessionId: value.ownerSessionId,
    toolCallId: value.toolCallId,
    agent: value.agent,
    agentId: value.agentId,
    childSessionId: value.childSessionId,
    status: value.status,
    ...(typeof value.latestMessage === "string" ? { latestMessage: value.latestMessage } : {}),
    ...(isObject(value.event) ? { event: value.event } : {}),
  };
}

function isSubagentSupervisorEvent(event: unknown): boolean {
  if (!isObject(event) || event.type !== "subagent_supervisor") return false;
  if (event.status !== "working" && event.status !== "complete" && event.status !== "error") return false;
  return [
    event.launchId,
    event.ownerSessionId,
    event.toolCallId,
    event.agent,
    event.agentId,
    event.childSessionId,
  ].every((value) => typeof value === "string" && value.trim().length > 0);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function configFileParams(url: URL): { scope: ConfigScope; cwd?: string; path?: string } {
  const scope = (url.searchParams.get("scope") ?? "global") as ConfigScope;
  const cwd = url.searchParams.get("cwd") ?? undefined;
  const path = url.searchParams.get("path") ?? undefined;
  return { scope, cwd, path };
}

class BodyError extends Error {}

function requireQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) throw new BodyError(`${name} query parameter is required`);
  return value;
}

async function jsonBody<T>(req: Request): Promise<T> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new BodyError("Malformed JSON body");
  }
  if (body === null || typeof body !== "object") throw new BodyError("Malformed JSON body");
  return body as T;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function errorResponse(status: number, message: string, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ error: message, ...extra }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function configurationUnavailableResponse(error: ConfigurationUnavailableError): Response {
  return errorResponse(503, error.message, { code: "CONFIGURATION_UNAVAILABLE" });
}

function contentType(file: string): string {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}
