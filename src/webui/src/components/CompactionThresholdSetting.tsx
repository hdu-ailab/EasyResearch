import { Minus, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CompactionSettingsDto } from "../../../web/contracts";
import { getCompactionSettings, patchCompactionSettings } from "../api";
import { useI18n } from "../i18n/useI18n";

const MIN_PERCENT = 10;
const MAX_PERCENT = 90;
const STEP_PERCENT = 5;
const buttonClass =
  "flex h-7 w-7 items-center justify-center rounded-md border border-v2-grey-200 text-v2-text-text-base transition-colors hover:bg-v2-grey-100 disabled:opacity-40";

function parseDraft(value: string): number | undefined {
  if (!/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= MIN_PERCENT && parsed <= MAX_PERCENT ? parsed : undefined;
}

export function CompactionThresholdSetting({ configurationGeneration }: { configurationGeneration: number }) {
  const { t } = useI18n();
  const [accepted, setAccepted] = useState<CompactionSettingsDto | null>(null);
  const [draft, setDraft] = useState("70");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<"invalid" | "load" | "save" | null>(null);
  const [failedTarget, setFailedTarget] = useState<number | null>(null);
  const request = useRef(0);

  const load = useCallback(async () => {
    const id = ++request.current;
    setBusy(true);
    setError(null);
    setFailedTarget(null);
    try {
      const next = await getCompactionSettings();
      if (id !== request.current) return;
      setAccepted(next);
      setDraft(String(next.triggerPercent));
    } catch {
      if (id === request.current) setError("load");
    } finally {
      if (id === request.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    void configurationGeneration;
    void load();
    return () => {
      request.current += 1;
    };
  }, [configurationGeneration, load]);

  const commit = useCallback(
    async (target: number) => {
      if (accepted?.triggerPercent === target) {
        setDraft(String(target));
        setError(null);
        setFailedTarget(null);
        return;
      }
      const id = ++request.current;
      setBusy(true);
      setError(null);
      setFailedTarget(null);
      try {
        const next = await patchCompactionSettings({ triggerPercent: target });
        if (id !== request.current) return;
        setAccepted(next);
        setDraft(String(next.triggerPercent));
      } catch {
        if (id !== request.current) return;
        setDraft(String(accepted?.triggerPercent ?? 70));
        setFailedTarget(target);
        setError("save");
      } finally {
        if (id === request.current) setBusy(false);
      }
    },
    [accepted],
  );

  const commitDraft = () => {
    const target = parseDraft(draft);
    if (target === undefined) {
      setDraft(String(accepted?.triggerPercent ?? 70));
      setFailedTarget(null);
      setError("invalid");
      return;
    }
    void commit(target);
  };

  const step = (delta: number) => {
    const base = parseDraft(draft) ?? accepted?.triggerPercent ?? 70;
    const target = Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, base + delta));
    setDraft(String(target));
    void commit(target);
  };

  const current = parseDraft(draft) ?? accepted?.triggerPercent ?? 70;
  const errorText =
    error === "invalid"
      ? t("settings.conversation.compactionRangeError")
      : error === "save"
        ? t("settings.conversation.compactionSaveError")
        : error === "load"
          ? t("settings.conversation.compactionLoadError")
          : null;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <span className="text-[13px] text-v2-text-text-base">{t("settings.conversation.compactionThreshold")}</span>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            className={buttonClass}
            aria-label={t("settings.conversation.decreaseCompaction")}
            disabled={busy || current <= MIN_PERCENT}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => step(-STEP_PERCENT)}
          >
            <Minus size={13} aria-hidden />
          </button>
          <div className="flex items-center gap-1">
            <input
              type="number"
              min={MIN_PERCENT}
              max={MAX_PERCENT}
              step={1}
              inputMode="numeric"
              aria-label={t("settings.conversation.compactionThreshold")}
              aria-invalid={error === "invalid"}
              value={draft}
              disabled={busy}
              onChange={(event) => {
                setDraft(event.target.value);
                setError(null);
                setFailedTarget(null);
              }}
              onBlur={commitDraft}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
              className="h-7 w-12 rounded-md border border-v2-grey-200 bg-v2-background-bg-base px-1 text-center text-[13px] tabular-nums text-v2-text-text-base focus:border-v2-blue-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v2-blue-600 disabled:opacity-50"
            />
            <span className="text-[12px] text-v2-text-text-muted" aria-hidden>
              %
            </span>
          </div>
          <button
            type="button"
            className={buttonClass}
            aria-label={t("settings.conversation.increaseCompaction")}
            disabled={busy || current >= MAX_PERCENT}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => step(STEP_PERCENT)}
          >
            <Plus size={13} aria-hidden />
          </button>
        </div>
      </div>
      {accepted?.globalEnabled === false ? (
        <p className="text-[12px] text-v2-text-text-muted">{t("settings.conversation.compactionDisabled")}</p>
      ) : null}
      {errorText ? (
        <div className="flex items-center gap-2 text-[12px] text-v2-status-error" role="alert">
          <span>{errorText}</span>
          {error !== "invalid" ? (
            <button
              type="button"
              className="rounded px-1.5 py-0.5 font-medium underline underline-offset-2 disabled:opacity-50"
              disabled={busy}
              onClick={() => {
                if (failedTarget !== null) void commit(failedTarget);
                else void load();
              }}
            >
              {t("settings.conversation.compactionRetry")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
