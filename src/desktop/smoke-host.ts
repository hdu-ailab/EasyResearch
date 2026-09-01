import { DESKTOP_ACCESS_HEADER } from "./contracts";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

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
}): Promise<{ sessionId: string }> {
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
    sessions?: Array<{ path?: unknown }>;
  };
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
      return { sessionId: created.id };
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
