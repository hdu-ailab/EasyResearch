import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, ChevronDown, ChevronRight } from "lucide-react";
import type { SessionMessageView, ToolView } from "../session-reducer";
import { useExpandable } from "../hooks/useExpandable";
import { useI18n } from "../i18n/useI18n";
import { agentDisplayName } from "../i18n/agents";
import type { MessageKey } from "../i18n/messages";
import { usePreferences } from "../preferences/PreferencesProvider";
import { MarkdownBlock } from "./MarkdownBlock";
import { SubagentToolCard } from "./SubagentToolCard";

export interface ChatTranscriptProps {
  messages: SessionMessageView[];
  tools: ToolView[];
  emptyHint?: string;
  /** While true, renders a working agent row under the newest user message. */
  pending?: boolean;
  onViewDetails?: (toolCallId: string, step?: number) => void;
}

const ROLE_LABELS: Record<string, MessageKey> = {
  user: "transcript.you",
  assistant: "transcript.orchestrator",
};

const STICK_THRESHOLD = 24;

/** Collapsible reasoning block initialized from the preference for this row. */
function ReasoningBlock({ text, initialOpen }: { text: string; initialOpen: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(initialOpen);
  const { mounted, phase } = useExpandable(open);

  return (
    <div className="flex w-full flex-col gap-1.5">
      <button
        type="button"
        className="flex items-center gap-1 text-[12px] font-medium text-v2-text-text-faint transition-colors hover:text-v2-text-text-muted"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
        <span>{open ? t("transcript.hideDetails") : t("transcript.showDetails")}</span>
        <span className="text-v2-text-text-faint/70">{t("transcript.thinking")}</span>
      </button>
      {mounted && (
        <div
          className={`border-l-2 border-v2-blue-200 pl-3 ${
            phase === "enter" ? "animate-v2-expand-down" : "animate-v2-collapse-up"
          } motion-reduce:animate-none`}
        >
          <div className="v2-md text-[12.5px] text-v2-text-text-muted">
            <MarkdownBlock text={text} />
          </div>
        </div>
      )}
    </div>
  );
}

function ToolRow({ tool, initialOpen }: { tool: ToolView; initialOpen: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(initialOpen);
  const { mounted, phase } = useExpandable(open);
  const statusClass = tool.done
    ? tool.error
      ? "border-v2-status-error/30 text-v2-status-error hover:bg-v2-status-error/5"
      : "border-v2-grey-200 text-v2-text-text-muted hover:bg-v2-grey-100"
    : "border-v2-blue-200 text-v2-blue-600 hover:bg-v2-blue-100/50";

  return (
    <li className="flex flex-col gap-1 items-start">
      <button
        type="button"
        className={`flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] transition-colors ${statusClass}`}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {tool.running ? <span className="v2-spinner" aria-hidden /> : null}
        {tool.done && !tool.error ? <Check size={13} aria-hidden /> : null}
        {tool.error ? <AlertTriangle size={13} aria-hidden /> : null}
        <span className="truncate">
          {tool.running ? t("transcript.runningTool") : ""}
          {tool.name}
          {tool.args ? <span className="text-v2-text-text-faint"> {tool.args}</span> : null}
        </span>
        {open ? (
          <ChevronDown size={12} aria-hidden />
        ) : (
          <ChevronRight size={12} aria-hidden />
        )}
      </button>
      {mounted && (
        <div
          className={`max-h-64 w-full overflow-y-auto rounded-md border border-v2-grey-200 bg-v2-background-bg-deep px-3 py-2 ${
            phase === "enter" ? "animate-v2-expand-down" : "animate-v2-collapse-up"
          } motion-reduce:animate-none`}
        >
          {tool.output ? (
            <pre className="whitespace-pre-wrap font-mono text-[length:var(--v2-chat-font-size)] leading-relaxed text-v2-text-text-muted">
              {tool.output}
            </pre>
          ) : tool.running ? (
            <p className="text-[12px] text-v2-text-text-muted">{t("transcript.running")}</p>
          ) : (
            <p className="text-[12px] text-v2-text-text-faint">{t("transcript.noOutput")}</p>
          )}
        </div>
      )}
    </li>
  );
}

/** A single message bubble. Human messages align right with the You label;
 * anything labeled otherwise (subagent-line dispatches, agent replies)
 * aligns left under its own label. */
function MessageRow({ message, initialThinkingOpen }: { message: SessionMessageView; initialThinkingOpen: boolean }) {
  const { t } = useI18n();
  const roleKey = ROLE_LABELS[message.role];
  const label = message.label ? agentDisplayName(t, message.label) : roleKey ? t(roleKey) : message.role;
  const isYou = message.role === "user" && message.label == null;
  return (
    <li className={`flex flex-col gap-1 ${isYou ? "items-end" : "items-start"}`}>
      <span className="text-[11px] font-medium uppercase tracking-wide text-v2-text-text-faint">{label}</span>
      {message.reasoning ? <ReasoningBlock text={message.reasoning} initialOpen={initialThinkingOpen} /> : null}
      {message.role === "assistant" || message.role === "user" ? (
        <div
          className={`v2-md max-w-full rounded-lg px-3 py-2 text-[length:var(--v2-chat-font-size)] ${
            isYou ? "bg-v2-blue-100/60 text-v2-text-text-base" : "bg-v2-background-bg-deep text-v2-text-text-base"
          } ${message.error ? "text-v2-status-error" : ""}`}
        >
          <MarkdownBlock text={message.text} />
          {message.streaming && <span className="v2-caret" aria-hidden />}
        </div>
      ) : (
        <span
          className={`rounded-md px-2 py-1 font-mono text-[12px] ${
            message.error ? "text-v2-status-error" : "text-v2-text-text-muted"
          }`}
        >
          {message.text}
          {message.streaming && <span className="v2-caret" aria-hidden />}
        </span>
      )}
    </li>
  );
}

/**
 * Streaming chat transcript. Messages and tool rows share one stream order
 * (the reducer assigns monotonically increasing positions), so tool rows
 * interleave with message bubbles exactly where the agent executed them.
 * The list pins to the bottom while the user stays at the bottom; any
 * manual scroll away unpins it, and returning to the bottom re-pins.
 */
export function ChatTranscript({ messages, tools, emptyHint, pending = false, onViewDetails }: ChatTranscriptProps) {
  const { t } = useI18n();
  const { preferences } = usePreferences();
  const hint = emptyHint ?? t("transcript.sendToStart");
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLUListElement>(null);
  const stickRef = useRef(true);
  const frameRef = useRef<number | null>(null);
  const entries = useMemo(
    () => [...messages, ...tools].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [messages, tools],
  );

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD;
  };

  const scheduleFollow = () => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const element = scrollRef.current;
      if (element && stickRef.current) element.scrollTop = element.scrollHeight;
    });
  };

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const observer = new ResizeObserver(scheduleFollow);
    observer.observe(content);
    return () => {
      observer.disconnect();
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    scheduleFollow();
  }, [entries, pending]);

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto" aria-label={t("transcript.conversation")} onScroll={onScroll}>
      {messages.length === 0 && tools.length === 0 && !pending && (
        <p className="px-4 pt-6 text-center text-[length:var(--v2-chat-font-size)] text-v2-text-text-faint">{hint}</p>
      )}
      <ul ref={contentRef} className="mx-auto flex w-full max-w-[1000px] flex-col gap-3 p-4 md:max-w-200 2xl:max-w-[1000px]">
        {entries.map((entry) =>
          "name" in entry ? entry.name === "subagent" ? (
            <SubagentToolCard
              key={entry.key}
              tool={entry}
              initialOpen={preferences.expandSubagentOutput}
              onViewDetails={onViewDetails}
            />
          ) : (
            <ToolRow key={entry.key} tool={entry} initialOpen={preferences.autoExpandTools} />
          ) : (
            <MessageRow key={entry.key} message={entry} initialThinkingOpen={preferences.autoExpandThinking} />
          ),
        )}
        {pending && (
          <li className="flex flex-col items-start gap-1" aria-label={t("transcript.working")}>
            <span className="text-[11px] font-medium uppercase tracking-wide text-v2-text-text-faint">{t("transcript.orchestrator")}</span>
            <div className="v2-md flex items-center gap-2 rounded-lg bg-v2-background-bg-deep px-3 py-2 text-[length:var(--v2-chat-font-size)] text-v2-text-text-base">
              <span className="v2-spinner" aria-hidden />
              <span className="text-[12px] text-v2-text-text-faint">{t("transcript.workingInProgress")}</span>
              <span className="v2-caret" aria-hidden />
            </div>
          </li>
        )}
      </ul>
    </div>
  );
}
