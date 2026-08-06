/**
 * PDF runtime abstraction. Components depend only on these interfaces plus a
 * `PdfLoader`, so tests can inject `fakePdfLoader` and keep pdfjs-dist out of
 * jsdom. The production loader lazily imports pdfjs-dist (only on the first
 * `load`) and points the worker at the packaged worker bundle.
 */

export interface PdfViewport {
  scale: number;
  rotation: number;
  width: number;
  height: number;
}

export interface PdfRenderTask {
  promise: Promise<unknown>;
  cancel: () => void;
}

/** Affine transform passed to pdfjs; used to rasterize at the device pixel ratio. */
export type PdfRenderTransform = [number, number, number, number, number, number];

export interface PdfRenderOptions {
  canvas: HTMLCanvasElement;
  viewport: PdfViewport;
  transform?: PdfRenderTransform;
}

export interface PdfPageHandle {
  viewport(scale: number, rotation: number): PdfViewport;
  render(options: PdfRenderOptions): PdfRenderTask;
  textContent(): Promise<string>;
}

export interface PdfDocumentHandle {
  numPages: number;
  page(n: number): Promise<PdfPageHandle>;
  destroy(): void;
}

export interface PdfLoader {
  load(source: { url: string }): Promise<PdfDocumentHandle>;
}

/** Deterministic fake loader used by component tests. */
export interface FakePdfRenderCall {
  canvas: HTMLCanvasElement;
  viewport: PdfViewport;
  transform?: PdfRenderTransform;
}

export interface FakePdfLoaderOptions {
  pages: number;
  text: string[];
  /** Optional sink that records every page render call for assertions. */
  renderLog?: FakePdfRenderCall[];
}

export function fakePdfLoader(options: FakePdfLoaderOptions): PdfLoader {
  return {
    async load() {
      const { pages, text } = options;
      return {
        numPages: pages,
        async page(n: number): Promise<PdfPageHandle> {
          const index = n - 1;
          return {
            viewport(scale: number, rotation: number): PdfViewport {
              const rotated = rotation % 180 !== 0;
              const width = (rotated ? 140 : 100) * scale;
              const height = (rotated ? 100 : 140) * scale;
              return { scale, rotation, width, height };
            },
            render(renderOptions: PdfRenderOptions) {
              options.renderLog?.push({
                canvas: renderOptions.canvas,
                viewport: renderOptions.viewport,
                transform: renderOptions.transform,
              });
              return { promise: Promise.resolve(undefined), cancel: () => {} };
            },
            async textContent(): Promise<string> {
              return text[index] ?? "";
            },
          };
        },
        destroy() {},
      };
    },
  };
}

let pdfjsModule: typeof import("pdfjs-dist") | null = null;

async function loadPdfJs(): Promise<typeof import("pdfjs-dist")> {
  if (!pdfjsModule) {
    const mod = await import("pdfjs-dist");
    mod.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).href;
    pdfjsModule = mod;
  }
  return pdfjsModule;
}

/** Production loader backed by pdfjs-dist with the bundled worker. */
export function createPdfLoader(): PdfLoader {
  return {
    async load(source) {
      const { getDocument } = await loadPdfJs();
      const loadingTask = getDocument({ url: source.url });
      const doc = await loadingTask.promise;
      return {
        numPages: doc.numPages,
        async page(n: number): Promise<PdfPageHandle> {
          const page = await doc.getPage(n);
          return {
            viewport(scale: number, rotation: number): PdfViewport {
              const vp = page.getViewport({ scale, rotation });
              return { scale, rotation, width: vp.width, height: vp.height };
            },
            render({ canvas, viewport, transform }): PdfRenderTask {
              const vp = page.getViewport({ scale: viewport.scale, rotation: viewport.rotation });
              const task = transform
                ? page.render({ canvas, viewport: vp, transform })
                : page.render({ canvas, viewport: vp });
              return { promise: task.promise, cancel: () => task.cancel() };
            },
            async textContent(): Promise<string> {
              const content = await page.getTextContent();
              return content.items
                .map((item) => ("str" in item ? (item as { str: string }).str : ""))
                .join(" ");
            },
          };
        },
        destroy() {
          loadingTask.destroy().catch(() => {});
        },
      };
    },
  };
}
