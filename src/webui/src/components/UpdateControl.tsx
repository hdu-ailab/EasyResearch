import {
  ArrowDownToLine,
  ArrowUpCircle,
  Check,
  CircleAlert,
  CircleCheck,
  CircleMinus,
  Copy,
  ExternalLink,
  FolderOpen,
  LoaderCircle,
  PackageCheck,
  RotateCw,
  X,
} from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DesktopUpdateOpenIntent } from "../../../desktop/contracts";
import {
  LATEST_RELEASE_PAGE,
  type UpdateAction,
  type UpdateActionResult,
  type UpdatePhase,
  type UpdateSnapshot,
} from "../../../runtime/update-contract";
import { getUpdateSnapshot, requestUpdateAction, subscribeUpdates } from "../api/update";
import { canFocusElement, useModalLayer } from "../hooks/useModalLayer";
import { useI18n } from "../i18n/useI18n";
import { ProductMark } from "./Topbar";
import "./update-control.css";

type Confirmation = {
  action: "install" | "activate";
  operationId: string;
  busy?: Extract<UpdateActionResult, { code: "RUNTIME_BUSY" }>;
};

const working = new Set(["checking", "downloading", "installing", "verifying", "activating"]);
const checkableIntentPhases = new Set<UpdatePhase>(["idle", "current", "failed", "cancelled"]);
const phaseIcons = {
  idle: ArrowUpCircle,
  checking: LoaderCircle,
  current: CircleCheck,
  available: ArrowDownToLine,
  downloading: ArrowDownToLine,
  downloaded: PackageCheck,
  installing: LoaderCircle,
  verifying: LoaderCircle,
  ready: RotateCw,
  activating: LoaderCircle,
  failed: CircleAlert,
  cancelled: CircleMinus,
} satisfies Record<UpdatePhase, typeof X>;

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
  const openRef = useRef(false);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const trigger = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  const [connection, setConnection] = useState(0);
  const connectionRef = useRef(0);
  const reading = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const intentRef = useRef<{
    kind: DesktopUpdateOpenIntent;
    connection: number;
    mutation: number;
    handled: boolean;
  } | null>(null);
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
  const confirmationRef = useRef(confirmation);
  confirmationRef.current = confirmation;

  useLayoutEffect(() => {
    // App removes its inert surface after the dialog's cleanup. Restore here,
    // through the existing modal eligibility guard, once that DOM commit is done.
    if (wasOpen.current && !open) {
      const target = canFocusElement(returnFocus.current) ? returnFocus.current : trigger.current;
      if (canFocusElement(target)) target.focus({ preventScroll: true });
    }
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

  const observing = connection > 0;
  useEffect(() => {
    if (!observing) return;
    let active = true;
    const unsubscribe = subscribeUpdates(
      (next) => {
        if (active) accept(next);
      },
      () => {
        if (active) setError("connection");
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [observing, accept]);

  useEffect(() => {
    if (snapshot?.phase !== "activating") return;
    // Boot replacement is owned by App's existing configuration subscription.
    // This timer supplies recovery, never fabricates update success or polls.
    const timer = window.setTimeout(() => setError("timeout"), 90_000);
    return () => window.clearTimeout(timer);
  }, [snapshot?.phase]);

  const close = () => {
    openRef.current = false;
    intentRef.current = null;
    connectionRef.current++;
    reading.current = false;
    setRefreshing(false);
    setOpen(false);
    setConfirmation(null);
    onOpenChangeRef.current?.(false);
  };
  const show = useCallback(() => {
    if (openRef.current) return false;
    const opener = document.activeElement;
    // Tray intents have no DOM invoker. Document roots are not focus-return
    // targets; use the header after App removes inert unless a real opener exists.
    returnFocus.current =
      opener instanceof HTMLElement && opener !== document.body && opener !== document.documentElement ? opener : null;
    openRef.current = true;
    setOpen(true);
    setError(null);
    onOpenChangeRef.current?.(true);
    return true;
  }, []);

  const refresh = useCallback(() => {
    const next = ++connectionRef.current;
    reading.current = true;
    setRefreshing(true);
    setConnection(next);
    return next;
  }, []);

  const run = useCallback(
    async (action: UpdateAction) => {
      if (!alive.current) return;
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
      if (intentRef.current) intentRef.current.handled = true;
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
    },
    [accept],
  );

  useEffect(() => {
    if (!connection) return;
    let active = true;
    // The live subscription is established before this snapshot barrier. A newer
    // event always wins, including when a tray request arrives during startup.
    void getUpdateSnapshot().then(
      (next) => {
        if (!active || !alive.current || connection !== connectionRef.current) return;
        accept(next);
        if (next.revision >= (latest.current?.revision ?? 0)) setError(null);
        reading.current = false;
        setRefreshing(false);
        const intent = intentRef.current;
        if (!openRef.current || !intent || intent.connection !== connection || intent.handled) return;
        intent.handled = true;
        const current = latest.current;
        if (
          intent.kind === "check" &&
          intent.mutation === requestSequence.current &&
          pendingRef.current === null &&
          cancellationRef.current === null &&
          confirmationRef.current === null &&
          current &&
          checkableIntentPhases.has(current.phase) &&
          !current.canDownload &&
          !current.canInstall &&
          !current.canActivate &&
          !current.canReveal &&
          !current.canCancel
        ) {
          void run({ action: "check" });
        }
      },
      () => {
        if (!active || !alive.current || connection !== connectionRef.current) return;
        reading.current = false;
        setRefreshing(false);
        setError("request");
      },
    );
    return () => {
      active = false;
    };
  }, [connection, accept, run]);

  const openFromHost = useCallback(
    (intent: DesktopUpdateOpenIntent) => {
      if (!alive.current) return;
      show();
      const previous = intentRef.current;
      // Repeated tray requests are one view intent. Recovery wins for the entire
      // open view, so a later check cannot erase an install failure or its recovery.
      if (previous?.kind === "recovery" || (previous?.kind === "check" && intent === "check")) return;
      const next = intent === "check" && reading.current ? connectionRef.current : refresh();
      intentRef.current = {
        kind: intent,
        connection: next,
        mutation: requestSequence.current,
        handled: pendingRef.current !== null || cancellationRef.current !== null || confirmationRef.current !== null,
      };
    },
    [refresh, show],
  );

  useEffect(() => window.easyresearchDesktop?.onOpenUpdates?.(openFromHost), [openFromHost]);

  const newer = snapshot ? (snapshot.phase === "current" ? null : snapshot.latestVersion) : latestVersion;
  return (
    <>
      <button
        ref={trigger}
        type="button"
        onClick={() => {
          if (show()) refresh();
        }}
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
            pending={pending || cancelling || refreshing}
            loading={!snapshot && refreshing}
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
  loading,
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
  loading: boolean;
  cancelling: boolean;
  error: "request" | "connection" | "timeout" | null;
  confirmation: Confirmation | null;
  onConfirm(value: Confirmation | null): void;
  onAction(value: UpdateAction): Promise<void>;
  onClose(): void;
}) {
  const { t, language } = useI18n();
  const ref = useRef<HTMLElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  const primaryButton = useRef<HTMLButtonElement>(null);
  const hadConfirmation = useRef(false);
  const layer = useModalLayer(onClose, ref);
  const title = useId();
  const [copy, setCopy] = useState<{ command: string; status: "copied" | "failed" } | null>(null);
  const copyStatus = copy?.command === snapshot?.manualCommand ? copy?.status : null;
  const phase = snapshot?.phase ?? "idle";
  const busy = loading || working.has(phase);
  const PhaseIcon = loading ? LoaderCircle : phaseIcons[phase];
  const operationId = snapshot?.operationId;
  const desktop = snapshot?.owner === "desktop" || (!snapshot && !!window.easyresearchDesktop);
  const canCheck = !working.has(phase) && !snapshot?.canActivate;
  const primary = snapshot?.canActivate
    ? "activate"
    : snapshot?.canInstall
      ? "install"
      : snapshot?.canDownload
        ? "download"
        : desktop && snapshot?.canReveal
          ? "reveal"
          : desktop && (phase === "failed" || error)
            ? "release"
            : canCheck
              ? "check"
              : null;
  const number = useMemo(() => new Intl.NumberFormat(language, { maximumFractionDigits: 1 }), [language]);
  const formatBytes = (bytes: number) => {
    const units = ["B", "KiB", "MiB", "GiB"];
    const unit = bytes > 0 ? Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1) : 0;
    return `${number.format(bytes / 1024 ** unit)} ${units[unit]}`;
  };
  const received = phase === "downloading" ? snapshot?.bytesReceived : undefined;
  const total = phase === "downloading" ? snapshot?.bytesTotal : undefined;
  const measured = received !== undefined && total !== undefined && total > 0;
  const progressText =
    received === undefined
      ? null
      : total !== undefined && total > 0
        ? t("update.downloadSize").replace("{received}", formatBytes(received)).replace("{total}", formatBytes(total))
        : t("update.downloadReceived").replace("{received}", formatBytes(received));
  const availableVersion =
    snapshot?.latestVersion && phase !== "current" && snapshot.latestVersion !== snapshot.currentVersion
      ? snapshot.latestVersion
      : null;
  const buttonClass = (action: string) => `er-update-button${primary === action ? " er-update-primary" : ""}`;

  useLayoutEffect(() => {
    if (confirmation && !hadConfirmation.current && canFocusElement(backButton.current)) {
      backButton.current.focus({ preventScroll: true });
    } else if (!confirmation && hadConfirmation.current && !ref.current?.contains(document.activeElement)) {
      const target = primaryButton.current ?? closeButton.current;
      if (canFocusElement(target)) target.focus({ preventScroll: true });
    }
    hadConfirmation.current = !!confirmation;
  }, [confirmation]);

  const install = (action: "install" | "activate") => {
    if (operationId) onConfirm({ action, operationId });
  };
  const copyCommand = async () => {
    const command = snapshot?.manualCommand;
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      if (field.current?.value === command) setCopy({ command, status: "copied" });
    } catch {
      if (field.current?.value !== command) return;
      setCopy({ command, status: "failed" });
      if (canFocusElement(field.current)) {
        field.current.focus();
        field.current.select();
      }
    }
  };
  const description =
    confirmation?.action === "install" && snapshot?.owner === "cli"
      ? "update.installDescription"
      : "update.restartDescription";
  return (
    <div className="er-update-overlay" {...layer.layerProps}>
      <section ref={ref} role="dialog" {...layer.dialogProps} aria-labelledby={title} className="er-update-dialog">
        <header className="er-update-header">
          <div className="er-update-identity">
            <ProductMark />
            <h2 id={title}>{t("update.title")}</h2>
          </div>
          <button
            ref={closeButton}
            type="button"
            aria-label={t("dialog.close")}
            onClick={onClose}
            className="er-update-close"
          >
            <X size={16} aria-hidden />
          </button>
        </header>
        <div className="er-update-body">
          <div className="er-update-status" data-phase={phase}>
            <span className="er-update-phase-icon" aria-hidden="true">
              <PhaseIcon size={23} className={PhaseIcon === LoaderCircle ? "er-update-spinner" : undefined} />
            </span>
            <h3 id={`${title}-phase`}>
              <span role={busy ? undefined : "status"}>{t(loading ? "update.loading" : `update.${phase}`)}</span>
            </h3>
          </div>
          <dl className="er-update-versions">
            <div>
              <dt>{t("update.currentVersion")}</dt>
              <dd>v{snapshot?.currentVersion ?? currentVersion}</dd>
            </div>
            {availableVersion && (
              <div>
                <dt>{t("update.latestVersion")}</dt>
                <dd>v{availableVersion}</dd>
              </div>
            )}
          </dl>
          {busy && (
            <div className="er-update-progress">
              <progress
                aria-labelledby={`${title}-phase`}
                aria-describedby={progressText ? `${title}-progress` : undefined}
                value={measured ? received : undefined}
                max={measured ? total : undefined}
              />
              {progressText && (
                <div id={`${title}-progress`} className="er-update-progress-details">
                  <span>{progressText}</span> {measured && <span>{Math.floor((received / total) * 100)}%</span>}
                </div>
              )}
            </div>
          )}
          {snapshot?.message && (
            <p role={snapshot.phase === "failed" ? "alert" : undefined} className="er-update-message">
              {snapshot.message}
            </p>
          )}
          {error && (
            <p role="alert" className="er-update-error">
              {t(
                error === "timeout"
                  ? "update.activationTimeout"
                  : error === "connection"
                    ? "update.connectionError"
                    : "update.requestError",
              )}
            </p>
          )}
          {confirmation && (
            <div className="er-update-confirmation" id={`${title}-confirmation`}>
              <p>{t(description)}</p>
              {confirmation.busy && (
                <p role="alert">{t("update.busy").replace("{n}", String(confirmation.busy.activeSessions))}</p>
              )}
              {confirmation.busy?.authFlowActive && <p>{t("update.authBusy")}</p>}
            </div>
          )}
          {snapshot?.manualCommand && (
            <div className="er-update-command">
              <label htmlFor={`${title}-command`}>{t("update.command")}</label>
              <textarea
                id={`${title}-command`}
                ref={field}
                readOnly
                rows={3}
                spellCheck={false}
                value={snapshot.manualCommand}
              />
              <div className="er-update-copy">
                <button type="button" className="er-update-button" onClick={() => void copyCommand()}>
                  {copyStatus === "copied" ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
                  {t("update.copy")}
                </button>
                <span role="status">
                  {copyStatus && t(copyStatus === "copied" ? "update.copied" : "update.copyFailed")}
                </span>
              </div>
            </div>
          )}
        </div>
        <footer className="er-update-footer">
          {desktop && !confirmation && (
            <a
              href={LATEST_RELEASE_PAGE}
              target="_blank"
              rel="noopener noreferrer"
              className={primary === "release" ? "er-update-button er-update-primary" : "er-update-release"}
            >
              {t("update.release")}
              <ExternalLink size={14} aria-hidden />
            </a>
          )}
          {confirmation ? (
            <>
              <button
                ref={backButton}
                type="button"
                className="er-update-button"
                onClick={() => onConfirm(null)}
                disabled={pending}
              >
                {t("update.back")}
              </button>
              <button
                type="button"
                className="er-update-button er-update-primary"
                aria-describedby={`${title}-confirmation`}
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
            </>
          ) : (
            <>
              {canCheck && (
                <button
                  ref={primary === "check" ? primaryButton : undefined}
                  type="button"
                  className={buttonClass("check")}
                  disabled={pending}
                  onClick={() => void onAction({ action: "check" })}
                >
                  {t("update.check")}
                </button>
              )}
              {snapshot?.canDownload && operationId && (
                <button
                  ref={primary === "download" ? primaryButton : undefined}
                  type="button"
                  className={buttonClass("download")}
                  disabled={pending}
                  onClick={() => void onAction({ action: "download", operationId })}
                >
                  <ArrowDownToLine size={15} aria-hidden />
                  {t("update.download")}
                </button>
              )}
              {snapshot?.canInstall && (
                <button
                  ref={primary === "install" ? primaryButton : undefined}
                  type="button"
                  className={buttonClass("install")}
                  disabled={pending}
                  onClick={() => install("install")}
                >
                  {t("update.install")}
                </button>
              )}
              {snapshot?.canActivate && (
                <button
                  ref={primary === "activate" ? primaryButton : undefined}
                  type="button"
                  className={buttonClass("activate")}
                  disabled={pending}
                  onClick={() => install("activate")}
                >
                  <RotateCw size={15} aria-hidden />
                  {t("update.activate")}
                </button>
              )}
              {snapshot?.owner === "desktop" && snapshot.canReveal && operationId && (
                <button
                  ref={primary === "reveal" ? primaryButton : undefined}
                  type="button"
                  className={buttonClass("reveal")}
                  disabled={pending}
                  onClick={() => void onAction({ action: "reveal", operationId })}
                >
                  <FolderOpen size={15} aria-hidden />
                  {t("update.reveal")}
                </button>
              )}
            </>
          )}
          {snapshot?.canCancel && operationId && (
            <button
              type="button"
              className="er-update-button"
              disabled={cancelling}
              onClick={() => void onAction({ action: "cancel", operationId })}
            >
              {t("update.cancel")}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
