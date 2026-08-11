import { AlertTriangle, ChevronLeft, ChevronRight, Download, FileText, Minus, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { rawFileUrl } from "../../api";
import { useI18n } from "../../i18n/useI18n";
import { createPdfLoader, type PdfDocumentHandle, type PdfLoader } from "./pdf-runtime";

export interface PdfPreviewProps {
  path: string;
  loader?: PdfLoader;
}

const DEFAULT_LOADER: PdfLoader = createPdfLoader();

const MIN_SCALE = 0.5;
const MAX_SCALE = 4;
const SCALE_STEP = 0.25;

/** Pages rendered as canvas bitmaps on each side of the current page. */
const RENDER_BUFFER = 2;

/**
 * Continuous PDF preview with viewport-virtualized rendering: only the pages
 * around the current page (±RENDER_BUFFER) hold canvas bitmaps; pages outside
 * the window keep their placeholder geometry (style width/height) so the
 * scroll height is stable, while their bitmap is released (canvas.width = 0).
 * Page navigation, zoom, and download. Page navigation scrolls the continuous
 * viewport to the target canvas and the current page synchronizes on scroll.
 * Loading and render tasks are cancelled on cleanup; failures surface inline
 * with a Retry action.
 */
export function PdfPreview({ path, loader }: PdfPreviewProps) {
  const { t } = useI18n();
  const effectiveLoader = loader ?? DEFAULT_LOADER;
  const [doc, setDoc] = useState<PdfDocumentHandle | null>(null);
  const [pageSizes, setPageSizes] = useState<{ width: number; height: number }[]>([]);
  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [scale, setScale] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([]);
  const renderedPages = useRef(new Map<number, number>());

  useEffect(() => {
    void retryToken;
    let cancelled = false;
    let loaded: PdfDocumentHandle | null = null;
    setDoc(null);
    setPageSizes([]);
    setNumPages(0);
    setCurrentPage(1);
    setError(null);
    effectiveLoader
      .load({ url: rawFileUrl(path) })
      .then(async (document) => {
        if (cancelled) {
          document.destroy();
          return;
        }
        loaded = document;
        const sizes: { width: number; height: number }[] = [];
        for (let n = 1; n <= document.numPages; n += 1) {
          const page = await document.page(n);
          const base = page.viewport(1, 0);
          sizes.push({ width: base.width, height: base.height });
        }
        if (cancelled) return;
        setDoc(document);
        setPageSizes(sizes);
        setNumPages(document.numPages);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
      loaded?.destroy();
    };
  }, [effectiveLoader, path, retryToken]);

  useEffect(() => {
    if (!doc) return;
    const windowStart = Math.max(1, currentPage - RENDER_BUFFER);
    const windowEnd = Math.min(numPages, currentPage + RENDER_BUFFER);
    const dpr = globalThis.devicePixelRatio ?? 1;
    for (let n = 1; n <= numPages; n += 1) {
      const canvas = canvasRefs.current[n - 1];
      if (!canvas) continue;
      const base = pageSizes[n - 1];
      canvas.style.width = `${Math.round((base?.width ?? 0) * scale)}px`;
      canvas.style.height = `${Math.round((base?.height ?? 0) * scale)}px`;
      if (n < windowStart || n > windowEnd) {
        if (canvas.width !== 0) canvas.width = 0;
        renderedPages.current.delete(n);
      }
    }
    let cancelled = false;
    const tasks: { cancel(): void }[] = [];
    (async () => {
      for (let n = windowStart; n <= windowEnd; n += 1) {
        if (cancelled) return;
        const canvas = canvasRefs.current[n - 1];
        if (!canvas) continue;
        if (renderedPages.current.get(n) === scale && canvas.width > 0) continue;
        const page = await doc.page(n);
        if (cancelled) return;
        const viewport = page.viewport(scale, 0);
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.round(viewport.width)}px`;
        canvas.style.height = `${Math.round(viewport.height)}px`;
        const task = page.render({ canvas, viewport, transform: [dpr, 0, 0, dpr, 0, 0] });
        tasks.push(task);
        task.promise
          .then(() => {
            if (!cancelled) renderedPages.current.set(n, scale);
          })
          .catch((e: unknown) => {
            if (!cancelled) setError(e instanceof Error ? e.message : String(e));
          });
      }
    })().catch((e: unknown) => {
      if (!cancelled) setError(e instanceof Error ? e.message : String(e));
    });
    return () => {
      cancelled = true;
      for (const task of tasks) task.cancel();
    };
  }, [doc, scale, currentPage, pageSizes, numPages]);

  const zoom = (direction: 1 | -1) => {
    setScale((current) =>
      Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round((current + direction * SCALE_STEP) * 100) / 100)),
    );
  };

  const scrollToCanvas = useCallback((page: number) => {
    const canvas = canvasRefs.current[page - 1];
    if (!canvas) return;
    if (typeof canvas.scrollIntoView === "function") {
      canvas.scrollIntoView({ block: "start" });
      return;
    }
    const container = scrollRef.current;
    if (container && typeof container.scrollTo === "function") {
      container.scrollTo({ top: Math.max(0, canvas.offsetTop - 12) });
    }
  }, []);

  const navigateToPage = useCallback(
    (page: number, { scroll = true } = {}) => {
      const clamped = Math.max(1, Math.min(numPages, page));
      setCurrentPage(clamped);
      if (scroll) scrollToCanvas(clamped);
    },
    [numPages, scrollToCanvas],
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const containerRect = el.getBoundingClientRect();
      const threshold = containerRect.height * 0.35;
      let nearest = 1;
      for (let i = 0; i < numPages; i += 1) {
        const canvas = canvasRefs.current[i];
        if (!canvas) break;
        if (canvas.getBoundingClientRect().top - containerRect.top <= threshold) nearest = i + 1;
        else break;
      }
      setCurrentPage((prev) => (prev === nearest ? prev : nearest));
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, [numPages]);

  if (error) {
    return (
      <div className="flex h-full min-w-0 flex-col">
        <header className="flex shrink-0 items-center gap-2 border-b border-v2-grey-200 px-3 py-1.5">
          <FileText size={14} className="shrink-0 text-v2-icon-icon-muted" aria-hidden />
          <span className="shrink-0 font-mono text-[11px] text-v2-text-text-faint">PDF</span>
        </header>
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4">
          <AlertTriangle size={20} className="shrink-0 text-v2-status-error" aria-hidden />
          <p className="max-w-[420px] text-center text-[13px] text-v2-text-text-muted" role="alert">
            {t("preview.pdf.loadError").replace("{error}", error)}
          </p>
          <button
            type="button"
            className="rounded-md border border-v2-grey-200 px-3 py-1 text-[12px] font-medium text-v2-text-text-base transition-colors hover:bg-v2-grey-100"
            onClick={() => setRetryToken((token) => token + 1)}
          >
            {t("preview.retry")}
          </button>
        </div>
      </div>
    );
  }

  const iconButton =
    "flex size-7 shrink-0 items-center justify-center rounded-md text-v2-icon-icon-muted transition-colors hover:bg-v2-grey-100 hover:text-v2-icon-icon-base disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent";

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      <header className="flex shrink-0 items-center gap-1 border-b border-v2-grey-200 px-2 py-1.5">
        <div
          className="ml-auto flex min-w-0 flex-1 flex-wrap items-center gap-1"
          role="toolbar"
          aria-label={t("preview.pdf.controls")}
        >
          <button
            type="button"
            className={iconButton}
            aria-label={t("preview.pdf.previous")}
            title={t("preview.pdf.previous")}
            disabled={currentPage <= 1}
            onClick={() => navigateToPage(currentPage - 1)}
          >
            <ChevronLeft size={14} aria-hidden />
          </button>
          <input
            aria-label={t("preview.pdf.currentPage")}
            type="number"
            min={1}
            max={numPages}
            value={currentPage}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (Number.isInteger(next) && next >= 1 && next <= numPages) navigateToPage(next);
            }}
            className="w-11 shrink-0 rounded-md border border-v2-grey-200 bg-v2-background-bg-base px-1 py-0.5 text-center font-mono text-[12px] text-v2-text-text-base outline-none focus:border-v2-blue-600"
          />
          <span className="shrink-0 whitespace-nowrap font-mono text-[12px] text-v2-text-text-faint">
            {numPages > 0 ? `${currentPage} / ${numPages}` : "– / –"}
          </span>
          <button
            type="button"
            className={iconButton}
            aria-label={t("preview.pdf.next")}
            title={t("preview.pdf.next")}
            disabled={currentPage >= numPages}
            onClick={() => navigateToPage(currentPage + 1)}
          >
            <ChevronRight size={14} aria-hidden />
          </button>
          <span className="mx-1 h-4 w-px shrink-0 bg-v2-grey-200" aria-hidden />

          <button
            type="button"
            className={iconButton}
            aria-label={t("preview.pdf.zoomOut")}
            title={t("preview.pdf.zoomOut")}
            onClick={() => zoom(-1)}
          >
            <Minus size={14} aria-hidden />
          </button>
          <span className="w-11 shrink-0 text-center font-mono text-[11px] text-v2-text-text-muted">
            {Math.round(scale * 100)}%
          </span>
          <button
            type="button"
            className={iconButton}
            aria-label={t("preview.pdf.zoomIn")}
            title={t("preview.pdf.zoomIn")}
            onClick={() => zoom(1)}
          >
            <Plus size={14} aria-hidden />
          </button>
          <span className="mx-1 h-4 w-px shrink-0 bg-v2-grey-200" aria-hidden />

          <a
            href={rawFileUrl(path)}
            download
            className="flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px] font-medium text-v2-text-text-muted transition-colors hover:bg-v2-grey-100 hover:text-v2-text-text-base"
          >
            <Download size={13} aria-hidden />
            <span className="hidden sm:inline">{t("preview.pdf.download")}</span>
          </a>
        </div>
      </header>
      <section
        ref={scrollRef}
        data-testid="pdf-scroll"
        className="min-h-0 flex-1 overflow-auto bg-v2-grey-100 p-3"
        aria-label={t("preview.pdf.pages")}
      >
        {numPages === 0 ? (
          <p className="text-center text-[12px] text-v2-text-text-faint">{t("files.loading")}</p>
        ) : (
          <div className="flex flex-col items-center gap-3">
            {Array.from({ length: numPages }, (_, index) => (
              <canvas
                // biome-ignore lint/suspicious/noArrayIndexKey: PDF pages have stable document-order identities.
                key={`pdf-page-${index + 1}`}
                ref={(element) => {
                  canvasRefs.current[index] = element;
                }}
                aria-label={t("preview.pdf.pageLabel").replace("{page}", String(index + 1))}
                className="rounded-sm bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]"
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
