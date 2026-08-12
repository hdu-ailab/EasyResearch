import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ActiveSessionDto,
  AgentDto,
  AgentEffectiveModelDto,
  ConfigScope,
  SessionSummaryDto,
  WebuiSettingsDto,
  WebuiSettingsUpdate,
} from "./contracts";
import { createGlobalAgent, listGlobalAgents, readGlobalAgent, writeGlobalAgent, listGlobalSkills, readGlobalSkill, writeGlobalSkill } from "./agent-resources";
import type { DirectoryService } from "./directories";
import { DirectoryServiceError } from "./directories";
import { parseByteRange, RawFileRangeError, type ByteRange, type RawFileDescriptor } from "./raw-file";
import { UnknownSessionError, type ActiveSessionRegistry } from "./active-sessions";
import { ExtensionGuardError } from "../runtime/extensions-guard";
import type { ConfigFileService } from "./config-files";
import { ConfigPathError, ConfigServiceError } from "./config-files";
import { AgentModelError } from "./agent-models";
import { WebuiSettingsError, readWebuiSettings, updateWebuiSettings } from "./webui-settings";
import type { Logger } from "../runtime/logger";
import { SubagentSessionNotFoundError, type SubagentSessionService } from "./subagent-sessions";

export interface RouteServices {
  webuiDist: string;
  listAllSessions: () => Promise<SessionSummaryDto[]>;
  listAgents: (cwd?: string) => Promise<AgentDto[]>;
  listModels: () => Promise<Array<{ provider: string; id: string }>>;
  effectiveModels: (sessionId: string) => Promise<AgentEffectiveModelDto[]>;
  setAgentModel: (sessionId: string, agentName: string, model: string | null) => Promise<void>;
  listConfigProjects: () => Promise<{ home: string; projects: Array<{ cwd: string }> }>;
  getWebuiSettings: () => Promise<WebuiSettingsDto>;
  updateWebuiSettings: (patch: WebuiSettingsUpdate) => Promise<WebuiSettingsDto>;
  directories: DirectoryService;
  registry: ActiveSessionRegistry;
  config: ConfigFileService;
  subagentSessions: Pick<SubagentSessionService, "summaries" | "snapshot">;
  logger: Logger;
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

      if (req.method === "GET" && path === "/api/status") {
        return jsonResponse({
          agentDir: services.config.globalRoot,
          homeDir: services.directories.homeDir,
          sessions: await services.listAllSessions(),
          activeSessions: services.registry.listActive(),
        });
      }

      if (req.method === "GET" && path === "/api/agents") {
        return jsonResponse(await services.listAgents(url.searchParams.get("cwd") ?? undefined));
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

      if (req.method === "GET" && path === "/api/webui-settings") {
        return jsonResponse(await services.getWebuiSettings());
      }

      if (req.method === "PUT" && path === "/api/webui-settings") {
        const body = await jsonBody<WebuiSettingsUpdate>(req);
        return jsonResponse(await services.updateWebuiSettings(body));
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

      const childSnapshotMatch = path.match(/^\/api\/sessions\/([^/]+)\/subagents\/([^/]+)\/snapshot$/);
      if (req.method === "GET" && childSnapshotMatch) {
        return jsonResponse(await services.subagentSessions.snapshot(childSnapshotMatch[1]!, childSnapshotMatch[2]!));
      }

      const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)\/snapshot$/);
      if (req.method === "GET" && sessionMatch) {
        const sessionId = sessionMatch[1]!;
        const snapshot = await services.registry.snapshot(sessionId);
        return jsonResponse({ ...snapshot, subagents: await services.subagentSessions.summaries(sessionId) });
      }

      const eventsMatch = path.match(/^\/api\/sessions\/([^/]+)\/events$/);
      if (req.method === "GET" && eventsMatch) {
        return sessionEvents(services, eventsMatch[1]!);
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

      const effectiveModelsMatch = path.match(/^\/api\/sessions\/([^/]+)\/agents\/effective-models$/);
      if (req.method === "GET" && effectiveModelsMatch) {
        return jsonResponse(await services.effectiveModels(effectiveModelsMatch[1]!));
      }

      const agentModelMatch = path.match(/^\/api\/sessions\/([^/]+)\/agents\/([^/]+)\/model$/);
      if (req.method === "PUT" && agentModelMatch) {
        const body = await jsonBody<{ model: unknown }>(req);
        if (body.model !== null && typeof body.model !== "string") {
          return errorResponse(400, "model must be a string or null");
        }
        await services.setAgentModel(agentModelMatch[1]!, agentModelMatch[2]!, body.model as string | null);
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

      if (req.method === "GET") {
        const assetPath = path === "/" ? "index.html" : path.replace(/^\//, "");
        const file = join(services.webuiDist, assetPath);
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
      if (error instanceof ConfigServiceError) return errorResponse(error.status, error.message);
      if (error instanceof DirectoryServiceError) return errorResponse(error.status, error.message);
      if (error instanceof ExtensionGuardError) return errorResponse(400, error.message);
      if (error instanceof UnknownSessionError) return errorResponse(404, error.message);
      if (error instanceof SubagentSessionNotFoundError) return errorResponse(404, error.message);
      if (error instanceof AgentModelError) return errorResponse(error.status, error.message);
      if (error instanceof WebuiSettingsError) return errorResponse(error.status, error.message);
      if (error instanceof BodyError) return errorResponse(400, error.message);
      return errorResponse(500, "Internal server error");
    }
  };
}

async function createSession(
  services: RouteServices,
  body: { cwd: string },
): Promise<Response> {
  if (!body.cwd) throw new BodyError("cwd is required");
  return jsonResponse(await services.registry.create({ cwd: body.cwd }));
}

async function openSession(
  services: RouteServices,
  body: { path: string },
): Promise<Response> {
  if (!body.path) throw new BodyError("path is required");
  const sessions = await services.listAllSessions();
  const session = sessions.find((s) => s.path === body.path);
  if (!session) throw new UnknownSessionError(`Unknown session path: ${body.path}`);
  const dto: ActiveSessionDto = await services.registry.open({
    cwd: session.cwd,
    sessionPath: session.path,
  });
  return jsonResponse(dto);
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
  let initialized = false;
  let cancelled = false;
  const pendingEvents: unknown[] = [];
  const send = (controller: ReadableStreamDefaultController<Uint8Array>, event: unknown): void => {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
  };
  try {
    unsubscribe = registry.subscribe(id, (event) => {
      if (cancelled) return;
      if (!initialized) {
        pendingEvents.push(event);
        return;
      }
      if (controllerRef) send(controllerRef, event);
    });
  } catch {
    throw new UnknownSessionError(`Unknown session: ${id}`);
  }
  logger.info("sse connected", { sessionId: id });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      Promise.all([registry.snapshot(id), subagentSessions.summaries(id)]).then(
        ([{ session, messages }, subagents]) => {
          if (cancelled) return;
          send(controller, { type: "snapshot", session, messages, subagents });
          initialized = true;
          for (const event of pendingEvents) send(controller, event);
          pendingEvents.length = 0;
        },
        (error) => {
          if (!cancelled) send(controller, { type: "error", error: String(error) });
        },
      );
    },
    cancel() {
      // Browser disconnect only unsubscribes; the registry entry keeps running.
      cancelled = true;
      pendingEvents.length = 0;
      unsubscribe?.();
      logger.info("sse disconnected", { sessionId: id });
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
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

function contentType(file: string): string {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}
