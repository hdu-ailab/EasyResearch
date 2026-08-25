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
    { id: "bash", parentId: "tool", role: "other", kind: "bash", text: "Bash command" },
    { id: "model", parentId: "bash", role: "other", kind: "model-change", text: "model-v2" },
    {
      id: "a-leaf",
      parentId: "model",
      role: "assistant",
      kind: "assistant",
      text: "Answer",
      label: "checkpoint",
    },
    { id: "compact", parentId: "a-leaf", role: "other", kind: "compaction", text: "Compact summary" },
    { id: "summary", parentId: "compact", role: "other", kind: "branch-summary", text: "Branch summary" },
    { id: "info", parentId: "summary", role: "other", kind: "session-info", text: "Paper" },
  ],
};

const linearTree: SessionTreeDto = {
  leafId: "u-third",
  filterMode: "all",
  skipBranchSummaryPrompt: false,
  tree: [
    { id: "u-first", parentId: null, role: "user", kind: "user", text: "Linear first" },
    { id: "u-second", parentId: "u-first", role: "user", kind: "user", text: "Linear second" },
    {
      id: "u-third",
      parentId: "u-second",
      role: "user",
      kind: "user",
      text: "Linear third with enough text to require its own intrinsic row width",
    },
  ],
};

const branchedSegmentsTree: SessionTreeDto = {
  leafId: "u-a2",
  filterMode: "default",
  skipBranchSummaryPrompt: false,
  tree: [
    { id: "u-root", parentId: null, role: "user", kind: "user", text: "Active segment root" },
    { id: "u-a", parentId: "u-root", role: "user", kind: "user", text: "Active branch" },
    { id: "u-a1", parentId: "u-a", role: "user", kind: "user", text: "Active continuation" },
    {
      id: "u-a2",
      parentId: "u-a1",
      role: "user",
      kind: "user",
      text: "Active branch terminal with complete horizontally scrollable text",
    },
    { id: "u-b", parentId: "u-root", role: "user", kind: "user", text: "Side branch" },
    { id: "u-b1", parentId: "u-b", role: "user", kind: "user", text: "Side continuation" },
  ],
};

it("starts every history dialog with the user-only filter", () => {
  render(
    <SessionHistoryDialog
      value={filterTree}
      busy={false}
      onNavigate={vi.fn()}
      onRestoreDraft={vi.fn()}
      onClose={vi.fn()}
    />,
  );

  expect(screen.getByRole("combobox", { name: /history filter/i })).toHaveValue("user-only");
  expect(screen.getAllByRole("treeitem")).toHaveLength(1);
  expect(screen.getByRole("treeitem")).toHaveTextContent("Question");
});

it("offers exactly the three product history filters", () => {
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
  expect(
    within(filter)
      .getAllByRole("option")
      .map((option) => [option.getAttribute("value"), option.textContent]),
  ).toEqual([
    ["user-only", "User only"],
    ["messages", "User and assistant"],
    ["all", "All"],
  ]);
});

it("keeps a visible single-child history chain at one visual level", () => {
  render(
    <SessionHistoryDialog
      value={linearTree}
      busy={false}
      onNavigate={vi.fn()}
      onRestoreDraft={vi.fn()}
      onClose={vi.fn()}
    />,
  );

  const items = screen.getAllByRole("treeitem");
  expect(items.map((item) => item.getAttribute("aria-level"))).toEqual(["1", "1", "1"]);
});

it("indents siblings created by a real branch", async () => {
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

  await user.selectOptions(screen.getByRole("combobox", { name: /history filter/i }), "messages");

  const items = screen.getAllByRole("treeitem");
  expect(items.map((item) => item.getAttribute("aria-level"))).toEqual(["1", "2", "2"]);
});

it("uses branch segments for visual levels and folding", () => {
  render(
    <SessionHistoryDialog
      value={branchedSegmentsTree}
      busy={false}
      onNavigate={vi.fn()}
      onRestoreDraft={vi.fn()}
      onClose={vi.fn()}
    />,
  );

  const items = screen.getAllByRole("treeitem");
  expect(items.map((item) => item.getAttribute("aria-level"))).toEqual(["1", "2", "3", "3", "2", "3"]);
  expect(items.map((item) => item.getAttribute("aria-expanded"))).toEqual(["true", "true", null, null, "true", null]);
  expect(items[1]).toHaveTextContent("-•user:Active branch");
  expect(items[4]).toHaveTextContent("-·user:Side branch");
});

