import type { CompactionPolicyDto, CompactionStateDto, ContextUsageDto } from "../../../web/contracts";
import { useI18n } from "../i18n/useI18n";

export interface ContextCapacityProps {
  usage?: ContextUsageDto;
  compactionState: CompactionStateDto;
  compactionPolicy: CompactionPolicyDto;
}

const SIZE = 20;
const CENTER = SIZE / 2;
const TRACK_RADIUS = 8;
const STROKE_WIDTH = 2;

export function ContextCapacity({ usage, compactionState, compactionPolicy }: ContextCapacityProps) {
  const { t } = useI18n();
  if (!usage && compactionState === "idle") return null;

  const actualPercent = usage?.percent ?? null;
  const roundedPercent = actualPercent === null ? null : Math.round(actualPercent);
  const clampedPercent = roundedPercent === null ? null : Math.min(100, Math.max(0, roundedPercent));
  const tokenSummary = usage
    ? `${usage.tokens === null ? t("context.unknown") : formatTokens(usage.tokens)} / ${formatTokens(usage.contextWindow)}`
    : t("context.unknown");
  const usageSummary =
    roundedPercent === null
      ? t("context.unknown")
      : t("context.usageSummary")
          .replace(
            "{tokens}",
            usage?.tokens === null || usage === undefined ? t("context.unknown") : formatTokens(usage.tokens),
          )
          .replace("{window}", usage === undefined ? t("context.unknown") : formatTokens(usage.contextWindow))
          .replace("{percent}", String(roundedPercent));
  const policySummary = compactionPolicy.enabled
    ? t("context.thresholdSummary").replace("{percent}", String(compactionPolicy.triggerPercent))
    : t("context.disabledSummary");
  const statusSummary =
    compactionState === "queued" ? t("context.queued") : compactionState === "running" ? t("context.compacting") : null;
  const valueText = [usageSummary, policySummary, statusSummary].filter(Boolean).join(". ");
  const indeterminate = compactionState === "running";
  const arcPercent = indeterminate ? 24 : actualPercent === null ? 0 : Math.min(100, Math.max(0, actualPercent));

  return (
    <div
      role="progressbar"
      aria-label={t("context.capacity")}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={clampedPercent ?? undefined}
      aria-valuetext={valueText}
      aria-live="polite"
      title={valueText}
      className="flex items-center gap-2 text-v2-text-text-faint"
    >
      <div className="size-5 shrink-0">
        <svg
          data-testid="context-capacity-ring"
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          className="size-5"
          aria-hidden
          focusable="false"
        >
          <title>{t("context.capacity")}</title>
          <circle
            data-context-track
            cx={CENTER}
            cy={CENTER}
            r={TRACK_RADIUS}
            fill="none"
            strokeWidth={STROKE_WIDTH}
            className="stroke-v2-grey-300"
          />
          <g className={indeterminate ? "origin-center animate-spin motion-reduce:animate-none" : undefined}>
            <circle
              data-progress-arc
              cx={CENTER}
              cy={CENTER}
              r={TRACK_RADIUS}
              fill="none"
              strokeWidth={STROKE_WIDTH}
              strokeLinecap="butt"
              pathLength={100}
              strokeDasharray={`${arcPercent} 100`}
              transform={`rotate(-90 ${CENTER} ${CENTER})`}
              className="stroke-v2-blue-600 transition-[stroke-dasharray] duration-200 ease-v2-panel motion-reduce:transition-none"
            />
          </g>
        </svg>
      </div>
      {statusSummary ? (
        <span
          data-testid="context-compaction-state"
          data-state={compactionState}
          className="rounded bg-v2-blue-100 px-1 py-0.5 text-[9px] font-medium text-v2-blue-700 transition-opacity"
          aria-hidden
        >
          {statusSummary}
        </span>
      ) : null}
      {usage ? (
        <span className="hidden whitespace-nowrap font-mono text-[11px] text-v2-text-text-muted min-[640px]:inline">
          {tokenSummary}
        </span>
      ) : null}
    </div>
  );
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}m`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}
