import { useId, useRef, useState } from "react";
import type { WorkspaceMutationResultDto } from "../../../web/contracts";
import {
  deleteWorkspace,
  parseSessionHistoryConflict,
  parseWorkspaceBusyError,
  relocateWorkspace,
  renameWorkspace,
  workspaceMissingCwd,
} from "../api";
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
  return <WorkspaceDialogContent key={`${props.cwd}:${props.mode}`} {...props} />;
}

function WorkspaceDialogContent(props: WorkspaceDialogProps) {
  const { t } = useI18n();
  const [mode, setMode] = useState<WorkspaceDialogProps["mode"] | "relocate">(props.mode);
  const [name, setName] = useState(directoryName(props.cwd));
  const [directory, setDirectory] = useState("");
  const [choosing, setChoosing] = useState(false);
  const [pending, setPending] = useState(false);
  const [force, setForce] = useState(false);
  const [affectedCwds, setAffectedCwds] = useState<string[] | undefined>();
  const additionalCwds = (affectedCwds ?? []).filter((cwd) => cwd !== props.cwd);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const descriptionId = useId();
  const close = () => {
    if (!inFlight.current) props.onClose();
  };
  const { layerProps, dialogProps } = useModalLayer(close, formRef);
  const title = t(
    mode === "rename" ? "workspace.rename" : mode === "delete" ? "workspace.delete" : "workspace.missing",
  );
  const resetConfirmation = () => {
    setForce(false);
    setAffectedCwds(undefined);
    setError(null);
  };
  const submit = async (destination?: string) => {
    if (inFlight.current || (mode === "missing" && !destination)) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const result =
        mode === "delete"
          ? await deleteWorkspace(props.cwd, force, force ? affectedCwds : undefined)
          : mode === "rename"
            ? await renameWorkspace(props.cwd, name, force)
            : await relocateWorkspace(props.cwd, destination ?? directory, force);
      await props.onComplete(result, mode === "delete");
      props.onClose();
    } catch (failure) {
      const busy = parseWorkspaceBusyError(failure);
      if (busy) {
        setForce(true);
        setAffectedCwds(busy.affectedCwds);
      } else if (parseSessionHistoryConflict(failure)) {
        resetConfirmation();
        setError(t("history.conflict"));
      } else if (workspaceMissingCwd(failure)) {
        resetConfirmation();
        setMode("missing");
      } else {
        resetConfirmation();
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Cancel and modal keyboard handling also dismiss the dialog.
    <div
      role="presentation"
      className="fixed inset-0 flex items-center justify-center bg-v2-grey-1200/20 p-4"
      {...layerProps}
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
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.nativeEvent.isComposing || event.keyCode === 229 || event.repeat)) {
            event.preventDefault();
          }
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
        {additionalCwds.length > 0 && (
          <div role="status" className="mt-3 text-[13px] text-v2-text-text-muted">
            <p>{t("history.additionalStopScopes")}</p>
            <ul className="mt-1 space-y-1 break-all font-mono text-[12px]">
              {additionalCwds.map((cwd) => (
                <li key={cwd}>{cwd}</li>
              ))}
            </ul>
          </div>
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
                  resetConfirmation();
                }}
              >
                {t("workspace.delete")}
              </button>
              <button
                type="button"
                className="er-outlined-button"
                disabled={pending}
                onClick={() => {
                  resetConfirmation();
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
              onClick={(event) => {
                if (event.detail > 1) event.preventDefault();
              }}
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
    </div>
  );
}
