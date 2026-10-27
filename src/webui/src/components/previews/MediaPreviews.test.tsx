import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadFileUrl, rawFileUrl } from "../../api";
import { FilePreview } from "./FilePreview";
import { ImagePreview } from "./ImagePreview";
import { VideoPreview } from "./VideoPreview";

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

function resizeImageViewport(image: HTMLImageElement, width: number, height: number, notify = true) {
  const padded = image.parentElement!;
  const viewport = padded.parentElement!;
  padded.style.padding = "12px";
  Object.defineProperties(viewport, {
    clientWidth: { value: width + 24, configurable: true },
    clientHeight: { value: height + 24, configurable: true },
  });
  if (!notify) return;
  const { FakeResizeObserver } = globalThis as unknown as {
    FakeResizeObserver: {
      instances: { __observed: Element[]; __fireEntries(entries: ResizeObserverEntry[]): void }[];
    };
  };
  act(() => {
    for (const observer of FakeResizeObserver.instances) {
      if (observer.__observed.includes(viewport)) {
        observer.__fireEntries([
          {
            target: viewport,
            contentRect: new DOMRect(0, 0, width + 24, height + 24),
            borderBoxSize: [],
            contentBoxSize: [],
            devicePixelContentBoxSize: [],
          },
        ]);
      }
    }
  });
}

function loadedImage(width = 800, height = 600): HTMLImageElement {
  const image = document.querySelector("img")!;
  Object.defineProperties(image, {
    naturalWidth: { value: width, configurable: true },
    naturalHeight: { value: height, configurable: true },
  });
  resizeImageViewport(image, 400, 300);
  vi.spyOn(image, "getBoundingClientRect").mockImplementation(() => {
    const viewport = image.parentElement!.parentElement!;
    const fit = Math.min(1, (viewport.clientWidth - 24) / width, (viewport.clientHeight - 24) / height);
    return {
      width: image.style.width ? Number.parseFloat(image.style.width) : width * fit,
      height: image.style.height ? Number.parseFloat(image.style.height) : height * fit,
    } as DOMRect;
  });
  fireEvent.load(image);
  return image;
}

