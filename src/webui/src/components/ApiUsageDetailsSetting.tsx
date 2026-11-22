import { useCallback, useEffect, useRef, useState } from "react";
import { getApiUsageSettings, patchApiUsageSettings } from "../api";
import type { MessageKey } from "../i18n/messages";
import { useI18n } from "../i18n/useI18n";

const loadApiUsage = async () => (await getApiUsageSettings()).showApiUsageDetails;
const saveApiUsage = async (value: boolean) =>
  (await patchApiUsageSettings({ showApiUsageDetails: value })).showApiUsageDetails;

export function ApiUsageDetailsSetting({ configurationGeneration }: { configurationGeneration: number }) {
  return (
    <BooleanConversationSetting
      configurationGeneration={configurationGeneration}
      read={loadApiUsage}
      write={saveApiUsage}
      labelKey="settings.conversation.apiUsageDetails"
      loadErrorKey="settings.conversation.apiUsageLoadError"
      saveErrorKey="settings.conversation.apiUsageSaveError"
    />
  );
}

export function BooleanConversationSetting({
  configurationGeneration,
  read,
  write,
  labelKey,
  loadErrorKey,
  saveErrorKey,
  hintKey,
}: {
  configurationGeneration: number;
  read(): Promise<boolean>;
  write(value: boolean): Promise<boolean>;
  labelKey: MessageKey;
  loadErrorKey: MessageKey;
  saveErrorKey: MessageKey;
  hintKey?: MessageKey;
}) {
  const { t } = useI18n();
  const [accepted, setAccepted] = useState<boolean | null>(null);
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
      const next = await read();
      if (id === request.current) setAccepted(next);
    } catch {
      if (id === request.current) setError("load");
    } finally {
      if (id === request.current) setBusy(false);
    }
  }, [read]);

  useEffect(() => {
    void configurationGeneration;
    void load();
    return () => {
      request.current += 1;
    };
  }, [configurationGeneration, load]);

  const commit = useCallback(
    async (target: boolean) => {
      const id = ++request.current;
      setBusy(true);
      setError(null);
      setFailedTarget(null);
      try {
        const next = await write(target);
        if (id === request.current) setAccepted(next);
      } catch {
        if (id === request.current) {
          setFailedTarget(target);
          setError("save");
        }
      } finally {
        if (id === request.current) setBusy(false);
      }
    },
    [write],
  );

  const checked = accepted ?? false;
  const label = t(labelKey);
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
      {hintKey ? <p className="text-[12px] text-v2-text-text-muted">{t(hintKey)}</p> : null}
      {error ? (
        <div className="flex items-center gap-2 text-[12px] text-v2-status-error" role="alert">
          <span>{t(error === "load" ? loadErrorKey : saveErrorKey)}</span>
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
