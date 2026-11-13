import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveSessionDto, StatusDto } from "../../../web/contracts";
import * as api from "../api";
import { STORAGE_KEY } from "../preferences";
import { PreferencesProvider } from "../preferences/PreferencesProvider";
import { useSessionShell } from "./useSessionShell";

vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  listStatus: vi.fn(),
  openSession: vi.fn(),
  resumeRelocatedSession: vi.fn(),
}));

const tabs = [
  { id: "a", cwd: "/a", name: "Same" },
  { id: "b", cwd: "/a", name: "Same" },
  { id: "c", cwd: "/c" },
] as const;
const status: StatusDto = {
  bootId: "boot",
  agentDir: "/agent",
  homeDir: "/home",
  activeSessions: [],
  sessions: tabs.map((tab) => ({
    ...tab,
    path: `/store/${tab.id}`,
    created: "",
    modified: "",
    messageCount: 1,
    firstMessage: "",
  })),
};
const active = (id: string, cwd = `/${id}`): ActiveSessionDto => ({ id, cwd, status: "ready", isStreaming: false });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup(selected: string | null = null) {
  let effectiveSelected = selected;
  const onRemoved = vi.fn((id: string | null) => {
    effectiveSelected = id;
  });
  const onReplaced = vi.fn((previousId: string, session: { id: string }) => {
    if (effectiveSelected === previousId) effectiveSelected = session.id;
  });
  const hook = renderHook(() => useSessionShell(() => effectiveSelected, onRemoved, onReplaced), {
    wrapper: ({ children }: { children: ReactNode }) => <PreferencesProvider>{children}</PreferencesProvider>,
  });
  return { ...hook, onRemoved, onReplaced };
}

