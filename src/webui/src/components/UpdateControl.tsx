import { X } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  LATEST_RELEASE_PAGE,
  type UpdateAction,
  type UpdateActionResult,
  type UpdateSnapshot,
} from "../../../runtime/update-contract";
import { getUpdateSnapshot, requestUpdateAction, subscribeUpdates } from "../api/update";
import { canFocusElement, useModalLayer } from "../hooks/useModalLayer";
import { useI18n } from "../i18n/useI18n";

type Confirmation = {
  action: "install" | "activate";
  operationId: string;
  busy?: Extract<UpdateActionResult, { code: "RUNTIME_BUSY" }>;
};

const working = new Set(["checking", "downloading", "installing", "verifying", "activating"]);

/** The view observes one host-owned operation; closing it never cancels installation. */
export function UpdateControl({
  currentVersion,
  latestVersion,
  onOpenChange,
}: {
  currentVersion: string;
  latestVersion?: string | null;
  onOpenChange?(open: boolean): void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const [connection, setConnection] = useState(0);
  const [snapshot, setSnapshot] = useState<UpdateSnapshot | null>(null);
  const latest = useRef<UpdateSnapshot | null>(null);
  const [error, setError] = useState<"request" | "connection" | "timeout" | null>(null);
  const [pending, setPending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const pendingRef = useRef<number | null>(null);
  const cancellationRef = useRef<number | null>(null);
  const requestSequence = useRef(0);
  const alive = useRef(true);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);

  useLayoutEffect(() => {
    // App removes its inert surface after the dialog's cleanup. Restore here,
    // through the existing modal eligibility guard, once that DOM commit is done.
    if (wasOpen.current && !open && canFocusElement(trigger.current)) trigger.current?.focus({ preventScroll: true });
    wasOpen.current = open;
  }, [open]);

  const accept = useCallback((next: UpdateSnapshot) => {
    if (!alive.current || (latest.current && next.revision <= latest.current.revision)) return;
    latest.current = next;
    setSnapshot(next);
    setError(null);
    setConfirmation((current) => {
      if (!current || current.operationId !== next.operationId) return null;
      return (current.action === "install" ? next.canInstall : next.canActivate) ? current : null;
    });
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!connection) return;
    let active = true;
    const unsubscribe = subscribeUpdates(
      (next) => {
        if (active) accept(next);
      },
      () => {
        if (active) setError("connection");
      },
    );
    void getUpdateSnapshot().then(
      (next) => {
        if (active) accept(next);
      },
      () => {
        if (active) setError("request");
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [connection, accept]);

  useEffect(() => {
    if (snapshot?.phase !== "activating") return;
    // Boot replacement is owned by App's existing configuration subscription.
    // This timer supplies recovery, never fabricates update success or polls.
    const timer = window.setTimeout(() => setError("timeout"), 90_000);
    return () => window.clearTimeout(timer);
  }, [snapshot?.phase]);

  const close = () => {
    setOpen(false);
    setConfirmation(null);
    onOpenChange?.(false);
  };
  const show = () => {
    setOpen(true);
    setError(null);
    setConnection((value) => value + 1);
    onOpenChange?.(true);
  };

  const run = async (action: UpdateAction) => {
    const cancellingAction = action.action === "cancel";
    if (cancellationRef.current !== null || (!cancellingAction && pendingRef.current !== null)) return;
    const current = latest.current;
    const allowed =
      action.action === "check"
        ? !current || (!working.has(current.phase) && !current.canActivate)
        : current &&
          action.operationId === current.operationId &&
          (action.action === "install"
            ? current.canInstall
            : action.action === "activate"
              ? current.canActivate
              : action.action === "download"
                ? current.canDownload
                : action.action === "reveal"
                  ? current.owner === "desktop" && current.canReveal
                  : current.canCancel);
    if (!allowed) {
      setConfirmation(null);
      return;
    }
    const sequence = ++requestSequence.current;
    if (cancellingAction) {
      cancellationRef.current = sequence;
      setCancelling(true);
      // Cancellation supersedes a lost install acknowledgement. Its eventual
      // reply cannot restore controls or clear a newer request's pending state.
      pendingRef.current = null;
      setPending(false);
    } else {
      pendingRef.current = sequence;
      setPending(true);
    }
    setError(null);
    try {
      const result = await requestUpdateAction(action);
      if (!alive.current || requestSequence.current !== sequence) return;
      if ("code" in result) {
        if (
          (action.action === "install" || action.action === "activate") &&
          action.operationId &&
          action.operationId === latest.current?.operationId &&
          (action.action === "install" ? latest.current.canInstall : latest.current.canActivate)
        ) {
          setConfirmation({ action: action.action, operationId: action.operationId, busy: result });
        }
      } else {
        accept(result);
        setConfirmation(null);
      }
    } catch {
      if (alive.current && requestSequence.current === sequence) setError("request");
    } finally {
      if (pendingRef.current === sequence) {
        pendingRef.current = null;
        if (alive.current) setPending(false);
      }
      if (cancellationRef.current === sequence) {
        cancellationRef.current = null;
        if (alive.current) setCancelling(false);
      }
    }
  };

  const newer = snapshot ? (snapshot.phase === "current" ? null : snapshot.latestVersion) : latestVersion;
  return (
    <>
      <button
        ref={trigger}
        type="button"
        onClick={show}
        aria-label={`${t("update.title")} · v${currentVersion}`}
        title={t("update.title")}
        className="min-h-7 shrink-0 rounded-md border border-v2-grey-300 bg-v2-background-bg-base px-1.5 font-mono text-[11px] text-v2-text-text-muted hover:bg-v2-grey-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v2-blue-600"
      >
        v{currentVersion}
      </button>
      {newer && (
        <span role="status" className="truncate text-[12px] font-medium text-v2-text-text-accent">
          {t("home.updateAvailable")} <span className="font-mono">v{newer}</span>
        </span>
      )}
      {open &&
        createPortal(
          <UpdateDialog
            snapshot={snapshot}
            currentVersion={currentVersion}
            pending={pending || cancelling}
            cancelling={cancelling}
            error={error}
            confirmation={confirmation}
            onConfirm={setConfirmation}
            onAction={run}
            onClose={close}
          />,
          document.body,
        )}
    </>
  );
}

function UpdateDialog({
  snapshot,
  currentVersion,
  pending,
  cancelling,
  error,
  confirmation,
  onConfirm,
  onAction,
  onClose,
}: {
  snapshot: UpdateSnapshot | null;
  currentVersion: string;
  pending: boolean;
  cancelling: boolean;
  error: "request" | "connection" | "timeout" | null;
  confirmation: Confirmation | null;
  onConfirm(value: Confirmation | null): void;
  onAction(value: UpdateAction): Promise<void>;
  onClose(): void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const layer = useModalLayer(onClose, ref);
  const title = useId();
  const [copy, setCopy] = useState<"copied" | "failed" | null>(null);
  const busy = snapshot && working.has(snapshot.phase);
  const operationId = snapshot?.operationId;
  const install = (action: "install" | "activate") => {
    if (operationId) onConfirm({ action, operationId });
  };
  const copyCommand = async () => {
    if (!snapshot?.manualCommand) return;
    try {
      await navigator.clipboard.writeText(snapshot.manualCommand);
      setCopy("copied");
    } catch {
      setCopy("failed");
      field.current?.focus();
      field.current?.select();
    }
  };
  const description =
    confirmation?.action === "install" && snapshot?.owner === "cli"
      ? "update.installDescription"
      : "update.restartDescription";
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/20 p-4" {...layer.layerProps}>
      <section
        ref={ref}
        role="dialog"
        {...layer.dialogProps}
        aria-labelledby={title}
        className="flex max-h-[calc(100dvh-32px)] w-full max-w-[520px] flex-col overflow-hidden rounded-xl border border-v2-grey-200 bg-v2-background-bg-base text-v2-text-text-base shadow-[var(--v2-elevation-overlay)]"
      >
        <header className="flex items-center justify-between border-b border-v2-grey-200 px-4 py-3">
          <h2 id={title} className="text-[14px] font-semibold">
            {t("update.title")}
          </h2>
          <button
            type="button"
            aria-label={t("dialog.close")}
            onClick={onClose}
            className="flex size-8 items-center justify-center rounded-md hover:bg-v2-grey-100"
          >
            <X size={16} aria-hidden />
          </button>
        </header>
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto overscroll-contain p-4 text-[13px]">
          <div className="flex flex-wrap justify-between gap-2 font-mono text-[12px] text-v2-text-text-muted">
            <span>{t("update.currentVersion").replace("{version}", snapshot?.currentVersion ?? currentVersion)}</span>
            {snapshot?.latestVersion && (
              <span>{t("update.latestVersion").replace("{version}", snapshot.latestVersion)}</span>
            )}
          </div>
          <p role={busy ? undefined : "status"}>{t(`update.${snapshot?.phase ?? "idle"}`)}</p>
          {busy && (
            <progress
              aria-label={t(`update.${snapshot.phase}`)}
              className="w-full accent-v2-blue-600"
              value={
                snapshot.phase !== "downloading" || snapshot.bytesTotal === undefined
                  ? undefined
                  : (snapshot.bytesReceived ?? 0)
              }
              max={snapshot.phase === "downloading" ? snapshot.bytesTotal : undefined}
            />
          )}
          {snapshot?.message && (
            <p
              role={snapshot.phase === "failed" ? "alert" : undefined}
              className="whitespace-pre-wrap break-words text-v2-text-text-muted"
            >
              {snapshot.message}
            </p>
          )}
          {error && (
            <p role="alert" className="text-v2-status-error">
              {t(
                error === "timeout"
                  ? "update.activationTimeout"
                  : error === "connection"
                    ? "update.connectionError"
                    : "update.requestError",
              )}
            </p>
          )}
          {confirmation ? (
            <div className="flex flex-col gap-3 rounded-lg border border-v2-grey-300 p-3">
              <p>{t(description)}</p>
              {confirmation.busy && (
                <p role="alert">{t("update.busy").replace("{n}", String(confirmation.busy.activeSessions))}</p>
              )}
              {confirmation.busy?.authFlowActive && <p>{t("update.authBusy")}</p>}
              <div className="flex flex-wrap justify-end gap-2">
                <button type="button" className="er-outlined-button" onClick={() => onConfirm(null)} disabled={pending}>
                  {t("update.back")}
                </button>
                <button
                  type="button"
                  className="er-outlined-button"
                  disabled={pending}
                  onClick={() =>
                    void onAction({
                      action: confirmation.action,
                      operationId: confirmation.operationId,
                      ...(confirmation.busy ? { force: true } : {}),
                    })
                  }
                >
                  {t(
                    confirmation.busy
                      ? "update.force"
                      : confirmation.action === "install"
                        ? "update.confirmInstall"
                        : "update.confirmRestart",
                  )}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {!busy && !snapshot?.canActivate && (
                <button
                  type="button"
                  className="er-outlined-button"
                  disabled={pending}
                  onClick={() => void onAction({ action: "check" })}
                >
                  {t("update.check")}
                </button>
              )}
              {snapshot?.canDownload && operationId && (
                <button
                  type="button"
                  className="er-outlined-button"
                  disabled={pending}
                  onClick={() => void onAction({ action: "download", operationId })}
                >
                  {t("update.download")}
                </button>
              )}
              {snapshot?.canInstall && (
                <button
                  type="button"
                  className="er-outlined-button"
                  disabled={pending}
                  onClick={() => install("install")}
                >
                  {t("update.install")}
                </button>
              )}
              {snapshot?.canActivate && (
                <button
                  type="button"
                  className="er-outlined-button"
                  disabled={pending}
                  onClick={() => install("activate")}
                >
                  {t("update.activate")}
                </button>
              )}
              {snapshot?.owner === "desktop" && snapshot.canReveal && operationId && (
                <button
                  type="button"
                  className="er-outlined-button"
                  disabled={pending}
                  onClick={() => void onAction({ action: "reveal", operationId })}
                >
                  {t("update.reveal")}
                </button>
              )}
              {snapshot?.canCancel && operationId && (
                <button
                  type="button"
                  className="er-outlined-button"
                  disabled={cancelling}
                  onClick={() => void onAction({ action: "cancel", operationId })}
                >
                  {t("update.cancel")}
                </button>
              )}
            </div>
          )}
          {snapshot?.manualCommand && (
            <div className="flex flex-col gap-2">
              <label className="text-v2-text-text-muted" htmlFor={`${title}-command`}>
                {t("update.command")}
              </label>
              <textarea
                id={`${title}-command`}
                ref={field}
                readOnly
                rows={4}
                value={snapshot.manualCommand}
                className="w-full resize-none rounded-lg border border-v2-grey-300 bg-v2-background-bg-deep p-3 font-mono text-[12px]"
              />
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" className="er-outlined-button" onClick={() => void copyCommand()}>
                  {t("update.copy")}
                </button>
                <span role="status" className="text-v2-text-text-muted">
                  {copy && t(copy === "copied" ? "update.copied" : "update.copyFailed")}
                </span>
              </div>
            </div>
          )}
          {(snapshot?.owner === "desktop" || (!snapshot && window.easyresearchDesktop)) && (
            <a
              href={LATEST_RELEASE_PAGE}
              target="_blank"
              rel="noopener noreferrer"
              className="w-fit text-v2-text-text-accent underline underline-offset-2"
            >
              {t("update.release")}
            </a>
          )}
        </div>
      </section>
    </div>
  );
}
