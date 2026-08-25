import type { ActiveSessionDto, SessionSummaryDto } from "../../../web/contracts";
import type { Language } from "../preferences";

export type HomeActiveSession = ActiveSessionDto & {
  firstMessage?: string;
  modified?: string;
  messageCount?: number;
};

export interface HomeProjectGroup {
  cwd: string;
  history: SessionSummaryDto[];
  active: HomeActiveSession[];
}

export function sessionTitle(session: {
  id: string;
  firstMessage?: string;
  name?: string;
  sessionName?: string;
}): string {
  const name = session.sessionName ?? session.name;
  if (name?.trim()) return name;
  const firstMessage = session.firstMessage?.trim();
  return firstMessage ? firstMessage : session.id.slice(0, 8);
}

export function buildHomeProjectGroups(history: SessionSummaryDto[], active: ActiveSessionDto[]): HomeProjectGroup[] {
  const groups = new Map<string, HomeProjectGroup>();
  const ensure = (cwd: string) => {
    let group = groups.get(cwd);
    if (!group) {
      group = { cwd, history: [], active: [] };
      groups.set(cwd, group);
    }
    return group;
  };
  // Connected sessions belong in Active sessions and must not be duplicated in
  // the history list, including sessions that are ready but currently idle.
  const activePaths = new Set(
    active
      .filter(isConnected)
      .map((session) => session.sessionFile)
      .filter((path): path is string => Boolean(path)),
  );
  const summariesByPath = new Map<string, SessionSummaryDto>();
  for (const session of history) {
    if (session.path) summariesByPath.set(session.path, session);
  }
  for (const session of active.filter(isConnected)) {
    const summary = session.sessionFile ? summariesByPath.get(session.sessionFile) : undefined;
    ensure(session.cwd).active.push(
      summary === undefined
        ? session
        : {
            ...session,
            firstMessage: summary.firstMessage,
            modified: summary.modified,
            messageCount: summary.messageCount,
          },
    );
  }
  for (const session of history) {
    if (session.path && activePaths.has(session.path)) continue;
    ensure(session.cwd).history.push(session);
  }
  return [...groups.values()];
}

export function directoryName(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  if (!normalized) return path;
  return normalized.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export function compactParentPath(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const separator = normalized.includes("\\") ? "\\" : "/";
  const lastSeparator = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  if (lastSeparator < 0) return normalized;
  const parent = normalized.slice(0, lastSeparator) || separator;
  if (separator === "\\" && /^[A-Za-z]:$/u.test(parent)) return `${parent}\\`;
  const absolutePrefix =
    separator === "\\" && parent.startsWith("\\\\") ? "\\\\" : parent.startsWith(separator) ? separator : "";
  const segments = parent.split(/[\\/]/).filter(Boolean);
  if (segments.length <= 3) return parent;
  return `${absolutePrefix}${[segments[0], segments[1], "…", segments.at(-1)].join(separator)}`;
}

export function formatRelativeModifiedTime(modified: string | undefined, language: Language, now = Date.now()): string {
  if (!modified) return "";
  const timestamp = Date.parse(modified);
  if (!Number.isFinite(timestamp)) return "";
  const difference = timestamp - now;
  const absolute = Math.abs(difference);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 365 * 24 * 60 * 60 * 1000],
    ["month", 30 * 24 * 60 * 60 * 1000],
    ["week", 7 * 24 * 60 * 60 * 1000],
    ["day", 24 * 60 * 60 * 1000],
    ["hour", 60 * 60 * 1000],
    ["minute", 60 * 1000],
  ];
  const [unit, size] = units.find(([, candidate]) => absolute >= candidate) ?? ["minute", 60 * 1000];
  const value = Math.round(difference / size);
  return new Intl.RelativeTimeFormat(language, { numeric: "auto" }).format(value, unit);
}

export function isActuallyRunning(session: ActiveSessionDto): boolean {
  return session.status === "running" || session.isStreaming;
}

export function isConnected(session: ActiveSessionDto): boolean {
  return session.status === "starting" || session.status === "ready" || session.status === "running";
}

export function countConnectedSessions(sessions: ActiveSessionDto[]): number {
  return sessions.filter(isConnected).length;
}

export function countRunningSessions(sessions: ActiveSessionDto[]): number {
  return sessions.filter(isActuallyRunning).length;
}

export function matchesSessionQuery(session: SessionSummaryDto | HomeActiveSession, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  const values =
    "status" in session
      ? [session.cwd, session.id, session.sessionName, session.firstMessage]
      : [session.cwd, session.id, session.name, session.firstMessage];
  return values.some((value) => value?.toLocaleLowerCase().includes(needle));
}