describe("native image preview", () => {
  it.each([
    [8_000, 6_000],
    [8_000_000_000, 6_000_000_000],
  ])("never enlarges a %dx%d image with Zoom out below the normal minimum", async (width, height) => {
    const user = userEvent.setup();
    render(<ImagePreview path="/p/large.png" />);
    const image = loadedImage(width, height);
    const fitted = image.getBoundingClientRect();
    const zoomOut = screen.getByRole("button", { name: "Zoom out" });
    expect(zoomOut).toBeDisabled();
    await user.click(zoomOut);
    expect(image.getBoundingClientRect()).toEqual(fitted);
    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(image.getBoundingClientRect().width).toBeGreaterThan(fitted.width);
    expect(zoomOut).toBeEnabled();
    await user.click(zoomOut);
    expect(image.getBoundingClientRect().width).toBeCloseTo(fitted.width);
    expect(image.getBoundingClientRect().height).toBeCloseTo(fitted.height);
    expect(zoomOut).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Fit image" }));
    expect(image.style.width).toBe("");
    expect(image.getBoundingClientRect()).toEqual(fitted);
    expect(zoomOut).toBeDisabled();
  });

  it("updates bounds when the pane resizes in both fit and manual zoom modes", async () => {
    const user = userEvent.setup();
    render(<ImagePreview path="/p/large.png" />);
    const image = loadedImage(8_000, 6_000);
    const zoomOut = screen.getByRole("button", { name: "Zoom out" });
    expect(zoomOut).toBeDisabled();

    resizeImageViewport(image, 1_600, 1_200);
    expect(zoomOut).toBeEnabled();
    await user.click(zoomOut);
    expect(image).toHaveStyle({ width: "800px", height: "600px" });
    expect(zoomOut).toBeDisabled();

    resizeImageViewport(image, 600, 450);
    expect(zoomOut).toBeEnabled();
    await user.click(zoomOut);
    expect(image).toHaveStyle({ width: "600px", height: "450px" });
    expect(zoomOut).toBeDisabled();

    // Enlarging the pane must not clamp an existing smaller manual image upward.
    resizeImageViewport(image, 1_600, 1_200);
    await user.click(zoomOut);
    expect(image).toHaveStyle({ width: "600px", height: "450px" });
    expect(zoomOut).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Fit image" }));
    expect(image.getBoundingClientRect().width).toBe(1_600);
    expect(zoomOut).toBeEnabled();

    resizeImageViewport(image, 240, 180);
    expect(image.getBoundingClientRect().width).toBe(240);
    expect(zoomOut).toBeDisabled();
    resizeImageViewport(image, 0, 0);
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeDisabled();
    resizeImageViewport(image, 400, 300);
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeEnabled();
    expect(zoomOut).toBeDisabled();
  });

  it("rechecks fitted geometry if a click precedes resize-observer delivery", async () => {
    const user = userEvent.setup();
    render(<ImagePreview path="/p/large.png" />);
    const image = loadedImage(8_000, 6_000);
    const zoomOut = screen.getByRole("button", { name: "Zoom out" });
    resizeImageViewport(image, 4_000, 3_000);
    expect(zoomOut).toBeEnabled();

    resizeImageViewport(image, 400, 300, false);
    const fitted = image.getBoundingClientRect();
    await user.click(zoomOut);
    expect(image.getBoundingClientRect()).toEqual(fitted);
    expect(zoomOut).toBeDisabled();
  });

  it("streams the image, zooms from its fitted size, and resets without reading bytes", async () => {
    const user = userEvent.setup();
    render(<ImagePreview path="/p/figure.png" revision={4} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading");
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeDisabled();
    const image = loadedImage();
    expect(image).toHaveAttribute("src", rawFileUrl("/p/figure.png", 4));
    expect(image).toHaveStyle({ maxWidth: "100%", maxHeight: "100%" });
    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(image).toHaveStyle({ width: "600px", height: "450px", maxWidth: "none" });
    expect(screen.getByText("75%")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(image).toHaveStyle({ width: "400px", height: "300px" });
    await user.click(screen.getByRole("button", { name: "Fit image" }));
    expect(image).toHaveStyle({ maxWidth: "100%", maxHeight: "100%" });
    expect(image.style.width).toBe("");
    expect(screen.getByRole("button", { name: "Fit image" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("link", { name: "Download image" })).toHaveAttribute(
      "href",
      downloadFileUrl("/p/figure.png"),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows retry/download after failure and separates retry from watcher revisions", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ImagePreview path="/p/figure.png" revision={0} />);
    const failed = document.querySelector("img")!;
    fireEvent.error(failed);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not display");
    await user.click(screen.getByRole("button", { name: "Retry image" }));
    const retry = loadedImage();
    const retrySource = retry.getAttribute("src");
    expect(retrySource).not.toBe(failed.getAttribute("src"));
    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    rerender(<ImagePreview path="/p/figure.png" revision={1} />);
    const updated = loadedImage();
    expect(updated).not.toBe(retry);
    expect(updated.getAttribute("src")).not.toBe(retrySource);
    expect(updated.style.width).toBe("");
    fireEvent.error(retry);
    expect(screen.queryByRole("alert")).toBeNull();
    rerender(<ImagePreview path="/p/other.png" revision={1} />);
    expect(screen.getByRole("status")).toBeVisible();
    expect(document.querySelector("img")).toHaveAttribute("src", rawFileUrl("/p/other.png", 1));
  });

  it("treats SVG as an image URL instead of mounting the supplied text markup", () => {
    render(
      <FilePreview
        path="/p/figure.SVG"
        textFile={{
          path: "/p/figure.SVG",
          content: '<svg id="authored-svg"><script>bad()</script></svg>',
          binary: false,
          truncated: false,
          byteCount: 60,
        }}
        onOpenFile={() => {}}
      />,
    );
    expect(document.querySelector("img")).toHaveAttribute("src", rawFileUrl("/p/figure.SVG", 0));
    expect(document.querySelector("#authored-svg")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("native video preview", () => {
  it("uses native playback/seek/fullscreen controls, metadata only, and an attachment download", () => {
    render(<FilePreview path="/p/clip.MP4" revision={3} textFile={null} onOpenFile={() => {}} />);
    const video = screen.getByLabelText("Video preview") as HTMLVideoElement;
    expect(video).toHaveAttribute("src", rawFileUrl("/p/clip.MP4", 3));
    expect(video.controls).toBe(true);
    expect(video.playsInline).toBe(true);
    expect(video.preload).toBe("metadata");
    expect(video.autoplay).toBe(false);
    expect(video).not.toHaveAttribute("controlslist");
    fireEvent.loadedMetadata(video);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("link", { name: "Download video" })).toHaveAttribute(
      "href",
      downloadFileUrl("/p/clip.MP4"),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("pauses and releases the old media on retry, revision, path switch and unmount", async () => {
    const user = userEvent.setup();
    const { rerender, unmount } = render(<VideoPreview path="/p/clip.mp4" revision={0} />);
    const first = screen.getByLabelText("Video preview") as HTMLVideoElement;
    const pause = vi.spyOn(first, "pause");
    const load = vi.spyOn(first, "load");
    fireEvent.error(first);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not play");
    await user.click(screen.getByRole("button", { name: "Retry video" }));
    const retry = screen.getByLabelText("Video preview") as HTMLVideoElement;
    expect(pause).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledOnce();
    expect(first).not.toHaveAttribute("src");
    expect(retry).not.toBe(first);
    const retrySource = retry.getAttribute("src");
    rerender(<VideoPreview path="/p/clip.mp4" revision={1} />);
    const updated = screen.getByLabelText("Video preview");
    expect(retry).not.toHaveAttribute("src");
    expect(updated).not.toHaveAttribute("src", retrySource);
    fireEvent.loadedMetadata(updated);
    fireEvent.error(retry);
    expect(screen.queryByRole("alert")).toBeNull();
    rerender(<VideoPreview path="/p/next.mp4" revision={0} />);
    expect(updated).not.toHaveAttribute("src");
    const next = screen.getByLabelText("Video preview");
    expect(next).toHaveAttribute("src", rawFileUrl("/p/next.mp4", 0));
    unmount();
    expect(next).not.toHaveAttribute("src");
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(4);
    expect(HTMLMediaElement.prototype.load).toHaveBeenCalledTimes(4);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("shared file download toolbar", () => {
  it.each(["notes.txt", "paper.md", "data.bin"])(
    "keeps one download available for %s even before text arrives",
    (name) => {
      const path = `/p/${name}`;
      const { rerender } = render(<FilePreview path={path} textFile={null} onOpenFile={() => {}} />);
      expect(screen.getByRole("link", { name: "Download file" })).toHaveAttribute("href", downloadFileUrl(path));
      rerender(
        <FilePreview
          path={path}
          textFile={{
            path,
            content: name.endsWith("md") ? "# Paper" : "content",
            binary: name.endsWith("bin"),
            truncated: false,
            byteCount: 10,
          }}
          onOpenFile={() => {}}
        />,
      );
      expect(screen.getAllByRole("link", { name: "Download file" })).toHaveLength(1);
      expect(screen.getByRole("link", { name: "Download file" })).toHaveAttribute("download", name);
    },
  );
});
