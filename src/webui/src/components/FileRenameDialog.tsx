import { useLayoutEffect, useRef, useState } from "react";
import type { FileEntryDto, FileRenameResultDto } from "../../../web/contracts";
import { renameFile } from "../api";
import { useModalLayer } from "../hooks/useModalLayer";
import type { MessageKey } from "../i18n/messages";
import { useI18n } from "../i18n/useI18n";
import { fileOperationError } from "./file-operation-error";

export function FileRenameDialog({
  cwd,
  entry,
  onClose,
  onComplete,
}: {
  cwd: string;
  entry: FileEntryDto;
  onClose(): void;
  onComplete(result: FileRenameResultDto): void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(entry.name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const inFlight = useRef(false);
  const live = useRef(true);
  const form = useRef<HTMLFormElement>(null);
  const close = () => {
    if (!inFlight.current) onClose();
  };
  const { zIndex, dialogProps } = useModalLayer(close, form);
  useLayoutEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const submit = async () => {
    if (inFlight.current || !name.trim()) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await renameFile(cwd, entry.path, name);
      if (!live.current) return;
      onComplete(result);
      onClose();
    } catch (failure) {
      if (live.current) setError(fileOperationError(failure));
    } finally {
      inFlight.current = false;
      if (live.current) setPending(false);
    }
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Cancel and the modal keyboard handler also dismiss.
    <div
      role="presentation"
      className="fixed inset-0 flex items-center justify-center bg-v2-grey-1200/20 p-4"
      style={{ zIndex }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <form
        ref={form}
        role="dialog"
        {...dialogProps}
        aria-label={t("files.rename")}
        aria-busy={pending}
        className="max-h-[calc(100dvh-2rem)] w-full max-w-[460px] overflow-y-auto rounded-[10px] bg-v2-background-bg-base p-4 shadow-[var(--v2-elevation-overlay)]"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h2 className="text-[14px] font-semibold">{t("files.rename")}</h2>
        <p className="mt-3 break-all font-mono text-[12px] text-v2-text-text-muted">{entry.path}</p>
        <label className="mt-3 block text-[13px]">
          {t("files.fileName")}
          <input
            className="mt-1 w-full rounded-md border border-v2-grey-300 bg-v2-background-bg-base p-2"
            value={name}
            disabled={pending}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {error && (
          <p role="alert" className="mt-3 text-[13px] text-v2-status-error">
            {t(error)}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="er-outlined-button" disabled={pending} onClick={close}>
            {t("dialog.cancel")}
          </button>
          <button type="submit" className="er-outlined-button font-medium" disabled={pending || !name.trim()}>
            {t(pending ? "files.renaming" : "files.rename")}
          </button>
        </div>
      </form>
    </div>
  );
}
