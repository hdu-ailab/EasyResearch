import type { ApiUsageRecordDto, ApiUsageTotalsDto } from "../../../web/contracts";
import { useI18n } from "../i18n/useI18n";

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

export function formatApiUsageCost(value: number): string {
  return `$${value.toFixed(4)}`;
}

export function formatCacheHitRate(value: number | null): string {
  return value === null ? "--" : `${(value * 100).toFixed(1)}%`;
}

export function ApiUsageLine({ record }: { record: ApiUsageRecordDto }) {
  const { t } = useI18n();
  const usage = record.usage;
  const parts = [
    record.source === "compaction" || record.source === "branch-summary" ? t("usage.internalSummary") : record.model,
    `${t("usage.inputShort")} ${formatNumber(usage.input)}`,
    `${t("usage.outputShort")} ${formatNumber(usage.output)}`,
    `${t("usage.cacheReadShort")} ${formatNumber(usage.cacheRead)}`,
    `${t("usage.cacheWriteShort")} ${formatNumber(usage.cacheWrite)}`,
    usage.cacheWrite1h === undefined
      ? undefined
      : `${t("usage.cacheWrite1hShort")} ${formatNumber(usage.cacheWrite1h)}`,
    usage.reasoning === undefined ? undefined : `${t("usage.reasoningShort")} ${formatNumber(usage.reasoning)}`,
    `${t("usage.cacheHit")} ${formatCacheHitRate(usage.cacheHitRate)}`,
    formatApiUsageCost(usage.cost.total),
  ].filter((part): part is string => Boolean(part));
  return (
    <div
      role="note"
      aria-label={t("usage.details")}
      className="max-w-full break-words font-mono text-[11px] leading-5 text-v2-text-text-faint"
      title={t("usage.estimateTitle")}
    >
      {parts.join(" · ")}
    </div>
  );
}

export function ApiUsageSummaryLine({ totals }: { totals: ApiUsageTotalsDto }) {
  const { t } = useI18n();
  return (
    <div
      role="note"
      aria-label={t("usage.subtree")}
      className="font-mono text-[11px] leading-5 text-v2-text-text-faint"
      title={t("usage.estimateTitle")}
    >
      {t("usage.api")} · {formatNumber(totals.totalTokens)} {t("usage.tokens")} · {t("usage.cacheHit")}{" "}
      {formatCacheHitRate(totals.cacheHitRate)} · {formatApiUsageCost(totals.cost.total)}
    </div>
  );
}
