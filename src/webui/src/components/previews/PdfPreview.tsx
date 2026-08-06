import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Download,
  FileText,
  Maximize,
  Minus,
  Plus,
  RotateCw,
  Search,
} from "lucide-react";
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
 * scale/rotation; page navigation, zoom, fit-width (via ResizeObserver),
 * rotation, case-insensitive text search with match navigation, and download.
 * Loading and render tasks are cancelled on cleanup.
 */
export function PdfPreview({ path, loader }: PdfPreviewProps) {
  const effectiveLoader = loader ?? DEFAULT_LOADER;
  const [doc, setDoc] = useState<PdfDocumentHandle | null>(null);
  const [pageTexts, setPageTexts] = useState<string[]>([]);
  const [pageSizes, setPageSizes] = useState<{ width: number; height: number }[]>([]);
  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [fitWidth, setFitWidth] = useState(false);
  const [query, setQuery] = useState("");
  const [activeMatch, setActiveMatch] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      setContainerWidth(entry ? entry.contentRect.width : null);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let loaded: PdfDocumentHandle | null = null;
    setDoc(null);
    setPageTexts([]);
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
        const texts: string[] = [];
        const sizes: { width: number; height: number }[] = [];
        for (let n = 1; n <= document.numPages; n += 1) {
          const page = await document.page(n);
          texts.push(await page.textContent());
          const base = page.viewport(1, 0);
          sizes.push({ width: base.width, height: base.height });
        }
        if (cancelled) return;
        setDoc(document);
        setPageTexts(texts);
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
    let cancelled = false;
    const tasks: { cancel(): void }[] = [];
    (async () => {
      for (let n = 1; n <= doc.numPages; n += 1) {
        if (cancelled) return;
        const page = await doc.page(n);
        if (cancelled) return;
        const base = pageSizes[n - 1];
        const effectiveScale =
          fitWidth && containerWidth !== null && base
            ? containerWidth / (rotation % 180 === 0 ? base.width : base.height)
            : scale;
        const viewport = page.viewport(effectiveScale, rotation);
        const canvas = canvasRefs.current[n - 1];
        if (!canvas) continue;
        const dpr = globalThis.devicePixelRatio ?? 1;
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.round(viewport.width)}px`;
        canvas.style.height = `${Math.round(viewport.height)}px`;
        const task = page.render({ canvas, viewport });
        tasks.push(task);
        task.promise.catch(() => {});
      }
    })();
    return () => {
      cancelled = true;
      for (const task of tasks) task.cancel();
    };
  }, [doc, scale, rotation, fitWidth, containerWidth, pageSizes]);

  const matches = useMemo(() => {
    if (!query.trim()) return [];
    const needle = query.trim().toLowerCase();
    return pageTexts
      .map((text, index) => (text.toLowerCase().includes(needle) ? index + 1 : 0))
      .filter((page): page is number => page > 0);
  }, [query, pageTexts]);

  useEffect(() => {
    setActiveMatch(1);
  }, [query]);

  const shownMatch = matches.length === 0 ? 0 : Math.min(activeMatch, matches.length);

  const zoom = (direction: 1 | -1) => {
    setScale((current) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round((current + direction * SCALE_STEP) * 100) / 100)));
  };

  const goToMatch = (direction: 1 | -1) => {
    if (matches.length === 0) return;
    const next = direction === 1 ? Math.min(activeMatch + 1, matches.length) : Math.max(activeMatch - 1, 1);
    setActiveMatch(next);
    const page = matches[next - 1];
    if (page !== undefined) setCurrentPage(page);
  };

  if (error) {
    return (
      <div className="flex h-full min-w-0 flex-col">
        <header className="flex shrink-0 items-center gap-2 border-b border-v2-grey-200 px-3 py-1.5">
          <FileText size={14} className="shrink-0 text-v2-icon-icon-muted" aria-hidden />
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-v2-text-text-muted" title={path}>
            {path}
          </span>
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
    <div className="flex h-full min-w-0 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-1 border-b border-v2-grey-200 px-2 py-1">
        <span className="hidden min-w-0 max-w-[200px] truncate font-mono text-[12px] text-v2-text-text-muted md:block" title={path}>
          {path}
        </span>
        <div className="ml-auto flex items-center gap-1" role="toolbar" aria-label="PDF controls">
          <button
            type="button"
            className={iconButton}
            aria-label="Previous page"
            title="Previous page"
            disabled={currentPage <= 1}
            onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
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
              if (Number.isInteger(next) && next >= 1 && next <= numPages) setCurrentPage(next);
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
            onClick={() => setCurrentPage((page) => Math.min(numPages, page + 1))}
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
          <button
            type="button"
            className={iconButton}
            aria-label="Fit width"
            title="Fit width"
            aria-pressed={fitWidth}
            onClick={() => setFitWidth((current) => !current)}
          >
            <Maximize size={14} aria-hidden />
          </button>
          <button
            type="button"
            className={iconButton}
            aria-label="Rotate"
            title="Rotate"
            onClick={() => setRotation((current) => (current + 90) % 360)}
          >
            <RotateCw size={14} aria-hidden />
          </button>
          <span className="mx-1 h-4 w-px shrink-0 bg-v2-grey-200" aria-hidden />

          <label className="flex shrink-0 items-center gap-1 rounded-md border border-v2-grey-200 bg-v2-background-bg-base px-2 py-0.5 focus-within:border-v2-blue-600">
            <Search size={12} className="shrink-0 text-v2-text-text-faint" aria-hidden />
            <input
              type="search"
              aria-label="Find in PDF"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find in PDF"
              spellCheck={false}
              className="w-28 bg-transparent font-mono text-[12px] text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint"
            />
          </label>
          {query.trim() && (
            <span className="shrink-0 whitespace-nowrap font-mono text-[11px] text-v2-text-text-faint">
              {shownMatch === 0 ? "No matches" : `${shownMatch} / ${matches.length} matches`}
            </span>
          )}
          <button
            type="button"
            className={iconButton}
            aria-label="Previous match"
            title="Previous match"
            disabled={matches.length === 0}
            onClick={() => goToMatch(-1)}
          >
            <ChevronUp size={14} aria-hidden />
          </button>
          <button
            type="button"
            className={iconButton}
            aria-label="Next match"
            title="Next match"
            disabled={matches.length === 0}
            onClick={() => goToMatch(1)}
          >
            <ChevronDown size={14} aria-hidden />
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
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto bg-v2-grey-100 p-3">
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
