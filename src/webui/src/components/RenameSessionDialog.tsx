import { useRef, useState } from "react";
import { useModalLayer } from "../hooks/useModalLayer";
import { useI18n } from "../i18n/useI18n";

export interface RenameSessionDialogProps {
  currentName: string;
  onSave: (name: string) => void;
  onClose: () => void;
}

export function RenameSessionDialog({ currentName, onSave, onClose }: RenameSessionDialogProps) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLFormElement>(null);
  const { zIndex, dialogProps } = useModalLayer(onClose, dialogRef);
  const [name, setName] = useState(currentName);

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-v2-grey-1200/20 p-4" style={{ zIndex }}>
      <form
        ref={dialogRef}
        role="dialog"
        {...dialogProps}
        aria-label={t("home.renameDialogTitle")}
        className="w-full max-w-[360px] rounded-[10px] bg-v2-background-bg-base p-4 shadow-[var(--v2-elevation-overlay)]"
        onSubmit={(event) => {
          event.preventDefault();
          onSave(name.trim());
        }}
      >
        <h2 className="mb-3 text-[13px] font-semibold text-v2-text-text-base">{t("home.renameDialogTitle")}</h2>
        <input
          aria-label={t("home.renameDialogLabel")}
          className="h-8 w-full rounded-md border border-v2-grey-200 px-2 text-[12px] text-v2-text-text-base outline-none focus:border-v2-blue-600"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t("home.renameDialogLabel")}
        />
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md px-3 py-1.5 text-[13px] text-v2-text-text-muted transition-colors hover:bg-v2-grey-100"
            onClick={onClose}
          >
            {t("home.renameDialogCancel")}
          </button>
          <button
            type="submit"
            className="rounded-md bg-v2-grey-1100 px-3 py-1.5 text-[13px] font-medium text-v2-grey-50 transition-opacity hover:opacity-90"
          >
            {t("home.renameDialogSave")}
          </button>
        </div>
      </form>
    </div>
  );
}
