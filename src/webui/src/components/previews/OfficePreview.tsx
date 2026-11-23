import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Copy, Minus, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { RawFileSizeError, readRawFileBytes } from "../../api";
import type { MessageKey } from "../../i18n/messages";
import { useI18n } from "../../i18n/useI18n";
import { useViewActivity } from "../../view-activity";
import { createOfficeClient, type OfficeClient, OfficePreviewError } from "./office-client";
import { createOfficePainter } from "./office-paint";
import {
  OFFICE_COLUMNS,
  OFFICE_MAX_FILE_BYTES,
  OFFICE_ROWS,
  type OfficeDocument,
  type OfficeFrame,
  type OfficeKind,
  type OfficeView,
  officeCanvasSize,
  officeColumnLabel,
} from "./office-protocol";
import { PreviewToolbar, previewButtonClass } from "./PreviewToolbar";

export interface OfficePreviewProps {
  kind: OfficeKind;
  path: string;
  revision?: number;
}

function errorKey(error: unknown): MessageKey {
  if (error instanceof RawFileSizeError) return "preview.office.limit";
  if (error instanceof OfficePreviewError) {
    if (["limit", "too-many-entries", "entry-too-large", "archive-too-large"].includes(error.message))
      return "preview.office.limit";
    if (error.message === "timeout") return "preview.office.timeout";
    if (error.message === "encrypted") return "preview.office.encrypted";
    if (error.message === "unsupported") return "preview.office.unsupported";
  }
  return "preview.office.error";
}
const isAbort = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

/** A changed path/revision owns a fresh Worker, fonts and canvas; retained hidden views release them too. */
export function OfficePreview(props: OfficePreviewProps) {
  return <OfficePreviewFile key={`${props.kind}:${props.path}:${props.revision ?? 0}`} {...props} />;
}

