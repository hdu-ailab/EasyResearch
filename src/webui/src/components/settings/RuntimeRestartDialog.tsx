import { useId, useRef, useState } from "react";
import type { RuntimeRestartBusyDto } from "../../../../web/contracts";
import { parseRuntimeBusyError, restartRuntime } from "../../api";
import { useModalLayer } from "../../hooks/useModalLayer";
import { useI18n } from "../../i18n/useI18n";

export interface RuntimeRestartDialogProps {
  onLater(): void;
  onAccepted(oldBootId: string): void;
}

type RestartState =
  | { kind: "choice" }
  | { kind: "submitting"; force: boolean }
  | { kind: "busy"; details: RuntimeRestartBusyDto }
  | { kind: "error"; force: boolean };

function replace(template: string, token: string, value: string): string {
  return template.replace(`{${token}}`, value);
}

export function RuntimeRestartDialog({ onLater, onAccepted }: RuntimeRestartDialogProps) {
  const { t } = useI18n();
  const id = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<RestartState>({ kind: "choice" });
  const submitting = state.kind === "submitting";
  const layer = useModalLayer(submitting ? () => {} : onLater, dialogRef);

  const submit = async (force: boolean) => {
    setState({ kind: "submitting", force });
    try {
      const result = await restartRuntime(force);
      onAccepted(result.bootId);
    } catch (cause) {
      const busy = force ? null : parseRuntimeBusyError(cause);
      setState(busy ? { kind: "busy", details: busy } : { kind: "error", force });
    }
  };

  return (
    <>
      <div
        className="fixed inset-0 flex items-center justify-center bg-v2-grey-1200/30 p-0 min-[820px]:p-4"
        style={{ zIndex: layer.zIndex }}
      >
        <div
          ref={dialogRef}
          role="dialog"
          {...layer.dialogProps}
          aria-labelledby={`${id}-title`}
          aria-describedby={`${id}-description`}
          className="h-full w-full overflow-y-auto bg-v2-background-bg-base p-5 shadow-[var(--v2-elevation-overlay)] min-[820px]:h-auto min-[820px]:max-h-[calc(100vh-32px)] min-[820px]:max-w-[420px] min-[820px]:rounded-[10px]"
        >
          <h2 id={`${id}-title`} className="text-[15px] font-semibold text-v2-text-text-base">
            {t("settings.restart.title")}
          </h2>
          <p id={`${id}-description`} className="mt-2 text-[13px] leading-relaxed text-v2-text-text-muted">
            {t("settings.restart.description")}
          </p>
          {state.kind === "error" && (
            <p
              role="alert"
              className="mt-3 rounded-md border border-v2-status-error/30 bg-v2-status-error/5 px-3 py-2 text-[12px] text-v2-status-error"
            >
              {t("settings.restart.error")}
            </p>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              disabled={submitting}
              className="h-9 rounded-md border border-v2-grey-200 px-3 text-[12px] font-medium text-v2-text-text-base hover:bg-v2-grey-100 focus:outline-2 focus:outline-offset-2 focus:outline-v2-blue-600 disabled:opacity-50"
              onClick={onLater}
            >
              {t("settings.restart.later")}
            </button>
            <button
              type="button"
              disabled={submitting}
              className="h-9 rounded-md bg-v2-blue-600 px-3 text-[12px] font-medium text-v2-grey-50 hover:bg-v2-blue-700 focus:outline-2 focus:outline-offset-2 focus:outline-v2-blue-600 disabled:opacity-50"
              onClick={() => void submit(state.kind === "error" ? state.force : false)}
            >
              {submitting
                ? t("settings.restart.restarting")
                : state.kind === "error"
                  ? t("settings.restart.retry")
                  : t("settings.restart.now")}
            </button>
          </div>
        </div>
      </div>
      {state.kind === "busy" && (
        <BusyRestartDialog
          details={state.details}
          onCancel={() => setState({ kind: "choice" })}
          onConfirm={() => void submit(true)}
        />
      )}
    </>
  );
}

function BusyRestartDialog({
  details,
  onCancel,
  onConfirm,
}: {
  details: RuntimeRestartBusyDto;
  onCancel(): void;
  onConfirm(): void;
}) {
  const { t } = useI18n();
  const id = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const layer = useModalLayer(onCancel, dialogRef);
  return (
    <div
      className="fixed inset-0 flex items-center justify-center bg-v2-grey-1200/40 p-0 min-[820px]:p-4"
      style={{ zIndex: layer.zIndex }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        {...layer.dialogProps}
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
        className="h-full w-full overflow-y-auto bg-v2-background-bg-base p-5 shadow-[var(--v2-elevation-overlay)] min-[820px]:h-auto min-[820px]:max-h-[calc(100vh-32px)] min-[820px]:max-w-[440px] min-[820px]:rounded-[10px]"
      >
        <h2 id={`${id}-title`} className="text-[15px] font-semibold text-v2-status-error">
          {t("settings.restart.busyTitle")}
        </h2>
        <div id={`${id}-description`} className="mt-2 space-y-1 text-[13px] leading-relaxed text-v2-text-text-muted">
          <p>{replace(t("settings.restart.busySessions"), "n", String(details.activeSessions))}</p>
          {details.authFlowActive && <p>{t("settings.restart.busyAuth")}</p>}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            className="h-9 rounded-md border border-v2-grey-200 px-3 text-[12px] font-medium text-v2-text-text-base hover:bg-v2-grey-100 focus:outline-2 focus:outline-offset-2 focus:outline-v2-blue-600"
            onClick={onCancel}
          >
            {t("settings.restart.cancel")}
          </button>
          <button
            type="button"
            className="h-9 rounded-md bg-v2-status-error px-3 text-[12px] font-medium text-white hover:opacity-90 focus:outline-2 focus:outline-offset-2 focus:outline-v2-blue-600"
            onClick={onConfirm}
          >
            {t("settings.restart.force")}
          </button>
        </div>
      </div>
    </div>
  );
}
