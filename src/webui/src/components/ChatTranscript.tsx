import { elementScroll, useVirtualizer } from "@tanstack/react-virtual";
import { AlertTriangle, Check, ChevronDown, ChevronRight } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { isScrollKeyTarget, normalizeWheelDelta, scrollKey, scrollKeyOwner } from "../hooks/scrollGesture";
import { useAutoScroll } from "../hooks/useAutoScroll";
import { useExpandable } from "../hooks/useExpandable";
import { useScrollGesture } from "../hooks/useScrollGesture";
import { agentDisplayName } from "../i18n/agents";
import type { MessageKey } from "../i18n/messages";
import { useI18n } from "../i18n/useI18n";
import { usePreferences } from "../preferences/PreferencesProvider";
import type { SessionMessageView, ToolView } from "../session-reducer";
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

export interface ChatTranscriptHandle {
  /** Re-pins the transcript to the latest message and resumes following. */
  scrollToLatest(): void;
}

type PendingRow = { kind: "pending" };
type TranscriptEntry = SessionMessageView | ToolView | PendingRow;

const ROLE_LABELS: Record<string, MessageKey> = {
  user: "transcript.you",
  assistant: "transcript.paperAssistant",
};

const ROW_ESTIMATE = 60;
const ROW_GAP_PX = 12;

