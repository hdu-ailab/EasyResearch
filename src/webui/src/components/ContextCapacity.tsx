import type { CompactionStateDto, ContextUsageDto } from "../../../web/contracts";
import { useI18n } from "../i18n/useI18n";

export type ContextSeverity = "normal" | "warning" | "error";

export interface ContextCapacityProps {
  usage?: ContextUsageDto;
  compactionState: CompactionStateDto;
}

export function ContextCapacity({ usage, compactionState }: ContextCapacityProps) {
  const { t } = useI18n();
  if (!usage && compactionState === "idle") return null;

  const percent = usage?.percent ?? null;
  const roundedPercent = percent === null ? null : Math.round(percent);
  const severity: ContextSeverity =
    percent !== null && percent > 90 ? "error" : percent !== null && percent > 70 ? "warning" : "normal";
  const signalClass =
    severity === "error"
      ? "text-v2-status-error"
      : severity === "warning"
        ? "text-v2-status-warning"
        : "text-v2-text-text-muted";
  const barClass =
    severity === "error" ? "bg-v2-status-error" : severity === "warning" ? "bg-v2-status-warning" : "bg-v2-blue-600";
  const status =
    compactionState === "queued" ? t("context.queued") : compactionState === "running" ? t("context.compacting") : null;

  return (
    <div
      data-context-severity={severity}
      className="mb-2 flex items-center gap-2 text-[11px] text-v2-text-text-faint"
      aria-live="polite"
    >
      <span className="shrink-0 font-medium text-v2-text-text-muted">{t("context.label")}</span>
      <div
        role="progressbar"
        aria-label={t("context.capacity")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={roundedPercent ?? undefined}
        aria-valuetext={roundedPercent === null ? t("context.unknown") : `${roundedPercent}%`}
        className="h-1.5 min-w-16 flex-1 overflow-hidden rounded-full bg-v2-grey-100"
      >
        <div
          className={`h-full rounded-full transition-[width] duration-200 motion-reduce:transition-none ${barClass} ${
            roundedPercent === null ? "w-1/3 animate-pulse motion-reduce:animate-none" : ""
          }`}
          style={roundedPercent === null ? undefined : { width: `${Math.min(100, Math.max(0, roundedPercent))}%` }}
        />
      </div>
      <span className={`shrink-0 font-mono ${signalClass}`}>
        {usage
          ? `${usage.tokens === null ? t("context.unknown") : formatTokens(usage.tokens)} / ${formatTokens(usage.contextWindow)}`
          : t("context.unknown")}
      </span>
      <span className={`w-9 shrink-0 text-right font-mono ${signalClass}`}>
        {roundedPercent === null ? "—" : `${roundedPercent}%`}
      </span>
      {status ? (
        <span className="shrink-0 rounded bg-v2-blue-100 px-1.5 py-0.5 font-medium text-v2-blue-700">{status}</span>
      ) : null}
    </div>
  );
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}m`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}