describe("document session view ownership", () => {
  beforeEach(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ language: "en", sessionTabs: tabs }));
    vi.mocked(api.listStatus).mockReset().mockResolvedValue(status);
    vi.mocked(api.openSession)
      .mockReset()
      .mockImplementation(async (path) => active(path.slice("/store/".length)));
    vi.mocked(api.resumeRelocatedSession).mockReset();
  });

  it("accepts the real explicit-recovery API's new UUID for a never-persisted root", async () => {
    const realApi = await vi.importActual<typeof import("../api")>("../api");
    vi.mocked(api.resumeRelocatedSession).mockImplementation(realApi.resumeRelocatedSession);
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path === "/api/status") return Response.json({ ...status, sessions: [], activeSessions: [] });
      if (path === "/api/sessions" && init?.method === "POST") return Response.json(active("new-uuid", "/moved"));
      throw new Error(`Unexpected request ${path}`);
    });
    try {
      const { result, onReplaced } = setup("a");
      act(() => result.current.resolve({ id: "a", cwd: "/moved" }, "relocate"));
      const oldOwner = result.current.views.a!.generation;
      await waitFor(() => expect(result.current.views["new-uuid"]?.phase).toBe("ready"));
      expect(result.current.tabs.map((tab) => tab.id)).toEqual(["new-uuid", "b", "c"]);
      expect(result.current.views.a).toBeUndefined();
      expect(onReplaced.mock.calls).toEqual([["a", { id: "new-uuid", cwd: "/moved" }]]);
      act(() => result.current.metadata({ id: "a", cwd: "/old" }, oldOwner));
      expect(result.current.getTab("a")).toBeUndefined();
      expect(
        fetch.mock.calls.some(([input, init]) => String(input).endsWith("/api/sessions") && init?.method === "POST"),
      ).toBe(true);
    } finally {
      fetch.mockRestore();
    }
  });

  it("deduplicates an accepted replacement into an already-retained root without replacing that view", async () => {
    vi.mocked(api.resumeRelocatedSession).mockResolvedValue(active("b", "/a"));
    const { result } = setup("a");
    act(() => result.current.resolve(tabs[1], "opened"));
    const target = result.current.views.b;
    act(() => result.current.resolve(tabs[0], "relocate"));
    await waitFor(() => expect(result.current.views.a).toBeUndefined());
    expect(result.current.tabs.map((tab) => tab.id)).toEqual(["b", "c"]);
    expect(result.current.views.b).toBe(target);
  });

  it("rejects unexpected UUID changes during ordinary resolution and fences late explicit recovery", async () => {
    vi.mocked(api.openSession).mockResolvedValue(active("unrelated"));
    const { result, onReplaced } = setup();
    act(() => result.current.resolve(tabs[0]));
    await waitFor(() => expect(result.current.views.a?.phase).toBe("error"));
    expect(result.current.getTab("unrelated")).toBeUndefined();
    expect(onReplaced).not.toHaveBeenCalled();
    const recovery = deferred<ActiveSessionDto>();
    vi.mocked(api.resumeRelocatedSession).mockReturnValue(recovery.promise);
    act(() => result.current.resolve(tabs[0], "relocate"));
    act(() => result.current.close("a"));
    await act(async () => recovery.resolve(active("replacement")));
    expect(result.current.getTab("replacement")).toBeUndefined();
    expect(onReplaced).not.toHaveBeenCalled();
  });

  it("restores descriptors lazily and deduplicates by UUID, not name or cwd", async () => {
    const { result } = setup();
    expect(result.current.tabs).toEqual(tabs);
    expect(result.current.views).toEqual({});
    expect(api.listStatus).not.toHaveBeenCalled();
    act(() => result.current.resolve(tabs[0]));
    await waitFor(() => expect(result.current.views.a?.phase).toBe("ready"));
    const first = result.current.views.a;
    act(() => {
      result.current.resolve(tabs[1]);
      result.current.resolve(tabs[0]);
    });
    await waitFor(() => expect(result.current.views.b?.phase).toBe("ready"));
    expect(result.current.views.a).toBe(first);
    expect(result.current.views.c).toBeUndefined();
    expect(api.openSession).toHaveBeenCalledTimes(2);
    expect(result.current.tabs.map((tab) => tab.id)).toEqual(["a", "b", "c"]);
  });

  it("replaces a stale bookmark cwd from active-only inventory before publishing a ready workspace", async () => {
    vi.mocked(api.listStatus).mockResolvedValue({
      ...status,
      sessions: [],
      activeSessions: [active("a", "/authoritative")],
    });
    const { result } = setup("a");
    act(() => result.current.resolve({ id: "a", cwd: "/stale-hash" }));
    expect(result.current.views.a?.workspaceResolved).toBe(false);
    await waitFor(() => expect(result.current.views.a?.phase).toBe("ready"));
    expect(result.current.views.a).toMatchObject({
      session: { id: "a", cwd: "/authoritative" },
      workspaceResolved: true,
    });
    expect(result.current.getTab("a")?.cwd).toBe("/authoritative");
    expect(result.current.views.b).toBeUndefined();
    expect(api.openSession).not.toHaveBeenCalled();
  });

  it.each(["unknown", "listing-failure"] as const)(
    "keeps %s attachment hints distinct from resolved workspaces",
    async (failure) => {
      if (failure === "unknown")
        vi.mocked(api.listStatus).mockResolvedValue({ ...status, sessions: [], activeSessions: [] });
      else vi.mocked(api.listStatus).mockRejectedValue(new Error("Status unavailable"));
      const { result } = setup("a");
      act(() => result.current.resolve(tabs[0]));
      await waitFor(() => expect(result.current.views.a?.phase).toBe("ready"));
      expect(result.current.views.a).toMatchObject({ session: { id: "a", cwd: "/a" }, workspaceResolved: false });
      act(() => result.current.metadata({ ...tabs[0], status: "ready" }, result.current.views.a!.generation));
      expect(result.current.views.a?.workspaceResolved).toBe(false);
      expect(api.openSession).not.toHaveBeenCalled();
    },
  );

  it("rejects a closed resolver after reopening the same id and fences callbacks from the old view", async () => {
    const old = deferred<ActiveSessionDto>();
    const fresh = deferred<ActiveSessionDto>();
    vi.mocked(api.openSession).mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const { result } = setup();
    act(() => result.current.resolve(tabs[0]));
    await waitFor(() => expect(api.openSession).toHaveBeenCalledTimes(1));
    const owner = result.current.views.a!.generation;
    act(() => {
      result.current.close("a");
      result.current.resolve(tabs[0]);
    });
    await waitFor(() => expect(api.openSession).toHaveBeenCalledTimes(2));
    await act(async () => {
      fresh.resolve({ ...active("a"), sessionName: "New title" });
    });
    await act(async () => {
      old.resolve({ ...active("a", "/obsolete"), sessionName: "Old title" });
    });
    act(() => {
      result.current.metadata({ id: "a", cwd: "/obsolete", name: "Stale event" }, owner);
      result.current.close("a", owner);
      result.current.resolve({ id: "a", cwd: "/obsolete" }, "relocate", owner);
    });
    expect(result.current.views.a?.session.cwd).toBe("/a");
    expect(result.current.getTab("a")?.name).toBe("New title");
    expect(api.resumeRelocatedSession).not.toHaveBeenCalled();
  });

  it("does not open a runtime when its tab closes before path lookup completes", async () => {
    const lookup = deferred<StatusDto>();
    vi.mocked(api.listStatus).mockReturnValue(lookup.promise);
    const { result } = setup();
    act(() => result.current.resolve(tabs[0]));
    act(() => result.current.close("a"));
    await act(async () => lookup.resolve(status));
    expect(api.openSession).not.toHaveBeenCalled();
    expect(result.current.views.a).toBeUndefined();
  });

  it("fences Home opens on close/rebind but accepts metadata for an unvisited tab activated during a mutation", () => {
    const { result } = setup();
    const ownsOpen = result.current.captureOpen("a");
    const mutation = result.current.captureMutation();
    act(() => result.current.resolve(tabs[0], "opened"));
    act(() => result.current.resolve({ id: "new", cwd: "/new" }, "opened"));
    act(() => mutation.renamed("a", "Renamed while opening"));
    act(() => mutation.renamed("new", "Opened during rename"));
    expect(result.current.getTab("a")?.name).toBe("Renamed while opening");
    expect(result.current.getTab("new")?.name).toBe("Opened during rename");
    expect(ownsOpen()).toBe(true);
    act(() => result.current.close("a"));
    act(() => result.current.resolve(tabs[0], "opened"));
    expect(ownsOpen()).toBe(false);
    const ownsMoved = result.current.captureOpen("a");
    act(() => result.current.captureMutation().workspace("/a", { cwd: "/moved", sessionIds: ["a"] }, false));
    expect(ownsMoved()).toBe(false);
  });

  it("does not recreate a closed unvisited bookmark from a delayed mutation", () => {
    const { result } = setup();
    const mutation = result.current.captureMutation();
    act(() => result.current.close("a"));
    act(() => result.current.resolve(tabs[0], "opened"));
    act(() => mutation.renamed("a", "Obsolete"));
    expect(result.current.getTab("a")?.name).not.toBe("Obsolete");
    expect(api.listStatus).not.toHaveBeenCalled();
  });

  it("fences a ready-view launch on synchronous replacement and unmount but not metadata updates", () => {
    const { result, unmount } = setup("a");
    act(() => result.current.resolve(tabs[0], "opened"));
    const ownsView = result.current.captureOpen("a", result.current.views.a!.generation);
    act(() => result.current.metadata({ ...tabs[0], name: "Current name", status: "running" }));
    expect(ownsView()).toBe(true);
    act(() => {
      result.current.resolve(tabs[0], "opened");
      expect(ownsView()).toBe(false);
    });
    const ownsNext = result.current.captureOpen("a", result.current.views.a!.generation);
    expect(ownsNext()).toBe(true);
    unmount();
    expect(ownsNext()).toBe(false);
  });

  it("ignores stale Home status after live metadata, including authoritative empty names", async () => {
    const { result } = setup();
    const publish = result.current.captureStatus();
    act(() => result.current.resolve(tabs[0], "opened"));
    act(() =>
      result.current.metadata(
        { id: "a", cwd: "/a", name: "Live", status: "running" },
        result.current.views.a!.generation,
      ),
    );
    act(() => publish(status));
    expect(result.current.getTab("a")?.name).toBe("Live");
    const nextPoll = result.current.captureStatus();
    act(() =>
      result.current.metadata({ id: "a", cwd: "/a", name: "", status: "ready" }, result.current.views.a!.generation),
    );
    act(() => nextPoll(status));
    expect(result.current.getTab("a")?.name).toBe("");
    expect(
      JSON.parse(localStorage.getItem(STORAGE_KEY)!).sessionTabs.find((tab: { id: string }) => tab.id === "a").name,
    ).toBe("");
  });

  it("keeps external bookmark writes document-local and status-only events storage-free", async () => {
    const { result } = setup();
    const writes = vi.spyOn(Storage.prototype, "setItem");
    act(() => result.current.resolve(tabs[0], "opened"));
    writes.mockClear();
    act(() => result.current.metadata({ ...tabs[0], status: "running" }, result.current.views.a!.generation));
    act(() => result.current.metadata({ ...tabs[0], status: "ready" }, result.current.views.a!.generation));
    expect(writes).not.toHaveBeenCalled();
    const view = result.current.views.a;
    act(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ language: "en", studioTheme: "dark", sessionTabs: [] }));
      window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
    });
    expect(document.documentElement.dataset.uiTheme).toBe("dark");
    expect(result.current.tabs).toHaveLength(3);
    expect(result.current.views.a).toBe(view);
    writes.mockClear();
    act(() => result.current.metadata({ ...tabs[0], status: "running" }, view!.generation));
    expect(writes).not.toHaveBeenCalled();
    writes.mockRestore();
  });

  it("applies workspace metadata to unvisited bookmarks without opening or selecting them", () => {
    const { result, onRemoved } = setup("c");
    act(() => result.current.captureMutation().workspace("/a", { cwd: "/moved", sessionIds: ["a", "b"] }, false));
    expect(result.current.getTab("a")?.cwd).toBe("/moved");
    expect(result.current.getTab("b")?.cwd).toBe("/moved");
    expect(result.current.views).toEqual({});
    expect(api.listStatus).not.toHaveBeenCalled();
    expect(onRemoved).not.toHaveBeenCalled();
  });

  it("removes a workspace atomically, choosing a surviving neighbor once", () => {
    const { result, onRemoved } = setup("a");
    act(() => result.current.captureMutation().workspace("/a", { cwd: "/a", sessionIds: ["a", "b"] }, true));
    expect(result.current.tabs.map((tab) => tab.id)).toEqual(["c"]);
    expect(onRemoved.mock.calls).toEqual([["c"]]);
    expect(api.openSession).not.toHaveBeenCalled();
  });

  it("fences a pending resolver across workspace relocation and close", async () => {
    const old = deferred<ActiveSessionDto>();
    const moved = deferred<ActiveSessionDto>();
    vi.mocked(api.openSession).mockReturnValue(old.promise);
    vi.mocked(api.resumeRelocatedSession).mockReturnValue(moved.promise);
    const { result, onRemoved } = setup("b");
    act(() => result.current.resolve(tabs[0]));
    await waitFor(() => expect(api.openSession).toHaveBeenCalled());
    act(() => result.current.resolve({ id: "a", cwd: "/moved" }, "relocate", result.current.views.a!.generation));
    await act(async () => {
      old.reject(new Error("obsolete failure"));
    });
    expect(result.current.views.a?.phase).toBe("loading");
    act(() => result.current.close("a"));
    await act(async () => {
      moved.resolve(active("a", "/moved"));
    });
    expect(result.current.views.a).toBeUndefined();
    expect(result.current.getTab("a")).toBeUndefined();
    expect(onRemoved).not.toHaveBeenCalled();
  });
});
