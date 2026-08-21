import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rawFileUrl } from "../../api";
import { DocxPreview } from "./DocxPreview";
import type { DocxLoader } from "./docx-runtime";

function fakeLoader(options?: { load?: DocxLoader["load"]; render?: DocxLoader["render"] }): DocxLoader {
  return {
    load: options?.load ?? (async () => new Uint8Array([1]).buffer),
    render:
      options?.render ??
      (async (_bytes, body, styles) => {
        body.replaceChildren();
        styles.replaceChildren();
        const paragraph = body.ownerDocument.createElement("p");
        paragraph.textContent = "Rendered manuscript";
        body.append(paragraph);
      }),
  };
}

function stubUrlRevocation(): ReturnType<typeof vi.fn> {
  const revokeObjectURL = vi.fn();
  class StubURL extends URL {}
  Object.defineProperty(StubURL, "revokeObjectURL", { value: revokeObjectURL });
  vi.stubGlobal("URL", StubURL);
  return revokeObjectURL;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("DocxPreview", () => {
  it("loads one document into an isolated iframe and keeps a raw download", async () => {
    render(<DocxPreview path="/p/paper.docx" loader={fakeLoader()} />);

    const toolbar = screen.getByRole("toolbar", { name: "DOCX controls" });
    expect(toolbar).toBeVisible();
    expect(screen.getByRole("link", { name: "Download DOCX" })).toHaveAttribute("href", rawFileUrl("/p/paper.docx"));
    const frame = screen.getByTitle("DOCX document") as HTMLIFrameElement;
    expect(frame).toHaveAttribute("sandbox", "allow-same-origin");
    expect(frame).toHaveClass("invisible");
    expect(frame).not.toHaveClass("hidden");
    await waitFor(() => expect(frame.contentDocument?.body.textContent).toContain("Rendered manuscript"));
    expect(frame).toHaveClass("visible");
    expect(frame.contentDocument?.querySelector('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute(
      "content",
      expect.stringContaining("default-src 'none'"),
    );
    expect(frame.contentDocument?.querySelector("style")?.textContent).toContain("content-visibility: auto");
  });

  it("renders without replacing the iframe document root", async () => {
    render(<DocxPreview path="/p/paper.docx" loader={fakeLoader()} />);
    const frame = screen.getByTitle("DOCX document") as HTMLIFrameElement;
    vi.spyOn(frame.contentDocument!, "replaceChildren").mockImplementation(() => {
      throw new DOMException("Only one element on document allowed", "HierarchyRequestError");
    });

    await waitFor(() => expect(frame.contentDocument?.body.textContent).toContain("Rendered manuscript"));
    expect(frame).toHaveClass("visible");
  });

  it("zooms with CSS without loading or rendering again", async () => {
    const user = userEvent.setup();
    const loader = fakeLoader({ load: vi.fn(async () => new Uint8Array([1]).buffer), render: vi.fn(async () => {}) });
    render(<DocxPreview path="/p/paper.docx" loader={loader} />);
    const frame = screen.getByTitle("DOCX document") as HTMLIFrameElement;
    await waitFor(() => expect(frame.contentDocument?.body.style.zoom).toBe("1"));

    await user.click(screen.getByRole("button", { name: "Zoom in" }));

    expect(screen.getByText("125%")).toBeVisible();
    expect(frame.contentDocument?.body.style.zoom).toBe("1.25");
    expect(loader.load).toHaveBeenCalledOnce();
    expect(loader.render).toHaveBeenCalledOnce();
  });

  it("shows a load failure and retries from a clean document", async () => {
    const user = userEvent.setup();
    const load = vi.fn().mockRejectedValueOnce(new Error("corrupt docx")).mockResolvedValueOnce(new ArrayBuffer(1));
    render(<DocxPreview path="/p/bad.docx" loader={fakeLoader({ load })} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("corrupt docx");

    await user.click(screen.getByRole("button", { name: "Retry" }));

    const frame = screen.getByTitle("DOCX document") as HTMLIFrameElement;
    await waitFor(() => expect(frame.contentDocument?.body.textContent).toContain("Rendered manuscript"));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("releases and clears a partial render before showing its error", async () => {
    const revokeObjectURL = stubUrlRevocation();
    const loader = fakeLoader({
      async render(_bytes, body) {
        const image = body.ownerDocument.createElement("img");
        image.src = "blob:partial-render";
        body.append(image, "partial content");
        throw new Error("render failed");
      },
    });
    render(<DocxPreview path="/p/bad.docx" loader={loader} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("render failed");
    const frame = screen.getByTitle("DOCX document") as HTMLIFrameElement;
    expect(frame.contentDocument?.body.textContent).not.toContain("partial content");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:partial-render");
  });

  it("releases an unattached Blob URL reported before rendering fails", async () => {
    const revokeObjectURL = stubUrlRevocation();
    const renderDocx = (async (
      _bytes: ArrayBuffer,
      _body: HTMLElement,
      _styles: HTMLElement,
      onBlobUrl?: (url: string) => void,
    ) => {
      onBlobUrl?.("blob:detached-font");
      throw new Error("malformed formula");
    }) as DocxLoader["render"];
    render(<DocxPreview path="/p/bad.docx" loader={fakeLoader({ render: renderDocx })} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("malformed formula");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:detached-font");
  });

  it("immediately releases Blob URLs reported after rendering fails", async () => {
    const revokeObjectURL = stubUrlRevocation();
    let reportBlobUrl: ((url: string) => void) | undefined;
    const renderDocx = (async (
      _bytes: ArrayBuffer,
      _body: HTMLElement,
      _styles: HTMLElement,
      onBlobUrl?: (url: string) => void,
    ) => {
      reportBlobUrl = onBlobUrl;
      throw new Error("malformed formula");
    }) as DocxLoader["render"];
    render(<DocxPreview path="/p/bad.docx" loader={fakeLoader({ render: renderDocx })} />);
    await screen.findByRole("alert");

    reportBlobUrl?.("blob:late-image");

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:late-image");
  });

  it("neutralizes unsafe links and revokes rendered Blob URLs on teardown", async () => {
    const revokeObjectURL = stubUrlRevocation();
    const open = vi.fn();
    vi.stubGlobal("open", open);
    const loader = fakeLoader({
      async render(_bytes, body, styles) {
        const empty = body.ownerDocument.createElement("a");
        empty.setAttribute("href", "");
        empty.textContent = "empty";
        const unsafe = body.ownerDocument.createElement("a");
        unsafe.href = "javascript:alert(1)";
        unsafe.textContent = "unsafe";
        const external = body.ownerDocument.createElement("a");
        external.href = "https://example.com/paper";
        external.textContent = "external";
        const image = body.ownerDocument.createElement("img");
        image.src = "blob:docx-image";
        const style = body.ownerDocument.createElement("style");
        style.textContent = "@font-face { src: url('blob:docx-font'); }";
        styles.append(style);
        body.append(empty, unsafe, external, image);
      },
    });
    const { unmount } = render(<DocxPreview path="/p/paper.docx" loader={loader} />);
    const frame = screen.getByTitle("DOCX document") as HTMLIFrameElement;
    await waitFor(() => expect(frame.contentDocument?.body.textContent).toContain("external"));
    const anchors = frame.contentDocument?.querySelectorAll("a");
    expect(anchors?.[0]).not.toHaveAttribute("href");
    expect(anchors?.[1]).not.toHaveAttribute("href");
    expect(anchors?.[2]).toHaveAttribute("data-docx-external-href", "https://example.com/paper");
    const FrameMouseEvent = (frame.contentWindow as Window & typeof globalThis).MouseEvent;
    anchors?.[2]?.dispatchEvent(new FrameMouseEvent("click", { bubbles: true, cancelable: true }));
    expect(open).toHaveBeenCalledWith("https://example.com/paper", "_blank", "noopener,noreferrer");

    unmount();

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:docx-image");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:docx-font");
  });

  it("keeps a late stale render from revoking the current document resources", async () => {
    const revokeObjectURL = stubUrlRevocation();
    let finishFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const renderDocx = vi.fn(async (bytes: ArrayBuffer, body: HTMLElement) => {
      const marker = new Uint8Array(bytes)[0];
      if (marker === 1) await firstPending;
      const image = body.ownerDocument.createElement("img");
      image.src = marker === 1 ? "blob:stale-a" : "blob:current-b";
      body.append(image, marker === 1 ? "stale A" : "current B");
    });
    const loader = fakeLoader({
      async load(path) {
        return new Uint8Array([path.endsWith("a.docx") ? 1 : 2]).buffer;
      },
      render: renderDocx,
    });
    const { rerender } = render(<DocxPreview path="/p/a.docx" loader={loader} />);
    await waitFor(() => expect(renderDocx).toHaveBeenCalledOnce());

    rerender(<DocxPreview path="/p/b.docx" loader={loader} />);
    const frame = screen.getByTitle("DOCX document") as HTMLIFrameElement;
    await waitFor(() => expect(frame.contentDocument?.body.textContent).toContain("current B"));

    finishFirst();

    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:stale-a"));
    expect(revokeObjectURL).not.toHaveBeenCalledWith("blob:current-b");
    expect(frame.contentDocument?.body.textContent).toContain("current B");
  });
});
