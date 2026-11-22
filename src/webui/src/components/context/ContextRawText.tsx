import { useEffect, useRef, useState } from "react";
import type { ContextItemDto, ContextItemTextDto } from "../../../../web/context-contracts";
import { getContextItemText } from "../../api";
import { useI18n } from "../../i18n/useI18n";
import { useViewActivity } from "../../view-activity";
import { contextNumber, contextShare } from "./ContextStrip";
import { contextErrorCode } from "./useContextDraft";

export function ContextRawText({
  sessionId,
  revision,
  item,
  label,
  change,
  previewPending,
  onStale,
}: {
  sessionId: string;
  revision: string;
  item: ContextItemDto;
  label: string;
  change?: "fold" | "delete";
  previewPending: boolean;
  onStale(): void;
}) {
  const { t } = useI18n();
  const { interactive } = useViewActivity();
  const [view, setView] = useState<"original" | "current">("original");
  const [content, setContent] = useState<{ identity: string; page: ContextItemTextDto } | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [copied, setCopied] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const synthetic = view === "current" && change ? change : undefined;
  const waiting = view === "current" && previewPending;
  const identity = `${sessionId}\0${revision}\0${item.id}\0${view}\0${synthetic}\0${waiting}`;
  const page = content?.identity === identity ? content.page : null;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const load = async (offset: number) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const sequence = ++generation.current;
    setLoading(true);
    setError(false);
    try {
      const next = await getContextItemText(sessionId, revision, item.id, view, offset, controller.signal);
      if (controller.signal.aborted || sequence !== generation.current || currentIdentity.current !== identity) return;
      if (next.revision !== revision) {
        onStale();
        return;
      }
      if (next.itemId !== item.id || next.view !== view || next.offset !== offset)
        throw new Error("Mismatched context page");
      setContent((previous) => ({
        identity,
        page: {
          ...next,
          text: offset === 0 ? next.text : (previous?.identity === identity ? previous.page.text : "") + next.text,
        },
      }));
    } catch (error) {
      if (controller.signal.aborted || sequence !== generation.current || currentIdentity.current !== identity) return;
      if (contextErrorCode(error) === "CONTEXT_STALE") onStale();
      else setError(true);
    } finally {
      if (!controller.signal.aborted && sequence === generation.current && currentIdentity.current === identity)
        setLoading(false);
    }
  };
  // Identity owns all pages. Closing/switching/suspending cancels the view read.
  // biome-ignore lint/correctness/useExhaustiveDependencies: load is intentionally captured by the explicit complete identity.
  useEffect(() => {
    setContent(null);
    setCopied(null);
    setError(false);
    setLoading(false);
    if (interactive && !synthetic && !waiting) void load(0);
    return () => {
      request.current?.abort();
      generation.current += 1;
    };
  }, [identity, interactive, attempt]);
  const text =
    synthetic === "fold" ? "已折叠的工具输出" : synthetic === "delete" ? t("context.removedPreview") : page?.text;
  const copy = async () => {
    if (text === undefined) return;
    const captured = identity;
    const sequence = generation.current;
    try {
      await navigator.clipboard.writeText(text);
      if (currentIdentity.current === captured && sequence === generation.current) setCopied(t("context.copied"));
    } catch {
      if (currentIdentity.current === captured && sequence === generation.current) setCopied(t("context.copyError"));
    }
  };
  return (
    <section className="context-section context-raw" aria-label={t("context.raw")}>
      <div className="context-section-heading">
        <h3>{t("context.raw")}</h3>
        <button type="button" disabled={text === undefined || waiting} onClick={() => void copy()}>
          {t(page?.nextOffset != null ? "context.copyLoaded" : "studio.copy")}
        </button>
      </div>
      <p className="context-muted">
        {label} · {contextNumber(item.tokens)} tokens ·{" "}
        {t("context.segmentShare").replace("{share}", contextShare(item.segmentPercent))} ·{" "}
        {t("context.totalShare").replace("{share}", contextShare(item.percent))}
      </p>
      <fieldset className="context-raw-tabs" aria-label={t("context.textView")}>
        <button type="button" aria-pressed={view === "original"} onClick={() => setView("original")}>
          {t("context.original")}
        </button>
        <button type="button" aria-pressed={view === "current"} onClick={() => setView("current")}>
          {t("context.current")}
        </button>
      </fieldset>
      {waiting ? (
        <p>{t("context.previewing")}</p>
      ) : text !== undefined ? (
        <textarea
          readOnly
          spellCheck={false}
          aria-label={t(view === "original" ? "context.original" : "context.current")}
          value={text}
        />
      ) : null}
      {loading ? <p className="context-muted">{t("dialog.loading")}</p> : null}
      {error ? (
        <p role="alert">
          {t("context.readError")}{" "}
          <button
            type="button"
            onClick={() => (page?.nextOffset != null ? void load(page.nextOffset) : setAttempt((n) => n + 1))}
          >
            {t("usage.retry")}
          </button>
        </p>
      ) : null}
      {!synthetic && !waiting && page?.nextOffset != null ? (
        <button type="button" disabled={loading} onClick={() => void load(page.nextOffset as number)}>
          {t("context.loadMore")}
        </button>
      ) : null}
      <p role="status">{copied}</p>
    </section>
  );
}
