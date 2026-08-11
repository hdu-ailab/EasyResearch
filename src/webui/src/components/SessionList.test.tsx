import { render, screen } from "@testing-library/react";
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

function renderList(history: SessionSummaryDto[]) {
  return render(<SessionList history={history} onOpenHistory={vi.fn()} />);
}

it("shows the literal first prompt as the recent title even when a session name is set", () => {
  renderList([history()]);
  expect(screen.getByText("write a paper")).toBeVisible();
  expect(screen.queryByText("Fault diagnosis")).toBeNull();
});

it("renders the full first prompt as the recent title tooltip on a single truncating line", () => {
  renderList([history({ firstMessage: "write a very long first prompt" })]);
  const title = screen.getByTitle("write a very long first prompt");
  expect(title).toHaveTextContent("write a very long first prompt");
  expect(title).toHaveClass("truncate");
});

it("falls back to the first eight id characters when the first message is blank", () => {
  renderList([history({ firstMessage: "   " })]);
  expect(screen.getByText("01234567")).toBeVisible();
});
