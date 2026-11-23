import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FileLineRange } from "../../../../web/file-reference-contracts";
import { useI18n } from "../../i18n/useI18n";
import { useViewActivityRef } from "../../view-activity";

export interface TextSourcePreviewProps {
  content: string;
  selection?: FileLineRange;
  selectionKey?: number;
  label?: string;
}

const PAGE_LINES = 400;

/** Bounded read-only DOM: native text selection and scrolling, no editor runtime. */
export function TextSourcePreview({ content, selection, selectionKey, label }: TextSourcePreviewProps) {
  const { t } = useI18n();
  const activity = useViewActivityRef();
  const lines = useMemo(() => content.split(/\r?\n/u), [content]);
  const valid =
    selection &&
    Number.isInteger(selection.start) &&
    Number.isInteger(selection.end) &&
    selection.start > 0 &&
    selection.end >= selection.start &&
    selection.end <= 1_000_000
      ? selection
      : undefined;
  const targetPage = valid ? Math.floor((Math.min(valid.start, lines.length) - 1) / PAGE_LINES) : 0;
  const [page, setPage] = useState(targetPage);
  const scroller = useRef<HTMLPreElement>(null);
  const target = useRef<HTMLSpanElement>(null);
  const start = Math.min(page, Math.floor((lines.length - 1) / PAGE_LINES)) * PAGE_LINES;
  const end = Math.min(start + PAGE_LINES, lines.length);
  useLayoutEffect(() => {
    void selectionKey;
    void content;
    setPage(targetPage);
  }, [targetPage, selectionKey, content]);
  useLayoutEffect(() => {
    void selectionKey;
    void page;
    void content;
    void valid?.start;
    if (!activity.current.visible || !scroller.current) return;
    if (target.current) {
      const top = target.current.getBoundingClientRect().top - scroller.current.getBoundingClientRect().top;
      scroller.current.scrollTop += top - scroller.current.clientHeight / 3;
      target.current.focus({ preventScroll: true });
    } else scroller.current.scrollTop = 0;
  }, [page, selectionKey, content, valid?.start, activity]);
  const lineLabel = (key: "files.source.lines" | "files.source.selection", first: number, last: number) =>
    t(key).replace("{start}", String(first)).replace("{end}", String(last)).replace("{total}", String(lines.length));
  return (
    <section
      aria-label={label ?? t("files.source.label")}
      className="flex h-full min-h-0 min-w-0 flex-col text-v2-text-text-base"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-v2-grey-200 px-3 py-2 text-xs">
        <span>{lineLabel("files.source.lines", start + 1, end)}</span>
        <button
          type="button"
          className="rounded px-2 py-1 hover:bg-v2-grey-100 disabled:opacity-40"
          disabled={start === 0}
          onClick={() => setPage((current) => Math.max(0, current - 1))}
        >
          {t("files.source.previous")}
        </button>
        <button
          type="button"
          className="rounded px-2 py-1 hover:bg-v2-grey-100 disabled:opacity-40"
          disabled={end === lines.length}
          onClick={() => setPage((current) => current + 1)}
        >
          {t("files.source.next")}
        </button>
        {valid && valid.start <= lines.length ? (
          <span role="status">{lineLabel("files.source.selection", valid.start, valid.end)}</span>
        ) : null}
        {valid && valid.end > lines.length ? <span role="status">{t("files.source.outside")}</span> : null}
      </div>
      {/* Native scroll region must be reachable for keyboard-only source navigation. */}
      <pre
        ref={scroller}
        className="m-0 min-h-0 flex-1 overflow-auto overscroll-contain p-3 font-mono text-xs leading-6"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard scrolling of read-only source.
        tabIndex={0}
      >
        {lines.slice(start, end).map((line, index) => {
          const number = start + index + 1;
          const highlighted = valid && number >= valid.start && number <= valid.end;
          return (
            <span
              key={number}
              data-line={number}
              ref={number === valid?.start ? target : undefined}
              tabIndex={number === valid?.start ? -1 : undefined}
              className="block min-w-max focus-visible:outline-2"
            >
              <span
                aria-hidden="true"
                className="mr-4 inline-block w-12 select-none text-right text-v2-text-text-faint"
              >
                {number}
              </span>
              {highlighted ? (
                <mark className="border-s-2 border-v2-blue-600 bg-v2-grey-200 text-inherit">{line || " "}</mark>
              ) : (
                line || " "
              )}
            </span>
          );
        })}
      </pre>
    </section>
  );
}
