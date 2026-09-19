import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { I18nContext } from "../i18n/I18nProvider";
import { messages } from "../i18n/messages";
import { HomePage } from "./HomePage";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    listStatus: vi.fn(),
    checkForUpdate: vi.fn(),
    listDirectories: vi.fn(),
    listDirectoryRoots: vi.fn(),
    createSession: vi.fn(),
    openSession: vi.fn(),
    restartSession: vi.fn(),
    touchSession: vi.fn(),
    stopSession: vi.fn(),
    renameSession: vi.fn(),
    deleteSession: vi.fn(),
  };
});

const ApiError = api.ApiError;

const history = [
  {
    id: "h1",
    path: "/agent/sessions/--p--/a.jsonl",
    cwd: "/proj",
    name: "Fault diagnosis",
    created: "2026-08-01T00:00:00.000Z",
    modified: "2026-08-01T00:00:00.000Z",
    messageCount: 12,
    firstMessage: "write a paper",
  },
];

const active = [
  {
    id: "a1",
    cwd: "/proj",
    sessionFile: "/agent/sessions/--p--/b.jsonl",
    isStreaming: true,
    status: "running",
  },
];

const otherHistory = {
  id: "h2",
  path: "/agent/sessions/--other--/a.jsonl",
  cwd: "/other",
  name: "Other paper",
  created: "2026-08-02T00:00:00.000Z",
  modified: "2026-08-02T00:00:00.000Z",
  messageCount: 4,
  firstMessage: "compare another method",
};

const otherActive = {
  id: "a2",
  cwd: "/other",
  sessionFile: "/agent/sessions/--other--/b.jsonl",
  sessionName: "Other experiment",
  isStreaming: true,
  status: "running",
};

function renderHome() {
  return render(
    <HomePage
      onOpenSession={() => {}}
      onOpenSettings={() => {}}
      settingsButton={<button type="button">Settings</button>}
    />,
  );
}

function renderHomeWithTwoProjects() {
  vi.mocked(api.listStatus).mockResolvedValue({
    agentDir: "/agent",
    homeDir: "/home/user",
    sessions: [...history, otherHistory],
    activeSessions: [{ ...active[0], sessionName: "Project experiment" }, otherActive],
  } as never);
  return renderHome();
}

