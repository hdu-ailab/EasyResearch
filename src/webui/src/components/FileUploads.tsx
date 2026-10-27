import { FILE_UPLOAD_LIMIT } from "../../../web/contracts";
import type { useFileUploads } from "../hooks/useFileUploads";
import { useI18n } from "../i18n/useI18n";

const uploadActionClass =
  "inline-flex min-h-8 min-w-11 shrink-0 items-center justify-center rounded-md border border-v2-grey-300 bg-v2-background-bg-base px-2 text-[11px] text-v2-text-text-muted transition-colors hover:border-v2-grey-400 hover:bg-v2-grey-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v2-blue-600 disabled:cursor-not-allowed disabled:opacity-45 pointer-coarse:min-h-11";

export function FileUploads({ uploads }: { uploads: ReturnType<typeof useFileUploads> }) {
  const { t } = useI18n();
  if (!uploads.rows.length && !uploads.queueError) return null;
  return (
    <section
      className="max-h-56 shrink-0 overflow-y-auto border-b border-v2-grey-200 p-2"
      aria-label={t("files.uploads")}
    >
      {uploads.queueError && (
        <p role="alert" className="text-[12px] text-v2-status-error">
          {t(uploads.queueError)}
        </p>
      )}
      <ul className="space-y-2">
        {uploads.rows.map((row) => {
          const terminal = ["complete", "cancelled", "failed"].includes(row.state);
          const percent = row.total ? Math.floor((row.loaded / row.total) * 100) : row.state === "queued" ? 0 : 100;
          return (
            <li key={row.id} className="min-w-0 text-[12px]" aria-label={row.name}>
              <div className="flex min-w-0 flex-col gap-1">
                <span className="block min-w-0 truncate font-medium" title={row.name}>
                  {row.name}
                </span>
                <div className="flex flex-wrap justify-end gap-1">
                  {terminal ? (
                    <>
                      {row.state !== "complete" && row.total <= FILE_UPLOAD_LIMIT && (
                        <button
                          type="button"
                          className={uploadActionClass}
                          aria-label={t("files.retryRow").replace("{name}", row.name)}
                          onClick={() => uploads.retry(row.id)}
                        >
                          {t("files.retry")}
                        </button>
                      )}
                      <button
                        type="button"
                        className={uploadActionClass}
                        aria-label={t("files.dismissUpload").replace("{name}", row.name)}
                        onClick={() => uploads.dismiss(row.id)}
                      >
                        {t("files.dismiss")}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className={uploadActionClass}
                      disabled={row.state === "cancelling"}
                      aria-label={t("files.cancelUpload").replace("{name}", row.name)}
                      onClick={() => uploads.cancel(row.id)}
                    >
                      {t("dialog.cancel")}
                    </button>
                  )}
                </div>
              </div>
              <p className="truncate font-mono text-[11px] text-v2-text-text-muted" title={row.directory}>
                {t("files.destination").replace("{path}", row.directory)}
              </p>
              <p
                role={row.state === "failed" ? "alert" : "status"}
                className={row.state === "failed" ? "text-v2-status-error" : "text-v2-text-text-muted"}
              >
                {row.error ? t(row.error) : t(`files.upload.${row.state}`)}
              </p>
              <div className="flex items-center gap-2">
                <progress
                  className="min-w-0 flex-1 accent-v2-blue-600"
                  aria-label={t("files.uploadProgress").replace("{name}", row.name)}
                  max={100}
                  value={percent}
                />
                <span className="shrink-0 tabular-nums">{percent}%</span>
              </div>
              <p className="text-[11px] tabular-nums text-v2-text-text-faint">
                {row.loaded} / {row.total} {t("files.bytes")}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
