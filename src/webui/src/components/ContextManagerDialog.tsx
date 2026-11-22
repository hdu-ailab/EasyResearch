import { RefreshCw, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ContextEditDto, ContextItemDto } from "../../../web/context-contracts";
import { useModalLayer } from "../hooks/useModalLayer";
import { useI18n } from "../i18n/useI18n";
import { formatCacheHitRate } from "./ApiUsageLine";
import { ContextRawText } from "./context/ContextRawText";
import { type ContextBlock, ContextStrip, contextNumber } from "./context/ContextStrip";
import { useContextDraft } from "./context/useContextDraft";
import "./context/context-manager.css";

export function ContextManagerDialog({
  sessionId,
  refreshSignal,
  busy,
  compacting = false,
  onCompact,
  onClose,
}: {
  sessionId: string;
  refreshSignal: string;
  busy: boolean;
  compacting?: boolean;
  onCompact?(): Promise<unknown>;
  onClose(): void;
}) {
  const { t } = useI18n();
  const root = useRef<HTMLElement>(null);
  const { layerProps, dialogProps } = useModalLayer(onClose, root);
  const titleId = useId();
  const [compactPending, setCompactPending] = useState(false);
  const [compactError, setCompactError] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const draft = useContextDraft(sessionId, refreshSignal, busy || compacting || compactPending);
  const { invalidate, stale, edits } = draft;
  const previousCompacting = useRef(compacting);
  useEffect(() => {
    const started = compacting && !previousCompacting.current;
    previousCompacting.current = compacting;
    if (started && edits.length && !stale) invalidate();
  }, [compacting, edits.length, stale, invalidate]);
  const compact = async () => {
    if (!onCompact || compactPending || compacting || draft.applying) return;
    setCompactPending(true);
    setCompactError(false);
    try {
      await onCompact();
    } catch {
      if (mounted.current) setCompactError(true);
    } finally {
      if (mounted.current) setCompactPending(false);
    }
  };
  const { snapshot, preview } = draft;
  const [selection, setSelection] = useState<{ revision: string; segmentId: string; itemId?: string } | null>(null);
  const selected = selection?.revision === snapshot?.revision ? selection : null;
  const segment = snapshot?.segments.find((s) => s.id === selected?.segmentId);
  const itemsById = useMemo(() => new Map(snapshot?.items.map((item) => [item.id, item])), [snapshot]);
  const items =
    segment?.itemIds.flatMap((id) => {
      const item = itemsById.get(id);
      return item ? [item] : [];
    }) ?? [];
  const item = items.find((item) => item.id === selected?.itemId);
  const changes = new Map(preview?.changes.map((change) => [change.itemId, change.action]));
  const itemLabel = (item: ContextItemDto) => {
    switch (item.type) {
      case "tool-call":
        return `${t("context.toolCall")}${item.toolName ? ` · ${item.toolName}` : ""}`;
      case "tool-result":
        return t("context.toolResult")
          .replace("{name}", item.toolName ?? "")
          .trim();
      case "assistant":
        return t("context.reply");
      case "thinking":
        return t("context.thinking");
      case "system":
        return t("context.system");
      case "summary":
        return t("context.summary");
      case "user":
        return t("context.user");
    }
  };
  const itemBlocks: ContextBlock[] = items.map((item) => ({
    ...item,
    label: itemLabel(item),
    width: item.segmentPercent,
    change: changes.get(item.id),
  }));
  const blocks: ContextBlock[] =
    snapshot?.segments.map((segment) => {
      const actions = new Set(
        segment.itemIds.flatMap((id) => {
          const action = changes.get(id);
          return action ? [action] : [];
        }),
      );
      return {
        ...segment,
        label:
          segment.type === "system"
            ? t("context.system")
            : segment.preview || t(`context.${segment.type === "assistant" ? "reply" : segment.type}`),
        width: segment.percent,
        change:
          actions.size > 1 ? "mixed" : actions.has("delete") ? "delete" : actions.has("fold") ? "fold" : undefined,
      };
    }) ?? [];
  const locked = draft.stale || draft.applying || draft.checking;
  const stage = (target: ContextEditDto["target"], id: string, action: ContextEditDto["action"]) =>
    draft.stage({ target, id, action });
  const isBusy = busy || compacting || compactPending || snapshot?.busy;
  const errorKey =
    draft.error === "CONTEXT_STALE"
      ? "context.stale"
      : draft.error === "CONTEXT_BUSY"
        ? "context.busy"
        : draft.error === "CONTEXT_TOO_LARGE"
          ? "context.tooLarge"
          : draft.error === "CONTEXT_INVALID"
            ? "context.invalid"
            : "context.unavailable";
  return (
    <div className="context-backdrop" {...layerProps}>
      <section ref={root} role="dialog" {...dialogProps} aria-labelledby={titleId} className="context-manager">
        <header className="context-header">
          <div>
            <h2 id={titleId}>{t("context.title")}</h2>
            <p className="context-muted">
              {t("transcript.researchAssistant")}
              {snapshot?.model ? ` · ${snapshot.model.name}` : ""}
            </p>
          </div>
          <div className="context-header-actions">
            {onCompact ? (
              <button
                type="button"
                disabled={compacting || compactPending || draft.applying}
                onClick={() => void compact()}
              >
                {t(compacting || compactPending ? "context.compacting" : "context.compactAll")}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => {
                void draft.refresh();
                if (draft.stale) setSelection(null);
              }}
              disabled={draft.applying}
              aria-label={t("context.refresh")}
            >
              <RefreshCw size={15} aria-hidden />
              <span>{t("context.refresh")}</span>
            </button>
            <button type="button" aria-label={t("dialog.close")} onClick={onClose}>
              <X size={17} aria-hidden />
            </button>
          </div>
        </header>
        {snapshot ? (
          <div className="context-capacity">
            <span>
              {t("context.used")} <strong>{contextNumber(snapshot.totalTokens)} tokens</strong>
            </span>
            <span>
              {t("context.remaining")} <strong>{contextNumber(snapshot.remainingTokens)}</strong>
            </span>
            <span>
              {t("context.limit")} <strong>{contextNumber(snapshot.contextWindow)}</strong>
            </span>
            <span className="context-muted">{t("context.estimated")}</span>
          </div>
        ) : null}
        {isBusy ? <p className="context-notice">{t("context.busy")}</p> : null}
        {compactError ? (
          <p className="context-notice context-error" role="alert">
            {t("context.compactError")}
          </p>
        ) : null}
        {draft.error ? (
          <p className="context-notice context-error" role="alert">
            {t(errorKey)}
            {!draft.stale && draft.edits.length ? (
              <button type="button" onClick={draft.retryPreview}>
                {t("usage.retry")}
              </button>
            ) : null}
          </p>
        ) : null}
        <div className="context-body" aria-busy={draft.checking}>
          {snapshot ? (
            <>
              <section className="context-section">
                <div className="context-section-heading">
                  <h3>{t("context.overview")}</h3>
                  <span className="context-muted">{t("context.usedShare")}</span>
                </div>
                <ContextStrip
                  label={t("context.overview")}
                  blocks={blocks}
                  selected={segment?.id}
                  onSelect={(id) => {
                    const segment = snapshot.segments.find((segment) => segment.id === id);
                    if (segment)
                      setSelection({
                        revision: snapshot.revision,
                        segmentId: id,
                        ...(segment.type === "assistant" ? {} : { itemId: segment.itemIds[0] }),
                      });
                  }}
                />
                {segment?.type === "assistant" ? (
                  <fieldset className="context-scope" aria-label={t("context.segmentActions")}>
                    <div className="context-scope-label">
                      <strong>{t("context.segmentActions")}</strong>
                      <span>{segment.preview}</span>
                      <small>{t("context.segmentScope").replace("{count}", String(segment.itemIds.length))}</small>
                    </div>
                    <button
                      type="button"
                      disabled={locked || !segment.canFold}
                      onClick={() => stage("segment", segment.id, "fold")}
                    >
                      {t("context.foldSegment")}
                    </button>
                    <button
                      type="button"
                      className="context-danger"
                      disabled={locked || !segment.canDelete}
                      onClick={() => stage("segment", segment.id, "delete")}
                    >
                      {t("context.deleteSegment")}
                    </button>
                    <button
                      type="button"
                      disabled={locked || !draft.edits.length}
                      onClick={() => stage("segment", segment.id, "reset")}
                    >
                      {t("context.resetScope")}
                    </button>
                  </fieldset>
                ) : null}
              </section>
              {segment?.type === "assistant" ? (
                <section className="context-section">
                  <div className="context-section-heading">
                    <h3>{t("context.details")}</h3>
                    <button type="button" onClick={() => setSelection(null)}>
                      {t("context.collapse")}
                    </button>
                  </div>
                  <ContextStrip
                    key={segment.id}
                    label={t("context.details")}
                    blocks={itemBlocks}
                    selected={item?.id}
                    chips
                    onSelect={(id) => setSelection({ revision: snapshot.revision, segmentId: segment.id, itemId: id })}
                  />
                  {item ? (
                    <fieldset className="context-scope" aria-label={t("context.itemActions")}>
                      <div className="context-scope-label">
                        <strong>
                          {t("context.itemActions")} · {itemLabel(item)}
                        </strong>
                        <small>{t(item.relatedIds.length ? "context.pairedScope" : "context.itemScope")}</small>
                      </div>
                      <button
                        type="button"
                        disabled={locked || !item.canFold || item.type !== "tool-result"}
                        onClick={() => stage("item", item.id, "fold")}
                      >
                        {t("context.foldItem")}
                      </button>
                      <button
                        type="button"
                        className="context-danger"
                        disabled={locked || !item.canDelete}
                        onClick={() => stage("item", item.id, "delete")}
                      >
                        {t(item.relatedIds.length ? "context.deletePair" : "context.deleteItem")}
                      </button>
                      <button
                        type="button"
                        disabled={locked || !draft.edits.length}
                        onClick={() => stage("item", item.id, "reset")}
                      >
                        {t("context.resetScope")}
                      </button>
                    </fieldset>
                  ) : null}
                </section>
              ) : null}
              {item && !draft.stale ? (
                <ContextRawText
                  key={`${snapshot.revision}:${item.id}`}
                  sessionId={sessionId}
                  revision={snapshot.revision}
                  item={item}
                  label={itemLabel(item)}
                  change={changes.get(item.id)}
                  previewPending={draft.edits.length > 0 && !preview}
                  onStale={draft.invalidate}
                />
              ) : null}
            </>
          ) : draft.checking && !draft.error ? (
            <p className="context-section">{t("dialog.loading")}</p>
          ) : null}
        </div>
        <footer className="context-footer">
          <div className="context-impact" aria-live="polite">
            {draft.edits.length ? (
              <>
                <p>
                  {preview
                    ? t("context.pending").replace("{count}", String(preview.changes.length))
                    : t("context.previewing")}{" "}
                  {preview ? (
                    <strong>
                      {contextNumber(preview.beforeTokens)} → {contextNumber(preview.afterTokens)} tokens ·{" "}
                      {t("context.saved").replace("{tokens}", contextNumber(preview.removedTokens))}
                    </strong>
                  ) : null}
                </p>
                <p>
                  {t("context.cache")}{" "}
                  <strong>
                    {preview?.cache.hitRate == null
                      ? t("context.cacheUnknown")
                      : formatCacheHitRate(preview.cache.hitRate)}
                  </strong>
                </p>
                <p className="context-muted">{t("context.cacheHint")}</p>
              </>
            ) : (
              <p className="context-muted">{t("context.noChanges")}</p>
            )}
          </div>
          <button type="button" disabled={draft.applying || !draft.edits.length} onClick={draft.reset}>
            {t("context.reset")}
          </button>
          <button
            type="button"
            className="context-primary"
            disabled={locked || isBusy || draft.previewing || !preview?.changes.length}
            onClick={() => void draft.apply()}
          >
            {t(draft.applying ? "context.applying" : "context.apply")}
          </button>
        </footer>
      </section>
    </div>
  );
}
