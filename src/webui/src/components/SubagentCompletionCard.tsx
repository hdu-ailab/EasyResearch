import { ChevronDown, ChevronRight } from "lucide-react";
import { useExpandable } from "../hooks/useExpandable";
import { useI18n } from "../i18n/useI18n";
import type { SessionCompletionView } from "../session-reducer";
import { MarkdownBlock } from "./MarkdownBlock";

const sentenceSegmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });

export function SubagentCompletionCard({
  entry,
  open,
  onToggle,
  markdownScope,
  onRendered,
}: {
  entry: SessionCompletionView;
  open: boolean;
  onToggle: (open: boolean) => void;
  markdownScope: string;
  onRendered: () => void;
}) {
  const { t } = useI18n();
  const { mounted, phase } = useExpandable(open);
  const label = t(
    entry.status === "complete" ? "transcript.subagentCompletion" : "transcript.subagentCompletionError",
  ).replace("{agentId}", () => entry.agentId);
  const content = entry.text?.trim() ? entry.text : t("transcript.subagentResultUnavailable");
  const preview = open
    ? ""
    : sentenceSegmenter.segment(content.replace(/\s+/gu, " ").trim())[Symbol.iterator]().next().value?.segment.trim();

  return (
    <li className="flex w-full min-w-0 flex-col gap-1.5">
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-1 text-left text-[12px] font-medium text-v2-text-text-faint transition-colors hover:text-v2-text-text-muted"
        aria-expanded={open}
        onClick={() => onToggle(!open)}
      >
        {open ? (
          <ChevronDown size={14} className="shrink-0" aria-hidden />
        ) : (
          <ChevronRight size={14} className="shrink-0" aria-hidden />
        )}
        <span className="flex min-w-0 items-center gap-1">
          <span className="max-w-full shrink-0 truncate">
            {label}
            {preview ? ":" : null}
          </span>{" "}
          {preview ? (
            <span className="min-w-0 truncate text-[12.5px] font-normal text-v2-text-text-muted">{preview}</span>
          ) : null}
        </span>
      </button>
      {mounted ? (
        <div
          className={`border-l-2 border-v2-blue-200 pl-3 ${phase === "enter" ? "animate-v2-expand-down" : "animate-v2-collapse-up"} motion-reduce:animate-none`}
        >
          <div className="v2-md text-[12.5px] font-normal text-v2-text-text-muted">
            <MarkdownBlock
              text={content}
              scope={markdownScope}
              cacheKey={`${entry.key}:completion`}
              onRendered={onRendered}
            />
          </div>
        </div>
      ) : null}
    </li>
  );
}
