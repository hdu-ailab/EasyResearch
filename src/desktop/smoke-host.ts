import { DESKTOP_ACCESS_HEADER } from "./contracts";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type DesktopSmokeRestartFailureMilestone =
  | "successor-start-failed"
  | "restart-recovery-visible"
  | "successor-retry-requested";

export function desktopSmokeRestartFailureEvent(
  milestone: DesktopSmokeRestartFailureMilestone,
  workHash: string,
): Record<string, unknown> {
  if (!workHash.startsWith("#/work/")) {
    throw new Error("Desktop smoke restart failure milestone requires a canonical Work hash.");
  }
  return { type: `desktop-smoke.${milestone}`, hash: workHash };
}

export function desktopSmokeWorkHash(sessionId: string, cwd: string): string {
  return `#/work/${encodeURIComponent(sessionId)}?cwd=${encodeURIComponent(cwd)}`;
}

export function isDesktopSmokeRestoredWorkDocument(
  documentUrl: string,
  readyOrigin: string,
  expectedHash: string,
): boolean {
  try {
    const document = new URL(documentUrl);
    return document.origin === new URL(readyOrigin).origin
      && document.username === ""
      && document.password === ""
      && document.pathname === "/"
      && document.search === ""
      && document.hash === expectedHash;
  } catch {
    return false;
  }
}

export function desktopSmokeSidecarReadyEvent(
  ready: {
    origin: string;
    bootId: string;
    sidecarPid: number;
    rendererToken: string;
  },
  previous?: { bootId: string; rendererToken: string },
): Record<string, unknown> {
  if (previous && ready.rendererToken === previous.rendererToken) {
    throw new Error("Desktop smoke successor did not use a fresh renderer credential.");
  }
  if (previous && ready.bootId === previous.bootId) {
    throw new Error("Desktop smoke successor did not use a fresh boot identity.");
  }
  return {
    type: "desktop-smoke.sidecar-ready",
    origin: ready.origin,
    bootId: ready.bootId,
    sidecarPid: ready.sidecarPid,
    ...(previous ? { rendererCredentialFresh: true } : {}),
  };
}

export async function requestDesktopSmokeRestart(options: {
  origin: string;
  rendererToken: string;
  oldBootId: string;
  proxyUrl: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}): Promise<{ bootId: string }> {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Desktop smoke restart timeout must be a positive integer.");
  }
  const signal = AbortSignal.timeout(timeoutMs);
  const request = async (path: string, init: RequestInit = {}): Promise<unknown> => {
    const response = await fetchImpl(`${options.origin}${path}`, {
      ...init,
      signal: init.signal ?? signal,
      headers: {
        ...Object.fromEntries(new Headers(init.headers)),
        [DESKTOP_ACCESS_HEADER]: options.rendererToken,
      },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Desktop smoke request ${path} returned HTTP ${response.status}.`);
    return text ? JSON.parse(text) as unknown : undefined;
  };

  const current = await request("/api/settings/network-proxy") as { restartRequired?: unknown };
  if (current.restartRequired !== true) {
    const patched = await request("/api/settings/network-proxy", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ search: options.proxyUrl }),
    }) as { restartRequired?: unknown };
    if (patched.restartRequired !== true) {
      throw new Error("Desktop smoke proxy persistence did not require a restart.");
    }
  }

  const restarted = await request("/api/runtime/restart", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ force: true }),
  }) as { accepted?: unknown; bootId?: unknown };
  if (restarted.accepted !== true || restarted.bootId !== options.oldBootId) {
    throw new Error("Desktop smoke restart response did not match the old boot.");
  }
  return { bootId: restarted.bootId };
}

export async function verifyDesktopSmokeSuccessor(options: {
  origin: string;
  rendererToken: string;
  oldBootId: string;
  expectedSessionPath: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}): Promise<{ bootId: string }> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Desktop smoke successor timeout must be a positive integer.");
  }
  const response = await (options.fetch ?? fetch)(`${options.origin}/api/status`, {
    headers: { [DESKTOP_ACCESS_HEADER]: options.rendererToken },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Desktop smoke request /api/status returned HTTP ${response.status}.`);
  }
  const status = (text ? JSON.parse(text) : undefined) as {
    bootId?: unknown;
    sessions?: Array<{ path?: unknown }>;
  } | undefined;
  if (
    !status
    || typeof status.bootId !== "string"
    || !status.bootId
    || status.bootId === options.oldBootId
  ) {
    throw new Error("Desktop smoke successor did not report a fresh boot id.");
  }
  if (!status.sessions?.some((session) => session.path === options.expectedSessionPath)) {
    throw new Error("Desktop smoke successor could not see the persisted CLI session.");
  }
  return { bootId: status.bootId };
}

