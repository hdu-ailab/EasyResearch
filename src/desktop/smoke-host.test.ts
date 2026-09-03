import { describe, expect, it, vi } from "vitest";
import { DESKTOP_ACCESS_HEADER } from "./contracts";
import {
  desktopSmokeRestartFailureEvent,
  desktopSmokeSidecarReadyEvent,
  desktopSmokeWorkHash,
  isDesktopSmokeRestoredWorkDocument,
  prepareDesktopSmokeWork,
  requestDesktopSmokeRestart,
  verifyDesktopSmokeSuccessor,
} from "./smoke-host";

describe("packaged desktop smoke preflight", () => {
  const baseOptions = {
    origin: "http://127.0.0.1:43123",
    rendererToken: "renderer-secret",
    project: "/project",
    expectedSessionPath: "/agent/sessions/persisted.jsonl",
    expectedAgent: "smoke-reviewer",
  };

  it("serializes the smoke session and cwd as a canonical Work hash", () => {
    expect(desktopSmokeWorkHash("session one/part", "/paper one?set=1&part=2")).toBe(
      "#/work/session%20one%2Fpart?cwd=%2Fpaper%20one%3Fset%3D1%26part%3D2",
    );
  });

  it("emits only canonical Work identity for deterministic restart failure recovery", () => {
    const hash = "#/work/session%20one?cwd=%2Fpaper%20one";
    expect([
      "successor-start-failed",
      "restart-recovery-visible",
      "successor-retry-requested",
    ].map((milestone) => desktopSmokeRestartFailureEvent(milestone as never, hash))).toEqual([
      { type: "desktop-smoke.successor-start-failed", hash },
      { type: "desktop-smoke.restart-recovery-visible", hash },
      { type: "desktop-smoke.successor-retry-requested", hash },
    ]);
    expect(() => desktopSmokeRestartFailureEvent("successor-start-failed", "#/"))
      .toThrow(/canonical Work hash/i);
  });

  it("projects a fresh successor ready event without exposing either renderer credential", () => {
    const event = desktopSmokeSidecarReadyEvent({
      origin: "http://127.0.0.1:45556",
      bootId: "boot-new",
      sidecarPid: 42,
      rendererToken: "renderer-new-secret",
    }, {
      bootId: "boot-old",
      rendererToken: "renderer-old-secret",
    });

    expect(event).toEqual({
      type: "desktop-smoke.sidecar-ready",
      origin: "http://127.0.0.1:45556",
      bootId: "boot-new",
      sidecarPid: 42,
      rendererCredentialFresh: true,
    });
    expect(JSON.stringify(event)).not.toContain("renderer-new-secret");
    expect(JSON.stringify(event)).not.toContain("renderer-old-secret");
  });

  it("rejects successor readiness when the renderer credential was reused", () => {
    expect(() => desktopSmokeSidecarReadyEvent({
      origin: "http://127.0.0.1:45556",
      bootId: "boot-new",
      sidecarPid: 42,
      rendererToken: "renderer-reused-secret",
    }, {
      bootId: "boot-old",
      rendererToken: "renderer-reused-secret",
    })).toThrow(/fresh renderer credential/i);
  });

  it("rejects successor readiness when the boot identity was reused", () => {
    expect(() => desktopSmokeSidecarReadyEvent({
      origin: "http://127.0.0.1:45556",
      bootId: "boot-old",
      sidecarPid: 42,
      rendererToken: "renderer-new-secret",
    }, {
      bootId: "boot-old",
      rendererToken: "renderer-old-secret",
    })).toThrow(/fresh boot/i);
  });

  it("accepts only the exact successor document with the canonical Work hash", () => {
    const origin = "http://127.0.0.1:45556";
    const hash = "#/work/session%20one?cwd=%2Fpaper%20one";
    expect(isDesktopSmokeRestoredWorkDocument(`${origin}/${hash}`, origin, hash)).toBe(true);
    expect(isDesktopSmokeRestoredWorkDocument(
      `http://127.0.0.1:45557/${hash}`,
      origin,
      hash,
    )).toBe(false);
    expect(isDesktopSmokeRestoredWorkDocument(`${origin}/extra${hash}`, origin, hash)).toBe(false);
    expect(isDesktopSmokeRestoredWorkDocument(`${origin}/?extra=1${hash}`, origin, hash)).toBe(false);
    expect(isDesktopSmokeRestoredWorkDocument(`${origin}/#/`, origin, hash)).toBe(false);
  });

  it("waits past POST acceptance and child-only activity for a real root run", async () => {
    const requests: Array<{
      url: string;
      method: string;
      body?: unknown;
      token: string | null;
      signal?: AbortSignal | null;
    }> = [];
    let activity = { status: "ready", isStreaming: false };
    const waiters: Array<() => void> = [];
    const wait = vi.fn(() => new Promise<void>((resolve) => waiters.push(resolve)));
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
      requests.push({
        url,
        method: init?.method ?? "GET",
        body,
        token: new Headers(init?.headers).get(DESKTOP_ACCESS_HEADER),
        signal: init?.signal,
      });
      if (url.endsWith("/api/status")) {
        return new Response(JSON.stringify({
          bootId: "boot-old",
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
      if (url.endsWith("/snapshot")) {
        return new Response(JSON.stringify({ session: activity, timeline: [] }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    let settled = false;
    const pending = prepareDesktopSmokeWork({
      ...baseOptions,
      fetch,
      now: () => 0,
      wait,
    }).finally(() => { settled = true; });

    await vi.waitFor(() => expect(wait).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);

    activity = { status: "running", isStreaming: false };
    waiters.shift()?.();
    await vi.waitFor(() => expect(wait).toHaveBeenCalledTimes(2));
    expect(settled).toBe(false);

    activity = { status: "running", isStreaming: true };
    waiters.shift()?.();
    await expect(pending).resolves.toEqual({
      sessionId: "active-session",
      bootId: "boot-old",
    });

    expect(requests.map(({ method, url }) => [method, new URL(url).pathname])).toEqual([
      ["GET", "/api/status"],
      ["GET", "/api/agents"],
      ["POST", "/api/sessions"],
      ["POST", "/api/sessions/active-session/messages"],
      ["GET", "/api/sessions/active-session/snapshot"],
      ["GET", "/api/sessions/active-session/snapshot"],
      ["GET", "/api/sessions/active-session/snapshot"],
    ]);
    expect(requests.every(({ token }) => token === "renderer-secret")).toBe(true);
    expect(requests.filter(({ url }) => url.endsWith("/snapshot")).every(
      ({ signal }) => signal instanceof AbortSignal,
    )).toBe(true);
    expect(requests[2]?.body).toEqual({ cwd: "/project" });
  });

  it("fails actionably when root activity never starts before the deadline", async () => {
    let now = 0;
    const fetch = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/status")) {
        return new Response(JSON.stringify({
          bootId: "boot-old",
          sessions: [{ path: baseOptions.expectedSessionPath }],
        }), { status: 200 });
      }
      if (url.includes("/api/agents?")) {
        return new Response(JSON.stringify([{ name: baseOptions.expectedAgent, source: "global" }]), { status: 200 });
      }
      if (url.endsWith("/api/sessions")) {
        return new Response(JSON.stringify({ id: "idle-session" }), { status: 200 });
      }
      if (url.endsWith("/messages")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.endsWith("/snapshot")) {
        return new Response(JSON.stringify({
          session: { status: "ready", isStreaming: false },
          timeline: [],
        }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    await expect(prepareDesktopSmokeWork({
      ...baseOptions,
      fetch,
      activityTimeoutMs: 20,
      pollIntervalMs: 10,
      now: () => now,
      wait: async (delayMs) => { now += delayMs; },
    })).rejects.toThrow(/idle-session.*root.*running.*latest.*ready.*false/is);
  });

  it("reports an authenticated snapshot request failure with its session route", async () => {
    const fetch = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/status")) {
        return new Response(JSON.stringify({
          bootId: "boot-old",
          sessions: [{ path: baseOptions.expectedSessionPath }],
        }), { status: 200 });
      }
      if (url.includes("/api/agents?")) {
        return new Response(JSON.stringify([{ name: baseOptions.expectedAgent, source: "global" }]), { status: 200 });
      }
      if (url.endsWith("/api/sessions")) {
        return new Response(JSON.stringify({ id: "failed-session" }), { status: 200 });
      }
      if (url.endsWith("/messages")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response("snapshot unavailable", { status: 503 });
    });

    await expect(prepareDesktopSmokeWork({ ...baseOptions, fetch })).rejects.toThrow(
      /\/api\/sessions\/failed-session\/snapshot.*HTTP 503/i,
    );
    expect(fetch.mock.calls.every(([, init]) =>
      new Headers(init?.headers).get(DESKTOP_ACCESS_HEADER) === "renderer-secret"
    )).toBe(true);
  });

  it("validates the root activity deadline before dispatching the message", async () => {
    const requests: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(new URL(url).pathname);
      if (url.endsWith("/api/status")) {
        return new Response(JSON.stringify({
          bootId: "boot-old",
          sessions: [{ path: baseOptions.expectedSessionPath }],
        }), { status: 200 });
      }
      if (url.includes("/api/agents?")) {
        return new Response(JSON.stringify([{ name: baseOptions.expectedAgent, source: "global" }]), { status: 200 });
      }
      if (url.endsWith("/api/sessions")) {
        return new Response(JSON.stringify({ id: "invalid-deadline-session" }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    await expect(prepareDesktopSmokeWork({
      ...baseOptions,
      fetch,
      activityTimeoutMs: 0,
    })).rejects.toThrow(/root activity timeout.*positive integer/i);
    expect(requests).not.toContain("/api/sessions/invalid-deadline-session/messages");
  });

  it("aborts a stalled message POST within the root activity deadline", async () => {
    let messageSignal: AbortSignal | undefined;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/status")) {
        return new Response(JSON.stringify({
          bootId: "boot-old",
          sessions: [{ path: baseOptions.expectedSessionPath }],
        }), { status: 200 });
      }
      if (url.includes("/api/agents?")) {
        return new Response(JSON.stringify([{ name: baseOptions.expectedAgent, source: "global" }]), { status: 200 });
      }
      if (url.endsWith("/api/sessions")) {
        return new Response(JSON.stringify({ id: "stalled-post-session" }), { status: 200 });
      }
      if (url.endsWith("/messages")) {
        messageSignal = init?.signal instanceof AbortSignal ? init.signal : undefined;
        if (!messageSignal) return new Response(JSON.stringify({ ok: true }), { status: 200 });
        return await new Promise<Response>((_resolve, reject) => {
          messageSignal?.addEventListener("abort", () => reject(messageSignal?.reason), { once: true });
        });
      }
      if (url.endsWith("/snapshot")) {
        return new Response(JSON.stringify({
          session: { status: "running", isStreaming: true },
          timeline: [],
        }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    await expect(prepareDesktopSmokeWork({
      ...baseOptions,
      fetch,
      activityTimeoutMs: 20,
    })).rejects.toThrow(/stalled-post-session.*messages.*root activity.*deadline/is);
    expect(messageSignal?.aborted).toBe(true);
  });

  it("reports message POST preflight failure with the bounded session route", async () => {
    let messageSignal: AbortSignal | undefined;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/status")) {
        return new Response(JSON.stringify({
          bootId: "boot-old",
          sessions: [{ path: baseOptions.expectedSessionPath }],
        }), { status: 200 });
      }
      if (url.includes("/api/agents?")) {
        return new Response(JSON.stringify([{ name: baseOptions.expectedAgent, source: "global" }]), { status: 200 });
      }
      if (url.endsWith("/api/sessions")) {
        return new Response(JSON.stringify({ id: "failed-post-session" }), { status: 200 });
      }
      if (url.endsWith("/messages")) {
        messageSignal = init?.signal instanceof AbortSignal ? init.signal : undefined;
        return new Response("preflight rejected", { status: 503 });
      }
      return new Response("not found", { status: 404 });
    });

    await expect(prepareDesktopSmokeWork({
      ...baseOptions,
      fetch,
    })).rejects.toThrow(/failed-post-session.*messages.*root activity.*HTTP 503/is);
    expect(messageSignal).toBeInstanceOf(AbortSignal);
  });

  it("fails before session creation when sequential state is missing", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      bootId: "boot-old",
      sessions: [],
    }), { status: 200 }));
    await expect(prepareDesktopSmokeWork({
      ...baseOptions,
      expectedSessionPath: "/missing.jsonl",
      fetch,
    })).rejects.toThrow(/persisted CLI session/i);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("persists a restart-required proxy and forces one real restart with renderer authentication", async () => {
    const requests: Array<{
      path: string;
      method: string;
      body?: unknown;
      token: string | null;
      signal?: AbortSignal | null;
    }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? "GET";
      requests.push({
        path,
        method,
        body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined,
        token: new Headers(init?.headers).get(DESKTOP_ACCESS_HEADER),
        signal: init?.signal,
      });
      if (method === "GET" && path === "/api/settings/network-proxy") {
        return Response.json({
          configured: {},
          appliedConfigured: {},
          sources: { all: "direct", llm: "direct", search: "direct" },
          errors: [],
          restartRequired: false,
        });
      }
      if (method === "PATCH" && path === "/api/settings/network-proxy") {
        return Response.json({
          configured: { search: "http://127.0.0.1:45555" },
          appliedConfigured: {},
          sources: { all: "direct", llm: "direct", search: "direct" },
          errors: [],
          restartRequired: true,
        });
      }
      if (method === "POST" && path === "/api/runtime/restart") {
        return Response.json({ accepted: true, bootId: "boot-old" }, { status: 202 });
      }
      return new Response("not found", { status: 404 });
    });

    await expect(requestDesktopSmokeRestart({
      origin: baseOptions.origin,
      rendererToken: baseOptions.rendererToken,
      oldBootId: "boot-old",
      proxyUrl: "http://127.0.0.1:45555",
      fetch,
    })).resolves.toEqual({ bootId: "boot-old" });

    expect(requests).toEqual([
      {
        path: "/api/settings/network-proxy",
        method: "GET",
        body: undefined,
        token: "renderer-secret",
        signal: expect.any(AbortSignal),
      },
      {
        path: "/api/settings/network-proxy",
        method: "PATCH",
        body: { search: "http://127.0.0.1:45555" },
        token: "renderer-secret",
        signal: expect.any(AbortSignal),
      },
      {
        path: "/api/runtime/restart",
        method: "POST",
        body: { force: true },
        token: "renderer-secret",
        signal: expect.any(AbortSignal),
      },
    ]);
  });

  it("accepts only an authenticated fresh boot that retains the persisted session", async () => {
    let observedToken: string | null = null;
    let observedSignal: AbortSignal | null | undefined;
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      observedToken = new Headers(init?.headers).get(DESKTOP_ACCESS_HEADER);
      observedSignal = init?.signal;
      return Response.json({
        bootId: "boot-new",
        sessions: [
          { path: "/agent/sessions/other.jsonl" },
          { path: baseOptions.expectedSessionPath },
        ],
        activeSessions: [],
      });
    });

    await expect(verifyDesktopSmokeSuccessor({
      origin: "http://127.0.0.1:45556",
      rendererToken: "renderer-new-secret",
      oldBootId: "boot-old",
      expectedSessionPath: baseOptions.expectedSessionPath,
      fetch,
    })).resolves.toEqual({ bootId: "boot-new" });
    expect(observedToken).toBe("renderer-new-secret");
    expect(observedSignal).toBeInstanceOf(AbortSignal);
  });

  it("rejects a reachable status response from the old boot", async () => {
    const fetch = vi.fn(async () => Response.json({
      bootId: "boot-old",
      sessions: [{ path: baseOptions.expectedSessionPath }],
      activeSessions: [],
    }));

    await expect(verifyDesktopSmokeSuccessor({
      origin: "http://127.0.0.1:45556",
      rendererToken: "renderer-new-secret",
      oldBootId: "boot-old",
      expectedSessionPath: baseOptions.expectedSessionPath,
      fetch,
    })).rejects.toThrow(/fresh boot/i);
  });

  it("rejects a fresh boot that lost the persisted session", async () => {
    const fetch = vi.fn(async () => Response.json({
      bootId: "boot-new",
      sessions: [{ path: "/agent/sessions/other.jsonl" }],
      activeSessions: [],
    }));

    await expect(verifyDesktopSmokeSuccessor({
      origin: "http://127.0.0.1:45556",
      rendererToken: "renderer-new-secret",
      oldBootId: "boot-old",
      expectedSessionPath: baseOptions.expectedSessionPath,
      fetch,
    })).rejects.toThrow(/persisted CLI session/i);
  });
});
