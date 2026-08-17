import { expect, it } from "vitest";
import type { ActiveSessionDto, SessionSummaryDto } from "../../../web/contracts";
import {
  buildHomeProjectGroups,
  countConnectedSessions,
  countRunningSessions,
  isActuallyRunning,
  isConnected,
  matchesSessionQuery,
  sessionTitle,
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

function active(id: string, cwd: string, status: ActiveSessionDto["status"]): ActiveSessionDto {
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

it("keeps all connected sessions out of the history list", () => {
  const groups = buildHomeProjectGroups(
    [history("s1", "/papers/a"), history("s2", "/papers/a"), history("other", "/papers/b")],
    [active("s1", "/papers/a", "running"), active("s2", "/papers/a", "ready")],
  );
  const groupA = groups.find((group) => group.cwd === "/papers/a")!;
  expect(groupA.active.map((s) => s.id)).toEqual(["s1", "s2"]);
  expect(groupA.history.map((s) => s.id)).toEqual([]);
  expect(groups.find((group) => group.cwd === "/papers/b")!.history.map((s) => s.id)).toEqual(["other"]);
});

it("classifies connected and disconnected records for the Home active list", () => {
  const ready = active("ready", "/p", "ready");
  const running = active("running", "/p", "running");
  const error = active("error", "/p", "error");
  expect(isConnected(ready)).toBe(true);
  expect(isConnected(running)).toBe(true);
  expect(isConnected(error)).toBe(false);
  expect(countConnectedSessions([ready, running, error])).toBe(2);
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

it("matches the copied active session first message in localized searches", () => {
  const running = { ...active("r1", "/Paper", "running"), firstMessage: "Fault diagnosis prompt" };
  expect(matchesSessionQuery(running, "diagnosis")).toBe(true);
  expect(matchesSessionQuery(running, "missing")).toBe(false);
});

it("titles sessions from the trimmed first message or the first eight id characters", () => {
  expect(sessionTitle({ id: "0123456789abcdef", firstMessage: "  write a paper  " })).toBe("write a paper");
  expect(sessionTitle({ id: "0123456789abcdef" })).toBe("01234567");
  expect(sessionTitle({ id: "0123456789abcdef", firstMessage: " \t " })).toBe("01234567");
  expect(sessionTitle({ id: "0123456789abcdef", firstMessage: "write a paper" })).toBe("write a paper");
});

it("prefers the session name over the first message for active rows", () => {
  expect(sessionTitle({ id: "abc12345", firstMessage: "write a paper", sessionName: "My Paper" })).toBe("My Paper");
});

it("prefers the session name over the first message for history rows", () => {
  expect(sessionTitle({ id: "abc12345", firstMessage: "write a paper", name: "My Paper" })).toBe("My Paper");
});

it("falls back to the first message without a name", () => {
  expect(sessionTitle({ id: "abc12345", firstMessage: "write a paper" })).toBe("write a paper");
});

it("copies the exact-file history firstMessage onto the running active view model", () => {
  const groups = buildHomeProjectGroups(
    [
      history("h1", "/papers/a"),
      { ...history("h1b", "/papers/a"), path: "/sessions/r1.jsonl", firstMessage: "fault diagnosis prompt" },
    ],
    [{ ...active("r1", "/papers/a", "running"), sessionFile: "/sessions/r1.jsonl" }],
  );
  const groupA = groups.find((group) => group.cwd === "/papers/a")!;
  expect(groupA.active[0]).toMatchObject({ id: "r1", firstMessage: "fault diagnosis prompt" });
  expect(groupA.history.map((session) => session.id)).toEqual(["h1"]);
});

it("never copies a firstMessage from a different session file", () => {
  const groups = buildHomeProjectGroups(
    [history("h1", "/papers/a")],
    [{ ...active("r1", "/papers/a", "running"), sessionFile: "/sessions/other.jsonl" }],
  );
  const groupA = groups.find((group) => group.cwd === "/papers/a")!;
  expect(groupA.active[0]).toMatchObject({ id: "r1" });
  expect(groupA.active[0]).not.toHaveProperty("firstMessage");
});
