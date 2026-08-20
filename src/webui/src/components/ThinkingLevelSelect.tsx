import { EXTENDED_THINKING_LEVELS, getSupportedThinkingLevels } from "../../../thinking-levels";
import type { ModelOption } from "../api/parsers";

export function thinkingLevelsForModel(
  model: ModelOption | undefined,
  current?: string,
  automaticModel = false,
): readonly string[] {
  const levels = model || !automaticModel ? [...getSupportedThinkingLevels(model)] : [...EXTENDED_THINKING_LEVELS];
  if (current && !levels.includes(current)) levels.unshift(current);
  return levels;
}

export interface ThinkingLevelSelectProps {
  value: string;
  levels: readonly string[];
  emptyLabel: string;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
  id?: string;
  onChange: (level: string) => void;
}

export function ThinkingLevelSelect({
  value,
  levels,
  emptyLabel,
  ariaLabel,
  disabled,
  className,
  id,
  onChange,
}: ThinkingLevelSelectProps) {
  return (
    <select
      id={id}
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
      className={
        className ??
        "h-6 min-w-0 flex-1 rounded-md border border-v2-grey-200 bg-v2-background-bg-base px-1 text-[11px] text-v2-text-text-base outline-none focus:border-v2-blue-600"
      }
    >
      <option value="">{emptyLabel}</option>
      {levels.map((level) => (
        <option key={level} value={level}>
          {level}
        </option>
      ))}
    </select>
  );
}
