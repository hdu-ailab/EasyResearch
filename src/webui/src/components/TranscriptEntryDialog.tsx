import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { TranscriptTimelineEntryDto } from "../../../web/contracts";
import { getTranscriptEntry } from "../api";
import { useModalLayer } from "../hooks/useModalLayer";
import { useI18n } from "../i18n/useI18n";
import { MarkdownBlock } from "./MarkdownBlock";

/** Explicit full-entry read; large JSON never passes through the shared event worker. */
export function TranscriptEntryDialog({
  sessionId,
  childId,
  entryId,
  onClose,
}: {
  sessionId: string;
  childId?: string;
  entryId: string;
  onClose(): void;
}) {
  const { t } = useI18n();
  const root = useRef<HTMLElement>(null);
  const { zIndex, dialogProps } = useModalLayer(onClose, root);
  const [content, setContent] = useState<{ identity: string; entry: TranscriptTimelineEntryDto }>();
  const identity = JSON.stringify([sessionId, childId ?? null, entryId]);
  const entry = content?.identity === identity ? content.entry : undefined;
  const summary = entry?.kind === "compaction" || entry?.kind === "branch-summary" ? entry : undefined;
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const currentAttempt = useRef(attempt);
  currentAttempt.current = attempt;
  useEffect(() => {
    const controller = new AbortController();
    setContent(undefined);
    setError(false);
    void getTranscriptEntry(sessionId, entryId, childId, controller.signal)
      .then((entry) => {
        if (!controller.signal.aborted && currentAttempt.current === attempt) setContent({ identity, entry });
      })
      .catch(() => {
        if (!controller.signal.aborted && currentAttempt.current === attempt) setError(true);
      });
    return () => controller.abort();
  }, [sessionId, childId, entryId, attempt, identity]);
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/20 p-4" style={{ zIndex }}>
      <section
        ref={root}
        role="dialog"
        {...dialogProps}
        aria-labelledby="transcript-entry-title"
        className="flex h-[min(720px,calc(100vh-32px))] w-full max-w-[900px] flex-col overflow-hidden rounded-xl border border-v2-grey-200 bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]"
      >
        <header className="flex items-center justify-between border-b border-v2-grey-200 px-4 py-3">
          <h2 id="transcript-entry-title" className="text-[14px] font-semibold">
            {t("transcript.fullEntry")}
          </h2>
          <button
            type="button"
            aria-label={t("dialog.close")}
            onClick={onClose}
            className="rounded-md p-1 hover:bg-v2-grey-100"
          >
            <X size={16} />
          </button>
        </header>
        {summary ? (
          <div className="min-h-0 flex-1 overflow-auto p-4" data-scrollable>
            <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-v2-text-text-muted">
              <span>{t(summary.kind === "compaction" ? "transcript.sessionCompacted" : "chat.branchSummary")}</span>
              <span>
                {t(childId ? "chat.childScope" : "chat.sessionScope")}: <code>{childId ?? sessionId}</code>
              </span>
              <code>{summary.entryId}</code>
            </div>
            <MarkdownBlock
              text={
                summary.summary ??
                t(
                  summary.kind === "compaction"
                    ? "transcript.compactionSummaryUnavailable"
                    : "transcript.branchSummaryUnavailable",
                )
              }
              scope={`full-entry:${identity}`}
              cacheKey={`${summary.entryId}:summary`}
              className="v2-md text-[length:var(--v2-chat-font-size)]"
            />
          </div>
        ) : entry !== undefined ? (
          <textarea
            readOnly
            spellCheck={false}
            aria-label={t("transcript.fullEntry")}
            value={JSON.stringify(entry, null, 2)}
            className="min-h-0 w-full flex-1 resize-none bg-v2-background-bg-base p-4 font-mono text-[12px] text-v2-text-text-base outline-none"
          />
        ) : error ? (
          <div role="alert" className="flex gap-2 p-4 text-[12px] text-v2-status-error">
            <span>{t("transcript.historyError")}</span>
            <button type="button" className="underline" onClick={() => setAttempt((n) => n + 1)}>
              {t("usage.retry")}
            </button>
          </div>
        ) : (
          <p className="p-4 text-[12px] text-v2-text-text-muted">{t("dialog.loading")}</p>
        )}
      </section>
    </div>
  );
}
