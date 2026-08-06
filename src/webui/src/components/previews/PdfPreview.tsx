import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, Download, FileText, Minus, Plus } from "lucide-react";
import { rawFileUrl } from "../../api";
import { createPdfLoader, type PdfDocumentHandle, type PdfLoader } from "./pdf-runtime";

export interface PdfPreviewProps {
  path: string;
  loader?: PdfLoader;
}

const DEFAULT_LOADER: PdfLoader = createPdfLoader();

const MIN_SCALE = 0.5;
const MAX_SCALE = 4;
const SCALE_STEP = 0.25;

/**
 * Continuous PDF preview: every page renders as a canvas at the selected
 * scale; page navigation, zoom, and download. Page navigation scrolls the
 * continuous viewport to the target canvas and the current page synchronizes
 * on scroll. Loading and render tasks are cancelled on cleanup; failures
 * surface inline with a Retry action.
 */
export function PdfPreview({ path, loader }: PdfPreviewProps) {
  const effectiveLoader = loader ?? DEFAULT_LOADER;
  const [doc, setDoc] = useState<PdfDocumentHandle | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [scale, setScale] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([]);

  useEffect(() => {
    let cancelled = false;
    let loaded: PdfDocumentHandle | null = null;
    setDoc(null);
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
        setDoc(document);
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
    let cancelled = false;
    const tasks: { cancel(): void }[] = [];
    const dpr = globalThis.devicePixelRatio ?? 1;
    (async () => {
      for (let n = 1; n <= doc.numPages; n += 1) {
        if (cancelled) return;
        const page = await doc.page(n);
        if (cancelled) return;
        const viewport = page.viewport(scale, 0);
        const canvas = canvasRefs.current[n - 1];
        if (!canvas) continue;
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.round(viewport.width)}px`;
        canvas.style.height = `${Math.round(viewport.height)}px`;
        const task = page.render({ canvas, viewport, transform: [dpr, 0, 0, dpr, 0, 0] });
        tasks.push(task);
        task.promise.catch((e: unknown) => {
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
  }, [doc, scale]);

  const zoom = (direction: 1 | -1) => {
    setScale((current) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round((current + direction * SCALE_STEP) * 100) / 100)));
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
            Could not load the PDF: {error}
          </p>
          <button
            type="button"
            className="rounded-md border border-v2-grey-200 px-3 py-1 text-[12px] font-medium text-v2-text-text-base transition-colors hover:bg-v2-grey-100"
            onClick={() => setRetryToken((token) => token + 1)}
          >
            Retry
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
          aria-label="PDF controls"
        >
          <button
            type="button"
            className={iconButton}
            aria-label="Previous page"
            title="Previous page"
            disabled={currentPage <= 1}
            onClick={() => navigateToPage(currentPage - 1)}
          >
            <ChevronLeft size={14} aria-hidden />
          </button>
          <input
            aria-label="Current page"
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
            aria-label="Next page"
            title="Next page"
            disabled={currentPage >= numPages}
            onClick={() => navigateToPage(currentPage + 1)}
          >
            <ChevronRight size={14} aria-hidden />
          </button>
          <span className="mx-1 h-4 w-px shrink-0 bg-v2-grey-200" aria-hidden />

          <button type="button" className={iconButton} aria-label="Zoom out" title="Zoom out" onClick={() => zoom(-1)}>
            <Minus size={14} aria-hidden />
          </button>
          <span className="w-11 shrink-0 text-center font-mono text-[11px] text-v2-text-text-muted">{Math.round(scale * 100)}%</span>
          <button type="button" className={iconButton} aria-label="Zoom in" title="Zoom in" onClick={() => zoom(1)}>
            <Plus size={14} aria-hidden />
          </button>
          <span className="mx-1 h-4 w-px shrink-0 bg-v2-grey-200" aria-hidden />

          <a
            href={rawFileUrl(path)}
            download
            className="flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px] font-medium text-v2-text-text-muted transition-colors hover:bg-v2-grey-100 hover:text-v2-text-text-base"
          >
            <Download size={13} aria-hidden />
            <span className="hidden sm:inline">Download PDF</span>
          </a>
        </div>
      </header>
      <div
        ref={scrollRef}
        data-testid="pdf-scroll"
        className="min-h-0 flex-1 overflow-auto bg-v2-grey-100 p-3"
        aria-label="PDF pages"
      >
        {numPages === 0 ? (
          <p className="text-center text-[12px] text-v2-text-text-faint">Loading…</p>
        ) : (
          <div className="flex flex-col items-center gap-3">
            {Array.from({ length: numPages }, (_, index) => (
              <canvas
                key={index}
                ref={(element) => {
                  canvasRefs.current[index] = element;
                }}
                aria-label={`Page ${index + 1}`}
                className="rounded-sm bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]"
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
