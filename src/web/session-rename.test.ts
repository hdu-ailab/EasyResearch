import { describe, expect, it, vi } from "vitest";
import { UnknownSessionError } from "./active-sessions";
import { resolveRenameSessionService, type SessionRenameDeps } from "./session-rename";
import type { SessionSummaryDto } from "./contracts";

const history: SessionSummaryDto[] = [
  {
    id: "s1",
    path: "/agent/sessions/--p--/a.jsonl",
    cwd: "/p",
    created: "2026-08-01T00:00:00.000Z",
    modified: "2026-08-01T00:00:00.000Z",
    messageCount: 2,
    firstMessage: "write a paper",
  },
];

function deps(overrides: Partial<SessionRenameDeps> = {}): SessionRenameDeps {
  return {
    isConnected: async () => false,
    setConnectedName: async () => {},
    listAll: async () => history,
    withHistoryMutation: async (_target, run) => run(),
    validateHistory: () => {},
    openSessionManager: async (path) => {
      throw new Error(`unexpected open: ${path}`);
    },
    ...overrides,
  };
}

describe("resolveRenameSessionService", () => {
  it("revalidates a stale historical target inside lifecycle admission before persistent open", async () => {
    let admitted = false;
    const openSessionManager = vi.fn(async () => ({ appendSessionInfo: vi.fn() }));
    const validateHistory = vi.fn(() => {
      expect(admitted).toBe(true);
      throw new UnknownSessionError("Session was removed");
    });
    const service = resolveRenameSessionService(deps({
      withHistoryMutation: async (_target, run) => { admitted = true; return run(); },
      validateHistory,
      openSessionManager,
    }));
    await expect(service.rename("s1", "late name")).rejects.toBeInstanceOf(UnknownSessionError);
    expect(validateHistory).toHaveBeenCalledWith(history[0]);
    expect(openSessionManager).not.toHaveBeenCalled();
  });
  it("renames a connected session through the live runtime", async () => {
    const setConnectedName = vi.fn(async () => {});
    const openSessionManager = vi.fn(async () => {
      throw new Error("must not open a file for a connected session");
    });
    const service = resolveRenameSessionService(
      deps({ isConnected: async () => true, setConnectedName, openSessionManager }),
    );

    await service.rename("s1", "New name");

    expect(setConnectedName).toHaveBeenCalledWith("s1", "New name");
    expect(openSessionManager).not.toHaveBeenCalled();
  });

  it("renames a historical session by appending session_info to its JSONL", async () => {
    const opened: string[] = [];
    const appended: string[] = [];
    const service = resolveRenameSessionService(
      deps({
        openSessionManager: async (path) => {
          opened.push(path);
          return { appendSessionInfo: (name: string) => appended.push(name) };
        },
      }),
    );

    await service.rename("s1", "Title");

    expect(opened).toEqual(["/agent/sessions/--p--/a.jsonl"]);
    expect(appended).toEqual(["Title"]);
  });

  it("clears the name with an empty string", async () => {
    const appended: string[] = [];
    const service = resolveRenameSessionService(
      deps({ openSessionManager: async () => ({ appendSessionInfo: (name: string) => appended.push(name) }) }),
    );

    await service.rename("s1", "");

    expect(appended).toEqual([""]);
  });

  it("throws UnknownSessionError for an unknown session id", async () => {
    const service = resolveRenameSessionService(deps());
    await expect(service.rename("missing", "x")).rejects.toBeInstanceOf(UnknownSessionError);
  });

  it("refuses ambiguous historical UUIDs without opening either file", async () => {
    const openSessionManager = vi.fn(async () => ({ appendSessionInfo: vi.fn() }));
    const service = resolveRenameSessionService(deps({
      listAll: async () => [history[0]!, { ...history[0]!, path: "/different.jsonl" }],
      openSessionManager,
    }));
    await expect(service.rename("s1", "ambiguous")).rejects.toThrow();
    expect(openSessionManager).not.toHaveBeenCalled();
  });
});
