import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptTimelineEntryDto } from "../../../web/contracts";
import { getTranscriptEntry } from "../api";
import { TranscriptEntryDialog } from "./TranscriptEntryDialog";

vi.mock("../api", () => ({ getTranscriptEntry: vi.fn() }));
vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), render: vi.fn() } }));

describe("full transcript entry inspector", () => {
  beforeEach(() => vi.mocked(getTranscriptEntry).mockReset());

  it.each(["compaction", "branch-summary"] as const)(
    "renders the complete %s as Markdown with exact scope and identity",
    async (kind) => {
      const summary = `# Stored context\n\n${"Evidence preserved in the complete entry. ".repeat(300)}\n\n- **Last saved fact**\n\nFormula $a^2+b^2=c^2$`;
      vi.mocked(getTranscriptEntry).mockResolvedValue({
        kind,
        entryId: "entry-1",
        timestamp: "2026-11-06T00:00:00Z",
        summary,
      });
      render(<TranscriptEntryDialog sessionId="root-1" childId="child-1" entryId="entry-1" onClose={() => {}} />);
      expect(await screen.findByRole("heading", { name: "Stored context" })).toBeVisible();
      expect(screen.getByText("Last saved fact").tagName).toBe("STRONG");
      expect(document.querySelector(".katex")).toBeTruthy();
      expect(screen.queryByRole("textbox")).toBeNull();
      expect(screen.getByText("entry-1")).toBeVisible();
      expect(screen.getByText("child-1")).toBeVisible();
      expect(getTranscriptEntry).toHaveBeenCalledWith("root-1", "entry-1", "child-1", expect.any(AbortSignal));
    },
  );

  it("aborts obsolete reads and prevents late root content from replacing a child summary", async () => {
    let resolveFirst!: (entry: TranscriptTimelineEntryDto) => void;
    vi.mocked(getTranscriptEntry).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const view = render(<TranscriptEntryDialog sessionId="root" entryId="same" onClose={() => {}} />);
    const signal = vi.mocked(getTranscriptEntry).mock.calls[0]![3]!;
    expect(screen.getByText("Loading…")).toBeVisible();
    vi.mocked(getTranscriptEntry).mockResolvedValueOnce({
      kind: "compaction",
      entryId: "same",
      timestamp: "2026-11-06T00:00:00Z",
      summary: "## Child context",
    });
    view.rerender(<TranscriptEntryDialog sessionId="root" childId="child" entryId="same" onClose={() => {}} />);
    expect(signal.aborted).toBe(true);
    await screen.findByRole("heading", { name: "Child context" });
    await act(async () =>
      resolveFirst({
        kind: "compaction",
        entryId: "same",
        timestamp: "2026-11-06T00:00:00Z",
        summary: "## Obsolete root",
      }),
    );
    expect(screen.queryByRole("heading", { name: "Obsolete root" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Child context" })).toBeVisible();
  });

  it("retains loading and retry errors for a failed typed full-entry read", async () => {
    vi.mocked(getTranscriptEntry).mockRejectedValueOnce(new Error("not available"));
    render(<TranscriptEntryDialog sessionId="root" entryId="entry" onClose={() => {}} />);
    expect(await screen.findByRole("alert")).toBeVisible();
    vi.mocked(getTranscriptEntry).mockResolvedValueOnce({
      kind: "compaction",
      entryId: "entry",
      timestamp: "2026-11-06T00:00:00Z",
      summary: "Recovered **summary**",
    });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByText("summary").tagName).toBe("STRONG"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(getTranscriptEntry).toHaveBeenCalledTimes(2);
  });

  it("keeps the original JSON inspector for non-summary entries", async () => {
    const entry = {
      kind: "message" as const,
      entryId: "m",
      message: { role: "user", content: "original input", timestamp: 1 },
    } satisfies TranscriptTimelineEntryDto;
    vi.mocked(getTranscriptEntry).mockResolvedValue(entry);
    render(<TranscriptEntryDialog sessionId="root" entryId="m" onClose={() => {}} />);
    expect(await screen.findByRole("textbox", { name: "Full entry" })).toHaveValue(JSON.stringify(entry, null, 2));
  });
});
