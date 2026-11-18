import { useCallback, useId, useRef } from "react";
import type { LlmRecoveryDto } from "../../../web/contracts";
import { useLlmRecovery } from "../hooks/useLlmRecovery";
import { useI18n } from "../i18n/useI18n";
import { useViewActivityRef } from "../view-activity";

export function LlmRecoveryBanner(props: {
  rootId: string;
  targetSessionId: string;
  parentHydrationRevision: number;
  hydrationRevision: number;
  recovery: LlmRecoveryDto | null | undefined;
  agentLabel: string;
  enabled: boolean;
  refresh(): void;
  returnFocus(): void;
}) {
  const { t } = useI18n();
  const activity = useViewActivityRef();
  const admission = useLlmRecovery(props);
  const statusId = useId();
  const button = useRef<HTMLButtonElement | null>(null);
  const callbacks = useRef(props);
  callbacks.current = props;
  const buttonRef = useCallback(
    (node: HTMLButtonElement | null) => {
      if (!node && button.current === document.activeElement && activity.current.interactive) {
        callbacks.current.returnFocus();
      }
      button.current = node;
    },
    [activity],
  );

  if (!props.recovery || props.recovery.targetSessionId !== props.targetSessionId || !props.enabled) return null;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-v2-grey-200 bg-v2-status-error/5 px-4 py-2 text-[13px]">
      <span
        id={statusId}
        role="status"
        aria-live={activity.current.interactive ? "polite" : "off"}
        className="min-w-0 break-words text-v2-status-warning"
      >
        {props.agentLabel} · {t(admission.busy ? "work.retryStarting" : "work.awaitingRetry")}
      </span>
      <button
        ref={buttonRef}
        type="button"
        aria-describedby={statusId}
        aria-disabled={admission.busy || !activity.current.interactive}
        onClick={() => {
          if (!admission.busy) void admission.retry();
        }}
        className={`min-h-8 rounded-md border border-v2-grey-200 px-3 py-1 text-v2-text-text-base aria-disabled:cursor-default aria-disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v2-blue-600 ${admission.busy ? "" : "hover:bg-v2-grey-100"}`}
      >
        {t("work.retryModelRequest")}
      </button>
      {admission.error ? (
        <p role="alert" className="w-full break-words text-v2-status-error">
          {admission.error}
        </p>
      ) : null}
    </div>
  );
}
