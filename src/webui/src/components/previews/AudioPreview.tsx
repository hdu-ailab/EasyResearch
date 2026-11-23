import { RotateCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { mediaPreviewUrl } from "../../api";
import { useI18n } from "../../i18n/useI18n";
import { PreviewToolbar, previewButtonClass } from "./PreviewToolbar";

export function AudioPreview({ path, revision = 0 }: { path: string; revision?: number }) {
  return <AudioDocument key={JSON.stringify([path, revision])} path={path} revision={revision} />;
}

function AudioDocument({ path, revision }: { path: string; revision: number }) {
  const { t } = useI18n();
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const audioRef = useRef<HTMLAudioElement>(null);
  const url = mediaPreviewUrl(path, revision, attempt);
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.src = url;
    return () => {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    };
  }, [url]);
  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      <PreviewToolbar path={path} label={t("preview.audio.download")} controlsLabel={t("preview.audio.controls")}>
        <button
          type="button"
          className={previewButtonClass}
          aria-label={t("preview.audio.retry")}
          title={t("preview.audio.retry")}
          onClick={() => {
            setStatus("loading");
            setAttempt((value) => value + 1);
          }}
        >
          <RotateCw size={14} aria-hidden />
        </button>
      </PreviewToolbar>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 overflow-auto p-4">
        {/* biome-ignore lint/a11y/useMediaCaption: Local user audio has no separate transcript contract. */}
        <audio
          key={attempt}
          ref={audioRef}
          controls
          preload="metadata"
          aria-label={t("preview.audio.title")}
          className="w-full max-w-lg"
          onLoadedMetadata={(event) => {
            if (event.currentTarget === audioRef.current) setStatus("ready");
          }}
          onError={(event) => {
            if (event.currentTarget === audioRef.current) setStatus("error");
          }}
        />
        {status !== "ready" && (
          <p role={status === "error" ? "alert" : "status"} className="text-center text-[12px] text-v2-text-text-muted">
            {t(status === "error" ? "preview.audio.loadError" : "files.loading")}
          </p>
        )}
      </div>
    </div>
  );
}
