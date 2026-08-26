/**
 * Hash-based client router (ADR-076). Page identity lives in the URL hash so
 * a browser refresh restores the current page without any backend SPA
 * fallback. Pure parsing/serialization lives here; the React binding is
 * `src/webui/src/hooks/useHashRoute.ts`.
 *
 * Routes: `#/` home, `#/settings` settings, `#/config` JSON config,
 * `#/work/<sessionId>?cwd=<encoded>` work.
 */

export interface WorkSession {
  id: string;
  cwd: string;
}

export type AppRoute =
  | { page: "home" }
  | { page: "settings" }
  | { page: "config" }
  | { page: "work"; session: WorkSession };

const HOME = "#/";

/** Parses a raw `location.hash` value; unknown or malformed hashes return null. */
export function parseHashRoute(hash: string): AppRoute | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (raw === "" || raw === "/") return { page: "home" };
  if (raw === "/settings") return { page: "settings" };
  if (raw === "/config") return { page: "config" };
  if (!raw.startsWith("/work/")) return null;
  const rest = raw.slice("/work/".length);
  const queryIndex = rest.indexOf("?");
  const idPart = queryIndex >= 0 ? rest.slice(0, queryIndex) : rest;
  const query = queryIndex >= 0 ? rest.slice(queryIndex + 1) : "";
  try {
    const id = decodeURIComponent(idPart);
    const cwd = new URLSearchParams(query).get("cwd");
    if (id && cwd) return { page: "work", session: { id, cwd } };
  } catch {
    return null;
  }
  return null;
}

export function routeToHash(route: AppRoute): string {
  switch (route.page) {
    case "home":
      return HOME;
    case "settings":
      return "#/settings";
    case "config":
      return "#/config";
    case "work":
      return `#/work/${encodeURIComponent(route.session.id)}?cwd=${encodeURIComponent(route.session.cwd)}`;
  }
}

export interface WorkSessionResolver {
  listStatus(): Promise<{ sessions: Array<{ id: string; path: string }> }>;
  openSession(path: string): Promise<WorkSession>;
}

/**
 * Resolves a work route's session before WorkPage mounts: map the session id
 * to its persisted JSONL path through the status listing, then open it so the
 * backend attaches the active registry record or resumes the persisted
 * history. When the session is not persisted yet (no first assistant message)
 * or listing is unavailable, the URL identity is returned unchanged so an
 * already-active session can still attach. A known persisted session's open
 * failure remains actionable and is propagated.
 */
export async function resolveWorkSession(id: string, cwd: string, deps: WorkSessionResolver): Promise<WorkSession> {
  let status: Awaited<ReturnType<WorkSessionResolver["listStatus"]>>;
  try {
    status = await deps.listStatus();
  } catch {
    return { id, cwd };
  }
  const summary = status.sessions.find((session) => session.id === id);
  if (summary) return await deps.openSession(summary.path);
  return { id, cwd };
}
