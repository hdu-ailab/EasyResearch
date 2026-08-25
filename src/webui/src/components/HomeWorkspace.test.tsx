import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { ActiveSessionDto, SessionSummaryDto } from "../../../web/contracts";
import { buildHomeProjectGroups } from "../pages/home-view-model";
import { HomeWorkspace } from "./HomeWorkspace";

function history(patch: Partial<SessionSummaryDto> = {}): SessionSummaryDto {
  return {
    id: "h1",
    path: "/agent/sessions/h1.jsonl",
    cwd: "/proj",
    name: "Custom name",
    created: "2026-08-10T00:00:00.000Z",
    modified: "2026-08-10T00:00:00.000Z",
    messageCount: 3,
    firstMessage: "write a fault diagnosis paper",
    ...patch,
  };
}

function active(patch: Partial<ActiveSessionDto> = {}): ActiveSessionDto {
  return {
    id: "0123456789abcdef",
    cwd: "/proj",
    sessionFile: "/agent/sessions/a1.jsonl",
    sessionName: "Custom active name",
    isStreaming: false,
    status: "running",
    ...patch,
  };
}

function renderWorkspace(
  history: SessionSummaryDto[],
  active: ActiveSessionDto[],
  handlers: {
    onRenameActive?: (session: ActiveSessionDto | SessionSummaryDto) => void;
    onRenameHistory?: (session: SessionSummaryDto) => void;
  } = {},
) {
  return render(
    <HomeWorkspace
      groups={buildHomeProjectGroups(history, active)}
      selectedCwd={null}
      loading={false}
      creating={false}
      onSelectProject={vi.fn()}
      onChooseDirectory={vi.fn()}
      onCreateInProject={vi.fn()}
      onOpenActive={vi.fn()}
      onDisconnectActive={vi.fn()}
      onOpenHistory={vi.fn()}
      onRenameSession={handlers.onRenameActive ?? vi.fn()}
      onRenameHistory={handlers.onRenameHistory ?? vi.fn()}
    />,
  );
}

it("shows the active session name when set", () => {
  renderWorkspace(
    [{ ...history({ id: "h1", path: "/agent/sessions/a1.jsonl" }) }],
    [active({ sessionFile: "/agent/sessions/a1.jsonl" })],
  );
  expect(screen.getByText("Custom active name")).toBeVisible();
  expect(screen.queryByText("write a fault diagnosis paper")).toBeNull();
});

it("renders the full first prompt as the active session title tooltip on a single truncating line", () => {
  renderWorkspace(
    [
      {
        ...history({
          id: "h1",
          path: "/agent/sessions/a1.jsonl",
          name: undefined,
          firstMessage: "write a very long first prompt",
        }),
      },
    ],
    [active({ sessionFile: "/agent/sessions/a1.jsonl", sessionName: undefined })],
  );
  const title = screen.getByTitle("write a very long first prompt");
  expect(title).toHaveTextContent("write a very long first prompt");
  expect(title).toHaveClass("truncate");
});

it("falls back to the first eight real id characters for an active session without a name or matched history row", () => {
  renderWorkspace([], [active({ sessionName: undefined })]);
  expect(screen.getByText("01234567")).toBeVisible();
  expect(screen.queryByText("Custom active name")).toBeNull();
});

it("renders a ready session in the active list with the idle status", () => {
  renderWorkspace([], [active({ id: "idle-session", status: "ready", sessionName: "Idle session" })]);
  expect(screen.getByText("Idle session")).toBeVisible();
  expect(screen.getByText("Idle")).toBeVisible();
});

it("renders a separate disconnect control for an active session", () => {
  renderWorkspace([], [active({ sessionName: "Disconnectable" })]);
  expect(screen.getByRole("button", { name: /^disconnect session/i })).toBeVisible();
});

it("renders a rename control per active row and per history row", () => {
  const onRenameActive = vi.fn();
  const onRenameHistory = vi.fn();
  renderWorkspace([history({ id: "h1" })], [active({ id: "a1" })], { onRenameActive, onRenameHistory });
  expect(screen.getAllByRole("button", { name: /rename session/i })).toHaveLength(2);
});

it("separates the New project entry from an existing project's New session action", () => {
  renderWorkspace([history()], []);

  expect(screen.getByRole("button", { name: "New project" })).toBeVisible();
  expect(screen.getByRole("button", { name: "New session /proj" })).toBeVisible();
});
