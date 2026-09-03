import { LoaderCircle } from "lucide-react";
import { useRef } from "react";
import { useModalLayer } from "../hooks/useModalLayer";
import { useI18n } from "../i18n/useI18n";

export interface RuntimeRestartOverlayProps {
  phase: "waiting" | "timed-out";
  desktop: boolean;
  onRetry(): void;
}

const keepOpen = () => {};

export function RuntimeRestartOverlay({ phase, desktop, onRetry }: RuntimeRestartOverlayProps) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDivElement>(null);
  const layer = useModalLayer(keepOpen, dialogRef);
  const timedOut = phase === "timed-out";
  return (
    <div
      className="fixed inset-0 flex items-center justify-center bg-v2-grey-1200/55 p-4"
      style={{ zIndex: layer.zIndex }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        {...layer.dialogProps}
        aria-labelledby="runtime-restart-title"
        aria-describedby="runtime-restart-description"
        className="w-full max-w-[440px] rounded-[12px] bg-v2-background-bg-base p-6 text-center shadow-[var(--v2-elevation-overlay)]"
      >
        {!timedOut && (
          <LoaderCircle
            size={24}
            className="mx-auto mb-3 animate-spin text-v2-blue-600 motion-reduce:animate-none"
            aria-hidden
          />
        )}
        <h1 id="runtime-restart-title" className="text-[16px] font-semibold text-v2-text-text-base">
          {t(timedOut ? "runtimeRestart.timeoutTitle" : "runtimeRestart.title")}
        </h1>
        <p
          id="runtime-restart-description"
          role={timedOut ? "alert" : "status"}
          className={`mt-2 text-[13px] leading-relaxed ${
            timedOut ? "text-v2-status-warning" : "text-v2-text-text-muted"
          }`}
        >
          {t(
            timedOut
              ? "runtimeRestart.timeoutDescription"
              : desktop
                ? "runtimeRestart.desktopDescription"
                : "runtimeRestart.waitingDescription",
          )}
        </p>
        {timedOut && !desktop && (
          <button
            type="button"
            className="mt-5 h-9 rounded-md bg-v2-blue-600 px-4 text-[12px] font-medium text-v2-grey-50 hover:bg-v2-blue-700 focus:outline-2 focus:outline-offset-2 focus:outline-v2-blue-600"
            onClick={onRetry}
          >
            {t("runtimeRestart.retry")}
          </button>
        )}
      </div>
    </div>
  );
}
