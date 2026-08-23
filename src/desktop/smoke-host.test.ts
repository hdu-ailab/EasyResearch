import { describe, expect, it, vi } from "vitest";
import { DESKTOP_ACCESS_HEADER } from "./contracts";
import { prepareDesktopSmokeWork } from "./smoke-host";

describe("packaged desktop smoke preflight", () => {
  it("verifies sequential state then starts one real active session", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown; token: string | null }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
      requests.push({
        url,
        method: init?.method ?? "GET",
        body,
        token: new Headers(init?.headers).get(DESKTOP_ACCESS_HEADER),
      });
      if (url.endsWith("/api/status")) {
        return new Response(JSON.stringify({
          sessions: [{ path: "/agent/sessions/persisted.jsonl" }],
        }), { status: 200 });
      }
      if (url.includes("/api/agents?")) {
        return new Response(JSON.stringify([{ name: "smoke-reviewer", source: "global" }]), { status: 200 });
      }
      if (url.endsWith("/api/sessions")) {
        return new Response(JSON.stringify({ id: "active-session", cwd: "/project" }), { status: 200 });
      }
      if (url.endsWith("/messages")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    await expect(prepareDesktopSmokeWork({
      origin: "http://127.0.0.1:43123",
      rendererToken: "renderer-secret",
      project: "/project",
      expectedSessionPath: "/agent/sessions/persisted.jsonl",
      expectedAgent: "smoke-reviewer",
      fetch,
    })).resolves.toEqual({ sessionId: "active-session" });

    expect(requests.map(({ method, url }) => [method, new URL(url).pathname])).toEqual([
      ["GET", "/api/status"],
      ["GET", "/api/agents"],
      ["POST", "/api/sessions"],
      ["POST", "/api/sessions/active-session/messages"],
    ]);
    expect(requests.every(({ token }) => token === "renderer-secret")).toBe(true);
    expect(requests[2]?.body).toEqual({ cwd: "/project" });
  });

  it("fails before session creation when sequential state is missing", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ sessions: [] }), { status: 200 }));
    await expect(prepareDesktopSmokeWork({
      origin: "http://127.0.0.1:43123",
      rendererToken: "renderer-secret",
      project: "/project",
      expectedSessionPath: "/missing.jsonl",
      expectedAgent: "smoke-reviewer",
      fetch,
    })).rejects.toThrow(/persisted CLI session/i);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