function OfficePreviewFile({ path, kind }: OfficePreviewProps) {
  const { t } = useI18n();
  const { visible } = useViewActivity();
  const [retry, setRetry] = useState(0);
  const [opened, setOpened] = useState<OfficeDocument | null>(null);
  const [frame, setFrame] = useState<OfficeFrame | null>(null);
  const [view, setView] = useState<OfficeView>({ index: 0, row: 0, column: 0 });
  const [scale, setScale] = useState(1);
  const [error, setError] = useState<unknown>(null);
  const [visual, setVisual] = useState(true);
  const [omittedImages, setOmittedImages] = useState(false);
  const [copyStatus, setCopyStatus] = useState<MessageKey | null>(null);
  const client = useRef<OfficeClient | null>(null);
  const openedOwner = useRef<OfficeClient | null>(null);
  const painter = useRef<ReturnType<typeof createOfficePainter> | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    void retry;
    if (!visible) return;
    const controller = new AbortController();
    let ownedClient: OfficeClient | undefined;
    const ownedPainter = createOfficePainter();
    painter.current = ownedPainter;
    openedOwner.current = null;
    setOpened(null);
    setFrame(null);
    setError(null);
    setView({ index: 0, row: 0, column: 0 });
    const timeout = setTimeout(() => {
      setError(new OfficePreviewError("timeout"));
      controller.abort();
      ownedClient?.dispose();
    }, 60_000);
    void (async () => {
      try {
        if (typeof Worker === "undefined") throw new OfficePreviewError("unsupported");
        ownedClient = createOfficeClient();
        client.current = ownedClient;
        const bytes = await readRawFileBytes(path, { maxBytes: OFFICE_MAX_FILE_BYTES, signal: controller.signal });
        if (controller.signal.aborted) return;
        const document = await ownedClient.open(kind, bytes, controller.signal);
        if (!controller.signal.aborted) {
          openedOwner.current = ownedClient;
          setOpened(document);
        }
      } catch (nextError) {
        if (!controller.signal.aborted && !isAbort(nextError)) {
          setError(nextError);
          ownedClient?.dispose();
        }
      } finally {
        clearTimeout(timeout);
      }
    })();
    return () => {
      controller.abort();
      clearTimeout(timeout);
      ownedClient?.dispose();
      ownedPainter.dispose();
      if (client.current === ownedClient) client.current = null;
      if (painter.current === ownedPainter) painter.current = null;
    };
  }, [path, kind, retry, visible]);

  useEffect(() => {
    if (!visible || !opened?.items.length || !client.current || client.current !== openedOwner.current) return;
    const controller = new AbortController();
    setFrame(null);
    setError(null);
    setCopyStatus(null);
    void client.current.frame(view, controller.signal).then(
      (next) => {
        if (!controller.signal.aborted) setFrame(next);
      },
      (nextError) => {
        if (!controller.signal.aborted && !isAbort(nextError)) setError(nextError);
      },
    );
    return () => controller.abort();
  }, [opened, view, visible]);

  useEffect(() => {
    if (!frame || !canvas.current || !painter.current || !visible || client.current !== openedOwner.current) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
      setVisual(false);
    }, 15_000);
    const target = canvas.current;
    target.width = target.height = 0;
    setVisual(true);
    setOmittedImages(false);
    void painter.current
      .paint(target, frame, Math.min(globalThis.devicePixelRatio || 1, 2) * scale, controller.signal)
      .then(
        (result) => {
          if (!controller.signal.aborted) {
            setVisual(result.visual);
            setOmittedImages(result.omittedImages);
          }
        },
        (nextError) => {
          if (!controller.signal.aborted && !isAbort(nextError)) setVisual(false);
        },
      )
      .finally(() => clearTimeout(timeout));
    return () => {
      controller.abort();
      clearTimeout(timeout);
      target.width = target.height = 0;
    };
  }, [frame, scale, visible]);

  const changeItem = (index: number) => setView({ index, row: 0, column: 0 });
  const copyText = async () => {
    if (!frame) return;
    try {
      await navigator.clipboard.writeText(frame.text);
      setCopyStatus("preview.office.copied");
    } catch {
      setCopyStatus("preview.office.copyError");
    }
  };
  const range =
    frame?.kind === "spreadsheet"
      ? t("preview.office.range")
          .replace("{rows}", `${frame.row + 1}–${frame.lastRow + 1}`)
          .replace("{columns}", `${officeColumnLabel(frame.column)}–${officeColumnLabel(frame.lastColumn)}`)
      : "";
  const displaySize = frame ? officeCanvasSize(frame.list.width, frame.list.height, scale) : undefined;

  return (
    <div className="flex h-full min-w-0 flex-col">
      <PreviewToolbar path={path} controlsLabel={t("preview.office.controls")}>
        {opened && opened.items.length > 0 && (
          <>
            <label className="flex min-w-0 items-center gap-1 text-xs text-v2-text-text-muted">
              {t(kind === "spreadsheet" ? "preview.office.sheet" : "preview.office.slide")}
              <select
                className="h-7 min-w-0 max-w-44 rounded border border-v2-grey-200 bg-v2-grey-0 px-1 text-v2-text-text-base"
                value={view.index}
                onChange={(event) => changeItem(Number(event.target.value))}
              >
                {opened.items.map((item) => (
                  <option key={item.index} value={item.index}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            {kind === "presentation" && (
              <>
                <button
                  type="button"
                  className={previewButtonClass}
                  aria-label={t("preview.office.previous")}
                  disabled={view.index <= 0}
                  onClick={() => changeItem(view.index - 1)}
                >
                  <ChevronLeft size={14} />
                </button>
                <button
                  type="button"
                  className={previewButtonClass}
                  aria-label={t("preview.office.next")}
                  disabled={view.index >= opened.items.length - 1}
                  onClick={() => changeItem(view.index + 1)}
                >
                  <ChevronRight size={14} />
                </button>
              </>
            )}
          </>
        )}
        <button
          type="button"
          className={previewButtonClass}
          aria-label={t("preview.office.zoomOut")}
          disabled={scale <= 0.5}
          onClick={() => setScale((value) => Math.max(0.5, value - 0.25))}
        >
          <Minus size={14} />
        </button>
        <span className="font-mono text-xs text-v2-text-text-muted">{Math.round(scale * 100)}%</span>
        <button
          type="button"
          className={previewButtonClass}
          aria-label={t("preview.office.zoomIn")}
          disabled={scale >= 2}
          onClick={() => setScale((value) => Math.min(2, value + 0.25))}
        >
          <Plus size={14} />
        </button>
      </PreviewToolbar>
      {kind === "spreadsheet" && opened && (
        <fieldset className="flex shrink-0 flex-wrap items-center gap-1 border-b border-v2-grey-200 p-1">
          <legend className="sr-only">{t("preview.office.cells")}</legend>
          <button
            type="button"
            className={previewButtonClass}
            aria-label={t("preview.office.previousRows")}
            disabled={view.row === 0}
            onClick={() => setView((value) => ({ ...value, row: Math.max(0, value.row - OFFICE_ROWS) }))}
          >
            <ChevronUp size={14} />
          </button>
          <button
            type="button"
            className={previewButtonClass}
            aria-label={t("preview.office.nextRows")}
            disabled={frame?.kind !== "spreadsheet" || view.row + OFFICE_ROWS >= frame.rowCount}
            onClick={() => setView((value) => ({ ...value, row: value.row + OFFICE_ROWS }))}
          >
            <ChevronDown size={14} />
          </button>
          <button
            type="button"
            className={previewButtonClass}
            aria-label={t("preview.office.previousColumns")}
            disabled={view.column === 0}
            onClick={() => setView((value) => ({ ...value, column: Math.max(0, value.column - OFFICE_COLUMNS) }))}
          >
            <ChevronLeft size={14} />
          </button>
          <button
            type="button"
            className={previewButtonClass}
            aria-label={t("preview.office.nextColumns")}
            disabled={frame?.kind !== "spreadsheet" || view.column + OFFICE_COLUMNS >= frame.columnCount}
            onClick={() => setView((value) => ({ ...value, column: value.column + OFFICE_COLUMNS }))}
          >
            <ChevronRight size={14} />
          </button>
          <span className="text-xs text-v2-text-text-muted">{range}</span>
        </fieldset>
      )}
      <div className="min-h-0 min-w-0 flex-1 overflow-auto bg-v2-grey-100 p-2">
        {error ? (
          <div className="flex flex-col items-start gap-2 p-3">
            <p role="alert" className="text-sm text-v2-text-text-muted">
              {t(errorKey(error))}
            </p>
            <button type="button" className={previewButtonClass} onClick={() => setRetry((value) => value + 1)}>
              {t("preview.retry")}
            </button>
          </div>
        ) : !opened || (!frame && opened.items.length > 0) ? (
          <p className="p-4 text-xs text-v2-text-text-muted">{t("files.loading")}</p>
        ) : opened.items.length === 0 ? (
          <p>{t("preview.office.empty")}</p>
        ) : null}
        {frame && !error && (
          <>
            <canvas
              ref={canvas}
              role="img"
              aria-label={t("preview.office.canvas")}
              className={visual ? "block bg-white" : "hidden"}
              style={{ width: displaySize?.width, height: displaySize?.height }}
            />
            {!visual && (
              <p role="status" className="my-2 text-xs text-v2-text-text-muted">
                {t("preview.office.textFallback")}
              </p>
            )}
            {(omittedImages || (frame.kind === "presentation" && frame.omittedImages)) && (
              <p className="my-2 text-xs text-v2-text-text-muted">{t("preview.office.imagesOmitted")}</p>
            )}
            {frame.truncated && <p className="my-2 text-xs text-v2-text-text-muted">{t("preview.office.truncated")}</p>}
            <details open={!visual || undefined} className="my-2 text-v2-text-text-base">
              <summary className="cursor-pointer py-1 text-sm">{t("preview.office.text")}</summary>
              <button type="button" className={previewButtonClass} onClick={() => void copyText()}>
                <Copy size={14} />
                {t("preview.office.copy")}
              </button>
              {copyStatus && (
                <p role="status" className="text-xs">
                  {t(copyStatus)}
                </p>
              )}
              {frame.kind === "spreadsheet" ? (
                <table className="border-collapse text-xs">
                  <caption className="text-start">
                    {t("preview.office.cells")} · {range}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">#</th>
                      {frame.cells[0]?.map((_, index) => (
                        <th
                          scope="col"
                          className="border border-v2-grey-200 p-1"
                          key={officeColumnLabel(frame.column + index)}
                        >
                          {officeColumnLabel(frame.column + index)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {frame.cells.map((row, rowIndex) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: The absolute sheet row is the immutable coordinate identity.
                      <tr key={frame.row + rowIndex}>
                        <th scope="row" className="border border-v2-grey-200 p-1">
                          {frame.row + rowIndex + 1}
                        </th>
                        {row.map((cell, columnIndex) => (
                          <td
                            key={officeColumnLabel(frame.column + columnIndex)}
                            className="max-w-80 whitespace-pre-wrap break-words border border-v2-grey-200 p-1"
                          >
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <pre className="whitespace-pre-wrap break-words text-sm">{frame.text}</pre>
              )}
            </details>
            {frame.kind === "presentation" && frame.notes && (
              <details className="my-2 text-v2-text-text-base">
                <summary className="cursor-pointer py-1 text-sm">{t("preview.office.notes")}</summary>
                <pre className="whitespace-pre-wrap break-words text-sm">{frame.notes}</pre>
              </details>
            )}
          </>
        )}
      </div>
    </div>
  );
}
