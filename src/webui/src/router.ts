/**
 * Hash-based client router (ADR-076). Page identity lives in the URL hash so
 * a browser refresh restores the current page without any backend SPA
 * fallback. Pure parsing/serialization lives here; the React binding is
 * `src/webui/src/hooks/useHashRoute.ts`.
 *
 * Routes: `#/` home, `#/config` JSON config, and
 * `#/work/<sessionId>?cwd=<encoded>` work. Settings is canonical query state
 * over Home or Work; `#/settings` remains a legacy parser input only.
 */

export interface WorkSession {
  id: string;
  cwd: string;
}

export interface HomeRoute {
  page: "home";
  settingsOpen?: true;
}

export interface WorkRoute {
  page: "work";
  session: WorkSession;
  settingsOpen?: true;
}

export type SettingsHostRoute =
  | { page: "home"; settingsOpen: true }
  | { page: "work"; session: WorkSession; settingsOpen: true };

export interface ConfigRoute {
  page: "config";
  returnTo: SettingsHostRoute | null;
}

export type AppRoute = HomeRoute | WorkRoute | ConfigRoute;

const HOME = "#/";

export function withSettings(route: HomeRoute | WorkRoute): SettingsHostRoute {
  return route.page === "home"
    ? { page: "home", settingsOpen: true }
    : { page: "work", session: route.session, settingsOpen: true };
}

export function withoutSettings(route: HomeRoute | WorkRoute): HomeRoute | WorkRoute {
  return route.page === "home" ? { page: "home" } : { page: "work", session: route.session };
}

export function isSettingsHostRoute(route: AppRoute): route is SettingsHostRoute {
  return route.page !== "config" && route.settingsOpen === true;
}

export function sameHostRoute(a: HomeRoute | WorkRoute, b: HomeRoute | WorkRoute): boolean {
  if (a.page === "home" || b.page === "home") return a.page === b.page;
  return a.session.id === b.session.id && a.session.cwd === b.session.cwd;
}

/** Parses a raw `location.hash` value; unknown or malformed hashes return null. */
export function parseHashRoute(hash: string): AppRoute | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const queryIndex = raw.indexOf("?");
  const path = queryIndex >= 0 ? raw.slice(0, queryIndex) : raw;
  const query = queryIndex >= 0 ? raw.slice(queryIndex + 1) : "";

  if (path === "" || path === "/") {
    if (queryIndex < 0) return { page: "home" };
    const entries = [...new URLSearchParams(query).entries()];
    return entries.length === 1 && entries[0]?.[0] === "settings" && entries[0][1] === "1"
      ? { page: "home", settingsOpen: true }
      : null;
  }

  if (path === "/settings" && queryIndex < 0) return { page: "home", settingsOpen: true };

  if (path === "/config") {
    if (queryIndex < 0) return { page: "config", returnTo: null };
    const entries = [...new URLSearchParams(query).entries()];
    if (entries.length !== 1 || entries[0]?.[0] !== "returnTo") return { page: "config", returnTo: null };

    const decodedReturnTo = entries[0][1];
    const parsedReturnTo = parseHashRoute(decodedReturnTo);
    return {
      page: "config",
      returnTo:
        parsedReturnTo && isSettingsHostRoute(parsedReturnTo) && routeToHash(parsedReturnTo) === decodedReturnTo
          ? parsedReturnTo
          : null,
    };
  }

  if (!path.startsWith("/work/") || queryIndex < 0) return null;
  const idPart = path.slice("/work/".length);
  try {
    const id = decodeURIComponent(idPart);
    const params = new URLSearchParams(query);
    const entries = [...params.entries()];
    const cwdValues = params.getAll("cwd");
    const settingsValues = params.getAll("settings");
    if (
      !id ||
      cwdValues.length !== 1 ||
      !cwdValues[0] ||
      settingsValues.length > 1 ||
      (settingsValues.length === 1 && settingsValues[0] !== "1") ||
      entries.some(([key]) => key !== "cwd" && key !== "settings")
    ) {
      return null;
    }

    const route: WorkRoute = { page: "work", session: { id, cwd: cwdValues[0] } };
    return settingsValues.length === 1 ? withSettings(route) : route;
  } catch {
    return null;
  }
}

export function routeToHash(route: AppRoute): string {
  switch (route.page) {
    case "home":
      return route.settingsOpen ? "#/?settings=1" : HOME;
    case "config":
      return route.returnTo ? `#/config?returnTo=${encodeURIComponent(routeToHash(route.returnTo))}` : "#/config";
    case "work":
      return `#/work/${encodeURIComponent(route.session.id)}?cwd=${encodeURIComponent(route.session.cwd)}${
        route.settingsOpen ? "&settings=1" : ""
      }`;
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
 * or the resolution round trip fails, the URL identity is returned unchanged.
 */
export async function resolveWorkSession(id: string, cwd: string, deps: WorkSessionResolver): Promise<WorkSession> {
  try {
    const status = await deps.listStatus();
    const summary = status.sessions.find((session) => session.id === id);
    if (summary) return await deps.openSession(summary.path);
  } catch {
    // Session listing/open unavailable: fall through to the URL identity,
    // which still attaches when the registry record is active.
  }
  return { id, cwd };
}
