import { ChevronDown, ChevronRight, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiUsageSessionSummaryDto, ApiUsageStatisticsDto, ApiUsageTotalsDto } from "../../../web/contracts";
import { getApiUsageStatistics } from "../api";
import { useModalLayer } from "../hooks/useModalLayer";
import { agentDisplayName, type Translate } from "../i18n/agents";
import { useI18n } from "../i18n/useI18n";
import { formatApiUsageCost, formatCacheHitRate } from "./ApiUsageLine";

function totalsText(totals: ApiUsageTotalsDto, t: Translate): string {
  const number = new Intl.NumberFormat();
  return `${t("usage.inputShort")} ${number.format(totals.input)} · ${t("usage.outputShort")} ${number.format(totals.output)} · ${t("usage.cacheReadShort")} ${number.format(totals.cacheRead)} · ${t("usage.cacheHit")} ${formatCacheHitRate(totals.cacheHitRate)} · ${formatApiUsageCost(totals.cost.total)}`;
}

export function ApiUsageStatisticsDialog({
  sessionId,
  liveStatistics,
  onClose,
}: {
  sessionId: string;
  liveStatistics?: ApiUsageStatisticsDto;
  onClose(): void;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLElement>(null);
  const { zIndex, dialogProps } = useModalLayer(onClose, dialogRef);
  const request = useRef(0);
  const [statistics, setStatistics] = useState<ApiUsageStatisticsDto | null>(liveStatistics ?? null);
  const [error, setError] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([sessionId]));

  const load = useCallback(async () => {
    const id = ++request.current;
    setError(false);
    try {
      const next = await getApiUsageStatistics(sessionId);
      if (id === request.current) setStatistics(next);
    } catch {
      if (id === request.current) setError(true);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
    return () => {
      request.current += 1;
    };
  }, [load]);

  useEffect(() => {
    if (liveStatistics) {
      request.current += 1;
      setStatistics(liveStatistics);
    }
  }, [liveStatistics]);

  const toggle = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/20 p-4" style={{ zIndex }}>
      <section
        ref={dialogRef}
        role="dialog"
        {...dialogProps}
        aria-labelledby="api-usage-statistics-title"
        className="flex max-h-[min(680px,calc(100vh-32px))] w-full max-w-[620px] flex-col overflow-hidden rounded-[12px] border border-v2-grey-200 bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]"
      >
        <header className="flex items-center justify-between border-b border-v2-grey-200 px-4 py-3">
          <h2 id="api-usage-statistics-title" className="text-[14px] font-semibold text-v2-text-text-base">
            {t("usage.statisticsTitle")}
          </h2>
          <button
            type="button"
            aria-label={t("dialog.close")}
            onClick={onClose}
            className="flex size-7 items-center justify-center rounded-md text-v2-text-text-muted hover:bg-v2-grey-100"
          >
            <X size={15} aria-hidden />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {statistics ? (
            <>
              <div className="rounded-lg bg-v2-background-bg-deep px-3 py-2">
                <p className="font-mono text-[13px] font-medium text-v2-text-text-base">
                  {totalsText(statistics.total, t)}
                </p>
              </div>
              {statistics.partial ? (
                <p className="mt-3 text-[12px] text-v2-status-warning" role="status">
                  {t("usage.partial")}
                </p>
              ) : null}
              <div className="mt-3 flex flex-col gap-2">
                {statistics.sessions.map((session) => (
                  <SessionUsageRow
                    key={session.sessionId}
                    session={session}
                    rootSessionId={statistics.rootSessionId}
                    expanded={expanded.has(session.sessionId)}
                    onToggle={() => toggle(session.sessionId)}
                  />
                ))}
              </div>
            </>
          ) : error ? (
            <div className="flex items-center gap-2 text-[12px] text-v2-status-error" role="alert">
              <span>{t("usage.statisticsLoadError")}</span>
              <button type="button" className="font-medium underline" onClick={() => void load()}>
                {t("usage.retry")}
              </button>
            </div>
          ) : (
            <p className="text-[12px] text-v2-text-text-muted">{t("dialog.loading")}</p>
          )}
        </div>
      </section>
    </div>
  );
}

function SessionUsageRow({
  session,
  rootSessionId,
  expanded,
  onToggle,
}: {
  session: ApiUsageSessionSummaryDto;
  rootSessionId: string;
  expanded: boolean;
  onToggle(): void;
}) {
  const { t } = useI18n();
  const label =
    session.sessionId === rootSessionId
      ? t("transcript.researchAssistant")
      : (session.agentId ?? agentDisplayName(t, session.agent ?? session.sessionId));
  return (
    <div className="rounded-lg border border-v2-grey-200">
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={label}
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {expanded ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-v2-text-text-base">{label}</span>
        <span className="shrink-0 font-mono text-[11px] text-v2-text-text-faint">{totalsText(session.subtree, t)}</span>
      </button>
      {expanded ? (
        <div className="border-t border-v2-grey-200 px-3 py-2">
          <p className="mb-2 font-mono text-[11px] text-v2-text-text-faint">
            {t("usage.direct")} · {totalsText(session.direct, t)}
          </p>
          <div className="flex flex-col gap-1.5">
            {session.models.map((model) => (
              <div key={model.key} className="flex items-center justify-between gap-3 text-[11px]">
                <span className="min-w-0 truncate text-v2-text-text-muted">
                  {model.kind === "internal" ? t("usage.internalTools") : model.key}
                </span>
                <span className="shrink-0 font-mono text-v2-text-text-faint">{totalsText(model.totals, t)}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
