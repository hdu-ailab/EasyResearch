import { ArrowLeft, Bot, ChevronUp, Terminal, X } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { BackgroundTask } from "../../../background/contracts";
import { canFocusElement } from "../hooks/useModalLayer";
import { type BackgroundOutputSubscription, useShellOutput } from "../hooks/useShellOutput";
import { agentDisplayName } from "../i18n/agents";
import { useI18n } from "../i18n/useI18n";
import { useViewActivityRef } from "../view-activity";
import "./background-task-controls.css";

const noEvents: BackgroundOutputSubscription = () => () => {};

export function BackgroundTaskControls({
  rootId,
  tasks,
  pending,
  error,
  disabled,
  onCancel,
  onPromote,
  leaseId = null,
  subscribeOutput = noEvents,
  onOpenSubagent,
  onDismiss,
}: {
  rootId: string;
  tasks: readonly BackgroundTask[];
  pending: readonly string[];
  error: string | null;
  disabled: boolean;
  onCancel: (id: string) => Promise<boolean>;
  onPromote: () => Promise<boolean>;
  leaseId?: string | null;
  subscribeOutput?: BackgroundOutputSubscription;
  onOpenSubagent?: (task: BackgroundTask) => void;
  onDismiss?: () => void;
}) {
  const { t } = useI18n();
  const activity = useViewActivityRef();
  const [documentVisible, setDocumentVisible] = useState(document.visibilityState !== "hidden");
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<BackgroundTask | null>(null);
  const [now, setNow] = useState(Date.now());
  const [position, setPosition] = useState({ left: 8, bottom: 8, maxHeight: 320 });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const scroller = useRef<HTMLElement>(null);
  const focusedControl = useRef<HTMLElement | null>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const focusIntent = useRef<"back" | "first" | string | null>(null);
  const focusFrame = useRef<number | undefined>(undefined);
  const revision = useRef(0);
  const id = useId();
  const running = tasks.filter((task) => task.status === "running");
  const currentTask = selected ? tasks.find((task) => task.id === selected.id) : undefined;
  const showing = open && activity.current.visible && activity.current.interactive && documentVisible;
  const blocking = running.some((task) => task.kind === "shell" && task.sessionID === rootId && task.blocking);
  const output = useShellOutput({
    rootId,
    taskId: selected?.id,
    taskStatus: currentTask?.status ?? "missing",
    leaseId,
    enabled: showing && !disabled,
    revision,
    subscribe: subscribeOutput,
  });
  const metadata = output.metadata;
  const status = metadata?.status ?? currentTask?.status;
  const selectedRunning = currentTask?.status === "running" && (!metadata || metadata.status === "running");
  const tail = output.text.trimEnd().split("\n").slice(-14).join("\n");
  const startedAt = metadata?.startedAt ?? selected?.startedAt;
  const title = t("background.title");
  const cancelLabel = (task: BackgroundTask) =>
    t(task.kind === "shell" ? "background.cancelShell" : "background.cancelAgent").replace(
      "{name}",
      task.description || task.command || task.id,
    );
  const elapsed = (started: number) =>
    t("background.elapsed").replace("{seconds}", String(Math.max(0, Math.floor((now - started) / 1000))));

  const close = useCallback(
    (restore: boolean) => {
      setOpen(false);
      setSelected(null);
      focusIntent.current = null;
      if (!restore) return;
      cancelAnimationFrame(focusFrame.current ?? 0);
      focusFrame.current = requestAnimationFrame(() => {
        if (!activity.current.interactive || document.visibilityState === "hidden") return;
        onDismiss?.();
        if (!onDismiss && canFocusElement(trigger.current)) trigger.current.focus({ preventScroll: true });
      });
    },
    [activity, onDismiss],
  );

  useEffect(() => {
    const changed = () => setDocumentVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", changed);
    return () => {
      document.removeEventListener("visibilitychange", changed);
      cancelAnimationFrame(focusFrame.current ?? 0);
    };
  }, []);

  useLayoutEffect(() => {
    if (!showing) return;
    const place = () => {
      if (!trigger.current) return;
      const anchor = trigger.current.getBoundingClientRect();
      const width = Math.min(selected ? 560 : 360, window.innerWidth - 16);
      const bottom = Math.max(8, Math.min(window.innerHeight - 72, window.innerHeight - anchor.top + 8));
      setPosition({
        left: Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8)),
        bottom,
        maxHeight: Math.min(selected ? 320 : 270, window.innerHeight - bottom - 8),
      });
    };
    place();
    const moved = (event: Event) => {
      if (!(event.target instanceof Node) || !panel.current?.contains(event.target)) place();
    };
    window.addEventListener("resize", place);
    window.addEventListener("scroll", moved, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", moved, true);
    };
  }, [showing, selected]);

  useLayoutEffect(() => {
    void selected; // Selection replaces the focused row/header DOM.
    if (!showing) {
      focusIntent.current = null;
      return;
    }
    if (!focusIntent.current) return;
    const intent = focusIntent.current;
    focusIntent.current = null;
    const target =
      intent === "back"
        ? back.current
        : (rows.current.get(intent) ?? panel.current?.querySelector<HTMLButtonElement>("button[data-task-open]"));
    target?.focus({ preventScroll: true });
  }, [showing, selected]);

  useLayoutEffect(() => {
    if (!showing) {
      focusedControl.current = null;
      return;
    }
    // Completion can remove a focused Stop control or task row without changing
    // the selected pane. Preserve its keyboard owner, never an outside focus.
    if (focusedControl.current?.isConnected !== false || document.activeElement !== document.body) return;
    const target = back.current ?? panel.current?.querySelector<HTMLButtonElement>("button:not(:disabled)") ?? null;
    if (canFocusElement(target)) target.focus({ preventScroll: true });
  });

  useEffect(() => {
    if (!showing) return;
    const outside = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node))
        close(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [showing, close]);

  const ticking = showing && (selected ? status === "running" : running.length > 0);
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);

  useLayoutEffect(() => {
    if (showing && tail && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [showing, tail]);

  useEffect(() => {
    if (open && !selected && running.length === 0 && !error)
      close(
        showing &&
          (document.activeElement === document.body || panel.current?.contains(document.activeElement) === true),
      );
  }, [open, selected, running.length, error, close, showing]);

  if (!running.length && !selected && !error) return null;
  const endLabel = metadata?.timeout
    ? t("background.timedOut")
    : status === "cancelled"
      ? t("background.cancelled")
      : metadata?.exitCode !== null && metadata?.exitCode !== undefined
        ? t("background.exitCode").replace("{code}", String(metadata.exitCode))
        : status === "error"
          ? t("background.errored")
          : status === "completed"
            ? t("background.completed")
            : t("background.finishing");

  return (
    <div className="er-background-capsule" data-background-tasks>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={showing}
        aria-controls={showing ? id : undefined}
        disabled={disabled}
        className="er-background-trigger"
        onClick={() => {
          if (open) close(true);
          else {
            focusIntent.current = "first";
            setOpen(true);
          }
        }}
      >
        <Terminal size={14} aria-hidden />
        <span>{selected && !running.length ? t("background.outputTitle") : `${title} · ${running.length}`}</span>
        <ChevronUp size={12} aria-hidden />
      </button>
      {blocking ? (
        <button
          type="button"
          className="er-background-action"
          disabled={disabled || pending.includes("promote")}
          onClick={() => void onPromote()}
        >
          {t("background.move")}
        </button>
      ) : null}
      {!showing && error ? (
        <p role="alert" className="er-background-error">
          {error}
        </p>
      ) : null}
      {showing &&
        createPortal(
          <div
            id={id}
            ref={panel}
            role="dialog"
            aria-label={selected ? t("background.outputTitle") : title}
            className={`er-background-panel ${selected ? "er-background-panel-shell" : ""}`}
            style={position}
            onFocusCapture={(event) => {
              focusedControl.current = event.target;
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.stopPropagation();
                close(true);
              }
            }}
            onBlur={(event) => {
              if (
                event.relatedTarget &&
                !event.currentTarget.contains(event.relatedTarget) &&
                event.relatedTarget !== trigger.current
              )
                close(false);
            }}
          >
            <div className="er-background-header">
              {selected ? (
                <button
                  ref={back}
                  type="button"
                  className="er-background-action"
                  aria-label={t("background.back")}
                  onClick={() => {
                    if (!running.length) close(true);
                    else {
                      focusIntent.current = selected.id;
                      setSelected(null);
                    }
                  }}
                >
                  <ArrowLeft size={16} aria-hidden />
                </button>
              ) : null}
              <span className="er-background-heading" title={selected?.command ?? selected?.description}>
                {selected ? selected.command || selected.description : title}
              </span>
              {selected && status === "running" && startedAt !== undefined ? (
                <span className="er-background-elapsed">{elapsed(startedAt)}</span>
              ) : null}
              {selected && selectedRunning ? (
                <button
                  type="button"
                  className="er-background-action"
                  aria-label={cancelLabel(selected)}
                  disabled={disabled || pending.includes(selected.id)}
                  onClick={() => void onCancel(selected.id)}
                >
                  {pending.includes(selected.id) ? t("background.stopping") : t("background.stop")}
                </button>
              ) : null}
              {selected && !selectedRunning && !output.error ? (
                <span
                  role="status"
                  className="er-background-end"
                  data-failed={metadata?.timeout || status === "error" || !!metadata?.exitCode || undefined}
                >
                  {endLabel}
                </span>
              ) : null}
              <button
                type="button"
                className="er-background-action"
                aria-label={t("background.close")}
                onClick={() => close(true)}
              >
                <X size={15} aria-hidden />
              </button>
            </div>
            {selected ? (
              <>
                {output.error ? (
                  <p role="alert" className="er-background-error">
                    {t(output.error === "unavailable" ? "background.outputUnavailable" : "background.outputFailed")}
                    <button type="button" className="er-background-action" onClick={output.retry}>
                      {t("background.retry")}
                    </button>
                  </p>
                ) : null}
                <section
                  ref={scroller}
                  aria-label={t("background.outputTitle")}
                  // biome-ignore lint/a11y/noNoninteractiveTabindex: The bounded output region needs native keyboard scrolling.
                  tabIndex={0}
                  data-scrollable
                  className="er-background-output"
                >
                  {tail ? (
                    <pre dir="ltr">
                      <code>{tail}</code>
                    </pre>
                  ) : !output.error ? (
                    <span className="er-background-empty">
                      {t(output.loading ? "background.loading" : "background.empty")}
                    </span>
                  ) : null}
                </section>
              </>
            ) : (
              <ul aria-label={title} className="er-background-list">
                {running.map((task) => (
                  <li key={task.id}>
                    {task.kind === "shell" ? <Terminal size={14} aria-hidden /> : <Bot size={14} aria-hidden />}
                    <button
                      type="button"
                      data-task-open
                      ref={(node) => {
                        if (node) rows.current.set(task.id, node);
                        else rows.current.delete(task.id);
                      }}
                      className="er-background-task"
                      data-kind={task.kind}
                      dir={task.kind === "shell" ? "ltr" : "auto"}
                      title={task.description || task.command || task.id}
                      aria-label={t(task.kind === "shell" ? "background.viewShell" : "background.viewAgent").replace(
                        "{name}",
                        task.description || task.command || task.id,
                      )}
                      onClick={() => {
                        if (task.kind === "shell") {
                          focusIntent.current = "back";
                          setSelected(task);
                        } else {
                          close(false);
                          onOpenSubagent?.(task);
                        }
                      }}
                    >
                      {task.kind === "subagent"
                        ? `${task.agent ? agentDisplayName(t, task.agent) : t("background.subagent")}: `
                        : ""}
                      {task.description || task.command || task.id}
                    </button>
                    {task.startedAt !== undefined ? (
                      <span className="er-background-elapsed">{elapsed(task.startedAt)}</span>
                    ) : null}
                    <button
                      type="button"
                      className="er-background-action"
                      aria-label={cancelLabel(task)}
                      disabled={disabled || pending.includes(task.id)}
                      onClick={() => void onCancel(task.id)}
                    >
                      {t("background.cancel")}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {error ? (
              <p role="alert" className="er-background-error">
                {error}
              </p>
            ) : null}
          </div>,
          document.body,
        )}
    </div>
  );
}
