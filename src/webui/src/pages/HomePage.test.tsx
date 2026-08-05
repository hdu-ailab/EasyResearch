// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

describe("HomePage", () => {
  beforeEach(() => {
    vi.mocked(api.listStatus).mockReset();
    vi.mocked(api.listDirectories).mockReset();
    vi.mocked(api.createSession).mockReset();
    vi.mocked(api.openSession).mockReset();
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

  it("selecting a directory in the dialog then Create calls createSession with the exact path", async () => {
    const user = userEvent.setup();
    render(<HomePage onOpenSession={() => {}} onOpenSettings={() => {}} settingsButton={<button type="button">Settings</button>} />);
    await user.click(screen.getByRole("button", { name: /choose directory/i }));
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
    await user.click(screen.getByRole("button", { name: /choose directory/i }));
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
    expect(screen.getByRole("button", { name: /choose directory/i })).toBeEnabled();
  });

  it("shows an error state that does not shift layout", async () => {
    vi.mocked(api.listStatus).mockRejectedValueOnce(new Error("agent dir unavailable"));
    render(<HomePage onOpenSession={() => {}} onOpenSettings={() => {}} settingsButton={<button type="button">Settings</button>} />);
    expect(await screen.findByText(/agent dir unavailable/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /choose directory/i })).toBeTruthy();
  });
});
