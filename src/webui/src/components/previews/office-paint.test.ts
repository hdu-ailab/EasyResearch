import { afterEach, describe, expect, it, vi } from "vitest";
import { createOfficePainter } from "./office-paint";
import type { OfficeFrame } from "./office-protocol";

const emptySlide = (): OfficeFrame => ({
  kind: "presentation",
  list: { contractVersion: 2, width: 960, height: 540, primitives: [] },
  images: [],
  text: "",
  notes: "",
  omittedImages: false,
  truncated: false,
  fonts: [],
});
function context() {
  return new Proxy<Record<string, unknown>>(
    { drawImage: vi.fn() },
    {
      get: (target, property) => target[String(property)] ?? (() => {}),
      set: (target, property, value) => {
        target[String(property)] = value;
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Office canvas ownership", () => {
  it("paints sanitized SVG through a local image Blob and releases it after canvas rasterization", async () => {
    const target = document.createElement("canvas");
    const targetContext = context();
    const stageContext = context();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
      return this === target ? targetContext : stageContext;
    } as unknown as typeof target.getContext);
    const created: LocalImage[] = [];
    class LocalImage {
      width = 320;
      height = 180;
      naturalWidth = 320;
      naturalHeight = 180;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      source = "";
      constructor() {
        created.push(this);
      }
      set src(value: string) {
        this.source = value;
        queueMicrotask(() => this.onload?.());
      }
      removeAttribute = vi.fn();
    }
    class BlobURL extends URL {
      static override createObjectURL = vi.fn(() => "blob:safe-svg");
      static override revokeObjectURL = vi.fn();
    }
    vi.stubGlobal("Image", LocalImage);
    vi.stubGlobal("URL", BlobURL);
    const bitmapDecoder = vi.fn();
    vi.stubGlobal("createImageBitmap", bitmapDecoder);
    const frame = emptySlide();
    if (frame.kind !== "presentation") throw new Error("wrong frame");
    frame.images.push({
      id: "ppt/media/vector.svg",
      mime: "image/svg+xml",
      svgSize: { width: 320, height: 180 },
      bytes: new TextEncoder().encode(
        '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="blue"/></svg>',
      ),
    });
    frame.list.primitives.push({
      kind: "image",
      objectId: 1,
      name: "Vector",
      x: 0,
      y: 0,
      w: 320,
      h: 180,
      assetId: "ppt/media/vector.svg",
    });
    const painter = createOfficePainter();
    await expect(painter.paint(target, frame, 1, new AbortController().signal)).resolves.toEqual({
      visual: true,
      omittedImages: false,
    });
    expect(bitmapDecoder).not.toHaveBeenCalled();
    expect(created[0]?.source).toBe("blob:safe-svg");
    expect(BlobURL.createObjectURL).toHaveBeenCalledWith(expect.objectContaining({ type: "image/svg+xml" }));
    expect(vi.mocked(stageContext.drawImage).mock.calls[0]?.[0]).toBe(created[0]);
    expect(targetContext.drawImage).toHaveBeenCalled();
    expect(created[0]?.removeAttribute).toHaveBeenCalledWith("src");
    expect(BlobURL.revokeObjectURL).toHaveBeenCalledWith("blob:safe-svg");
    expect(document.querySelector("svg, object, iframe")).toBeNull();
    painter.dispose();
  });

  it("revokes an SVG image still decoding when its view is closed", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context());
    let image: PendingImage | undefined;
    class PendingImage {
      onload = null;
      onerror = null;
      src = "";
      removeAttribute = vi.fn();
      constructor() {
        image = this;
      }
    }
    class BlobURL extends URL {
      static override createObjectURL = vi.fn(() => "blob:pending-svg");
      static override revokeObjectURL = vi.fn();
    }
    vi.stubGlobal("Image", PendingImage);
    vi.stubGlobal("URL", BlobURL);
    const frame = emptySlide();
    if (frame.kind !== "presentation") throw new Error("wrong frame");
    frame.images.push({
      id: "ppt/media/vector.svg",
      mime: "image/svg+xml",
      svgSize: { width: 320, height: 180 },
      bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"/>'),
    });
    const controller = new AbortController();
    const painter = createOfficePainter();
    const paint = painter.paint(document.createElement("canvas"), frame, 1, controller.signal);
    const failed = expect(paint).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(image?.src).toBe("blob:pending-svg"));
    controller.abort();
    await failed;
    expect(image?.removeAttribute).toHaveBeenCalledWith("src");
    expect(BlobURL.revokeObjectURL).toHaveBeenCalledOnce();
    painter.dispose();
  });

  it("returns a functional text fallback when a native canvas context is unavailable", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const painter = createOfficePainter();
    await expect(
      painter.paint(document.createElement("canvas"), emptySlide(), 1, new AbortController().signal),
    ).resolves.toEqual({ visual: false, omittedImages: false });
    painter.dispose();
  });

  it("discards an aborted late decode, closes its bitmap and never commits stale pixels", async () => {
    const target = document.createElement("canvas");
    const targetContext = context();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
      return this === target ? targetContext : context();
    } as unknown as typeof target.getContext);
    let resolve: ((bitmap: ImageBitmap) => void) | undefined;
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(
        () =>
          new Promise<ImageBitmap>((done) => {
            resolve = done;
          }),
      ),
    );
    const frame = emptySlide();
    if (frame.kind !== "presentation") throw new Error("wrong frame");
    const bytes = new Uint8Array(24);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x89504e47);
    view.setUint32(4, 0x0d0a1a0a);
    view.setUint32(16, 1);
    view.setUint32(20, 1);
    frame.images.push({ id: "ppt/media/a.png", bytes, mime: "image/png" });
    const controller = new AbortController();
    const painter = createOfficePainter();
    const paint = painter.paint(target, frame, 1, controller.signal);
    const failed = expect(paint).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(resolve).toBeDefined());
    controller.abort();
    const bitmap = { width: 1, height: 1, close: vi.fn() } as unknown as ImageBitmap;
    resolve?.(bitmap);
    await failed;
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(targetContext.drawImage).not.toHaveBeenCalled();
    painter.dispose();
  });

  it("removes file-owned FontFaces on close and refuses a late font registration", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context());
    const fontSet = { add: vi.fn(), delete: vi.fn() };
    Object.defineProperty(document, "fonts", { configurable: true, value: fontSet });
    let finish: (() => void) | undefined;
    class FakeFace {
      load = () =>
        new Promise<this>((resolve) => {
          finish = () => resolve(this);
        });
    }
    vi.stubGlobal("FontFace", FakeFace);
    const frame = emptySlide();
    frame.fonts.push({ family: "Owned-Font", weight: "400", style: "normal", bytes: new Uint8Array([1]) });
    const painter = createOfficePainter();
    const paint = painter.paint(document.createElement("canvas"), frame, 1, new AbortController().signal);
    const failed = expect(paint).rejects.toMatchObject({ name: "AbortError" });
    painter.dispose();
    finish?.();
    await failed;
    expect(fontSet.add).not.toHaveBeenCalled();
  });
});
