import type { ActiveSessionDto, SessionSummaryDto } from "../../../web/contracts";

export type HomeActiveSession = ActiveSessionDto & { firstMessage?: string };

export interface HomeProjectGroup {
  cwd: string;
  history: SessionSummaryDto[];
  active: HomeActiveSession[];
}

export function sessionTitle(session: { id: string; firstMessage?: string }): string {
  const firstMessage = session.firstMessage?.trim();
  return firstMessage ? firstMessage : session.id.slice(0, 8);
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
  // webui.md: the Recent list is history-only — a *running* session must not
  // appear there too; idle/ready sessions are shown only in Recent history.
  const activePaths = new Set(
    active
      .filter(isActuallyRunning)
      .map((session) => session.sessionFile)
      .filter((path): path is string => Boolean(path)),
  );
  const firstMessages = new Map<string, string>();
  for (const session of history) {
    if (session.path) firstMessages.set(session.path, session.firstMessage);
  }
  for (const session of active) {
    const firstMessage = session.sessionFile ? firstMessages.get(session.sessionFile) : undefined;
    ensure(session.cwd).active.push(firstMessage === undefined ? session : { ...session, firstMessage });
  }
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
  session: SessionSummaryDto | HomeActiveSession,
  query: string,
): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  const values = "messageCount" in session
    ? [session.cwd, session.id, session.name, session.firstMessage]
    : [session.cwd, session.id, session.sessionName, session.firstMessage];
  return values.some((value) => value?.toLocaleLowerCase().includes(needle));
}
