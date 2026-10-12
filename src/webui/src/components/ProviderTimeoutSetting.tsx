import { useCallback, useEffect, useRef, useState } from "react";
import { getProviderTimeoutSettings, patchProviderTimeoutSettings } from "../api";
import { useI18n } from "../i18n/useI18n";

export function ProviderTimeoutSetting({ configurationGeneration }: { configurationGeneration: number }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<"load" | "save" | "invalid" | null>(null);
  const dirty = useRef(false);
  const saving = useRef(false);
  const pendingRefresh = useRef(false);
  const request = useRef(0);
  const load = useCallback(async () => {
    if (saving.current) {
      pendingRefresh.current = true;
      return;
    }
    const id = ++request.current;
    setBusy(true);
    try {
      const next = await getProviderTimeoutSettings();
      if (id !== request.current) return;
      if (!dirty.current) setDraft(String(next.timeoutMs / 1000));
      setError((previous) => (previous === "load" ? null : previous));
    } catch {
      if (id === request.current) setError("load");
    } finally {
      if (id === request.current) setBusy(false);
    }
  }, []);
  useEffect(() => {
    void configurationGeneration;
    void load();
  }, [configurationGeneration, load]);
  useEffect(
    () => () => {
      request.current += 1;
    },
    [],
  );

  const commit = async (reset = false) => {
    const timeoutMs = reset ? null : Math.round(Number(draft) * 1000);
    if (
      timeoutMs !== null &&
      (!/^(?:\d+(?:\.\d{0,3})?|\.\d{1,3})$/.test(draft.trim()) ||
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 0 ||
        timeoutMs > 2_147_483_647)
    ) {
      setError("invalid");
      return;
    }
    const id = ++request.current;
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      const next = await patchProviderTimeoutSettings({ timeoutMs });
      if (id === request.current) {
        dirty.current = false;
        setDraft(String(next.timeoutMs / 1000));
      }
    } catch {
      if (id === request.current) setError("save");
    } finally {
      saving.current = false;
      if (id === request.current) {
        setBusy(false);
        if (pendingRefresh.current) {
          pendingRefresh.current = false;
          void load();
        }
      }
    }
  };
  const buttonClass =
    "rounded-md border border-v2-grey-200 px-2.5 py-1 text-[12px] text-v2-text-text-base hover:bg-v2-grey-100 disabled:opacity-50";
  const label = t("settings.conversation.timeout");
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-[13px] text-v2-text-text-base">{label}</span>
        <div className="flex flex-wrap items-center gap-2">
          <input
            aria-label={label}
            type="number"
            min={0}
            max={2147483.647}
            step="0.001"
            disabled={busy}
            value={draft}
            onChange={(event) => {
              dirty.current = true;
              setDraft(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void commit();
              }
            }}
            className="w-24 rounded-md border border-v2-grey-200 bg-v2-background-bg-base px-2 py-1 text-[13px] text-v2-text-text-base"
          />
          <button type="button" className={buttonClass} disabled={busy} onClick={() => void commit()}>
            {t("settings.conversation.timeoutSave")}
          </button>
          <button type="button" className={buttonClass} disabled={busy} onClick={() => void commit(true)}>
            {t("settings.conversation.timeoutDefault")}
          </button>
        </div>
      </div>
      <p className="text-[12px] text-v2-text-text-faint">{t("settings.conversation.timeoutHint")}</p>
      {error && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-[12px] text-v2-status-error">
          {t(
            error === "invalid"
              ? "settings.conversation.timeoutInvalid"
              : error === "load"
                ? "settings.conversation.timeoutLoadError"
                : "settings.conversation.timeoutSaveError",
          )}
          {error === "load" && (
            <button type="button" className={buttonClass} disabled={busy} onClick={() => void load()}>
              {t("settings.conversation.compactionRetry")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