describe("HomePage", () => {
  afterEach(() => vi.useRealTimers());

  beforeEach(() => {
    vi.mocked(api.listStatus).mockReset();
    vi.mocked(api.checkForUpdate).mockReset().mockResolvedValue({ latestVersion: null });
    vi.mocked(api.listDirectories).mockReset();
    vi.mocked(api.listDirectoryRoots)
      .mockReset()
      .mockResolvedValue([{ name: "/", path: "/" }]);
    vi.mocked(api.createSession).mockReset();
    vi.mocked(api.openSession).mockReset();
    vi.mocked(api.restartSession).mockReset();
    vi.mocked(api.touchSession).mockReset();
    vi.mocked(api.stopSession).mockReset();
    vi.mocked(api.renameSession).mockReset();
    vi.mocked(api.deleteSession).mockReset().mockResolvedValue(undefined);
    vi.mocked(api.listStatus).mockResolvedValue({
      agentDir: "/agent",
      homeDir: "/home/user",
      sessions: history,
      activeSessions: active,
    } as never);
    vi.mocked(api.listDirectories).mockResolvedValue({ path: "/", entries: [{ name: "proj", path: "/proj" }] });
    vi.mocked(api.createSession).mockResolvedValue({
      id: "new1",
      cwd: "/proj",
      isStreaming: false,
      status: "ready",
    } as never);
  });

  it("renders the current Home control above an edge-to-edge full-height workspace", async () => {
    renderHome();
    const home = screen.getByRole("button", { name: /back to home/i });
    expect(home).toHaveAttribute("aria-current", "page");
    const workspace = await screen.findByRole("region", { name: /research workspace/i });
    expect(workspace.parentElement).toHaveClass("min-h-full", "w-full", "flex", "flex-col");
    expect(workspace.parentElement).not.toHaveClass("px-2", "pb-2", "pt-[4px]");
    expect(workspace).toHaveClass("flex-1");
    expect(workspace).not.toHaveClass("home-workspace", "rounded-[10px]", "max-w-[1600px]");
  });

  it.each(["a1", "Fault diagnosis"])(
    "cancels deletion of %s without opening, stopping, or deleting it",
    async (title) => {
      const user = userEvent.setup();
      renderHome();
      const row = (await screen.findByText(title)).closest("li")!;
      const control = within(row).getByRole("button", { name: /^delete session/i });
      expect(control).toBeVisible();
      control.focus();
      await user.keyboard("{Enter}");
      const dialog = screen.getByRole("dialog", { name: /delete session/i });
      expect(within(dialog).getByText(title)).toBeVisible();
      expect(within(dialog).getByText("/proj")).toBeVisible();
      expect(dialog).toHaveTextContent(/permanently/i);
      expect(dialog).toHaveTextContent(/project files.*kept/i);
      const cancel = within(dialog).getByRole("button", { name: "Cancel" });
      expect(cancel).toHaveFocus();
      await user.tab();
      expect(within(dialog).getByRole("button", { name: title === "a1" ? "Stop and delete" : "Delete" })).toHaveFocus();
      await user.tab();
      expect(cancel).toHaveFocus();
      await user.click(cancel);
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(control).toHaveFocus();
      expect(api.deleteSession).not.toHaveBeenCalled();
      expect(api.openSession).not.toHaveBeenCalled();
      expect(api.touchSession).not.toHaveBeenCalled();
      expect(api.stopSession).not.toHaveBeenCalled();
    },
  );

  it.each(["running", "starting"] as const)("requires explicit stop and delete for known %s work", async (status) => {
    vi.mocked(api.listStatus).mockResolvedValue({
      bootId: "boot-a",
      agentDir: "/agent",
      homeDir: "/home/user",
      sessions: [],
      activeSessions: [{ ...active[0]!, status, isStreaming: false }],
    });
    const user = userEvent.setup();
    renderHome();
    await user.click(await screen.findByRole("button", { name: /^delete session/i }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByRole("button", { name: "Delete" })).toBeNull();
    expect(api.deleteSession).not.toHaveBeenCalled();
    vi.mocked(api.listStatus).mockReturnValue(new Promise(() => {}));
    await user.click(within(dialog).getByRole("button", { name: "Stop and delete" }));
    expect(api.deleteSession).toHaveBeenCalledExactlyOnceWith("a1", true);
    expect(screen.queryByText("a1")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("requires a separate force confirmation after an apparently idle session returns busy", async () => {
    const user = userEvent.setup();
    vi.mocked(api.deleteSession).mockRejectedValueOnce(
      new ApiError(409, { code: "SESSION_BUSY", error: "Active work" }),
    );
    renderHome();
    await user.click(await screen.findByRole("button", { name: "Delete session: Fault diagnosis" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    const force = await screen.findByRole("button", { name: "Stop and delete" });
    expect(api.deleteSession).toHaveBeenCalledExactlyOnceWith("h1", false);
    expect(screen.getByRole("dialog")).toHaveTextContent(/stop/i);
    vi.mocked(api.listStatus).mockReturnValue(new Promise(() => {}));
    await user.click(force);
    expect(api.deleteSession).toHaveBeenNthCalledWith(2, "h1", true);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("Fault diagnosis")).toBeNull();
  });

  it("blocks duplicate submission and dismissal while pending, then retains an error for retry", async () => {
    let reject!: (error: Error) => void;
    vi.mocked(api.deleteSession).mockReturnValueOnce(
      new Promise((_resolve, rejectPromise) => {
        reject = rejectPromise;
      }),
    );
    const user = userEvent.setup();
    renderHome();
    await user.click(await screen.findByRole("button", { name: "Delete session: Fault diagnosis" }));
    const dialog = screen.getByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Delete" });
    await user.dblClick(confirm);
    expect(confirm).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    await user.keyboard("{Escape}");
    await user.click(dialog.parentElement!);
    fireEvent.submit(dialog);
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(api.deleteSession).toHaveBeenCalledTimes(1);
    await act(async () => reject(new ApiError(409, { code: "LIFECYCLE_CONFLICT", error: "Cleanup could not finish" })));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Cleanup could not finish");
    expect(within(dialog).queryByRole("button", { name: "Stop and delete" })).toBeNull();
    vi.mocked(api.listStatus).mockReturnValue(new Promise(() => {}));
    await user.click(within(dialog).getByRole("button", { name: /retry/i }));
    expect(api.deleteSession).toHaveBeenNthCalledWith(2, "h1", false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each(["Escape", "backdrop"])("allows %s cancellation before submission", async (method) => {
    const user = userEvent.setup();
    renderHome();
    await user.click(await screen.findByRole("button", { name: "Delete session: Fault diagnosis" }));
    if (method === "Escape") await user.keyboard("{Escape}");
    else await user.click(screen.getByRole("dialog").parentElement!);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.deleteSession).not.toHaveBeenCalled();
  });

  it("keeps deletion localized including the target, scope, and busy action", async () => {
    const user = userEvent.setup();
    render(
      <I18nContext.Provider value={{ language: "zh-CN", setLanguage: () => {}, t: (key) => messages["zh-CN"][key] }}>
        <HomePage onOpenSession={() => {}} onOpenSettings={() => {}} settingsButton={null} />
      </I18nContext.Provider>,
    );
    await user.click(await screen.findByRole("button", { name: "删除会话: a1" }));
    const dialog = screen.getByRole("dialog", { name: "删除会话" });
    expect(dialog).toHaveTextContent("a1");
    expect(dialog).toHaveTextContent("永久");
    expect(dialog).toHaveTextContent(/项目文件.*保留/);
    expect(within(dialog).getByRole("button", { name: "取消" })).toHaveFocus();
    expect(within(dialog).getByRole("button", { name: "停止并删除" })).toBeEnabled();
  });

  it.each(["resolve", "reject"])(
    "rejects an older poll %s after immediate deletion and reconciles the last-row project",
    async (completion) => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const before = {
        bootId: "boot-a",
        agentDir: "/agent",
        homeDir: "/home/user",
        sessions: [...history, otherHistory],
        activeSessions: [],
      };
      let resolvePoll!: (value: typeof before) => void;
      let rejectPoll!: (error: Error) => void;
      let resolveRefresh!: (value: typeof before) => void;
      vi.mocked(api.listStatus)
        .mockResolvedValueOnce(before)
        .mockReturnValueOnce(
          new Promise((resolve, reject) => {
            resolvePoll = resolve;
            rejectPoll = reject;
          }),
        )
        .mockReturnValueOnce(
          new Promise((resolve) => {
            resolveRefresh = resolve;
          }),
        );
      const user = userEvent.setup();
      renderHome();
      await user.click(await screen.findByRole("button", { name: "/other" }));
      act(() => vi.advanceTimersByTime(5000));
      await user.click(screen.getByRole("button", { name: "Delete session: Other paper" }));
      await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
      expect(api.listStatus).toHaveBeenCalledTimes(3);
      expect(screen.queryByText("Other paper")).toBeNull();
      expect(screen.queryByRole("button", { name: "/other" })).toBeNull();
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "All projects" })).toHaveAttribute("aria-current", "true"),
      );
      expect(screen.getByText("Fault diagnosis")).toBeVisible();
      await act(async () => {
        if (completion === "resolve") resolvePoll(before);
        else rejectPoll(new Error("Old poll error"));
      });
      expect(screen.queryByText("Other paper")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      await act(async () => resolveRefresh({ ...before, sessions: history }));
      expect(screen.getByText("Fault diagnosis")).toBeVisible();
    },
  );

  it("renders historical and active sessions separately", async () => {
    render(
      <HomePage
        onOpenSession={() => {}}
        onOpenSettings={() => {}}
        settingsButton={<button type="button">Settings</button>}
      />,
    );
    expect(await screen.findByText("Fault diagnosis")).toBeTruthy();
    expect(screen.getByRole("button", { name: "/proj" })).toBeVisible();
    expect(screen.getAllByText("proj").length).toBeGreaterThan(0);
    expect(screen.getAllByText("12").length).toBeGreaterThan(0);
  });

  it("starts in All projects and filters both active and history by exact cwd", async () => {
    const user = userEvent.setup();
    renderHomeWithTwoProjects();
    expect(await screen.findByText("Fault diagnosis")).toBeVisible();
    expect(screen.getByText("Other paper")).toBeVisible();
    expect(screen.getByText("Project experiment")).toBeVisible();
    expect(screen.getByText("Other experiment")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "/other" }));
    expect(screen.getByRole("heading", { level: 1, name: "other" })).toBeVisible();
    expect(screen.queryByText("Fault diagnosis")).toBeNull();
    expect(screen.queryByText("Project experiment")).toBeNull();
    expect(screen.getByText("Other paper")).toBeVisible();
    expect(screen.getByText("Other experiment")).toBeVisible();
  });

  it("keeps mobile interaction and landmark order aligned with the visual workspace order", async () => {
    renderHomeWithTwoProjects();
    const elements = [
      await screen.findByRole("button", { name: /^new project$/i }),
      screen.getByRole("searchbox", { name: /search sessions/i }),
      screen.getByRole("heading", { name: /active sessions/i }),
      screen.getByRole("complementary", { name: /projects/i }),
      screen.getByRole("heading", { name: /recent sessions/i }),
    ];
    for (let index = 0; index < elements.length - 1; index += 1) {
      const current = elements[index]!;
      const next = elements[index + 1]!;
      expect(current.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("creates directly in a known project cwd", async () => {
    const user = userEvent.setup();
    renderHomeWithTwoProjects();
    await user.click(await screen.findByRole("button", { name: /new session \/other/i }));
    await waitFor(() => expect(api.createSession).toHaveBeenCalledWith("/other"));
  });

  it("keeps project selection and session opening keyboard accessible", async () => {
    const user = userEvent.setup();
    vi.mocked(api.openSession).mockResolvedValue({ id: "h2", cwd: "/other" } as never);
    renderHomeWithTwoProjects();
    const project = await screen.findByRole("button", { name: "/other" });
    project.focus();
    await user.keyboard("{Enter}");
    expect(project).toHaveAttribute("aria-current", "true");
    const session = screen.getByRole("button", { name: /^Other paper/ });
    session.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(api.openSession).toHaveBeenCalledWith(otherHistory.path));
    expect(api.createSession).not.toHaveBeenCalled();
  });

  it("reports connected running and idle sessions", async () => {
    vi.mocked(api.listStatus).mockResolvedValue({
      agentDir: "/agent",
      homeDir: "/home/user",
      sessions: history,
      activeSessions: [
        { id: "ready-sess", cwd: "/proj", sessionName: "Ready paper", isStreaming: false, status: "ready" },
        { id: "running-sess", cwd: "/proj", sessionName: "Running paper", isStreaming: false, status: "running" },
        { id: "error-sess", cwd: "/proj", sessionName: "Error paper", isStreaming: false, status: "error" },
      ],
    } as never);
    renderHome();
    expect(await screen.findByText(/^2 active$/i)).toBeVisible();
    expect(screen.getByText("Running paper")).toBeVisible();
    expect(screen.getByText("Ready paper")).toBeVisible();
    expect(screen.queryByText("Error paper")).toBeNull();
  });

  it("renders ready sessions in the active list", async () => {
    const running = { ...active[0], sessionName: "Running" };
    const idle = { id: "idle-sess", cwd: "/proj", sessionName: "Idle", isStreaming: false, status: "ready" };
    vi.mocked(api.listStatus).mockResolvedValueOnce({
      agentDir: "/agent",
      homeDir: "/home/user",
      sessions: [],
      activeSessions: [running, idle],
    } as never);
    renderHome();
    expect(await screen.findByRole("heading", { name: /active sessions/i })).toBeInTheDocument();
    expect(screen.getByTitle("Running")).toBeInTheDocument();
    expect(screen.getByTitle("Idle")).toBeInTheDocument();
  });

  it("searches active and historical session titles without hiding project selection", async () => {
    const user = userEvent.setup();
    renderHomeWithTwoProjects();
    await user.type(await screen.findByRole("searchbox", { name: /search sessions/i }), "other");
    expect(screen.queryByText("Fault diagnosis")).toBeNull();
    expect(screen.queryByText("Project experiment")).toBeNull();
    expect(screen.getByText("Other paper")).toBeVisible();
    expect(screen.getByText("Other experiment")).toBeVisible();
    expect(screen.getByRole("button", { name: "/proj" })).toBeVisible();
  });

  it("returns to All projects when polling removes the selected cwd", async () => {
    vi.useFakeTimers();
    vi.mocked(api.listStatus)
      .mockResolvedValueOnce({
        agentDir: "/agent",
        homeDir: "/home/user",
        sessions: [...history, otherHistory],
        activeSessions: [{ ...active[0], sessionName: "Project experiment" }, otherActive],
      } as never)
      .mockResolvedValue({
        agentDir: "/agent",
        homeDir: "/home/user",
        sessions: history,
        activeSessions: active,
      } as never);
    renderHome();
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "/other" }));
    expect(screen.getByRole("button", { name: "/other" })).toHaveAttribute("aria-current", "true");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(screen.getByRole("button", { name: /all projects/i })).toHaveAttribute("aria-current", "true");
    expect(screen.queryByRole("button", { name: "/other" })).toBeNull();
    expect(screen.getByText("Fault diagnosis")).toBeVisible();
  });

  it("renders Settings once", async () => {
    renderHome();
    await screen.findByText("Fault diagnosis");
    expect(screen.getAllByRole("button", { name: /settings/i })).toHaveLength(1);
  });

  it("selecting a directory in the dialog then Create calls createSession with the exact path", async () => {
    const user = userEvent.setup();
    render(
      <HomePage
        onOpenSession={() => {}}
        onOpenSettings={() => {}}
        settingsButton={<button type="button">Settings</button>}
      />,
    );
    await user.click(screen.getByRole("button", { name: /^new project$/i }));
    const dialog = await screen.findByRole("dialog", { name: /choose project directory/i });
    await user.click(await within(dialog).findByRole("treeitem", { name: /proj/i }));
    await user.click(screen.getByRole("button", { name: /create session/i }));
    await waitFor(() => expect(api.createSession).toHaveBeenCalledWith("/proj"));
  });

  it("surfaces a create failure inline without a trust dialog", async () => {
    const user = userEvent.setup();
    vi.mocked(api.createSession).mockRejectedValueOnce(
      new ApiError(400, { error: "EasyResearch does not load user-added Pi extensions" }),
    );
    render(
      <HomePage
        onOpenSession={() => {}}
        onOpenSettings={() => {}}
        settingsButton={<button type="button">Settings</button>}
      />,
    );
    await user.click(screen.getByRole("button", { name: /^new project$/i }));
    const dialog = await screen.findByRole("dialog", { name: /choose project directory/i });
    await user.click(await within(dialog).findByRole("treeitem", { name: /proj/i }));
    await user.click(screen.getByRole("button", { name: /create session/i }));
    expect(await screen.findByText(/user-added Pi extensions/)).toBeTruthy();
    expect(screen.queryByText(/trust decision/i)).toBeNull();
  });

  it("selecting history calls openSession(path), not createSession", async () => {
    const user = userEvent.setup();
    vi.mocked(api.openSession).mockResolvedValue({
      id: "h1",
      cwd: "/proj",
      sessionFile: "/agent/sessions/--p--/a.jsonl",
      isStreaming: false,
      status: "ready",
    } as never);
    const onOpen = vi.fn();
    render(
      <HomePage
        onOpenSession={onOpen}
        onOpenSettings={() => {}}
        settingsButton={<button type="button">Settings</button>}
      />,
    );
    await user.click(await screen.findByText("Fault diagnosis"));
    await waitFor(() => expect(api.openSession).toHaveBeenCalledWith("/agent/sessions/--p--/a.jsonl"));
    expect(api.createSession).not.toHaveBeenCalled();
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith({ id: "h1", cwd: "/proj" }));
  });

  it("renames a session from the row button and refreshes the status", async () => {
    // The renamed row must come from Save's refresh, never the monitor poll.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    vi.mocked(api.renameSession).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderHome();

    await screen.findByText("Fault diagnosis");
    const rename = screen.getByRole("button", { name: /rename session: fault diagnosis/i });
    await user.click(rename);
    const input = screen.getByRole("textbox", { name: /session name/i });
    await user.clear(input);
    await user.type(input, "Renamed paper");
    vi.mocked(api.listStatus).mockResolvedValue({
      bootId: "boot-a",
      agentDir: "/agent",
      homeDir: "/home/user",
      sessions: [{ ...history[0]!, name: "Renamed paper" }],
      activeSessions: [{ ...active[0]!, status: "running" }],
    });
    await user.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(api.renameSession).toHaveBeenCalledWith("h1", "Renamed paper"));
    expect(await screen.findByText("Renamed paper")).toBeVisible();
    expect(screen.getByRole("button", { name: "Rename session: Renamed paper" })).toBeVisible();
    expect(screen.queryByText("Fault diagnosis")).toBeNull();
  });

  it("keeps controls usable while loading", () => {
    vi.mocked(api.listStatus).mockReturnValue(new Promise(() => {}) as never);
    render(
      <HomePage
        onOpenSession={() => {}}
        onOpenSettings={() => {}}
        settingsButton={<button type="button">Settings</button>}
      />,
    );
    expect(screen.getByRole("button", { name: /^new project$/i })).toBeEnabled();
  });

  it("shows an error state that does not shift layout", async () => {
    vi.mocked(api.listStatus).mockRejectedValueOnce(new Error("agent dir unavailable"));
    render(
      <HomePage
        onOpenSession={() => {}}
        onOpenSettings={() => {}}
        settingsButton={<button type="button">Settings</button>}
      />,
    );
    expect(await screen.findByText(/agent dir unavailable/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^new project$/i })).toBeTruthy();
  });

  it("opens a running active session directly without restart", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listStatus).mockResolvedValue({
      agentDir: "/agent",
      homeDir: "/home/user",
      sessions: history,
      activeSessions: [{ id: "a1", cwd: "/proj", sessionName: "Running proj", isStreaming: true, status: "running" }],
    } as never);
    const onOpen = vi.fn();
    vi.mocked(api.touchSession).mockResolvedValue();
    render(
      <HomePage
        onOpenSession={onOpen}
        onOpenSettings={() => {}}
        settingsButton={<button type="button">Settings</button>}
      />,
    );
    await user.click(await screen.findByText("Running proj"));
    await waitFor(() => expect(api.restartSession).not.toHaveBeenCalled());
    await waitFor(() => expect(api.touchSession).toHaveBeenCalledWith("a1"));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith({ id: "a1", cwd: "/proj" }));
  });

  it("disconnects an active session without opening it and refreshes status", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    vi.mocked(api.stopSession).mockResolvedValue();
    render(
      <HomePage
        onOpenSession={onOpen}
        onOpenSettings={() => {}}
        settingsButton={<button type="button">Settings</button>}
      />,
    );

    await user.click(await screen.findByRole("button", { name: /disconnect.*a1|disconnect/i }));
    await waitFor(() => expect(api.stopSession).toHaveBeenCalledWith("a1"));
    expect(onOpen).not.toHaveBeenCalled();
    expect(api.listStatus).toHaveBeenCalledTimes(2);
  });
});
