import { useId, useRef, useState } from "react";
import type { WorkspaceMutationResultDto } from "../../../web/contracts";
import { deleteWorkspace, isWorkspaceBusy, relocateWorkspace, renameWorkspace, workspaceMissingCwd } from "../api";
import { useModalLayer } from "../hooks/useModalLayer";
import { useI18n } from "../i18n/useI18n";
import { directoryName } from "../pages/home-view-model";
import { DirectoryDialog } from "./DirectoryDialog";

export interface WorkspaceDialogProps {
  cwd: string;
  mode: "rename" | "delete" | "missing";
  homeDir: string;
  onClose(): void;
  onComplete(result: WorkspaceMutationResultDto, deleted: boolean): void | Promise<void>;
}

export function WorkspaceDialog(props: WorkspaceDialogProps) {
  const { t } = useI18n();
  const [mode, setMode] = useState<WorkspaceDialogProps["mode"] | "relocate">(props.mode);
  const [name, setName] = useState(directoryName(props.cwd));
  const [directory, setDirectory] = useState("");
  const [choosing, setChoosing] = useState(false);
  const [pending, setPending] = useState(false);
  const [force, setForce] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const descriptionId = useId();
  const close = () => {
    if (!inFlight.current) props.onClose();
  };
  const { zIndex, dialogProps } = useModalLayer(close, formRef);
  const title = t(
    mode === "rename" ? "workspace.rename" : mode === "delete" ? "workspace.delete" : "workspace.missing",
  );
  const submit = async (destination?: string) => {
    if (inFlight.current || (mode === "missing" && !destination)) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const result =
        mode === "delete"
          ? await deleteWorkspace(props.cwd, force)
          : mode === "rename"
            ? await renameWorkspace(props.cwd, name, force)
            : await relocateWorkspace(props.cwd, destination ?? directory, force);
      await props.onComplete(result, mode === "delete");
      props.onClose();
    } catch (failure) {
      if (isWorkspaceBusy(failure)) setForce(true);
      else if (workspaceMissingCwd(failure)) setMode("missing");
      else setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Cancel and modal keyboard handling also dismiss the dialog. */}
      <div
        role="presentation"
        className="fixed inset-0 flex items-center justify-center bg-v2-grey-1200/20 p-4"
        style={{ zIndex }}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) close();
        }}
      >
        <form
          ref={formRef}
          role="dialog"
          {...dialogProps}
          aria-label={title}
          aria-describedby={descriptionId}
          aria-busy={pending}
          className="max-h-[calc(100dvh-2rem)] w-full max-w-[460px] overflow-y-auto rounded-[10px] bg-v2-background-bg-base p-4 shadow-[var(--v2-elevation-overlay)]"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <h2 className="text-[14px] font-semibold text-v2-text-text-base">{title}</h2>
          <p className="mt-3 break-all font-mono text-[12px] text-v2-text-text-muted">{props.cwd}</p>
          <p id={descriptionId} className="mt-3 text-[13px] text-v2-text-text-muted">
            {t(
              mode === "rename"
                ? "workspace.renameDescription"
                : mode === "delete"
                  ? "workspace.deleteDescription"
                  : "workspace.missingDescription",
            )}
          </p>
          {mode === "rename" && (
            <label className="mt-3 block text-[13px]">
              {t("workspace.folderName")}
              <input
                className="mt-1 w-full rounded-md border border-v2-grey-300 bg-v2-background-bg-base p-2"
                value={name}
                disabled={pending}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
          )}
          {directory && mode === "relocate" && <p className="mt-3 break-all font-mono text-[12px]">{directory}</p>}
          {force && (
            <p role="status" className="mt-3 text-[13px] text-v2-text-text-muted">
              {t("workspace.busy")}
            </p>
          )}
          {error && (
            <p role="alert" className="mt-3 break-words text-[13px] text-v2-status-error">
              {error}
            </p>
          )}
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <button type="button" className="er-outlined-button" disabled={pending} onClick={close}>
              {t("dialog.cancel")}
            </button>
            {(mode === "missing" || mode === "relocate") && (
              <>
                <button
                  type="button"
                  className="er-outlined-button er-danger-action"
                  disabled={pending}
                  onClick={() => {
                    setMode("delete");
                    setForce(false);
                    setError(null);
                  }}
                >
                  {t("workspace.delete")}
                </button>
                <button
                  type="button"
                  className="er-outlined-button"
                  disabled={pending}
                  onClick={() => {
                    setForce(false);
                    setChoosing(true);
                  }}
                >
                  {t("workspace.chooseFolder")}
                </button>
              </>
            )}
            {mode !== "missing" && (
              <button
                type="submit"
                disabled={pending || (mode === "rename" && !name.trim())}
                className={`er-outlined-button ${mode === "delete" ? "er-danger-action" : "font-medium"}`}
              >
                {pending
                  ? t("workspace.working")
                  : force
                    ? t("workspace.stopAndContinue")
                    : mode === "rename"
                      ? t("workspace.rename")
                      : mode === "delete"
                        ? t("workspace.delete")
                        : t("workspace.migrate")}
              </button>
            )}
          </div>
        </form>
      </div>
      {choosing && (
        <DirectoryDialog
          homeDir={props.homeDir}
          title={t("workspace.chooseFolder")}
          selectLabel={t("workspace.migrate")}
          onClose={() => setChoosing(false)}
          onSelect={(path) => {
            setDirectory(path);
            setMode("relocate");
            setChoosing(false);
            void submit(path);
          }}
        />
      )}
    </>
  );
}
