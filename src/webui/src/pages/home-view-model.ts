import type { ActiveSessionDto, SessionSummaryDto } from "../../../web/contracts";

export interface HomeProjectGroup {
  cwd: string;
  history: SessionSummaryDto[];
  active: ActiveSessionDto[];
}

export function buildHomeProjectGroups(
  history: SessionSummaryDto[],
  active: ActiveSessionDto[],
): HomeProjectGroup[] {
  const groups = new Map<string, HomeProjectGroup>();
  const ensure = (cwd: string) => {
    let group = groups.get(cwd);
    if (!group) {
      group = { cwd, history: [], active: [] };
      groups.set(cwd, group);
    }
    return group;
  };
  for (const session of active) ensure(session.cwd).active.push(session);
  // webui.md: the Recent list is history-only — a *running* session must not
  // appear there too; idle/ready sessions are shown only in Recent history.
  const activePaths = new Set(
    active
      .filter(isActuallyRunning)
      .map((session) => session.sessionFile)
      .filter((path): path is string => Boolean(path)),
  );
  for (const session of history) {
    if (session.path && activePaths.has(session.path)) continue;
    ensure(session.cwd).history.push(session);
  }
  return [...groups.values()];
}

export function isActuallyRunning(session: ActiveSessionDto): boolean {
  return session.status === "running" || session.isStreaming;
}

export function countRunningSessions(sessions: ActiveSessionDto[]): number {
  return sessions.filter(isActuallyRunning).length;
}

export function matchesSessionQuery(
  session: SessionSummaryDto | ActiveSessionDto,
  query: string,
): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  const values = "messageCount" in session
    ? [session.cwd, session.id, session.name, session.firstMessage]
    : [session.cwd, session.id, session.sessionName];
  return values.some((value) => value?.toLocaleLowerCase().includes(needle));
}
