import { AlertTriangle, Download, FileText, Minus, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { RawFileSizeError, rawFileUrl } from "../../api";
import type { MessageKey } from "../../i18n/messages";
import { useI18n } from "../../i18n/useI18n";
import { DocxPackageError } from "./docx-package";
import { createDocxLoader, type DocxLoader } from "./docx-runtime";

export interface DocxPreviewProps {
  path: string;
  revision?: number;
  loader?: DocxLoader;
}

const DEFAULT_LOADER = createDocxLoader();
const MIN_SCALE = 0.5;
const MAX_SCALE = 2;
const SCALE_STEP = 0.25;
const FRAME_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src blob: data:; font-src blob: data:; connect-src 'none'; base-uri 'none'; form-action 'none'";
const FRAME_STYLE = `
html, body { min-height: 100%; margin: 0; background: #fafafa; }
body { overflow: auto; }
.docx-wrapper > section.docx {
  content-visibility: auto;
  contain-intrinsic-size: auto 1123px;
}`;

function resetFrame(frame: HTMLIFrameElement): { document: Document; body: HTMLElement; styles: HTMLElement } {
  const document = frame.contentDocument;
  if (!document) throw new Error("DOCX preview frame is unavailable");
  const head = document.createElement("head");
  const meta = document.createElement("meta");
  meta.httpEquiv = "Content-Security-Policy";
  meta.content = FRAME_CSP;
  const style = document.createElement("style");
  style.textContent = FRAME_STYLE;
  const frameBody = document.createElement("body");
  const styles = document.createElement("div");
  styles.hidden = true;
  const body = document.createElement("main");
  body.id = "docx-preview-root";
  head.append(meta, style);
  frameBody.append(styles, body);
  document.documentElement.replaceChildren(head, frameBody);
  return { document, body, styles };
}

function blobUrlsIn(...roots: ParentNode[]): Set<string> {
  const urls = new Set<string>();
  for (const root of roots) {
    for (const element of root.querySelectorAll<HTMLElement>("[src], [href]")) {
      for (const attribute of ["src", "href"] as const) {
        const value = element.getAttribute(attribute);
        if (value?.startsWith("blob:")) urls.add(value);
      }
    }
    for (const element of root.querySelectorAll<HTMLElement>("style, [style]")) {
      const css = element.tagName === "STYLE" ? element.textContent : element.getAttribute("style");
      for (const match of css?.matchAll(/blob:[^'"\s)]+/g) ?? []) urls.add(match[0]);
    }
  }
  return urls;
}

function releaseBlobUrls(urls: Set<string>): void {
  for (const url of urls) URL.revokeObjectURL(url);
  urls.clear();
}

function prepareLinks(document: Document, body: ParentNode): () => void {
  for (const anchor of body.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const href = anchor.getAttribute("href");
    if (href?.startsWith("#")) continue;
    if (href) {
      try {
        const url = new URL(href);
        if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:") {
          anchor.dataset.docxExternalHref = url.href;
        }
      } catch {
        // Unsupported relative and malformed links remain inert in the preview.
      }
    }
    anchor.removeAttribute("href");
  }

  const openExternal = (event: Event) => {
    const target = event.target as Node | null;
    const element = target?.nodeType === 1 ? (target as Element) : target?.parentElement;
    const anchor = element?.closest<HTMLAnchorElement>("a[data-docx-external-href]");
    const href = anchor?.dataset.docxExternalHref;
    if (!href) return;
    event.preventDefault();
    globalThis.open(href, "_blank", "noopener,noreferrer");
  };
  document.addEventListener("click", openExternal);
  return () => document.removeEventListener("click", openExternal);
}

function docxErrorKey(error: unknown): MessageKey {
  if (error instanceof RawFileSizeError) return "preview.docx.tooLarge";
  if (!(error instanceof DocxPackageError)) return "preview.docx.loadError";
  if (error.code === "encrypted") return "preview.docx.encrypted";
  if (error.code === "zip64") return "preview.docx.zip64";
  if (error.code === "too-many-entries" || error.code === "entry-too-large" || error.code === "archive-too-large") {
    return "preview.docx.expandedTooLarge";
  }
  return "preview.docx.invalid";
}

export function DocxPreview({ path, revision = 0, loader }: DocxPreviewProps) {
  const { t } = useI18n();
  const effectiveLoader = loader ?? DEFAULT_LOADER;
  const frameRef = useRef<HTMLIFrameElement>(null);
  const generationRef = useRef(0);
  const scaleRef = useRef(1);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<unknown>(null);
  const [retryToken, setRetryToken] = useState(0);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    void revision;
    void retryToken;
    const generation = ++generationRef.current;
    const controller = new AbortController();
    const ownedUrls = new Set<string>();
    let renderedRoots: ParentNode[] = [];
    let removeLinkHandler = () => {};
    let cancelled = false;
    let renderClosed = false;
    setStatus("loading");
    setError(null);

    const timer = globalThis.setTimeout(() => {
      void (async () => {
        try {
          const frame = frameRef.current;
          if (!frame) throw new Error("DOCX preview frame is unavailable");
          const prepared = resetFrame(frame);
          renderedRoots = [prepared.body, prepared.styles];
          prepared.document.body.style.setProperty("zoom", String(scaleRef.current));
          const bytes = await effectiveLoader.load(path, controller.signal);
          if (cancelled || generation !== generationRef.current) return;
          await effectiveLoader.render(bytes, prepared.body, prepared.styles, (url) => {
            if (renderClosed || cancelled || generation !== generationRef.current) {
              URL.revokeObjectURL(url);
              return;
            }
            ownedUrls.add(url);
          });
          renderClosed = true;
          for (const url of blobUrlsIn(...renderedRoots)) ownedUrls.add(url);
          if (cancelled || generation !== generationRef.current) {
            releaseBlobUrls(ownedUrls);
            return;
          }
          removeLinkHandler = prepareLinks(prepared.document, prepared.body);
          setStatus("ready");
        } catch (nextError) {
          renderClosed = true;
          if (renderedRoots.length > 0) {
            for (const url of blobUrlsIn(...renderedRoots)) ownedUrls.add(url);
            releaseBlobUrls(ownedUrls);
            for (const root of renderedRoots) root.replaceChildren();
          }
          if (
            !cancelled &&
            generation === generationRef.current &&
            !(nextError instanceof DOMException && nextError.name === "AbortError")
          ) {
            setError(nextError);
            setStatus("error");
          }
        }
      })();
    }, 0);

    return () => {
      cancelled = true;
      renderClosed = true;
      controller.abort();
      globalThis.clearTimeout(timer);
      removeLinkHandler();
      releaseBlobUrls(ownedUrls);
    };
  }, [effectiveLoader, path, retryToken, revision]);

  useEffect(() => {
    scaleRef.current = scale;
    frameRef.current?.contentDocument?.body.style.setProperty("zoom", String(scale));
  }, [scale]);

  const zoom = (direction: 1 | -1) => {
    setScale((current) =>
      Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round((current + direction * SCALE_STEP) * 100) / 100)),
    );
  };

  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorKey = docxErrorKey(error);
  const iconButton =
    "flex size-7 shrink-0 items-center justify-center rounded-md text-v2-icon-icon-muted transition-colors hover:bg-v2-grey-100 hover:text-v2-icon-icon-base disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent";

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      <header className="flex shrink-0 items-center gap-1 border-b border-v2-grey-200 px-2 py-1.5">
        <FileText size={14} className="shrink-0 text-v2-icon-icon-muted" aria-hidden />
        <span className="mr-auto shrink-0 font-mono text-[11px] text-v2-text-text-faint">DOCX</span>
        <fieldset className="flex min-w-0 flex-wrap items-center gap-1 border-0 p-0">
          <legend className="sr-only">{t("preview.docx.controls")}</legend>
          <button
            type="button"
            className={iconButton}
            aria-label={t("preview.docx.zoomOut")}
            title={t("preview.docx.zoomOut")}
            disabled={scale <= MIN_SCALE}
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
            aria-label={t("preview.docx.zoomIn")}
            title={t("preview.docx.zoomIn")}
            disabled={scale >= MAX_SCALE}
            onClick={() => zoom(1)}
          >
            <Plus size={14} aria-hidden />
          </button>
          <span className="mx-1 h-4 w-px shrink-0 bg-v2-grey-200" aria-hidden />
          <a
            href={rawFileUrl(path)}
            download
            aria-label={t("preview.docx.download")}
            className="flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px] font-medium text-v2-text-text-muted transition-colors hover:bg-v2-grey-100 hover:text-v2-text-text-base"
          >
            <Download size={13} aria-hidden />
            <span className="hidden sm:inline">{t("preview.docx.download")}</span>
          </a>
        </fieldset>
      </header>
      <div className="relative min-h-0 flex-1 bg-v2-grey-100">
        <iframe
          ref={frameRef}
          title={t("preview.docx.document")}
          sandbox="allow-same-origin"
          className={status === "ready" ? "visible block size-full border-0" : "invisible block size-full border-0"}
        />
        {status === "loading" && (
          <p className="absolute inset-0 flex items-center justify-center text-[12px] text-v2-text-text-faint">
            {t("files.loading")}
          </p>
        )}
        {status === "error" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4">
            <AlertTriangle size={20} className="shrink-0 text-v2-status-error" aria-hidden />
            <p className="max-w-[420px] text-center text-[13px] text-v2-text-text-muted" role="alert">
              {t(errorKey).replace("{error}", errorMessage)}
            </p>
            <button
              type="button"
              className="rounded-md border border-v2-grey-200 px-3 py-1 text-[12px] font-medium text-v2-text-text-base transition-colors hover:bg-v2-grey-100"
              onClick={() => setRetryToken((token) => token + 1)}
            >
              {t("preview.retry")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
