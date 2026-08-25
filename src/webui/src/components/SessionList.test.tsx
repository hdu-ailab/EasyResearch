import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { SessionSummaryDto } from "../../../web/contracts";
import { SessionList } from "./SessionList";

function history(patch: Partial<SessionSummaryDto> = {}): SessionSummaryDto {
  return {
    id: "0123456789abcdef",
    path: "/agent/sessions/h1.jsonl",
    cwd: "/proj",
    name: "Fault diagnosis",
    created: "2026-08-10T00:00:00.000Z",
    modified: "2026-08-10T00:00:00.000Z",
    messageCount: 12,
    firstMessage: "write a paper",
    ...patch,
  };
}

function renderList(history: SessionSummaryDto[], onRenameSession: (session: SessionSummaryDto) => void = vi.fn()) {
  return render(<SessionList history={history} onOpenHistory={vi.fn()} onRenameSession={onRenameSession} />);
}

it("shows the session name as the recent title when set", () => {
  renderList([history()]);
  expect(screen.getByText("Fault diagnosis")).toBeVisible();
  expect(screen.queryByText("write a paper")).toBeNull();
});

it("renders the full first prompt as the recent title tooltip on a single truncating line", () => {
  renderList([history({ name: undefined, firstMessage: "write a very long first prompt" })]);
  const title = screen.getByTitle("write a very long first prompt");
  expect(title).toHaveTextContent("write a very long first prompt");
  expect(title).toHaveClass("truncate");
});

it("falls back to the first eight id characters when no name or first message is set", () => {
  renderList([history({ name: undefined, firstMessage: "   " })]);
  expect(screen.getByText("01234567")).toBeVisible();
});

it("shows the project folder and message count in the recent-session ledger", () => {
  renderList([history({ cwd: "/papers/fault-diagnosis", messageCount: 12 })]);
  const row = screen.getByText("Fault diagnosis").closest("li");
  expect(row).not.toBeNull();
  expect(within(row!).getAllByText("fault-diagnosis").length).toBeGreaterThan(0);
  expect(within(row!).getAllByText("12").length).toBeGreaterThan(0);
  expect(within(row!).getByRole("button", { name: /12 messages/i })).toBeVisible();
});

it("uses a singular accessible message-count label", () => {
  renderList([history({ messageCount: 1 })]);
  expect(screen.getByRole("button", { name: /1 message/i })).toBeVisible();
  expect(screen.queryByRole("button", { name: /1 messages/i })).not.toBeInTheDocument();
});

it("exposes a rename control per recent row", () => {
  const onRenameSession = vi.fn();
  renderList([history({ id: "h1" })], onRenameSession);
  const rename = screen.getByRole("button", { name: /rename session/i });
  fireEvent.click(rename);
  expect(onRenameSession).toHaveBeenCalledWith(expect.objectContaining({ id: "h1" }));
});
