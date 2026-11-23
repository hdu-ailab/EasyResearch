import { Copy } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../i18n/useI18n";
import { previewButtonClass } from "./PreviewToolbar";
import { parseDelimited } from "./table-parser";

export function TablePreview({ path, content }: { path: string; content: string }) {
  const parsed = useMemo(
    () => parseDelimited(content, path.toLowerCase().endsWith(".tsv") ? "\t" : ","),
    [content, path],
  );
  return <TableDocument key={content} parsed={parsed} />;
}

function TableDocument({ parsed }: { parsed: ReturnType<typeof parseDelimited> }) {
  const { t } = useI18n();
  const [page, setPage] = useState(0);
  const [copyStatus, setCopyStatus] = useState<"copied" | "copyError" | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  // Wide files get fewer rows per page, bounding cells as well as rows in the DOM.
  const pageSize = Math.max(1, Math.min(50, Math.floor(1000 / Math.max(1, parsed.columns))));
  const pages = Math.max(1, Math.ceil((parsed.rows.length - 1) / pageSize));
  const columns = Array.from({ length: parsed.columns }, (_, index) => index);
  const copy = async (text: string) => {
    const signal = lifetime.current?.signal;
    try {
      await navigator.clipboard.writeText(text);
      if (!signal?.aborted) setCopyStatus("copied");
    } catch {
      if (!signal?.aborted) setCopyStatus("copyError");
    }
  };
  const cell = (value: string, row: number, column: number) => (
    <div className="flex items-start gap-2">
      <span className="max-w-[32rem] min-w-0 whitespace-pre-wrap break-words">{value}</span>
      <button
        type="button"
        className={`${previewButtonClass} ml-auto`}
        aria-label={t("preview.table.copy")
          .replace("{row}", String(row))
          .replace("{column}", String(column + 1))}
        onClick={() => void copy(value)}
      >
        <Copy size={12} aria-hidden />
      </button>
    </div>
  );
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {parsed.malformed && (
        <p role="alert" className="p-3 text-[12px] text-v2-status-warning">
          {t("preview.table.malformed")}
        </p>
      )}
      {parsed.limited && <p className="p-3 text-[12px] text-v2-status-warning">{t("preview.table.limited")}</p>}
      <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
        {parsed.rows.length ? (
          <table className="min-w-full border-collapse text-start text-[12px] text-v2-text-text-base">
            <caption className="sr-only">{t("preview.table.title")}</caption>
            <thead>
              <tr>
                {columns.map((column) => (
                  <th
                    key={column}
                    scope="col"
                    className="border border-v2-grey-200 bg-v2-grey-100 p-2 text-start align-top"
                  >
                    {cell(parsed.rows[0]?.[column] ?? "", 1, column)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {parsed.rows.slice(1 + page * pageSize, 1 + (page + 1) * pageSize).map((row, offset) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: Immutable rows within a content-keyed document use file positions as identities.
                <tr key={page * pageSize + offset}>
                  {columns.map((column) => (
                    <td key={column} className="border border-v2-grey-200 p-2 align-top">
                      {cell(row[column] ?? "", 2 + page * pageSize + offset, column)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="p-3 text-[12px] text-v2-text-text-muted">{t("preview.table.empty")}</p>
        )}
      </div>
      <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-v2-grey-200 p-2 text-[12px] text-v2-text-text-muted">
        <button
          type="button"
          className={previewButtonClass}
          disabled={page === 0}
          onClick={() => setPage((value) => value - 1)}
        >
          {t("preview.table.previous")}
        </button>
        <span>
          {t("preview.table.page")
            .replace("{page}", String(page + 1))
            .replace("{pages}", String(pages))}
        </span>
        <button
          type="button"
          className={previewButtonClass}
          disabled={page + 1 >= pages}
          onClick={() => setPage((value) => value + 1)}
        >
          {t("preview.table.next")}
        </button>
        <span role="status">{copyStatus ? t(`preview.table.${copyStatus}`) : ""}</span>
      </footer>
    </div>
  );
}
