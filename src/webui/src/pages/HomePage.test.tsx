// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomePage } from "./HomePage";
import * as api from "../api";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    listStatus: vi.fn(),
    listDirectories: vi.fn(),
    createSession: vi.fn(),
    openSession: vi.fn(),
    restartSession: vi.fn(),
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
    vi.mocked(api.listStatus).mockResolvedValue({
      agentDir: "/agent",
      homeDir: "/home/user",
      sessions: history,
      activeSessions: active,
    } as never);
    vi.mocked(api.listDirectories).mockResolvedValue([
      { name: "proj", path: "/proj" },
    ]);
    vi.mocked(api.createSession).mockResolvedValue({
      id: "new1",
      cwd: "/proj",
      isStreaming: false,
      status: "ready",
    } as never);
  });

  it("renders historical and active sessions separately", async () => {
    render(<HomePage onOpenSession={() => {}} onOpenSettings={() => {}} settingsButton={<button type="button">Settings</button>} />);
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

  it("reports only actually running sessions", async () => {
    vi.mocked(api.listStatus).mockResolvedValue({
      agentDir: "/agent",
      homeDir: "/home/user",
      sessions: history,
      activeSessions: [
        { id: "ready", cwd: "/proj", sessionName: "Ready paper", isStreaming: false, status: "ready" },
        { id: "running", cwd: "/proj", sessionName: "Running paper", isStreaming: false, status: "running" },
        { id: "error", cwd: "/proj", sessionName: "Error paper", isStreaming: false, status: "error" },
      ],
    } as never);
    renderHome();
    expect(await screen.findByText(/^1 running$/i)).toBeVisible();
    expect(screen.getByText("Running paper")).toBeVisible();
    expect(screen.queryByText("Ready paper")).toBeNull();
    expect(screen.queryByText("Error paper")).toBeNull();
  });

  it("renders only running sessions in the active list", async () => {
    const running = { ...active[0], sessionName: "Running" };
    const idle = { id: "idle", cwd: "/proj", sessionName: "Idle", isStreaming: false, status: "ready" };
    vi.mocked(api.listStatus).mockResolvedValueOnce({
      agentDir: "/agent",
      homeDir: "/home/user",
      sessions: [],
      activeSessions: [running, idle],
    } as never);
    renderHome();
    expect(await screen.findByRole("heading", { name: /active sessions/i })).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.queryByText("Idle")).not.toBeInTheDocument();
  });

  it("searches active and historical session names without hiding project selection", async () => {
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
    render(<HomePage onOpenSession={() => {}} onOpenSettings={() => {}} settingsButton={<button type="button">Settings</button>} />);
    await user.click(screen.getByRole("button", { name: /^new session$/i }));
    await user.click(await screen.findByText("proj"));
    await user.click(screen.getByRole("button", { name: /create session/i }));
    await waitFor(() => expect(api.createSession).toHaveBeenCalledWith("/proj"));
  });

  it("surfaces a create failure inline without a trust dialog", async () => {
    const user = userEvent.setup();
    vi.mocked(api.createSession).mockRejectedValueOnce(
      new ApiError(400, { error: "LazyResearch does not load user-added Pi extensions" }),
    );
    render(<HomePage onOpenSession={() => {}} onOpenSettings={() => {}} settingsButton={<button type="button">Settings</button>} />);
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
    render(<HomePage onOpenSession={onOpen} onOpenSettings={() => {}} settingsButton={<button type="button">Settings</button>} />);
    await user.click(await screen.findByText("Fault diagnosis"));
    await waitFor(() => expect(api.openSession).toHaveBeenCalledWith("/agent/sessions/--p--/a.jsonl"));
    expect(api.createSession).not.toHaveBeenCalled();
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith({ id: "h1", cwd: "/proj" }));
  });

  it("keeps controls usable while loading", () => {
    vi.mocked(api.listStatus).mockReturnValue(new Promise(() => {}) as never);
    render(<HomePage onOpenSession={() => {}} onOpenSettings={() => {}} settingsButton={<button type="button">Settings</button>} />);
    expect(screen.getByRole("button", { name: /^new session$/i })).toBeEnabled();
  });

  it("shows an error state that does not shift layout", async () => {
    vi.mocked(api.listStatus).mockRejectedValueOnce(new Error("agent dir unavailable"));
    render(<HomePage onOpenSession={() => {}} onOpenSettings={() => {}} settingsButton={<button type="button">Settings</button>} />);
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
    render(<HomePage onOpenSession={onOpen} onOpenSettings={() => {}} settingsButton={<button type="button">Settings</button>} />);
    await user.click(await screen.findByText("Running proj"));
    await waitFor(() => expect(api.restartSession).not.toHaveBeenCalled());
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith({ id: "a1", cwd: "/proj" }));
  });
});
