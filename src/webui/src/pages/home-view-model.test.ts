// @vitest-environment jsdom
import { expect, it } from "vitest";
import type { ActiveSessionDto, SessionSummaryDto } from "../../../web/contracts";
import {
  buildHomeProjectGroups,
  countRunningSessions,
  isActuallyRunning,
  matchesSessionQuery,
} from "./home-view-model";

function history(id: string, cwd: string): SessionSummaryDto {
  return {
    id,
    path: `/sessions/${id}.jsonl`,
    cwd,
    created: "2026-08-07T00:00:00.000Z",
    modified: "2026-08-07T00:00:00.000Z",
    messageCount: 1,
    firstMessage: "Research prompt",
  };
}

function active(
  id: string,
  cwd: string,
  status: ActiveSessionDto["status"],
): ActiveSessionDto {
  return {
    id,
    cwd,
    sessionFile: `/sessions/${id}.jsonl`,
    sessionName: id,
    isStreaming: false,
    status,
  };
}

it("groups history and active sessions by exact cwd without ancestor inference", () => {
  const groups = buildHomeProjectGroups(
    [history("h1", "/papers/a"), history("h2", "/papers/a/sub")],
    [active("a1", "/papers/a", "ready"), active("a2", "/papers/b", "running")],
  );
  expect(groups.map((group) => group.cwd)).toEqual(["/papers/a", "/papers/b", "/papers/a/sub"]);
  expect(groups[0]?.history.map((session) => session.id)).toEqual(["h1"]);
  expect(groups[2]?.history.map((session) => session.id)).toEqual(["h2"]);
});

it("counts only running or streaming sessions", () => {
  const sessions = [
    active("ready", "/p", "ready"),
    active("running", "/p", "running"),
    { ...active("streaming", "/p", "ready"), isStreaming: true },
    active("error", "/p", "error"),
  ];
  expect(sessions.map(isActuallyRunning)).toEqual([false, true, true, false]);
  expect(countRunningSessions(sessions)).toBe(2);
});

it("matches localized user searches against recognizable session fields", () => {
  expect(matchesSessionQuery({ ...history("h1", "/Paper"), name: "Fault Diagnosis" }, "diagnosis")).toBe(true);
  expect(matchesSessionQuery({ ...active("a1", "/Paper", "ready"), sessionName: "Baseline" }, "paper")).toBe(true);
  expect(matchesSessionQuery(active("a1", "/Paper", "ready"), "missing")).toBe(false);
});
