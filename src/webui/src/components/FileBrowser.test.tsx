import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listEntries, readFileContent } from "../api";
import { FileBrowser } from "./FileBrowser";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, listEntries: vi.fn(), readFileContent: vi.fn() };
});

vi.mock("./previews/pdf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./previews/pdf-runtime")>();
  return { ...actual, createPdfLoader: () => actual.fakePdfLoader({ pages: 1 }) };
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

  it("renders the tree toggle as the first tab-bar element with aria-expanded=true", async () => {
    render(<FileBrowser root="/p" />);
    const button = await screen.findByRole("button", { name: "Toggle file tree" });
    expect(button).toHaveAttribute("aria-expanded", "true");
    const slot = button.parentElement;
    const tablist = slot?.parentElement;
    expect(tablist?.getAttribute("role")).toBe("tablist");
    expect(tablist?.firstElementChild).toBe(slot);
  });

  it("colors the toggle when the tree is open and clears it when collapsed", async () => {
    const user = userEvent.setup();
    render(<FileBrowser root="/p" />);
    const button = await screen.findByRole("button", { name: "Toggle file tree" });
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(button).toHaveClass("bg-v2-background-bg-layer-2");

    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).not.toHaveClass("bg-v2-background-bg-layer-2");
  });

  it("collapses the tree on click while keeping the preview visible, and expands again", async () => {
    const user = userEvent.setup();
    render(<FileBrowser root="/p" />);
    const button = await screen.findByRole("button", { name: "Toggle file tree" });
    const tree = await screen.findByRole("tree", { name: "Project files tree" });
    const container = tree.closest("[class*='w-[240px]']");
    expect(container).not.toBeNull();
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByText("paper.pdf")).toBeVisible();

    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(container).toHaveClass("hidden");
    expect(screen.getByText("Open a file")).toBeVisible();

    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(container).not.toHaveClass("hidden");
    expect(screen.getByText("paper.pdf")).toBeVisible();
  });
});
