import { useEffect, useState } from "react";
import { listModels } from "../api";
import type { ModelOption } from "../api/parsers";
import { useI18n } from "../i18n/useI18n";

export function ProviderModelsList({
  providerId,
  configurationGeneration,
}: {
  providerId: string;
  configurationGeneration?: number;
}) {
  const { t } = useI18n();
  const [models, setModels] = useState<ModelOption[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [search, setSearch] = useState("");

  useEffect(() => {
    void configurationGeneration;
    void retry;
    let current = true;
    setLoading(true);
    setError(null);
    void listModels().then(
      (catalog) => {
        if (!current) return;
        setModels(catalog.filter((model) => model.provider === providerId).sort((a, b) => a.id.localeCompare(b.id)));
        setLoading(false);
      },
      (cause: unknown) => {
        if (!current) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setLoading(false);
      },
    );
    return () => {
      current = false;
    };
  }, [providerId, configurationGeneration, retry]);

  const query = search.trim().toLowerCase();
  const filtered = models?.filter((model) => model.id.toLowerCase().includes(query)) ?? [];

  return (
    <div className="flex min-w-0 flex-col gap-3 border-t border-v2-grey-200 p-3">
      <p className="text-[12px] text-v2-text-text-muted">{t("providerConnect.modelsScope")}</p>
      {loading && (
        <p role="status" className="text-[12px] text-v2-text-text-muted">
          {t("dialog.loading")}
        </p>
      )}
      {error && (
        <div className="flex items-center justify-between gap-3">
          <p role="alert" className="min-w-0 break-words text-[12px] text-v2-status-error">
            {error}
          </p>
          <button
            type="button"
            onClick={() => setRetry((value) => value + 1)}
            className="shrink-0 text-[12px] text-v2-blue-600 hover:underline"
          >
            {t("dialog.retry")}
          </button>
        </div>
      )}
      {models !== null && (
        <>
          <div className="flex items-center gap-3">
            <input
              type="search"
              aria-label={t("providerConnect.searchModels")}
              placeholder={t("providerConnect.searchModels")}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="h-8 min-w-0 flex-1 rounded-md border border-v2-grey-200 bg-v2-background-bg-base px-2 text-[13px] text-v2-text-text-base"
            />
            <span className="shrink-0 text-[12px] tabular-nums text-v2-text-text-muted">
              {t("providerConnect.modelCount").replace("{n}", String(models.length))}
            </span>
          </div>
          {filtered.length > 0 ? (
            <ul
              // biome-ignore lint/a11y/noNoninteractiveTabindex: the bounded list must be focusable for native keyboard scrolling.
              tabIndex={0}
              aria-label={t("providerConnect.viewModels")}
              className="max-h-64 overflow-y-auto overscroll-contain rounded-md border border-v2-grey-200 p-1"
            >
              {filtered.map((model) => (
                <li key={model.id} className="break-all px-2 py-1.5 font-mono text-[12px] text-v2-text-text-base">
                  {model.id}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[12px] text-v2-text-text-muted">
              {t(models.length === 0 ? "providerConnect.noModels" : "providerConnect.noModelResults")}
            </p>
          )}
        </>
      )}
    </div>
  );
}
