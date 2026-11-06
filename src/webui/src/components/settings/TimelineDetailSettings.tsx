import { ChevronDown, Eye, EyeOff } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n/useI18n";
import { usePreferences } from "../../preferences/PreferencesProvider";
import {
  cloneTimelineDetail,
  getTimelineDetail,
  getTimelinePreset,
  TIMELINE_CATEGORIES,
  TIMELINE_PRESETS,
  type TimelineCategory,
  type TimelineDetail,
  type TimelinePlacement,
} from "../../timeline-detail";

const scalePresets = [...TIMELINE_PRESETS].reverse();
const focusClass = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v2-blue-600";

function DetailSwitch({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange(checked: boolean): void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative h-[20px] w-[36px] shrink-0 overflow-hidden rounded-full transition-colors motion-reduce:transition-none hover:brightness-95 active:brightness-90 ${focusClass} ${checked ? "bg-v2-blue-600" : "bg-v2-grey-400"}`}
    >
      <span
        aria-hidden
        className={`absolute left-0 top-[2px] size-[16px] rounded-full bg-v2-background-bg-base transition-transform motion-reduce:transition-none ${checked ? "translate-x-[18px]" : "translate-x-[2px]"}`}
      />
    </button>
  );
}

export function TimelineDetailControl({
  value,
  onChange,
}: {
  value: TimelineDetail;
  onChange(value: TimelineDetail): void;
}) {
  const { t } = useI18n();
  const id = useId();
  const preset = getTimelinePreset(value);
  const position = preset ? scalePresets.indexOf(preset) : 2;
  const presetLabel = preset ? t(`settings.timeline.preset.${preset.id}`) : t("settings.timeline.custom");
  const [advanced, setAdvanced] = useState(!preset);
  const visiblePlacements = useRef<Partial<Record<TimelineCategory, Exclude<TimelinePlacement, "hidden">>>>({});

  useLayoutEffect(() => {
    // Remember committed preset/external updates too, without erasing hidden categories' last visible choice.
    for (const category of TIMELINE_CATEGORIES) {
      const placement = value[category].placement;
      if (placement !== "hidden") visiblePlacements.current[category] = placement;
    }
  }, [value]);

  function updateCategory(category: TimelineCategory, patch: Partial<TimelineDetail[TimelineCategory]>) {
    onChange({ ...value, [category]: { ...value[category], ...patch } });
  }

  return (
    <section
      aria-labelledby={`${id}-label`}
      data-component="timeline-detail-control"
      className="@container flex min-w-0 flex-col gap-2 text-[13px] text-v2-text-text-base"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label id={`${id}-label`} htmlFor={`${id}-slider`} className="font-medium">
          {t("settings.timeline.detail")}
        </label>
        <select
          aria-labelledby={`${id}-label`}
          aria-describedby={`${id}-description`}
          value={preset?.id ?? "custom"}
          onChange={(event) => {
            const selected = TIMELINE_PRESETS.find((item) => item.id === event.currentTarget.value);
            if (selected) onChange(cloneTimelineDetail(selected.value));
          }}
          className={`h-7 min-w-0 rounded-md border border-v2-grey-200 bg-v2-background-bg-base px-2 text-[12px] hover:border-v2-grey-400 ${focusClass}`}
        >
          {!preset && (
            <option value="custom" disabled>
              {t("settings.timeline.custom")}
            </option>
          )}
          {scalePresets.map((item) => (
            <option key={item.id} value={item.id}>
              {t(`settings.timeline.preset.${item.id}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="relative mx-2 mt-2 h-7">
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-3 h-1 rounded bg-v2-grey-200">
          <span
            className="absolute inset-y-0 left-0 rounded bg-v2-blue-600"
            style={{ width: `${(position / (scalePresets.length - 1)) * 100}%` }}
          />
          {scalePresets.map((item, index) => (
            <span
              key={item.id}
              className={`absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-v2-background-bg-base ${index <= position ? "bg-v2-blue-600" : "bg-v2-grey-400"}`}
              style={{ left: `${(index / (scalePresets.length - 1)) * 100}%` }}
            />
          ))}
        </div>
        <input
          id={`${id}-slider`}
          type="range"
          min={0}
          max={scalePresets.length - 1}
          step={1}
          value={position}
          aria-valuetext={presetLabel}
          aria-describedby={`${id}-description`}
          onChange={(event) => {
            const selected = scalePresets[event.currentTarget.valueAsNumber];
            if (selected) onChange(cloneTimelineDetail(selected.value));
          }}
          className={`relative -mx-2 block h-7 w-[calc(100%+16px)] cursor-pointer appearance-none rounded bg-transparent ${focusClass} [&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:bg-transparent [&::-webkit-slider-thumb]:-mt-1.5 [&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-v2-grey-400 [&::-webkit-slider-thumb]:bg-v2-grey-300 [&::-webkit-slider-thumb]:shadow-sm [&::-moz-range-track]:h-1 [&::-moz-range-track]:bg-transparent [&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-v2-grey-400 [&::-moz-range-thumb]:bg-v2-grey-300`}
        />
      </div>
      <p id={`${id}-description`} aria-live="polite" className="text-[12px] leading-relaxed text-v2-text-text-muted">
        {t(`settings.timeline.description.${preset?.id ?? "custom"}`)}
      </p>
      <button
        type="button"
        aria-expanded={advanced}
        aria-controls={`${id}-categories`}
        onClick={() => setAdvanced(!advanced)}
        className={`mt-1 flex min-h-8 w-fit items-center gap-1.5 rounded px-1 font-medium hover:bg-v2-grey-100 active:bg-v2-grey-200 ${focusClass}`}
      >
        {t("settings.timeline.advanced")}
        <ChevronDown
          size={14}
          aria-hidden
          className={`transition-transform motion-reduce:transition-none ${advanced ? "" : "-rotate-90"}`}
        />
      </button>
      <div id={`${id}-categories`} hidden={!advanced}>
        <div
          aria-hidden
          className="mb-2 hidden grid-cols-[minmax(0,1fr)_64px_80px] gap-1 px-3 text-center text-[12px] text-v2-text-text-muted @[251px]:grid"
        >
          <span />
          <span>{t("settings.timeline.group")}</span>
          <span>{t("settings.timeline.collapse")}</span>
        </div>
        <div className="rounded-lg border border-v2-grey-200 bg-v2-background-bg-deep">
          {TIMELINE_CATEGORIES.map((category) => {
            const row = value[category];
            const visible = row.placement !== "hidden";
            const activity = t(`settings.timeline.category.${category}`);
            const visibilityLabel = t(
              visible ? "settings.timeline.visibility.hide" : "settings.timeline.visibility.show",
            ).replace("{activity}", activity);
            return (
              <fieldset
                key={category}
                className="m-0 grid min-w-0 grid-cols-1 items-center gap-x-1 gap-y-2 border-b border-v2-grey-200 px-3 py-2 last:border-0 @[251px]:grid-cols-[minmax(0,1fr)_64px_80px]"
              >
                <legend className="sr-only">{activity}</legend>
                <div className={`flex min-w-0 items-center gap-2 ${visible ? "" : "text-v2-text-text-faint"}`}>
                  <button
                    type="button"
                    aria-label={visibilityLabel}
                    title={visibilityLabel}
                    aria-pressed={visible}
                    onClick={() => {
                      updateCategory(category, {
                        placement: visible ? "hidden" : (visiblePlacements.current[category] ?? "grouped"),
                      });
                    }}
                    className={`flex size-7 shrink-0 items-center justify-center rounded hover:bg-v2-grey-200 active:bg-v2-grey-300 ${focusClass}`}
                  >
                    {visible ? <Eye size={16} aria-hidden /> : <EyeOff size={16} aria-hidden />}
                  </button>
                  <span className="min-w-0 break-words">{activity}</span>
                </div>
                <div className="flex flex-col items-center gap-1">
                  <span aria-hidden className="text-[12px] text-v2-text-text-muted @[251px]:hidden">
                    {t("settings.timeline.group")}
                  </span>
                  {visible ? (
                    <DetailSwitch
                      label={t("settings.timeline.grouped.label").replace("{activity}", activity)}
                      checked={row.placement === "grouped"}
                      onChange={(checked) => updateCategory(category, { placement: checked ? "grouped" : "separate" })}
                    />
                  ) : (
                    <span aria-hidden className="w-6 border-t border-v2-grey-400" />
                  )}
                </div>
                <div className="flex flex-col items-center gap-1">
                  <span aria-hidden className="text-[12px] text-v2-text-text-muted @[251px]:hidden">
                    {t("settings.timeline.collapse")}
                  </span>
                  {visible ? (
                    <DetailSwitch
                      label={t("settings.timeline.collapsed.label").replace("{activity}", activity)}
                      checked={row.details === "collapsed"}
                      onChange={(checked) => updateCategory(category, { details: checked ? "collapsed" : "expanded" })}
                    />
                  ) : (
                    <span aria-hidden className="w-6 border-t border-v2-grey-400" />
                  )}
                </div>
              </fieldset>
            );
          })}
        </div>
      </div>
    </section>
  );
}

export function TimelineDetailSettings() {
  const { preferences, updatePreferences } = usePreferences();
  return (
    <TimelineDetailControl
      value={getTimelineDetail(preferences)}
      onChange={(timelineDetail) => updatePreferences({ timelineDetail })}
    />
  );
}
