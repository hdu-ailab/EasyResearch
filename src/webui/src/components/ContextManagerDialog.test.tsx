import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { ApiError } from "../api/transport";
import { contextPreview, contextSnapshot } from "../testing/context";
import { ViewActivityProvider } from "../view-activity";
import { ContextManagerDialog } from "./ContextManagerDialog";

vi.mock("../api", () => ({
  getSessionContext: vi.fn(),
  getContextItemText: vi.fn(),
  previewContextEdits: vi.fn(),
  applyContextEdits: vi.fn(),
}));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function mount(props: Partial<Parameters<typeof ContextManagerDialog>[0]> = {}) {
  return render(<ContextManagerDialog sessionId="s1" refreshSignal="1" busy={false} onClose={vi.fn()} {...props} />);
}
async function selectSegment() {
  const overview = await screen.findByRole("group", { name: "Overview" });
  fireEvent.click(within(overview).getByRole("button", { name: /^Evidence checked/ }));
  return screen.getByRole("group", { name: "Details" });
}
async function fold() {
  await selectSegment();
  fireEvent.click(screen.getByRole("button", { name: "Fold segment tool outputs" }));
  await waitFor(() => expect(api.previewContextEdits).toHaveBeenCalled());
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getSessionContext).mockResolvedValue(contextSnapshot());
  vi.mocked(api.previewContextEdits).mockResolvedValue(contextPreview());
  vi.mocked(api.applyContextEdits).mockResolvedValue(contextSnapshot("r2"));
  vi.mocked(api.getContextItemText).mockImplementation(async (_id, revision, itemId, view, offset = 0) => ({
    revision,
    itemId,
    view,
    offset,
    text: offset ? "second page" : "first page",
    totalChars: 21,
    nextOffset: offset ? null : 10,
  }));
});

