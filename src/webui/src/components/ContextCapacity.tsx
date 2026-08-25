import type { CompactionPolicyDto, CompactionStateDto, ContextUsageDto } from "../../../web/contracts";
import { useI18n } from "../i18n/useI18n";

export interface ContextCapacityProps {
  usage?: ContextUsageDto;
  compactionState: CompactionStateDto;
  compactionPolicy: CompactionPolicyDto;
}

const SIZE = 36;
const CENTER = SIZE / 2;
const TRACK_RADIUS = 15;
const TICK_OUTER_RADIUS = 12.8;
const TICK_INNER_RADIUS = 10;
const CIRCUMFERENCE = 2 * Math.PI * TRACK_RADIUS;

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
  const indeterminate = compactionState === "running" || roundedPercent === null;
  const arcPercent = indeterminate ? 24 : (clampedPercent ?? 0);
  const thresholdTick = compactionPolicy.enabled ? tickCoordinates(compactionPolicy.triggerPercent) : null;

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
      <div className="relative size-9 shrink-0">
        <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="size-9 overflow-visible" aria-hidden focusable="false">
          <title>{t("context.capacity")}</title>
          <circle
            cx={CENTER}
            cy={CENTER}
            r={TRACK_RADIUS}
            fill="none"
            strokeWidth="2.5"
            className="stroke-v2-grey-200"
          />
          <g className={indeterminate ? "origin-center animate-spin motion-reduce:animate-none" : undefined}>
            <circle
              data-progress-arc
              cx={CENTER}
              cy={CENTER}
              r={TRACK_RADIUS}
              fill="none"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray={`${(CIRCUMFERENCE * arcPercent) / 100} ${CIRCUMFERENCE}`}
              transform={`rotate(-90 ${CENTER} ${CENTER})`}
              className="origin-center stroke-v2-blue-600 transition-[stroke-dasharray] duration-200 ease-v2-panel motion-reduce:transition-none"
            />
          </g>
          {thresholdTick ? (
            <line
              data-testid="context-threshold-tick"
              x1={thresholdTick.x1}
              y1={thresholdTick.y1}
              x2={thresholdTick.x2}
              y2={thresholdTick.y2}
              strokeWidth="1.5"
              strokeLinecap="round"
              className="stroke-v2-text-text-muted"
            />
          ) : null}
        </svg>
        <span className="absolute inset-0 flex items-center justify-center text-[8px] font-semibold tabular-nums text-v2-text-text-base">
          {roundedPercent === null ? "—" : `${roundedPercent}%`}
        </span>
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

function tickCoordinates(percent: number) {
  const angle = (percent / 100) * Math.PI * 2 - Math.PI / 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x1: CENTER + cos * TICK_OUTER_RADIUS,
    y1: CENTER + sin * TICK_OUTER_RADIUS,
    x2: CENTER + cos * TICK_INNER_RADIUS,
    y2: CENTER + sin * TICK_INNER_RADIUS,
  };
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}m`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}
