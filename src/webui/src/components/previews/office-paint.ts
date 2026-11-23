import { officeRasterType } from "./office-images";
import { type OfficeFrame, type OfficeImage, officeCanvasSize } from "./office-protocol";

function cancelled(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException("Preview closed", "AbortError");
}
async function decodeImage(
  part: OfficeImage,
  signal: AbortSignal,
): Promise<{ source: CanvasImageSource; close(): void } | undefined> {
  const { bytes, svgSize } = part;
  const svg =
    part.mime === "image/svg+xml" &&
    svgSize &&
    [svgSize.width, svgSize.height].every((value) => Number.isInteger(value) && value > 0 && value <= 2048) &&
    svgSize.width * svgSize.height <= 4_000_000 &&
    bytes.byteLength <= 2 * 1024 * 1024;
  const mime = svg ? "image/svg+xml" : officeRasterType(bytes);
  if (!mime) return;
  const blob = new Blob([bytes], { type: mime });
  if (!svg && typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob);
    if (signal.aborted) {
      bitmap.close();
      cancelled(signal);
    }
    return { source: bitmap, close: () => bitmap.close() };
  }
  // SVG is a Worker-sanitized, bounded image Blob. Decode in image mode (scripts
  // and external resources disabled), never an iframe/object or app DOM subtree.
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(blob);
    const clear = () => {
      image.onload = image.onerror = null;
      image.removeAttribute("src");
      URL.revokeObjectURL(url);
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      clear();
      reject(new DOMException("Preview closed", "AbortError"));
    };
    image.onload = () => {
      if (
        svg &&
        (image.naturalWidth > 2048 ||
          image.naturalHeight > 2048 ||
          image.naturalWidth * image.naturalHeight > 4_000_000)
      ) {
        clear();
        resolve(undefined);
        return;
      }
      signal.removeEventListener("abort", abort);
      resolve({ source: image, close: clear });
    };
    image.onerror = () => {
      clear();
      resolve(undefined);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    image.src = url;
  });
}

/** Main-thread canvas fallback: only bounded display lists are painted; no Office parsing/layout happens here. */
export function createOfficePainter() {
  const fonts = new Map<string, FontFace>();
  let disposed = false;
  return {
    async paint(canvas: HTMLCanvasElement, frame: OfficeFrame, density: number, signal: AbortSignal) {
      const ownedImages: { close(): void }[] = [];
      const stage = document.createElement("canvas");
      try {
        const size = officeCanvasSize(frame.list.width, frame.list.height, density);
        stage.width = size.width;
        stage.height = size.height;
        const context = stage.getContext("2d");
        const target = canvas.getContext("2d");
        if (!context || !target) return { visual: false, omittedImages: false };
        for (const font of frame.fonts) {
          if (fonts.has(font.family) || typeof FontFace === "undefined" || !document.fonts) continue;
          const face = await new FontFace(font.family, font.bytes, { weight: font.weight, style: font.style }).load();
          if (disposed) throw new DOMException("Preview closed", "AbortError");
          cancelled(signal);
          fonts.set(font.family, face);
          document.fonts.add(face);
        }
        cancelled(signal);
        let omittedImages = false;
        if (frame.kind === "spreadsheet") {
          const { paintDisplayList } = await import("@betteroffice/xlsx");
          cancelled(signal);
          paintDisplayList(context, frame.list, size.scale);
        } else {
          const { paintSlide } = await import("@betteroffice/pptx");
          const images = new Map<string, CanvasImageSource>();
          // Decode serially and release after this frame; no unbounded cross-slide picture cache.
          let decodedPixels = 0;
          for (const image of frame.images) {
            cancelled(signal);
            try {
              const decoded = await decodeImage(image, signal);
              if (!decoded) {
                omittedImages = true;
                continue;
              }
              ownedImages.push(decoded);
              const source = decoded.source as HTMLImageElement | ImageBitmap;
              decodedPixels += source.width * source.height;
              if (decodedPixels > 32_000_000) {
                omittedImages = true;
                break;
              }
              images.set(image.id, decoded.source);
            } catch {
              cancelled(signal);
              omittedImages = true;
            }
          }
          cancelled(signal);
          await paintSlide(context, frame.list, size.scale, 1, {
            resolveImage: (id) => images.get(id) ?? null,
            maxShadowPixels: Math.min(16_000_000, size.width * size.height * 4),
          });
        }
        cancelled(signal);
        if (disposed) throw new DOMException("Preview closed", "AbortError");
        canvas.width = size.width;
        canvas.height = size.height;
        target.drawImage(stage, 0, 0);
        return { visual: true, omittedImages };
      } finally {
        for (const image of ownedImages) image.close();
        stage.width = stage.height = 0;
      }
    },
    dispose() {
      disposed = true;
      for (const face of fonts.values()) document.fonts?.delete(face);
      fonts.clear();
    },
  };
}
