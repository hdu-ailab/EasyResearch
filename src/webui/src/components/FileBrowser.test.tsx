// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FileBrowser } from "./FileBrowser";
import { listEntries, readFileContent } from "../api";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, listEntries: vi.fn(), readFileContent: vi.fn() };
});

vi.mock("./previews/pdf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./previews/pdf-runtime")>();
  return { ...actual, createPdfLoader: () => actual.fakePdfLoader({ pages: 1, text: ["rendered pdf text"] }) };
});

describe("FileBrowser", () => {
  beforeEach(() => {
    vi.mocked(listEntries).mockReset();
    vi.mocked(readFileContent).mockReset();
    vi.mocked(listEntries).mockResolvedValue([
      { kind: "file", name: "paper.pdf", path: "/p/paper.pdf" },
      { kind: "file", name: "notes.md", path: "/p/notes.md" },
    ]);
  });

  it("dispatches a PDF file to the PDF preview without fetching bounded text", async () => {
    const user = userEvent.setup();
    render(<FileBrowser root="/p" />);
    await user.click(await screen.findByText("paper.pdf"));
    expect(await screen.findByRole("toolbar", { name: "PDF controls" })).toBeVisible();
    expect(readFileContent).not.toHaveBeenCalled();
  });

  it("fetches bounded text only for non-PDF files", async () => {
    const user = userEvent.setup();
    vi.mocked(readFileContent).mockResolvedValue({
      path: "/p/notes.md",
      content: "# Notes\n\nplan",
      byteCount: 15,
      truncated: false,
      binary: false,
    } as never);
    render(<FileBrowser root="/p" />);
    await user.click(await screen.findByText("notes.md"));
    expect(await screen.findByRole("heading", { name: "Notes" })).toBeVisible();
    expect(readFileContent).toHaveBeenCalledWith("/p/notes.md");
  });
});
