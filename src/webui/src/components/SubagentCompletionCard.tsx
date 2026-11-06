import { AlertTriangle, ChevronDown, ChevronRight, GitFork } from "lucide-react";
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
    <li
      className="er-chat-activity flex w-full min-w-0 flex-col gap-1.5"
      data-error={entry.status === "error" || undefined}
    >
      <button type="button" className="er-chat-activity-trigger" aria-expanded={open} onClick={() => onToggle(!open)}>
        {entry.status === "error" ? <AlertTriangle size={15} aria-hidden /> : <GitFork size={15} aria-hidden />}
        <span className="flex min-w-0 items-center gap-1">
          <span className="max-w-full shrink-0 truncate">
            {label}
            {preview ? ":" : null}
          </span>{" "}
          {preview ? (
            <span className="min-w-0 truncate text-[12.5px] font-normal text-v2-text-text-muted">{preview}</span>
          ) : null}
        </span>
        {open ? (
          <ChevronDown size={14} className="shrink-0" aria-hidden />
        ) : (
          <ChevronRight size={14} className="shrink-0" aria-hidden />
        )}
      </button>
      {mounted ? (
        <div
          data-scrollable
          className={`er-chat-activity-body ${phase === "enter" ? "animate-v2-expand-down" : "animate-v2-collapse-up"} motion-reduce:animate-none`}
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
