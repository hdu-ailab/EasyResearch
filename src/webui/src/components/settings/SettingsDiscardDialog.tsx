import { useId, useRef } from "react";
import { useModalLayer } from "../../hooks/useModalLayer";
import { useI18n } from "../../i18n/useI18n";

export function SettingsDiscardDialog({ onCancel, onConfirm }: { onCancel(): void; onConfirm(): void }) {
  const { t } = useI18n();
  const id = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const layer = useModalLayer(onCancel, dialogRef);
  return (
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
        className="h-full w-full overflow-y-auto bg-v2-background-bg-base p-5 shadow-[var(--v2-elevation-overlay)] min-[820px]:h-auto min-[820px]:max-h-[calc(100vh-32px)] min-[820px]:max-w-[400px] min-[820px]:rounded-[10px]"
      >
        <h2 id={`${id}-title`} className="text-[15px] font-semibold text-v2-text-text-base">
          {t("settings.discard.title")}
        </h2>
        <p id={`${id}-description`} className="mt-2 text-[13px] leading-relaxed text-v2-text-text-muted">
          {t("settings.discard.description")}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            className="h-9 rounded-md border border-v2-grey-200 px-3 text-[12px] font-medium text-v2-text-text-base hover:bg-v2-grey-100 focus:outline-2 focus:outline-offset-2 focus:outline-v2-blue-600"
            onClick={onCancel}
          >
            {t("settings.discard.cancel")}
          </button>
          <button
            type="button"
            className="h-9 rounded-md bg-v2-status-error px-3 text-[12px] font-medium text-white hover:opacity-90 focus:outline-2 focus:outline-offset-2 focus:outline-v2-blue-600"
            onClick={onConfirm}
          >
            {t("settings.discard.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
