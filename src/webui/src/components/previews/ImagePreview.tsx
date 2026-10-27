import { Maximize, Minus, Plus, RotateCw } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { mediaPreviewUrl } from "../../api";
import { filesystemPathName } from "../../filesystem-path";
import { useI18n } from "../../i18n/useI18n";
import { PreviewToolbar, previewButtonClass } from "./PreviewToolbar";

export interface ImagePreviewProps {
  path: string;
  revision?: number;
}

export function ImagePreview({ path, revision = 0 }: ImagePreviewProps) {
  return <ImageDocument key={JSON.stringify([path, revision])} path={path} revision={revision} />;
}

function fittedImageScale(
  image: HTMLImageElement | null,
  viewport: HTMLDivElement | null,
  size: { width: number; height: number },
): number {
  if (!image?.parentElement || !viewport || !size.width || !size.height) return 0;
  const padding = getComputedStyle(image.parentElement);
  const width = Math.max(
    0,
    viewport.clientWidth -
      (Number.parseFloat(padding.paddingLeft) || 0) -
      (Number.parseFloat(padding.paddingRight) || 0),
  );
  const height = Math.max(
    0,
    viewport.clientHeight -
      (Number.parseFloat(padding.paddingTop) || 0) -
      (Number.parseFloat(padding.paddingBottom) || 0),
  );
  return Math.min(1, width / size.width, height / size.height);
}

function ImageDocument({ path, revision }: Required<ImagePreviewProps>) {
  const { t } = useI18n();
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [scale, setScale] = useState<number | null>(null);
  const [fittedScale, setFittedScale] = useState(0);
  const imageRef = useRef<HTMLImageElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const image = imageRef.current;
    const viewport = scrollRef.current;
    if (status !== "ready" || !image || !viewport) return;
    let cancelled = false;
    const measure = () => {
      if (!cancelled) setFittedScale(fittedImageScale(image, viewport, size));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [status, size]);

  const minimumScale = Math.min(0.1, fittedScale);
  const effectiveScale = scale ?? fittedScale;
  const reset = () => {
    setScale(null);
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
      scrollRef.current.scrollLeft = 0;
    }
  };
  const zoom = (direction: 1 | -1) => {
    // Read again at activation: a resize may precede its observer delivery.
    const fitted = fittedImageScale(imageRef.current, scrollRef.current, size);
    if (fitted <= 0) return;
    setFittedScale(fitted);
    setScale((current) => {
      const value = current ?? fitted;
      if (direction === 1) return Math.min(4, value + 0.25);
      // A growing pane can put the new floor above an existing manual zoom.
      // Zoom out must never enlarge that image to reach the floor.
      return Math.min(value, Math.max(Math.min(0.1, fitted), value - 0.25));
    });
  };

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      <PreviewToolbar path={path} label={t("preview.image.download")} controlsLabel={t("preview.image.controls")}>
        <button
          type="button"
          className={previewButtonClass}
          aria-label={t("preview.image.zoomOut")}
          title={t("preview.image.zoomOut")}
          disabled={status !== "ready" || fittedScale <= 0 || effectiveScale - minimumScale <= Number.EPSILON}
          onClick={() => zoom(-1)}
        >
          <Minus size={14} aria-hidden />
        </button>
        {scale !== null && (
          <span className="text-center font-mono text-[11px] text-v2-text-text-muted">{Math.round(scale * 100)}%</span>
        )}
        <button
          type="button"
          className={previewButtonClass}
          aria-label={t("preview.image.zoomIn")}
          title={t("preview.image.zoomIn")}
          disabled={status !== "ready" || fittedScale <= 0 || effectiveScale >= 4}
          onClick={() => zoom(1)}
        >
          <Plus size={14} aria-hidden />
        </button>
        <button
          type="button"
          className={previewButtonClass}
          aria-label={t("preview.image.reset")}
          title={t("preview.image.reset")}
          disabled={status !== "ready"}
          aria-pressed={scale === null}
          onClick={reset}
        >
          <Maximize size={14} aria-hidden />
        </button>
        <button
          type="button"
          className={previewButtonClass}
          aria-label={t("preview.image.retry")}
          title={t("preview.image.retry")}
          onClick={() => {
            setStatus("loading");
            reset();
            setAttempt((value) => value + 1);
          }}
        >
          <RotateCw size={14} aria-hidden />
        </button>
      </PreviewToolbar>
      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-auto bg-v2-grey-100">
        <div
          className={
            scale === null
              ? "flex size-full items-center justify-center p-3"
              : "grid min-h-full w-max min-w-full place-items-center p-3"
          }
        >
          <img
            key={attempt}
            ref={imageRef}
            src={mediaPreviewUrl(path, revision, attempt)}
            alt={filesystemPathName(path)}
            className={status === "ready" ? "block" : "invisible block"}
            style={
              scale === null
                ? { maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }
                : { width: size.width * scale, height: size.height * scale, maxWidth: "none" }
            }
            onLoad={(event) => {
              if (event.currentTarget !== imageRef.current) return;
              setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight });
              setStatus("ready");
            }}
            onError={(event) => {
              if (event.currentTarget === imageRef.current) setStatus("error");
            }}
          />
        </div>
        {status !== "ready" && (
          <p
            className="pointer-events-none absolute inset-0 flex items-center justify-center p-4 text-center text-[12px] text-v2-text-text-muted"
            role={status === "error" ? "alert" : "status"}
          >
            {t(status === "error" ? "preview.image.loadError" : "files.loading")}
          </p>
        )}
      </div>
    </div>
  );
}