describe("Context manager", () => {
  it.each([
    {
      actions: [
        { itemId: "call", action: "delete" },
        { itemId: "result", action: "delete" },
      ],
      change: "delete",
      label: "Pending deletion",
    },
    { actions: [{ itemId: "result", action: "fold" }], change: "fold", label: "Pending fold" },
    {
      actions: [
        { itemId: "thought", action: "delete" },
        { itemId: "result", action: "fold" },
      ],
      change: "mixed",
      label: "Pending fold and deletion",
    },
  ] as const)(
    "keeps $change overview indicators accurate after collapsing item details",
    async ({ actions, change, label }) => {
      vi.mocked(api.previewContextEdits).mockResolvedValue(contextPreview([...actions]));
      mount();
      const details = await selectSegment();
      fireEvent.click(within(details).getByRole("button", { name: /^Tool call/ }));
      fireEvent.click(screen.getByRole("button", { name: "Delete linked pair" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Apply changes" })).toBeEnabled());
      fireEvent.click(screen.getByRole("button", { name: "Collapse" }));
      const overview = screen.getByRole("group", { name: "Overview" });
      const block = within(overview).getByRole("button", { name: /^Evidence checked/ });
      expect(block).toHaveAttribute("data-change", change);
      expect(within(block).getByText(label)).toBeInTheDocument();
      expect(within(overview).getByRole("button", { name: /^Later assistant interval/ })).not.toHaveAttribute(
        "data-change",
      );
    },
  );

  it("wraps reverse Tab from compression through only mounted disclosure controls, including after reopen", async () => {
    const user = userEvent.setup();
    const view = mount({ onCompact: vi.fn().mockResolvedValue(undefined) });
    await screen.findByRole("group", { name: "Overview" });
    const first = screen.getByRole("button", { name: "Compress whole session" });
    expect(first).toHaveFocus();
    await user.tab({ shift: true });
    const disclosure = screen.getByRole("button", { name: "Select a segment" });
    expect(disclosure).toHaveFocus();
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("group", { name: "Select a segment" })).toBeNull();
    for (let attempt = 0; attempt < 2; attempt++) {
      await user.click(disclosure);
      expect(disclosure).toHaveAttribute("aria-expanded", "true");
      const choices = screen.getByRole("group", { name: "Select a segment" });
      const last = within(choices).getAllByRole("button").at(-1);
      act(() => first.focus());
      await user.tab({ shift: true });
      expect(last).toHaveFocus();
      await user.click(disclosure);
      expect(screen.queryByRole("group", { name: "Select a segment" })).toBeNull();
      act(() => first.focus());
      await user.tab({ shift: true });
      expect(disclosure).toHaveFocus();
    }
    view.unmount();
    mount({ onCompact: vi.fn().mockResolvedValue(undefined) });
    await screen.findByRole("group", { name: "Overview" });
    expect(screen.getByRole("button", { name: "Compress whole session" })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Select a segment" })).toHaveFocus();
    expect(screen.queryByRole("group", { name: "Select a segment" })).toBeNull();
  });
  it("allows a newly inspected busy compaction snapshot to be previewed while Apply stays disabled", async () => {
    mount({ busy: true, compacting: true });
    await fold();
    expect(await screen.findByText(/1,000 → 607 tokens/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Apply changes" })).toBeDisabled();
  });
  it("reconciles signals arriving during Apply instead of accepting its older response as the latest view", async () => {
    const pending = deferred<ReturnType<typeof contextSnapshot>>();
    vi.mocked(api.applyContextEdits).mockReturnValueOnce(pending.promise);
    const view = mount();
    await fold();
    await waitFor(() => expect(screen.getByRole("button", { name: "Apply changes" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    await waitFor(() => expect(api.applyContextEdits).toHaveBeenCalledTimes(1));
    vi.mocked(api.getSessionContext).mockResolvedValue({ ...contextSnapshot("r3"), totalTokens: 777 });
    view.rerender(<ContextManagerDialog sessionId="s1" refreshSignal="2" busy={false} onClose={vi.fn()} />);
    await act(async () => pending.resolve(contextSnapshot("r2")));
    expect(await screen.findByText("777 tokens")).toBeInTheDocument();
    expect(api.getSessionContext).toHaveBeenCalledTimes(2);
  });

  it("keeps an explicit stale fence when native Apply partly changes the projection before failing", async () => {
    vi.mocked(api.applyContextEdits).mockRejectedValueOnce(new ApiError(500, { code: "CONTEXT_UNAVAILABLE" }));
    const view = mount();
    await fold();
    await waitFor(() => expect(screen.getByRole("button", { name: "Apply changes" })).toBeEnabled());
    vi.mocked(api.getSessionContext).mockResolvedValue(contextSnapshot("partially-applied"));
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Context changed");
    expect(screen.getByRole("button", { name: "Reset changes" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Apply changes" })).toBeDisabled();
    view.rerender(<ContextManagerDialog sessionId="s1" refreshSignal="2" busy={false} onClose={vi.fn()} />);
    await waitFor(() => expect(api.getSessionContext).toHaveBeenCalledTimes(3));
    expect(screen.getByRole("alert")).toHaveTextContent("Refresh and reselect");
  });

  it("does not mix late raw pages across selection or original/current views", async () => {
    const pending = deferred<Awaited<ReturnType<typeof api.getContextItemText>>>();
    vi.mocked(api.getContextItemText).mockReturnValueOnce(pending.promise);
    mount();
    const details = await selectSegment();
    fireEvent.click(within(details).getByRole("button", { name: /^read tool output/ }));
    await waitFor(() => expect(api.getContextItemText).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Current / staged preview" }));
    expect(await screen.findByRole("textbox", { name: "Current / staged preview" })).toHaveValue("first page");
    await act(async () =>
      pending.resolve({
        revision: "r1",
        itemId: "result",
        view: "original",
        text: "obsolete original",
        offset: 0,
        totalChars: 17,
        nextOffset: null,
      }),
    );
    expect(screen.getByRole("textbox")).toHaveValue("first page");
    expect(vi.mocked(api.getContextItemText).mock.calls[0]?.[5]?.aborted).toBe(true);
    fireEvent.click(within(details).getByRole("button", { name: /^Assistant reply/ }));
    await waitFor(() =>
      expect(api.getContextItemText).toHaveBeenLastCalledWith(
        "s1",
        "r1",
        "answer",
        "original",
        0,
        expect.any(AbortSignal),
      ),
    );
  });

  it("reports an unknown cache baseline and debounces successive scope changes", async () => {
    vi.mocked(api.previewContextEdits).mockResolvedValue({
      ...contextPreview(),
      cache: { basis: "unchanged-prefix", hitRate: null, reusableTokens: null },
    });
    mount();
    await selectSegment();
    fireEvent.click(screen.getByRole("button", { name: "Fold segment tool outputs" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete segment" }));
    expect(await screen.findByText("Unknown")).toBeInTheDocument();
    await waitFor(() => expect(api.previewContextEdits).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.previewContextEdits).mock.calls[0]?.[1].edits).toEqual([
      { target: "segment", id: "first", action: "fold" },
      { target: "segment", id: "first", action: "delete" },
    ]);
  });
  it("requests existing whole-session compression and fences edits during native queued/running state", async () => {
    const onCompact = vi.fn().mockResolvedValue({ state: "queued" });
    const view = mount({ onCompact });
    await fold();
    fireEvent.click(screen.getByRole("button", { name: "Compress whole session" }));
    await waitFor(() => expect(onCompact).toHaveBeenCalledTimes(1));
    view.rerender(
      <ContextManagerDialog sessionId="s1" refreshSignal="2" busy compacting onCompact={onCompact} onClose={vi.fn()} />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Context changed");
    expect(screen.getByRole("button", { name: "Apply changes" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Compacting" })).toBeDisabled();
    expect(api.applyContextEdits).not.toHaveBeenCalled();
  });
  it("drills from one used-context strip to typed details and lazy read-only paged text", async () => {
    mount();
    const overview = await screen.findByRole("group", { name: "Overview" });
    expect(screen.queryByRole("heading", { name: "Details" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Original text" })).toBeNull();
    expect(api.getContextItemText).not.toHaveBeenCalled();
    expect(within(overview).getAllByRole("button")).toHaveLength(contextSnapshot().segments.length);
    const details = await selectSegment();
    expect(api.getContextItemText).not.toHaveBeenCalled();
    fireEvent.click(within(details).getByRole("button", { name: /^read tool output/ }));
    const raw = screen.getByRole("region", { name: "Original text" });
    const text = await within(raw).findByRole("textbox");
    expect(text).toHaveValue("first page");
    expect(text).toHaveAttribute("readonly");
    expect(within(raw).queryByRole("button", { name: /Delete|Fold/ })).toBeNull();
    fireEvent.click(within(raw).getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(text).toHaveValue("first pagesecond page"));
    expect(api.getContextItemText).toHaveBeenLastCalledWith(
      "s1",
      "r1",
      "result",
      "original",
      10,
      expect.any(AbortSignal),
    );
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    fireEvent.click(within(raw).getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("first pagesecond page"));
  });

  it("keeps fixed context inspectable and uneditable; keyboard focus shows bounded preview", async () => {
    const onClose = vi.fn();
    mount({ onClose });
    const overview = await screen.findByRole("group", { name: "Overview" });
    const system = within(overview).getByRole("button", { name: /^System prompt/ });
    vi.spyOn(system, "getBoundingClientRect").mockReturnValue(new DOMRect(20, 100, 100, 40));
    act(() => system.focus());
    expect(screen.getByRole("tooltip")).toHaveTextContent("Private system instruction");
    fireEvent.keyDown(system, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    const user = userEvent.setup();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("textbox")).toHaveValue("first page");
    expect(screen.queryByRole("group", { name: "Selected message" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Selected assistant segment" })).toBeNull();
    expect(api.getContextItemText).toHaveBeenCalledWith("s1", "r1", "system", "original", 0, expect.any(AbortSignal));
  });

  it("stages only the chosen interval and uses server totals/cache without changing strip widths", async () => {
    mount();
    await fold();
    expect(api.previewContextEdits).toHaveBeenLastCalledWith(
      "s1",
      { revision: "r1", edits: [{ target: "segment", id: "first", action: "fold" }] },
      expect.any(AbortSignal),
    );
    expect(await screen.findByText(/1,000 → 607 tokens/)).toBeInTheDocument();
    expect(screen.getByText("32.1%")).toBeInTheDocument();
    const overview = screen.getByRole("group", { name: "Overview" });
    expect(within(overview).getByRole("button", { name: /^Evidence checked/ }).style.flexGrow).toBe("70");
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    await waitFor(() =>
      expect(api.applyContextEdits).toHaveBeenCalledWith(
        "s1",
        { revision: "r1", edits: [{ target: "segment", id: "first", action: "fold" }] },
        expect.any(AbortSignal),
      ),
    );
    expect(await screen.findByText("No pending changes")).toBeInTheDocument();
  });

  it("uses item scope and server-resolved pairing, leaving other items and intervals alone", async () => {
    vi.mocked(api.previewContextEdits).mockResolvedValue(
      contextPreview([
        { itemId: "call", action: "delete" },
        { itemId: "result", action: "delete" },
      ]),
    );
    mount();
    const details = await selectSegment();
    fireEvent.click(within(details).getByRole("button", { name: /^Tool call/ }));
    fireEvent.click(screen.getByRole("button", { name: "Delete linked pair" }));
    await waitFor(() =>
      expect(api.previewContextEdits).toHaveBeenCalledWith(
        "s1",
        { revision: "r1", edits: [{ target: "item", id: "call", action: "delete" }] },
        expect.any(AbortSignal),
      ),
    );
    await waitFor(() =>
      expect(within(details).getByRole("button", { name: /^read tool output/ })).toHaveAttribute(
        "data-change",
        "delete",
      ),
    );
    expect(within(details).getByRole("button", { name: /^Assistant reply/ })).not.toHaveAttribute("data-change");
    fireEvent.click(screen.getByRole("button", { name: "Current / staged preview" }));
    expect(await screen.findByRole("textbox")).toHaveValue(
      "This message will be removed from model context. Original history is preserved.",
    );
    expect(api.getContextItemText).not.toHaveBeenCalledWith("s1", "r1", "call", "current", 0, expect.anything());
  });

  it("allows busy preview but blocks Apply, then fences a changed revision until Refresh/reselection", async () => {
    const view = mount({ busy: true });
    await fold();
    expect(screen.getByRole("button", { name: "Apply changes" })).toBeDisabled();
    vi.mocked(api.getSessionContext).mockResolvedValue(contextSnapshot("r2"));
    view.rerender(<ContextManagerDialog sessionId="s1" refreshSignal="2" busy={false} onClose={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Context changed");
    expect(screen.getByRole("button", { name: "Apply changes" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByText("No pending changes")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Details" })).toBeNull();
  });

  it("retains a valid draft after apply failure and permits retry after reconciliation", async () => {
    vi.mocked(api.applyContextEdits).mockRejectedValueOnce(new ApiError(500, { code: "CONTEXT_UNAVAILABLE" }));
    mount();
    await fold();
    await waitFor(() => expect(screen.getByRole("button", { name: "Apply changes" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("pending changes are retained");
    await waitFor(() => expect(screen.getByRole("button", { name: "Apply changes" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    await waitFor(() => expect(api.applyContextEdits).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.applyContextEdits).mock.calls[1]?.[1].edits).toEqual([
      { target: "segment", id: "first", action: "fold" },
    ]);
  });

  it("rejects late preview responses after a newer edit and cancels view reads on close", async () => {
    const old = deferred<ReturnType<typeof contextPreview>>();
    vi.mocked(api.previewContextEdits).mockReturnValueOnce(old.promise);
    const view = mount();
    await fold();
    const firstSignal = vi.mocked(api.previewContextEdits).mock.calls[0]?.[2];
    fireEvent.click(screen.getByRole("button", { name: "Delete segment" }));
    await waitFor(() => expect(api.previewContextEdits).toHaveBeenCalledTimes(2));
    expect(firstSignal?.aborted).toBe(true);
    await act(async () => old.resolve({ ...contextPreview(), afterTokens: 99999 }));
    expect(screen.queryByText(/99,999/)).toBeNull();
    const details = screen.getByRole("group", { name: "Details" });
    fireEvent.click(within(details).getByRole("button", { name: /^read tool output/ }));
    await waitFor(() => expect(api.getContextItemText).toHaveBeenCalled());
    const signal = vi.mocked(api.getContextItemText).mock.calls[0]?.[5];
    view.unmount();
    expect(signal?.aborted).toBe(true);
  });

  it("refreshes from existing signals, rejects old GETs and keeps retained drafts across inactive views", async () => {
    const old = deferred<ReturnType<typeof contextSnapshot>>();
    vi.mocked(api.getSessionContext).mockReturnValueOnce(old.promise);
    const view = mount();
    view.rerender(<ContextManagerDialog sessionId="s1" refreshSignal="2" busy={false} onClose={vi.fn()} />);
    await selectSegment();
    await act(async () => old.resolve({ ...contextSnapshot("old"), totalTokens: 987654 }));
    expect(screen.queryByText(/987,654/)).toBeNull();
    view.unmount();
    const retained = render(
      <ViewActivityProvider visible interactive>
        <ContextManagerDialog sessionId="s1" refreshSignal="1" busy={false} onClose={vi.fn()} />
      </ViewActivityProvider>,
    );
    await fold();
    retained.rerender(
      <ViewActivityProvider visible={false} interactive={false}>
        <ContextManagerDialog sessionId="s1" refreshSignal="2" busy={false} onClose={vi.fn()} />
      </ViewActivityProvider>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    retained.rerender(
      <ViewActivityProvider visible interactive>
        <ContextManagerDialog sessionId="s1" refreshSignal="2" busy={false} onClose={vi.fn()} />
      </ViewActivityProvider>,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Apply changes" })).toBeEnabled());
  });
});
