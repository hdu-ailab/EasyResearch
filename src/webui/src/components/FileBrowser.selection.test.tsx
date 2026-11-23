import { act, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { FileBrowser, type FileBrowserHandle } from "./FileBrowser";

vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  listEntries: vi.fn().mockResolvedValue([]),
  readFileContent: vi
    .fn()
    .mockResolvedValue({ path: "/p/a.txt", content: "a", binary: false, truncated: false, byteCount: 1 }),
}));
vi.mock("./previews/FilePreview", () => ({
  FilePreview: (props: { selectionKey: number; selection?: { start: number; end: number } }) => (
    <output data-testid="selection">{JSON.stringify(props)}</output>
  ),
}));
describe("file selection activation", () => {
  it("reuses a path tab and advances its reveal key for every activation", () => {
    const ref = createRef<FileBrowserHandle>();
    render(<FileBrowser ref={ref} root="/p" />);
    act(() => ref.current?.openPath("/p/a.txt", { start: 2, end: 4 }));
    const first = JSON.parse(screen.getByTestId("selection").textContent!);
    act(() => ref.current?.openPath("/p/a.txt", { start: 8, end: 8 }));
    const next = JSON.parse(screen.getByTestId("selection").textContent!);
    expect(next.selection).toEqual({ start: 8, end: 8 });
    expect(next.selectionKey).toBeGreaterThan(first.selectionKey);
    expect(screen.getAllByRole("tab", { name: /a.txt/ })).toHaveLength(1);
  });
});