export async function prepareDesktopSmokeWork(options: {
  origin: string;
  rendererToken: string;
  project: string;
  expectedSessionPath: string;
  expectedAgent: string;
  fetch?: FetchLike;
  onStateVisible?: () => void;
  activityTimeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  wait?: (delayMs: number) => Promise<void>;
}): Promise<{ sessionId: string; bootId: string }> {
  const fetchImpl = options.fetch ?? fetch;
  const request = async (path: string, init: RequestInit = {}): Promise<unknown> => {
    const response = await fetchImpl(`${options.origin}${path}`, {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init.headers)),
        [DESKTOP_ACCESS_HEADER]: options.rendererToken,
      },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Desktop smoke request ${path} returned HTTP ${response.status}.`);
    return text ? JSON.parse(text) as unknown : undefined;
  };

  const status = await request("/api/status") as {
    bootId?: unknown;
    sessions?: Array<{ path?: unknown }>;
  };
  if (typeof status.bootId !== "string" || !status.bootId) {
    throw new Error("Desktop smoke status did not include a boot id.");
  }
  if (!status.sessions?.some((session) => session.path === options.expectedSessionPath)) {
    throw new Error("Desktop smoke could not see the persisted CLI session.");
  }
  const agents = await request(
    `/api/agents?cwd=${encodeURIComponent(options.project)}`,
  ) as Array<{ name?: unknown; source?: unknown }>;
  if (!Array.isArray(agents) || !agents.some(
    (agent) => agent.name === options.expectedAgent && agent.source === "global",
  )) {
    throw new Error("Desktop smoke could not see the persisted global Agent.");
  }
  options.onStateVisible?.();

  const created = await request("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: options.project }),
  }) as { id?: unknown };
  if (typeof created.id !== "string" || !created.id) {
    throw new Error("Desktop smoke session creation returned an invalid id.");
  }
  const timeoutMs = options.activityTimeoutMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Desktop smoke root activity timeout must be a positive integer.");
  }
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error("Desktop smoke root activity poll interval must be a positive integer.");
  }
  const now = options.now ?? Date.now;
  const wait = options.wait
    ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const deadline = now() + timeoutMs;
  const signalForRemainingBudget = (phase: string): AbortSignal => {
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new Error(
        `Desktop smoke session ${created.id} root activity deadline expired before ${phase}.`,
      );
    }
    return AbortSignal.timeout(Math.max(1, Math.ceil(remaining)));
  };

  const messagePath = `/api/sessions/${encodeURIComponent(created.id)}/messages`;
  try {
    await request(messagePath, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Keep this deterministic desktop smoke request active until the host exits.",
      }),
      signal: signalForRemainingBudget("message POST"),
    });
  } catch (error) {
    throw new Error(
      `Desktop smoke session ${created.id} message POST ${messagePath} failed during the root activity deadline: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  let latestActivity = "not observed";
  while (now() < deadline) {
    const path = `/api/sessions/${encodeURIComponent(created.id)}/snapshot`;
    let snapshot: unknown;
    try {
      snapshot = await request(path, { signal: signalForRemainingBudget("snapshot request") });
    } catch (error) {
      throw new Error(
        `Desktop smoke root activity request ${path} failed for session ${created.id}. Latest activity: ${latestActivity}. ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    const activity = sessionActivity(snapshot);
    latestActivity = JSON.stringify(activity);
    if (activity.status === "running" && activity.isStreaming === true) {
      return { sessionId: created.id, bootId: status.bootId };
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await wait(Math.min(pollIntervalMs, remaining));
  }
  throw new Error(
    `Desktop smoke session ${created.id} did not enter root {status:"running",isStreaming:true} within ${timeoutMs}ms. Latest activity: ${latestActivity}.`,
  );
}

function sessionActivity(snapshot: unknown): { status: "ready" | "running"; isStreaming: boolean } {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("Desktop smoke root snapshot was not an object.");
  }
  const session = (snapshot as { session?: unknown }).session;
  if (!session || typeof session !== "object" || Array.isArray(session)) {
    throw new Error("Desktop smoke root snapshot had no session activity.");
  }
  const activity = session as { status?: unknown; isStreaming?: unknown };
  if (
    (activity.status !== "ready" && activity.status !== "running")
    || typeof activity.isStreaming !== "boolean"
    || (activity.status === "ready" && activity.isStreaming)
  ) {
    throw new Error(
      `Desktop smoke root snapshot had invalid activity: ${JSON.stringify({
        status: activity.status,
        isStreaming: activity.isStreaming,
      })}.`,
    );
  }
  return { status: activity.status, isStreaming: activity.isStreaming };
}
