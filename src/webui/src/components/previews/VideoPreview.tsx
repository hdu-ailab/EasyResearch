import { RotateCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { mediaPreviewUrl } from "../../api";
import { useI18n } from "../../i18n/useI18n";
import { PreviewToolbar, previewButtonClass } from "./PreviewToolbar";

export interface VideoPreviewProps {
  path: string;
  revision?: number;
}

export function VideoPreview({ path, revision = 0 }: VideoPreviewProps) {
  return <VideoDocument key={JSON.stringify([path, revision])} path={path} revision={revision} />;
}

function VideoDocument({ path, revision }: Required<VideoPreviewProps>) {
  const { t } = useI18n();
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const videoRef = useRef<HTMLVideoElement>(null);
  const url = mediaPreviewUrl(path, revision, attempt);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.src = url;
    return () => {
      video.pause();
      video.removeAttribute("src");
      // Abort pending range reads and release the old decoder, including on unmount.
      video.load();
    };
  }, [url]);

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      <PreviewToolbar path={path} label={t("preview.video.download")} controlsLabel={t("preview.video.controls")}>
        <button
          type="button"
          className={previewButtonClass}
          aria-label={t("preview.video.retry")}
          title={t("preview.video.retry")}
          onClick={() => {
            setStatus("loading");
            setAttempt((value) => value + 1);
          }}
        >
          <RotateCw size={14} aria-hidden />
        </button>
      </PreviewToolbar>
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-v2-grey-100">
        {/* Authored media may have no caption track; retain the browser's native controls. */}
        {/* biome-ignore lint/a11y/useMediaCaption: Local user media has no separate caption file contract. */}
        <video
          key={attempt}
          ref={videoRef}
          controls
          playsInline
          preload="metadata"
          aria-label={t("preview.video.title")}
          className="max-h-full w-full"
          onLoadedMetadata={(event) => {
            if (event.currentTarget === videoRef.current) setStatus("ready");
          }}
          onError={(event) => {
            if (event.currentTarget === videoRef.current) setStatus("error");
          }}
        />
        {status !== "ready" && (
          <p
            className="pointer-events-none absolute inset-0 flex items-center justify-center p-4 text-center text-[12px] text-v2-text-text-muted"
            role={status === "error" ? "alert" : "status"}
          >
            {t(status === "error" ? "preview.video.loadError" : "files.loading")}
          </p>
        )}
      </div>
    </div>
  );
}