/** Collapsible reasoning block; expansion state is controlled by the virtualized list. */
function ReasoningBlock({
  text,
  open,
  onToggle,
  active,
}: {
  text: string;
  open: boolean;
  onToggle: (open: boolean) => void;
  active: boolean;
}) {
  const { t } = useI18n();
  const { mounted, phase } = useExpandable(open);

  return (
    <div className="flex w-full flex-col gap-1.5">
      <button
        type="button"
        className="flex items-center gap-1 text-[12px] font-medium text-v2-text-text-faint transition-colors hover:text-v2-text-text-muted"
        aria-expanded={open}
        onClick={() => onToggle(!open)}
      >
        {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
        <span>{open ? t("transcript.hideDetails") : t("transcript.showDetails")}</span>
        {active ? <span className="v2-thinking-active text-v2-text-text-faint">{t("transcript.thinking")}</span> : null}
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

function ToolRow({ tool, open, onToggle }: { tool: ToolView; open: boolean; onToggle: (open: boolean) => void }) {
  const { t } = useI18n();
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
        onClick={() => onToggle(!open)}
      >
        {tool.running ? <span className="v2-spinner" aria-hidden /> : null}
        {tool.done && !tool.error ? <Check size={13} aria-hidden /> : null}
        {tool.error ? <AlertTriangle size={13} aria-hidden /> : null}
        <span className="truncate">
          {tool.running ? t("transcript.runningTool") : ""}
          {tool.name}
          {tool.args ? <span className="text-v2-text-text-faint"> {tool.args}</span> : null}
        </span>
        {open ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
      </button>
      {mounted && (
        <div
          data-scrollable
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
function MessageRow({
  message,
  open,
  onToggle,
}: {
  message: SessionMessageView;
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const roleKey = ROLE_LABELS[message.role];
  const label = message.label ? agentDisplayName(t, message.label) : roleKey ? t(roleKey) : message.role;
  const isYou = message.role === "user" && message.label == null;
  const hasBody = Boolean(message.text) || message.error || message.streaming;
  return (
    <li className={`flex flex-col gap-1 ${isYou ? "items-end" : "items-start"}`}>
      <span className="text-[11px] font-medium uppercase tracking-wide text-v2-text-text-faint">{label}</span>
      {message.reasoning ? (
        <ReasoningBlock text={message.reasoning} open={open} onToggle={onToggle} active={Boolean(message.isThinking)} />
      ) : message.isThinking ? (
        <span className="v2-thinking-active text-[12px] font-medium text-v2-text-text-faint">
          {t("transcript.thinking")}
        </span>
      ) : null}
      {hasBody && (message.role === "assistant" || message.role === "user") ? (
        <div
          className={`v2-md max-w-full rounded-lg px-3 py-2 text-[length:var(--v2-chat-font-size)] ${
            isYou ? "bg-v2-blue-100/60 text-v2-text-text-base" : "bg-v2-background-bg-deep text-v2-text-text-base"
          } ${message.error ? "text-v2-status-error" : ""}`}
        >
          <MarkdownBlock text={message.text} />
          {message.streaming && <span className="v2-caret" aria-hidden />}
        </div>
      ) : hasBody ? (
        <span
          className={`rounded-md px-2 py-1 font-mono text-[12px] ${
            message.error ? "text-v2-status-error" : "text-v2-text-text-muted"
          }`}
        >
          {message.text}
          {message.streaming && <span className="v2-caret" aria-hidden />}
        </span>
      ) : null}
    </li>
  );
}

function PendingRow() {
  const { t } = useI18n();
  return (
    <li className="flex flex-col items-start gap-1" aria-label={t("transcript.working")}>
      <span className="text-[11px] font-medium uppercase tracking-wide text-v2-text-text-faint">
        {t("transcript.paperAssistant")}
      </span>
      <div className="v2-md flex items-center gap-2 rounded-lg bg-v2-background-bg-deep px-3 py-2 text-[length:var(--v2-chat-font-size)] text-v2-text-text-base">
        <span className="v2-spinner" aria-hidden />
        <span className="text-[12px] text-v2-text-text-faint">{t("transcript.workingInProgress")}</span>
        <span className="v2-caret" aria-hidden />
      </div>
    </li>
  );
}

/**
 * Streaming chat transcript, virtualized with @tanstack/react-virtual and
 * following behavior ported from opencode (ADR-064): messages and tool rows
 * share one stream order (the reducer assigns monotonically increasing
 * positions), the list pins to the bottom while the user stays there, any
 * disengaged gesture unpins immediately, and returning to the bottom re-pins.
 * Expansion state for collapsible rows lives in `openByKey` so virtualized
 * rows keep their open/closed state across unmount/remount.
 */
export const ChatTranscript = forwardRef<ChatTranscriptHandle, ChatTranscriptProps>(function ChatTranscript(
  { messages, tools, emptyHint, pending = false, onViewDetails },
  ref,
) {
  const { t } = useI18n();
  const { preferences } = usePreferences();
  const hint = emptyHint ?? t("transcript.sendToStart");
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [openByKey, setOpenByKey] = useState<Record<string, boolean>>({});

  const entries = useMemo<TranscriptEntry[]>(() => {
    const base = [...messages, ...tools].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    if (!pending) return base;
    return [...base, { kind: "pending" }];
  }, [messages, tools, pending]);

  const autoScroll = useAutoScroll({ working: true, overflowAnchor: "none" });
  const {
    scrollRef: setAutoScrollRef,
    contentRef: setAutoScrollContentRef,
    handleScroll: handleAutoScroll,
    handleInteraction,
    resume: autoScrollResume,
    userScrolled,
  } = autoScroll;
  const { markScrollGesture, markBoundaryWheel, hasScrollGesture } = useScrollGesture(scrollRef);
  const shouldAnchorBottom = useCallback(() => !userScrolled(), [userScrolled]);

  const [scrollState, setScrollState] = useState({ overflow: false, bottom: true, jump: false });
  const scrollStateFrame = useRef<number | null>(null);
  const scrollStateEl = useRef<HTMLDivElement | null>(null);

  const jumpThreshold = useCallback((el: HTMLDivElement) => Math.max(400, el.clientHeight), []);

  const scheduleScrollState = useCallback(
    (el: HTMLDivElement) => {
      scrollStateEl.current = el;
      if (scrollStateFrame.current !== null) return;
      scrollStateFrame.current = requestAnimationFrame(() => {
        scrollStateFrame.current = null;
        const target = scrollStateEl.current;
        scrollStateEl.current = null;
        if (!target) return;
        const max = target.scrollHeight - target.clientHeight;
        const distance = max - target.scrollTop;
        const overflow = max > 1;
        const bottom = !overflow || distance <= 2;
        const jump = overflow && distance > jumpThreshold(target);
        setScrollState((current) =>
          current.overflow === overflow && current.bottom === bottom && current.jump === jump
            ? current
            : { overflow, bottom, jump },
        );
      });
    },
    [jumpThreshold],
  );

  const rowKey = useCallback((entry: TranscriptEntry | undefined, index: number) => {
    if (!entry) return `removed:${index}`;
    return "kind" in entry ? "pending" : entry.key;
  }, []);

  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE,
    overscan: 20,
    getItemKey: (index) => rowKey(entries[index], index),
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: 80,
    paddingEnd: 64,
    initialOffset: () => (shouldAnchorBottom() ? Number.MAX_SAFE_INTEGER : 0),
    scrollToFn: (offset, options, instance) => {
      // Expose the computed range before core writes an anchor correction so the browser does not clamp it to the old height.
      const content = contentRef.current;
      if (content) content.style.height = `${instance.getTotalSize()}px`;
      elementScroll(offset, options, instance);
    },
  });
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item) => {
    if (shouldAnchorBottom()) return false;
    const first = virtualizer.range?.startIndex;
    return first !== undefined && item.index < first;
  };

  const resumeScroll = useCallback(() => {
    autoScrollResume();
    virtualizer.scrollToEnd();
    const el = scrollRef.current;
    if (el) scheduleScrollState(el);
  }, [autoScrollResume, scheduleScrollState, virtualizer]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToLatest() {
        resumeScroll();
      },
    }),
    [resumeScroll],
  );

  const handleScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      scheduleScrollState(event.currentTarget);
      if (!hasScrollGesture()) return;
      handleAutoScroll();
      markScrollGesture(event.currentTarget);
    },
    [handleAutoScroll, hasScrollGesture, markScrollGesture, scheduleScrollState],
  );

  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      const root = event.currentTarget;
      const delta = normalizeWheelDelta({
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        rootHeight: root.clientHeight,
      });
      if (!delta) return;
      markBoundaryWheel(event.target, delta);
    },
    [markBoundaryWheel],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const key = scrollKey(event);
      if (!key) return;
      const root = scrollRef.current;
      if (!root) return;
      if (!isScrollKeyTarget(event.target, key)) return;
      if (scrollKeyOwner(root, event.target, key) !== root) return;
      markScrollGesture(root);
      const scrollAmount = root.clientHeight * 0.8;
      const lineAmount = 40;
      switch (key) {
        case "page-down":
          event.preventDefault();
          if (root.scrollBy) root.scrollBy({ top: scrollAmount, behavior: "smooth" });
          break;
        case "page-up":
          event.preventDefault();
          if (root.scrollBy) root.scrollBy({ top: -scrollAmount, behavior: "smooth" });
          break;
        case "home":
          event.preventDefault();
          if (root.scrollTo) root.scrollTo({ top: 0, behavior: "smooth" });
          break;
        case "end":
          event.preventDefault();
          if (root.scrollTo) root.scrollTo({ top: root.scrollHeight, behavior: "smooth" });
          break;
        case "up":
          event.preventDefault();
          if (root.scrollBy) root.scrollBy({ top: -lineAmount, behavior: "smooth" });
          break;
        case "down":
          event.preventDefault();
          if (root.scrollBy) root.scrollBy({ top: lineAmount, behavior: "smooth" });
          break;
      }
    },
    [markScrollGesture],
  );

  const bindScrollRef = useCallback(
    (el: HTMLDivElement | null) => {
      scrollRef.current = el;
      setAutoScrollRef(el);
      if (el) scheduleScrollState(el);
    },
    [scheduleScrollState, setAutoScrollRef],
  );

  const bindContentRef = useCallback(
    (el: HTMLDivElement | null) => {
      contentRef.current = el;
      setAutoScrollContentRef(el);
    },
    [setAutoScrollContentRef],
  );

  // Follow content growth while anchored; this also aligns a fresh transcript
  // to the bottom on its first render (initialOffset only shapes the first
  // virtual range, not the real scroll position).
  useEffect(() => {
    if (entries.length === 0) return;
    if (!shouldAnchorBottom() || hasScrollGesture()) return;
    virtualizer.scrollToEnd();
  }, [entries.length, hasScrollGesture, shouldAnchorBottom, virtualizer]);

  return (
    <div className="relative min-h-0 flex-1">
      {scrollState.overflow && scrollState.jump ? (
        <button
          type="button"
          aria-label={t("transcript.jumpToLatest")}
          onClick={resumeScroll}
          className="pointer-events-auto absolute bottom-6 left-1/2 z-50 flex h-7 -translate-x-1/2 items-center justify-center rounded-lg bg-v2-background-bg-base/95 px-2.5 text-v2-text-text-base shadow-[var(--v2-elevation-raised)] backdrop-blur transition-colors hover:bg-v2-background-bg-strong"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
            <title>{t("transcript.jumpToLatest")}</title>
            <path
              d="M12.3333 8.66665L8 13L3.66667 8.66665M8 12.6667V2.83332"
              stroke="currentColor"
              stroke-linecap="square"
            />
          </svg>
        </button>
      ) : null}
      {/* The scroll container is focusable so scroll keys reach it (opencode scroll-view parity); biome.json scopes this in. */}
      <section
        ref={bindScrollRef}
        data-scrollable
        tabIndex={0}
        className="min-h-0 h-full overflow-y-auto"
        aria-label={t("transcript.conversation")}
        onScroll={handleScroll}
        onWheel={handleWheel}
        onPointerDown={(event) => markScrollGesture(event.target)}
        onPointerMove={(event) => {
          if (event.buttons === 1) markScrollGesture(event.target);
        }}
        onKeyDown={handleKeyDown}
        onClick={handleInteraction}
      >
        {entries.length === 0 ? (
          <p className="px-4 pt-6 text-center text-[length:var(--v2-chat-font-size)] text-v2-text-text-faint">{hint}</p>
        ) : null}
        <div
          ref={bindContentRef}
          className="relative mx-auto w-full max-w-[1000px]"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const entry = entries[virtualRow.index];
            if (!entry) return null;
            const key = rowKey(entry, virtualRow.index);
            return (
              <div key={key} style={{ position: "absolute", top: `${virtualRow.start}px`, left: 0, width: "100%" }}>
                <div
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  className="px-4"
                  style={{ minHeight: `${virtualRow.size}px`, paddingBottom: ROW_GAP_PX }}
                >
                  {"kind" in entry ? (
                    <PendingRow />
                  ) : "name" in entry ? (
                    entry.name === "subagent" ? (
                      <SubagentToolCard
                        tool={entry}
                        open={openByKey[key] ?? preferences.expandSubagentOutput}
                        initialOpen={openByKey[key] ?? preferences.expandSubagentOutput}
                        onToggle={(next) => setOpenByKey((current) => ({ ...current, [key]: next }))}
                        onViewDetails={onViewDetails}
                      />
                    ) : (
                      <ToolRow
                        tool={entry}
                        open={openByKey[key] ?? preferences.autoExpandTools}
                        onToggle={(next) => setOpenByKey((current) => ({ ...current, [key]: next }))}
                      />
                    )
                  ) : (
                    <MessageRow
                      message={entry}
                      open={openByKey[key] ?? preferences.autoExpandThinking}
                      onToggle={(next) => setOpenByKey((current) => ({ ...current, [key]: next }))}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
});
