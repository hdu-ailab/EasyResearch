import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilePreview } from "./FilePreview";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: '<svg role="img" aria-label="Rendered graph" />' }),
  },
}));

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function text(path: string, content: string) {
  return { path, content, byteCount: content.length, binary: false, truncated: false };
}

describe("basic file dispatch", () => {
  it.each(["mp3", "wav", "oga", "flac", "weba"])(
    "streams %s audio without fetching text or full buffers",
    (extension) => {
      const path = `/p/sound.${extension}`;
      const { unmount } = render(<FilePreview path={path} revision={3} textFile={null} onOpenFile={() => {}} />);
      const audio = screen.getByLabelText("Audio preview");
      expect(audio.tagName).toBe("AUDIO");
      expect(audio).toHaveAttribute("controls");
      expect(audio).toHaveAttribute("preload", "metadata");
      const url = new URL(audio.getAttribute("src")!, "http://localhost");
      expect(url.pathname).toBe("/api/file/raw");
      expect(url.searchParams.get("path")).toBe(path);
      fireEvent.error(audio);
      expect(screen.getByRole("alert")).toHaveTextContent(/could not play/i);
      expect(screen.getByRole("link", { name: "Download audio" })).toHaveAttribute("download", `sound.${extension}`);
      unmount();
      expect(audio).not.toHaveAttribute("src");
      expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledOnce();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("releases and retries failed audio, rejecting old events after revision", async () => {
    const user = userEvent.setup();
    const props = { path: "/p/sound.opus", textFile: null, onOpenFile() {} };
    const { rerender } = render(<FilePreview {...props} revision={0} />);
    const old = screen.getByLabelText("Audio preview");
    fireEvent.error(old);
    await user.click(screen.getByRole("button", { name: "Retry audio" }));
    const retry = screen.getByLabelText("Audio preview");
    expect(retry).not.toBe(old);
    expect(old).not.toHaveAttribute("src");
    const url = retry.getAttribute("src");
    rerender(<FilePreview {...props} revision={1} />);
    const current = screen.getByLabelText("Audio preview");
    expect(current).not.toHaveAttribute("src", url);
    fireEvent.loadedMetadata(current);
    fireEvent.error(retry);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it.each(["webm", "mov", "ogv", "mkv"])("routes %s to native video", (extension) => {
    render(<FilePreview path={`/p/movie.${extension}`} textFile={null} onOpenFile={() => {}} />);
    expect(screen.getByLabelText("Video preview").tagName).toBe("VIDEO");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["tiff", "heic"])("keeps native decode failure and download for %s", (extension) => {
    render(<FilePreview path={`/p/picture.${extension}`} textFile={null} onOpenFile={() => {}} />);
    fireEvent.error(screen.getByRole("img"));
    expect(screen.getByRole("alert")).toBeVisible();
    expect(screen.getByRole("link", { name: "Download image" })).toBeVisible();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["md", "mdx", "svg", "csv", "mermaid"])(
    "reveals %s source for a new line selection and permits returning to preview",
    async (extension) => {
      const user = userEvent.setup();
      const path = `/p/file.${extension}`;
      const content = extension === "csv" ? "Name,Value\nfirst,1\nsecond,2" : "# Heading\nfirst\nsecond";
      const props = { path, textFile: text(path, content), onOpenFile() {} };
      const { rerender } = render(<FilePreview {...props} selection={{ start: 2, end: 2 }} selectionKey={1} />);
      expect(screen.getByRole("button", { name: "Source" })).toHaveAttribute("aria-pressed", "true");
      await user.click(screen.getByRole("button", { name: "Preview" }));
      expect(screen.getByRole("button", { name: "Preview" })).toHaveAttribute("aria-pressed", "true");
      rerender(<FilePreview {...props} selection={{ start: 3, end: 3 }} selectionKey={2} />);
      expect(screen.getByRole("button", { name: "Source" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getAllByRole("link", { name: /download/i })).toHaveLength(1);
    },
  );

  it("renders MDX as inert Markdown without executing JSX", () => {
    const path = "/p/file.mdx";
    render(
      <FilePreview
        path={path}
        textFile={text(path, '# Safe heading\n\n<script>window.evil=1</script>\n\n{alert("never")}')}
        onOpenFile={() => {}}
      />,
    );
    expect(screen.getByRole("heading", { name: "Safe heading" })).toBeVisible();
    expect(document.querySelector("script")).toBeNull();
  });

  it("routes Mermaid files through the existing strict diagram renderer and refreshes source", async () => {
    const { default: mermaid } = await import("mermaid");
    const path = "/p/graph.mmd";
    const { rerender } = render(
      <FilePreview path={path} textFile={text(path, "graph TD; A-->B")} onOpenFile={() => {}} />,
    );
    expect(await screen.findByRole("img", { name: "Rendered graph" })).toBeVisible();
    expect(mermaid.render).toHaveBeenCalledWith(expect.any(String), "graph TD; A-->B");
    rerender(<FilePreview path={path} revision={1} textFile={text(path, "graph TD; C-->D")} onOpenFile={() => {}} />);
    await waitFor(() => expect(mermaid.render).toHaveBeenCalledWith(expect.any(String), "graph TD; C-->D"));
  });

  it("keeps SVG in an image decoder and reveals literal source with the selected line", async () => {
    const user = userEvent.setup();
    const path = "/p/figure.svg";
    const content = '<svg>\n<script id="unsafe-svg">evil()</script>\n</svg>';
    const props = { path, textFile: text(path, content), onOpenFile() {} };
    const { rerender } = render(<FilePreview {...props} />);
    const image = screen.getByRole("img");
    expect(image.tagName).toBe("IMG");
    fireEvent.error(image);
    expect(screen.getByRole("alert")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Source" }));
    expect(screen.getByText('<script id="unsafe-svg">evil()</script>')).toBeVisible();
    expect(document.querySelector("#unsafe-svg")).toBeNull();
    rerender(<FilePreview {...props} selection={{ start: 2, end: 2 }} selectionKey={4} />);
    expect(document.querySelector("mark")?.textContent).toBe('<script id="unsafe-svg">evil()</script>');
  });

  it("labels malformed and bounded tables while keeping source and download available", async () => {
    const user = userEvent.setup();
    const path = "/p/file.csv";
    const { rerender } = render(
      <FilePreview path={path} textFile={text(path, 'a,b\n"unterminated')} onOpenFile={() => {}} />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/malformed/i);
    await user.click(screen.getByRole("button", { name: "Source" }));
    expect(screen.getByText('"unterminated')).toBeVisible();
    rerender(<FilePreview path={path} revision={1} textFile={text(path, "x,".repeat(300))} onOpenFile={() => {}} />);
    expect(screen.getByText(/table preview limit/i)).toBeVisible();
    expect(screen.getAllByRole("columnheader").length).toBeLessThan(300);
    expect(screen.getByRole("link", { name: "Download file" })).toBeVisible();
  });

  it("pages semantic tables, preserves quoted cell text when copying and refreshes data", async () => {
    const user = userEvent.setup();
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const path = "/p/file.csv";
    const content = `Name,Value\n"a,b","line 1\nline 2"\n${Array.from({ length: 130 }, (_, i) => `row${i},${i}`).join("\n")}`;
    const { rerender } = render(<FilePreview path={path} textFile={text(path, content)} onOpenFile={() => {}} />);
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row").length).toBeLessThan(100);
    const cell = within(table).getByText("a,b").closest("td")!;
    await user.click(within(cell).getByRole("button"));
    expect(write).toHaveBeenCalledWith("a,b");
    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(within(table).queryByText("a,b")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Previous page" }));
    expect(within(table).getByText("a,b")).toBeVisible();
    rerender(
      <FilePreview path={path} revision={1} textFile={text(path, "new,value\nupdated,7")} onOpenFile={() => {}} />,
    );
    expect(screen.getByRole("cell", { name: /updated/ })).toBeVisible();
  });
});
