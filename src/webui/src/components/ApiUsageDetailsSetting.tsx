import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiUsageSettingsDto } from "../../../web/contracts";
import { getApiUsageSettings, patchApiUsageSettings } from "../api";
import { useI18n } from "../i18n/useI18n";

export function ApiUsageDetailsSetting({ configurationGeneration }: { configurationGeneration: number }) {
  const { t } = useI18n();
  const [accepted, setAccepted] = useState<ApiUsageSettingsDto | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<"load" | "save" | null>(null);
  const [failedTarget, setFailedTarget] = useState<boolean | null>(null);
  const request = useRef(0);

  const load = useCallback(async () => {
    const id = ++request.current;
    setBusy(true);
    setError(null);
    setFailedTarget(null);
    try {
      const next = await getApiUsageSettings();
      if (id === request.current) setAccepted(next);
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

  const commit = useCallback(async (target: boolean) => {
    const id = ++request.current;
    setBusy(true);
    setError(null);
    setFailedTarget(null);
    try {
      const next = await patchApiUsageSettings({ showApiUsageDetails: target });
      if (id === request.current) setAccepted(next);
    } catch {
      if (id === request.current) {
        setFailedTarget(target);
        setError("save");
      }
    } finally {
      if (id === request.current) setBusy(false);
    }
  }, []);

  const checked = accepted?.showApiUsageDetails ?? false;
  const label = t("settings.conversation.apiUsageDetails");
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-4">
        <span className="text-[13px] text-v2-text-text-base">{label}</span>
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-label={label}
          disabled={busy}
          onClick={() => void commit(!checked)}
          className={`relative h-[20px] w-[36px] shrink-0 overflow-hidden rounded-full transition-colors disabled:opacity-50 ${checked ? "bg-v2-blue-600" : "bg-v2-grey-400"}`}
        >
          <span
            aria-hidden
            className={`absolute left-0 top-[2px] size-[16px] rounded-full bg-white transition-transform ${checked ? "translate-x-[18px]" : "translate-x-[2px]"}`}
          />
        </button>
      </div>
      {error ? (
        <div className="flex items-center gap-2 text-[12px] text-v2-status-error" role="alert">
          <span>
            {t(
              error === "load" ? "settings.conversation.apiUsageLoadError" : "settings.conversation.apiUsageSaveError",
            )}
          </span>
          <button
            type="button"
            className="rounded px-1.5 py-0.5 font-medium underline underline-offset-2 disabled:opacity-50"
            disabled={busy}
            onClick={() => {
              if (failedTarget === null) void load();
              else void commit(failedTarget);
            }}
          >
            {t("settings.conversation.apiUsageRetry")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
