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
  await request(`/api/sessions/${encodeURIComponent(created.id)}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "Keep this deterministic desktop smoke request active until the host exits.",
    }),
  });
  return { sessionId: created.id };
}
