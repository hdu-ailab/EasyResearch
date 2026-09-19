import { useId, useRef, useState } from "react";
import type { ActiveSessionDto, SessionSummaryDto } from "../../../web/contracts";
import { parseSessionBusyError } from "../api";
import { useModalLayer } from "../hooks/useModalLayer";
import { useI18n } from "../i18n/useI18n";
import { isActuallyRunning, sessionTitle } from "../pages/home-view-model";

export interface DeleteSessionDialogProps {
  session: ActiveSessionDto | SessionSummaryDto;
  onDelete: (force: boolean) => Promise<void>;
  onClose: () => void;
}

export function DeleteSessionDialog({ session, onDelete, onClose }: DeleteSessionDialogProps) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLFormElement>(null);
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [force, setForce] = useState(
    "status" in session && (session.status === "starting" || isActuallyRunning(session)),
  );
  const [error, setError] = useState<string | null>(null);
  const descriptionId = useId();
  const close = () => {
    if (!inFlight.current) onClose();
  };
  const { zIndex, dialogProps } = useModalLayer(close, dialogRef);

  const submit = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      await onDelete(force);
      onClose();
    } catch (failure: unknown) {
      if (parseSessionBusyError(failure)) setForce(true);
      else setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop provides pointer dismissal; Cancel and the modal layer provide keyboard dismissal.
    <div
      className="fixed inset-0 flex items-center justify-center bg-v2-grey-1200/20 p-4"
      style={{ zIndex }}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <form
        ref={dialogRef}
        role="dialog"
        {...dialogProps}
        aria-label={t("home.deleteSession")}
        aria-describedby={descriptionId}
        aria-busy={pending}
        className="max-h-[calc(100dvh-2rem)] w-full max-w-[420px] overflow-y-auto rounded-[10px] bg-v2-background-bg-base p-4 shadow-[var(--v2-elevation-overlay)]"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h2 className="text-[14px] font-semibold text-v2-text-text-base">{t("home.deleteSession")}</h2>
        <p className="mt-3 break-words text-[13px] font-medium text-v2-text-text-base">{sessionTitle(session)}</p>
        <p className="mt-1 break-all font-mono text-[12px] text-v2-text-text-muted">{session.cwd}</p>
        <div id={descriptionId} className="mt-3 space-y-2 text-[13px] text-v2-text-text-muted">
          <p>{t("home.deleteWarning")}</p>
          {force && <p role="status">{t("home.deleteBusyWarning")}</p>}
        </div>
        {error && (
          <p role="alert" className="mt-3 break-words text-[13px] text-v2-status-error">
            {error}
          </p>
        )}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            disabled={pending}
            className="min-h-9 rounded-md px-3 py-1.5 text-[13px] text-v2-text-text-muted transition-colors hover:bg-v2-grey-100 disabled:opacity-50"
            onClick={close}
          >
            {t("dialog.cancel")}
          </button>
          <button
            type="submit"
            disabled={pending}
            className="min-h-9 rounded-md bg-v2-status-error px-3 py-1.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-50"
          >
            {pending
              ? t("home.deleting")
              : force
                ? t("home.stopAndDelete")
                : error
                  ? t("home.retryDelete")
                  : t("home.delete")}
          </button>
        </div>
      </form>
    </div>
  );
}
