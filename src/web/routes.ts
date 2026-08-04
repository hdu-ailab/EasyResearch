import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { applyConfigRootToPi, getSessionsDir, loadConfig } from "../config";

/**
 * Pure request routing for the web panel. The Bun HTTP server in server.ts is
 * a thin wrapper over this; keeping routing here (node-compatible) makes the
 * API testable under vitest without a Bun global.
 */
export async function routeRequest(req: Request, webuiDist: string): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "GET" && url.pathname === "/api/status") {
    return apiStatus();
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    return sseResponse();
  }

  if (req.method === "GET") {
    const assetPath = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\//, "");
    const file = join(webuiDist, assetPath);
    try {
      const content = readFileSync(file);
      return new Response(content, { headers: { "Content-Type": contentType(file) } });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  }

  return new Response("Not found", { status: 404 });
}

async function apiStatus(): Promise<Response> {
  applyConfigRootToPi();
  const config = loadConfig();
  const sessions = await SessionManager.listAll(getSessionsDir());
  return Response.json({
    configRoot: process.env.LAZYRESEARCH_CONFIG_DIR ?? null,
    model: config.model ?? null,
    sessions: sessions.map((s) => ({
      id: s.id,
      path: s.path,
      cwd: s.cwd,
      name: s.name,
      created: s.created,
      modified: s.modified,
      messageCount: s.messageCount,
      firstMessage: s.firstMessage,
    })),
  });
}

function sseResponse(): Response {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(`data: ${JSON.stringify({ type: "connected" })}\n\n`);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

function contentType(file: string): string {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}
