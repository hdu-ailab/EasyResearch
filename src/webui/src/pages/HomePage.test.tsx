import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { HomePage } from "./HomePage";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    listStatus: vi.fn(),
    listDirectories: vi.fn(),
    createSession: vi.fn(),
    openSession: vi.fn(),
    restartSession: vi.fn(),
    touchSession: vi.fn(),
    stopSession: vi.fn(),
    renameSession: vi.fn(),
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
    vi.mocked(api.listDirectories).mockReset();
    vi.mocked(api.createSession).mockReset();
    vi.mocked(api.openSession).mockReset();
    vi.mocked(api.restartSession).mockReset();
    vi.mocked(api.touchSession).mockReset();
    vi.mocked(api.stopSession).mockReset();
    vi.mocked(api.renameSession).mockReset();
    vi.mocked(api.listStatus).mockResolvedValue({
      agentDir: "/agent",
      homeDir: "/home/user",
      sessions: history,
      activeSessions: active,
    } as never);
    vi.mocked(api.listDirectories).mockResolvedValue([{ name: "proj", path: "/proj" }]);
    vi.mocked(api.createSession).mockResolvedValue({
      id: "new1",
      cwd: "/proj",
      isStreaming: false,
      status: "ready",
    } as never);
  });

  it("renders the fixed current Home control above a 4px content gap", async () => {
    renderHome();
    const home = screen.getByRole("button", { name: /back to home/i });
    expect(home).toHaveAttribute("aria-current", "page");
    const workspace = await screen.findByRole("region", { name: /research workspace/i });
    expect(workspace.parentElement).toHaveClass("px-2", "pb-2", "pt-[4px]");
    expect(workspace.parentElement).not.toHaveClass("p-2");
  });

  it("renders historical and active sessions separately", async () => {
    render(
      <HomePage
        onOpenSession={() => {}}
        onOpenSettings={() => {}}
        settingsButton={<button type="button">Settings</button>}
      />,
    );
    expect(await screen.findByText("Fault diagnosis")).toBeTruthy();
    expect(screen.getAllByText("/proj").length).toBeGreaterThan(0);
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
    expect(screen.queryByText("Fault diagnosis")).toBeNull();
    expect(screen.queryByText("Project experiment")).toBeNull();
    expect(screen.getByText("Other paper")).toBeVisible();
    expect(screen.getByText("Other experiment")).toBeVisible();
  });

  it("keeps mobile interaction and landmark order aligned with the visual workspace order", async () => {
    renderHomeWithTwoProjects();
    const elements = [
      await screen.findByRole("button", { name: /^new session$/i }),
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
    await user.click(screen.getByRole("button", { name: /^new session$/i }));
    await user.click(await screen.findByText("proj"));
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
    await user.click(screen.getByRole("button", { name: /^new session$/i }));
    await user.click(await screen.findByText("proj"));
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
    vi.mocked(api.renameSession).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderHome();

    await screen.findByText("Fault diagnosis");
    const rename = screen.getByRole("button", { name: /rename session: fault diagnosis/i });
    await user.click(rename);
    const input = screen.getByRole("textbox", { name: /session name/i });
    await user.clear(input);
    await user.type(input, "Renamed paper");
    await user.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(api.renameSession).toHaveBeenCalledWith("h1", "Renamed paper"));
    expect(api.listStatus).toHaveBeenCalled();
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
    expect(screen.getByRole("button", { name: /^new session$/i })).toBeEnabled();
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
    expect(screen.getByRole("button", { name: /^new session$/i })).toBeTruthy();
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