it("moves and folds by branch segment with Left and Right", async () => {
  const user = userEvent.setup();
  render(
    <SessionHistoryDialog
      value={branchedSegmentsTree}
      busy={false}
      onNavigate={vi.fn()}
      onRestoreDraft={vi.fn()}
      onClose={vi.fn()}
    />,
  );

  expect(screen.getByRole("treeitem", { name: /active branch terminal/i })).toHaveFocus();
  await user.keyboard("{ArrowLeft}");
  expect(screen.getByRole("treeitem", { name: "user:Active branch" })).toHaveFocus();

  await user.keyboard("{ArrowLeft}");
  expect(screen.queryByRole("treeitem", { name: /active continuation/i })).toBeNull();
  expect(screen.queryByRole("treeitem", { name: /active branch terminal/i })).toBeNull();

  await user.keyboard("{ArrowRight}{ArrowRight}");
  expect(screen.getByRole("treeitem", { name: /active branch terminal/i })).toHaveFocus();
});

it("clears branch folds when search changes the visible branch structure", async () => {
  const user = userEvent.setup();
  render(
    <SessionHistoryDialog
      value={branchedSegmentsTree}
      busy={false}
      onNavigate={vi.fn()}
      onRestoreDraft={vi.fn()}
      onClose={vi.fn()}
    />,
  );

  await user.keyboard("{ArrowLeft}{ArrowLeft}");
  expect(screen.queryByRole("treeitem", { name: /active continuation/i })).toBeNull();

  await user.type(screen.getByRole("searchbox", { name: /search history/i }), "active");

  expect(screen.getByRole("treeitem", { name: /active continuation/i })).toBeVisible();
  expect(screen.getByRole("treeitem", { name: /active branch terminal/i })).toBeVisible();
  expect(screen.getByRole("treeitem", { name: "user:Active branch" })).not.toHaveAttribute("aria-expanded");
});

it("lets a history row grow with its text instead of truncating it to the viewport", () => {
  render(
    <SessionHistoryDialog
      value={branchedSegmentsTree}
      busy={false}
      onNavigate={vi.fn()}
      onRestoreDraft={vi.fn()}
      onClose={vi.fn()}
    />,
  );

  const text = screen.getByText("Active branch terminal with complete horizontally scrollable text");
  const row = text.closest('[role="treeitem"]');
  expect(row).toHaveClass("min-w-full", "w-max");
  expect(row).not.toHaveStyle({ paddingLeft: "44px" });
  expect(row?.firstElementChild).toHaveClass("shrink-0");
  expect(row?.firstElementChild).toHaveStyle({ width: "36px" });
  expect(text).toHaveClass("shrink-0", "whitespace-nowrap");
  expect(text).not.toHaveClass("truncate");
});

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

  await user.selectOptions(screen.getByRole("combobox", { name: /history filter/i }), "messages");
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

  await user.selectOptions(screen.getByRole("combobox", { name: /history filter/i }), "messages");
  screen.getAllByRole("treeitem")[0]?.focus();
  await user.keyboard("{Home}{ArrowLeft}");
  expect(screen.getAllByRole("treeitem")).toHaveLength(1);

  await user.selectOptions(screen.getByRole("combobox", { name: /history filter/i }), "all");

  expect(screen.getAllByRole("treeitem")).toHaveLength(3);
});

it("applies the three product history filters to their exact entry kinds", async () => {
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

  expect(filter).toHaveValue("user-only");
  expect(screen.getAllByRole("treeitem")).toHaveLength(1);
  expect(screen.getByRole("treeitem")).toHaveTextContent("Question");

  await user.selectOptions(filter, "messages");
  expect(screen.getAllByRole("treeitem")).toHaveLength(2);
  expect(screen.getByText("Answer")).toBeVisible();
  expect(screen.queryByText("Tool output")).toBeNull();
  expect(screen.queryByText("Bash command")).toBeNull();
  expect(screen.queryByText("model-v2")).toBeNull();
  expect(screen.queryByText("Paper")).toBeNull();

  await user.selectOptions(filter, "all");
  expect(screen.getAllByRole("treeitem")).toHaveLength(4);
  expect(screen.getByText("Tool output")).toBeVisible();
  expect(screen.getByText("Bash command")).toBeVisible();
  expect(screen.queryByText("model-v2")).toBeNull();
  expect(screen.queryByText("Compact summary")).toBeNull();
  expect(screen.queryByText("Branch summary")).toBeNull();
  expect(screen.queryByText("Paper")).toBeNull();
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

  await user.selectOptions(screen.getByRole("combobox", { name: /history filter/i }), "messages");
  const items = screen.getAllByRole("treeitem");
  expect(items.map((item) => item.textContent)).toEqual([
    expect.stringContaining("Root question"),
    expect.stringContaining("Main answer"),
    expect.stringContaining("Side answer"),
  ]);
  items[1]?.focus();
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

  await user.selectOptions(screen.getByRole("combobox", { name: /history filter/i }), "messages");
  const current = screen.getAllByRole("treeitem")[1];
  current?.focus();
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
