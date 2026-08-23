import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { SessionTreeDto } from "../../../web/contracts";
import { SessionHistoryDialog } from "./SessionHistoryDialog";

const branchingTree: SessionTreeDto = {
  leafId: "a-current",
  filterMode: "default",
  skipBranchSummaryPrompt: false,
  tree: [
    { id: "u-root", parentId: null, role: "user", kind: "user", text: "Root question" },
    { id: "a-side", parentId: "u-root", role: "assistant", kind: "assistant", text: "Side answer" },
    { id: "a-current", parentId: "u-root", role: "assistant", kind: "assistant", text: "Main answer" },
  ],
};

const filterTree: SessionTreeDto = {
  leafId: "a-leaf",
  filterMode: "default",
  skipBranchSummaryPrompt: false,
  tree: [
    { id: "u-root", parentId: null, role: "user", kind: "user", text: "Question" },
    { id: "tool", parentId: "u-root", role: "other", kind: "tool", text: "Tool output" },
    { id: "model", parentId: "tool", role: "other", kind: "model-change", text: "model-v2" },
    {
      id: "a-leaf",
      parentId: "model",
      role: "assistant",
      kind: "assistant",
      text: "Answer",
      label: "checkpoint",
    },
    { id: "info", parentId: "a-leaf", role: "other", kind: "session-info", text: "Paper" },
  ],
};

it("keeps focus in the search field while filtering history rows", async () => {
  const user = userEvent.setup();
  render(
    <SessionHistoryDialog
      value={branchingTree}
      busy={false}
      onNavigate={vi.fn()}
      onRestoreDraft={vi.fn()}
      onClose={vi.fn()}
    />,
  );

  const search = screen.getByRole("searchbox", { name: /search history/i });
  await user.type(search, "side");

  expect(search).toHaveValue("side");
  expect(search).toHaveFocus();
  expect(screen.getAllByRole("treeitem")).toHaveLength(1);
  expect(screen.getByRole("treeitem")).toHaveTextContent("Side answer");
});

it("restores an empty Pi editor value so history navigation can clear the draft", async () => {
  const user = userEvent.setup();
  const onRestoreDraft = vi.fn();
  const onNavigate = vi.fn().mockResolvedValue({ cancelled: false, editorText: "", leafId: null });
  render(
    <SessionHistoryDialog
      value={{ ...branchingTree, skipBranchSummaryPrompt: true }}
      busy={false}
      onNavigate={onNavigate}
      onRestoreDraft={onRestoreDraft}
      onClose={vi.fn()}
    />,
  );

  await user.keyboard("{Home}{Enter}");

  expect(onNavigate).toHaveBeenCalledWith("u-root", { summarize: false });
  expect(onRestoreDraft).toHaveBeenCalledWith("");
});

it("clears branch folds when the Pi history filter changes", async () => {
  const user = userEvent.setup();
  render(
    <SessionHistoryDialog
      value={branchingTree}
      busy={false}
      onNavigate={vi.fn()}
      onRestoreDraft={vi.fn()}
      onClose={vi.fn()}
    />,
  );

  await user.keyboard("{Home}{ArrowLeft}");
  expect(screen.getAllByRole("treeitem")).toHaveLength(1);

  await user.selectOptions(screen.getByRole("combobox", { name: /history filter/i }), "no-tools");

  expect(screen.getAllByRole("treeitem")).toHaveLength(3);
});

it("applies the five Pi history filters to visible entries", async () => {
  const user = userEvent.setup();
  render(
    <SessionHistoryDialog
      value={filterTree}
      busy={false}
      onNavigate={vi.fn()}
      onRestoreDraft={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  const filter = screen.getByRole("combobox", { name: /history filter/i });

  expect(screen.getAllByRole("treeitem")).toHaveLength(3);
  expect(screen.queryByText("model-v2")).toBeNull();
  expect(screen.queryByText("Paper")).toBeNull();

  await user.selectOptions(filter, "no-tools");
  expect(screen.getAllByRole("treeitem")).toHaveLength(2);
  expect(screen.queryByText("Tool output")).toBeNull();

  await user.selectOptions(filter, "user-only");
  expect(screen.getAllByRole("treeitem")).toHaveLength(1);
  expect(screen.getByRole("treeitem")).toHaveTextContent("Question");

  await user.selectOptions(filter, "labeled-only");
  expect(screen.getAllByRole("treeitem")).toHaveLength(1);
  expect(screen.getByRole("treeitem")).toHaveTextContent("checkpoint");

  await user.selectOptions(filter, "all");
  expect(screen.getAllByRole("treeitem")).toHaveLength(5);
});

it("uses active-branch-first order and roving tree keyboard navigation", async () => {
  const user = userEvent.setup();
  render(
    <SessionHistoryDialog
      value={branchingTree}
      busy={false}
      onNavigate={vi.fn()}
      onRestoreDraft={vi.fn()}
      onClose={vi.fn()}
    />,
  );

  const items = screen.getAllByRole("treeitem");
  expect(items.map((item) => item.textContent)).toEqual([
    expect.stringContaining("Root question"),
    expect.stringContaining("Main answer"),
    expect.stringContaining("Side answer"),
  ]);
  expect(items[1]).toHaveFocus();

  await user.keyboard("{ArrowDown}");
  expect(items[2]).toHaveFocus();
  await user.keyboard("{ArrowDown}");
  expect(items[0]).toHaveFocus();
  await user.keyboard("{End}");
  expect(items[2]).toHaveFocus();
  await user.keyboard("{Home}{ArrowRight}");
  expect(items[1]).toHaveFocus();
  await user.keyboard("{ArrowLeft}{ArrowLeft}");
  expect(screen.getAllByRole("treeitem")).toHaveLength(1);
  expect(screen.getByRole("treeitem")).toHaveFocus();
  await user.keyboard("{ArrowRight}{ArrowRight}");
  expect(screen.getAllByRole("treeitem")[1]).toHaveFocus();
});

it("keeps history browseable but prevents navigation while the session tree is busy", async () => {
  const user = userEvent.setup();
  const onNavigate = vi.fn();
  const onClose = vi.fn();
  render(
    <SessionHistoryDialog
      value={branchingTree}
      busy
      onNavigate={onNavigate}
      onRestoreDraft={vi.fn()}
      onClose={onClose}
    />,
  );

  const current = screen.getAllByRole("treeitem")[1];
  expect(current).toHaveAttribute("aria-disabled", "true");
  await user.keyboard("{ArrowDown}{Enter}");

  expect(screen.getAllByRole("treeitem")[2]).toHaveFocus();
  expect(onNavigate).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog", { name: /summarize branch/i })).toBeNull();
});

it("passes custom branch-summary instructions through typed navigation", async () => {
  const user = userEvent.setup();
  const onNavigate = vi.fn().mockResolvedValue({ cancelled: false, leafId: "u-root" });
  render(
    <SessionHistoryDialog
      value={branchingTree}
      busy={false}
      onNavigate={onNavigate}
      onRestoreDraft={vi.fn()}
      onClose={vi.fn()}
    />,
  );

  await user.keyboard("{Home}{Enter}");
  const summary = screen.getByRole("dialog", { name: /summarize branch/i });
  await user.click(within(summary).getByRole("button", { name: /custom instructions/i }));
  const instructions = within(summary).getByRole("textbox", { name: /custom summarization instructions/i });
  await user.type(instructions, "Keep method decisions");
  await user.click(within(summary).getByRole("button", { name: /^summarize$/i }));

  expect(onNavigate).toHaveBeenCalledWith("u-root", {
    summarize: true,
    customInstructions: "Keep method decisions",
  });
});
