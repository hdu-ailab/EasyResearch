import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveFileReferences } from "../../api";
import { ViewActivityProvider } from "../../view-activity";
import { MarkdownBlock } from "../MarkdownBlock";
import { parseMarkdownBlocks } from "./parse";
import { prepareMarkdownBlocks } from "./render";
import { TranscriptFileReferences } from "./TranscriptFileReferences";

vi.mock("../../api", async (original) => ({
  ...(await original<typeof import("../../api")>()),
  resolveFileReferences: vi.fn(),
}));
beforeEach(() => {
  vi.mocked(resolveFileReferences)
    .mockReset()
    .mockImplementation(async (_id, references) => ({
      references: references.map((reference) => ({
        reference,
        paths: reference === "object.value" ? [] : [`/p/${reference}`],
        truncated: false,
      })),
    }));
});

describe("transcript file reference interaction", () => {
  it("opens encoded leading-hash filenames and preserves double-encoded percent bytes", async () => {
    const open = vi.fn();
    render(
      <TranscriptFileReferences sessionId="root" cwd="/p" revision={0} onOpen={open}>
        <MarkdownBlock text="[Hash](%23report.txt) [Percent](%2523report.txt) [Fragment](#report.txt)" />
      </TranscriptFileReferences>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Hash" }));
    await waitFor(() => expect(open).toHaveBeenCalledWith("/p/#report.txt", undefined));
    fireEvent.click(screen.getByRole("button", { name: "Percent" }));
    await waitFor(() => expect(open).toHaveBeenCalledWith("/p/%23report.txt", undefined));
    expect(screen.queryByRole("button", { name: "Fragment" })).toBeNull();
  });
  it("releases the final candidate when Markdown unmounts while its provider remains mounted", async () => {
    vi.mocked(resolveFileReferences).mockImplementation(() => new Promise<never>(() => {}));
    const view = (shown: boolean) => (
      <TranscriptFileReferences sessionId="root" cwd="/p" revision={0} onOpen={vi.fn()}>
        {shown ? <MarkdownBlock text="`README`" /> : null}
      </TranscriptFileReferences>
    );
    const { rerender } = render(view(true));
    await waitFor(() => expect(resolveFileReferences).toHaveBeenCalledTimes(1));
    const signal = vi.mocked(resolveFileReferences).mock.calls[0]![2]!;
    rerender(view(false));
    expect(signal.aborted).toBe(true);
  });
  it("retains explicit UNC activation without automatically probing the share", async () => {
    const open = vi.fn();
    render(
      <TranscriptFileReferences sessionId="root" cwd="C:\\p" revision={0} onOpen={open}>
        <MarkdownBlock text={String.raw`[Shared](<\\\\server\\share\\report.txt>)`} />
      </TranscriptFileReferences>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Shared" }));
    expect(open).toHaveBeenCalledWith(String.raw`\\server\share\report.txt`, undefined);
    expect(resolveFileReferences).not.toHaveBeenCalled();
  });
  it("ignores a late explicit resolution after the view changes workspace", async () => {
    let complete!: (value: Awaited<ReturnType<typeof resolveFileReferences>>) => void;
    vi.mocked(resolveFileReferences).mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const open = vi.fn();
    const view = (cwd: string) => (
      <TranscriptFileReferences sessionId="root" cwd={cwd} revision={0} onOpen={open}>
        <MarkdownBlock text="[Open](README)" />
      </TranscriptFileReferences>
    );
    const { rerender } = render(view("/old"));
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(resolveFileReferences).toHaveBeenCalledTimes(1));
    rerender(view("/new"));
    await act(async () =>
      complete({ references: [{ reference: "README", paths: ["/old/README"], truncated: false }] }),
    );
    expect(open).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("retains a live batch after StrictMode effect replay", async () => {
    render(
      <StrictMode>
        <TranscriptFileReferences sessionId="root" cwd="/p" revision={0} onOpen={vi.fn()}>
          <MarkdownBlock text="`README`" />
        </TranscriptFileReferences>
      </StrictMode>,
    );
    expect(await screen.findByRole("button", { name: "README" })).toBeTruthy();
    expect(vi.mocked(resolveFileReferences).mock.calls.at(-1)?.[2]?.aborted).toBe(false);
  });
  it("batch-validates automatic candidates with Worker/fallback parity and keeps HTTP links external", async () => {
    const source =
      "`README` `object.value` `python scripts/run.py` [missing](missing.unknown#L7-L9) [web](https://example.com) <span>README `README`</span>";
    const blocks = prepareMarkdownBlocks(await parseMarkdownBlocks(source));
    const open = vi.fn();
    render(
      <TranscriptFileReferences sessionId="root" cwd="/p" revision={0} onOpen={open}>
        <section data-testid="worker">{blocks.map((block) => block.node)}</section>
        <section data-testid="fallback">
          <MarkdownBlock text={source} />
        </section>
      </TranscriptFileReferences>,
    );
    await waitFor(() => expect(screen.getAllByRole("button", { name: "README" })).toHaveLength(2));
    expect(resolveFileReferences).toHaveBeenCalledTimes(1);
    expect(vi.mocked(resolveFileReferences).mock.calls[0]?.[1].sort()).toEqual(["README", "object.value"]);
    for (const id of ["worker", "fallback"]) {
      const section = within(screen.getByTestId(id));
      expect(section.queryByRole("button", { name: "object.value" })).toBeNull();
      expect(section.getByRole("link", { name: "web" })).toHaveAttribute("href", "https://example.com");
      fireEvent.click(section.getByRole("button", { name: "missing" }));
      await waitFor(() => expect(open).toHaveBeenCalledWith("/p/missing.unknown", { start: 7, end: 9 }));
    }
  });
  it("requires an explicit choice for ambiguity and incomplete unique results", async () => {
    vi.mocked(resolveFileReferences).mockImplementation(async (_id, references) => ({
      references: references.map((reference) => ({
        reference,
        paths: reference === "ambiguous" ? ["/p/a/README", "/p/b/README"] : ["/p/a/README"],
        truncated: reference === "partial",
      })),
    }));
    const open = vi.fn();
    render(
      <TranscriptFileReferences sessionId="root" cwd="/p" revision={0} onOpen={open}>
        <MarkdownBlock text="[a](ambiguous) [b](partial)" />
      </TranscriptFileReferences>,
    );
    fireEvent.click(screen.getByRole("button", { name: "a" }));
    const dialog = await screen.findByRole("dialog", { name: "Choose a file" });
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "/p/b/README" }));
    expect(open).toHaveBeenCalledWith("/p/b/README", undefined);
    fireEvent.click(screen.getByRole("button", { name: "b" }));
    expect(await screen.findByText(/Search was incomplete/)).toBeTruthy();
    expect(open).toHaveBeenCalledTimes(1);
  });
  it("skips streaming and network candidates, invalidates existence and aborts hidden-view work", async () => {
    const open = vi.fn();
    const view = (visible: boolean, revision: number, streaming = false) => (
      <ViewActivityProvider visible={visible} interactive={visible}>
        <TranscriptFileReferences sessionId="root" cwd="/p" revision={revision} onOpen={open}>
          <MarkdownBlock text={"`README` `\\\\host\\share\\file.txt`"} streaming={streaming} />
        </TranscriptFileReferences>
      </ViewActivityProvider>
    );
    const { rerender } = render(view(true, 0, true));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(resolveFileReferences).not.toHaveBeenCalled();
    rerender(view(true, 0));
    await screen.findByRole("button", { name: "README" });
    expect(vi.mocked(resolveFileReferences).mock.calls[0]?.[1]).toEqual(["README"]);
    vi.mocked(resolveFileReferences).mockImplementation(async (_id, references) => ({
      references: references.map((reference) => ({ reference, paths: [], truncated: false })),
    }));
    rerender(view(true, 1));
    await waitFor(() => expect(screen.queryByRole("button", { name: "README" })).toBeNull());
    await waitFor(() => expect(resolveFileReferences).toHaveBeenCalledTimes(2));
    vi.mocked(resolveFileReferences).mockImplementation(() => new Promise<never>(() => {}));
    rerender(view(true, 2));
    await waitFor(() => expect(resolveFileReferences).toHaveBeenCalledTimes(3));
    const pendingSignal = vi.mocked(resolveFileReferences).mock.calls.at(-1)?.[2];
    rerender(view(false, 2));
    expect(pendingSignal?.aborted).toBe(true);
  });
});
