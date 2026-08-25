import { elementScroll, useVirtualizer } from "@tanstack/react-virtual";
import { AlertTriangle, Check, ChevronDown, ChevronLeft, ChevronRight, Copy, Pencil, Zap } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { isScrollKeyTarget, normalizeWheelDelta, scrollKey, scrollKeyOwner } from "../hooks/scrollGesture";
import { useAutoScroll } from "../hooks/useAutoScroll";
import { useExpandable } from "../hooks/useExpandable";
import { useScrollGesture } from "../hooks/useScrollGesture";
import { agentDisplayName } from "../i18n/agents";
import type { MessageKey } from "../i18n/messages";
import { useI18n } from "../i18n/useI18n";
import type { SessionMessageMeta } from "../message-tree";
import { usePreferences } from "../preferences/PreferencesProvider";
import type { SessionMessageView, SteerView, ToolView } from "../session-reducer";
import { MarkdownBlock } from "./MarkdownBlock";
import { SubagentToolCard } from "./SubagentToolCard";

export interface ChatTranscriptProps {
  messages: SessionMessageView[];
  tools: ToolView[];
  hydrationRevision?: number;
  hydrationScope?: string;
  emptyHint?: string;
  /** While true, renders a working agent row under the newest user message. */
  pending?: boolean;
  onViewDetails?: (toolCallId: string, step?: number) => void;
  /** Tree metadata per message key (entry ids and version groups, ADR-066). */
  messageMeta?: Record<string, SessionMessageMeta>;
  /** Edit a historical user message: branch in place, then re-send. */
  onEditMessage?: (entryId: string, text: string) => void;
  /** Switch to the previous/next version of a user message. */
  onSwitchBranch?: (entryId: string, direction: -1 | 1) => void;
  /** Steering messages queued for the active run (ADR-083); rendered below the
   * transcript as a fixed footer, newest last. */
  steers?: SteerView[];
}

export interface ChatTranscriptHandle {
  /** Re-pins the transcript to the latest message and resumes following. */
  scrollToLatest(): void;
}

type PendingRow = { kind: "pending" };
type TranscriptEntry = SessionMessageView | ToolView | PendingRow;

const ROLE_LABELS: Record<string, MessageKey> = {
  user: "transcript.you",
  assistant: "transcript.researchAssistant",
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

  if (tool.skillName) {
    return (
      <li className="flex flex-col gap-1 items-start">
        <div className="flex items-center gap-1.5 rounded-md border border-v2-blue-200 bg-v2-blue-100/40 px-2 py-1 text-[12px]">
          <Zap size={13} className="text-v2-blue-600" aria-hidden />
          <span className="font-medium text-v2-text-text-base">{t("transcript.readingSkill")}</span>
          <span className="font-mono text-v2-blue-700">{tool.skillName}</span>
        </div>
      </li>
    );
  }

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

/** In-place editor for a historical user message (ADR-066). Focus lands on
 * the textarea when the row mounts; Enter submits, Shift+Enter newlines. */
function EditMessageDraft({
  draft,
  onDraftChange,
  onCancelEdit,
  onSubmitEdit,
}: {
  draft: string;
  onDraftChange: (text: string) => void;
  onCancelEdit: () => void;
  onSubmitEdit: (text: string) => void;
}) {
  const { t } = useI18n();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);
  return (
    <div className="flex w-full max-w-[85%] flex-col items-end gap-1.5">
      <textarea
        ref={textareaRef}
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSubmitEdit(draft.trim());
          }
        }}
        aria-label={t("transcript.editMessage")}
        className="min-h-[52px] w-full resize-none rounded-lg border border-v2-blue-600 bg-v2-background-bg-base px-3 py-2 text-[13px] text-v2-text-text-base outline-none"
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onCancelEdit}
          className="rounded-md px-2 py-1 text-[12px] text-v2-text-text-muted hover:bg-v2-grey-100"
        >
          {t("transcript.cancelEdit")}
        </button>
        <button
          type="button"
          disabled={!draft.trim()}
          onClick={() => onSubmitEdit(draft.trim())}
          className="rounded-md bg-v2-grey-1100 px-2 py-1 text-[12px] text-v2-grey-50 hover:opacity-90 disabled:opacity-40"
        >
          {t("composer.send")}
        </button>
      </div>
    </div>
  );
}

function SkillInvocationContent({ invocation }: { invocation: NonNullable<SteerView["skillInvocation"]> }) {
  const { t } = useI18n();
  return (
    <>
      <div className="flex items-center gap-1.5 rounded-md border border-v2-blue-200 bg-v2-blue-100/40 px-2 py-1 text-[12px]">
        <Zap size={13} className="text-v2-blue-600" aria-hidden />
        <span className="font-medium text-v2-text-text-base">{t("transcript.skillInvocation")}</span>
        <span className="font-mono text-v2-blue-700">{invocation.name}</span>
      </div>
      {invocation.args ? <p className="mt-1 text-[12px] text-v2-text-text-muted">{invocation.args}</p> : null}
    </>
  );
}

/** A single message bubble. Human messages align right with the You label;
 * anything labeled otherwise (subagent-line dispatches, agent replies)
 * aligns left under its own label. User messages with tree metadata gain
 * hover Edit/Copy actions and a version switcher (ADR-066); skill-invoked
 * messages render a compact card instead of the expanded content. */
function MessageRow({
  message,
  open,
  onToggle,
  meta,
  editing,
  draft,
  onStartEdit,
  onCancelEdit,
  onDraftChange,
  onSubmitEdit,
  onSwitchBranch,
}: {
  message: SessionMessageView;
  open: boolean;
  onToggle: (open: boolean) => void;
  meta?: SessionMessageMeta;
  editing: boolean;
  draft: string;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onDraftChange: (text: string) => void;
  onSubmitEdit: (text: string) => void;
  onSwitchBranch?: (entryId: string, direction: -1 | 1) => void;
}) {
  const { t } = useI18n();
  const roleKey = ROLE_LABELS[message.role];
  const label = message.label ? agentDisplayName(t, message.label) : roleKey ? t(roleKey) : message.role;
  const isYou = message.role === "user" && message.label == null;
  const hasBody = Boolean(message.text) || message.error || message.streaming;
  return (
    <li className={`group flex flex-col gap-1 ${isYou ? "items-end" : "items-start"}`}>
      <span className="text-[11px] font-medium uppercase tracking-wide text-v2-text-text-faint">{label}</span>
      {message.reasoning ? (
        <ReasoningBlock text={message.reasoning} open={open} onToggle={onToggle} active={Boolean(message.isThinking)} />
      ) : message.isThinking ? (
        <span className="v2-thinking-active text-[12px] font-medium text-v2-text-text-faint">
          {t("transcript.thinking")}
        </span>
      ) : null}
      {editing && isYou ? (
        <EditMessageDraft
          draft={draft}
          onDraftChange={onDraftChange}
          onCancelEdit={onCancelEdit}
          onSubmitEdit={onSubmitEdit}
        />
      ) : hasBody && (message.role === "assistant" || message.role === "user") ? (
        <div
          className={`v2-md max-w-full rounded-lg px-3 py-2 text-[length:var(--v2-chat-font-size)] ${
            isYou ? "bg-v2-blue-100/60 text-v2-text-text-base" : "bg-v2-background-bg-deep text-v2-text-text-base"
          } ${message.error ? "text-v2-status-error" : ""}`}
        >
          {message.skillInvocation ? (
            <SkillInvocationContent invocation={message.skillInvocation} />
          ) : (
            <MarkdownBlock text={message.text} />
          )}
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
      {isYou && !message.streaming && !message.error && meta ? (
        <>
          <div className="mt-1 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <button
              type="button"
              aria-label={t("transcript.editMessage")}
              title={t("transcript.editMessage")}
              className="flex size-6 items-center justify-center rounded-md text-v2-text-text-muted hover:bg-v2-grey-100"
              onClick={onStartEdit}
            >
              <Pencil size={12} />
            </button>
            <button
              type="button"
              aria-label={t("transcript.copyMessage")}
              title={t("transcript.copyMessage")}
              className="flex size-6 items-center justify-center rounded-md text-v2-text-text-muted hover:bg-v2-grey-100"
              onClick={() => void navigator.clipboard?.writeText(message.text).catch(() => {})}
            >
              <Copy size={12} />
            </button>
          </div>
          {meta.version && meta.version.count > 1 ? (
            <span className="-mt-1 flex items-center gap-1 text-[11px] text-v2-text-text-faint">
              <button
                type="button"
                aria-label={t("transcript.previousVersion")}
                title={t("transcript.previousVersion")}
                disabled={meta.version.index <= 1}
                className="flex size-5 items-center justify-center rounded hover:bg-v2-grey-100 disabled:opacity-30"
                onClick={() => onSwitchBranch?.(meta.entryId, -1)}
              >
                <ChevronLeft size={12} />
              </button>
              <span>
                {meta.version.index}/{meta.version.count}
              </span>
              <button
                type="button"
                aria-label={t("transcript.nextVersion")}
                title={t("transcript.nextVersion")}
                disabled={meta.version.index >= meta.version.count}
                className="flex size-5 items-center justify-center rounded hover:bg-v2-grey-100 disabled:opacity-30"
                onClick={() => onSwitchBranch?.(meta.entryId, 1)}
              >
                <ChevronRight size={12} />
              </button>
            </span>
          ) : null}
        </>
      ) : null}
    </li>
  );
}

function PendingRow() {
  const { t } = useI18n();
  return (
    <li className="flex flex-col items-start gap-1" aria-label={t("transcript.working")}>
      <span className="text-[11px] font-medium uppercase tracking-wide text-v2-text-text-faint">
        {t("transcript.researchAssistant")}
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
  {
    messages,
    tools,
    hydrationRevision = 0,
    hydrationScope = "default",
    emptyHint,
    pending = false,
    onViewDetails,
    messageMeta,
    onEditMessage,
    onSwitchBranch,
    steers = [],
  },
  ref,
) {
  const { t } = useI18n();
  const { preferences } = usePreferences();
  const hint = emptyHint ?? t("transcript.sendToStart");
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [openByKey, setOpenByKey] = useState<Record<string, boolean>>({});
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const entries = useMemo<TranscriptEntry[]>(() => {
    const base = [...messages, ...tools].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    if (!pending) return base;
    return [...base, { kind: "pending" }];
  }, [messages, tools, pending]);
  const entryKeys = useMemo(
    () => entries.map((entry, index) => ("kind" in entry ? "pending" : (entry.key ?? `removed:${index}`))),
    [entries],
  );
  const seenRowKeys = useRef<Set<string> | null>(null);
  const hydrationIdentity = `${hydrationScope}\u0000${hydrationRevision}`;
  const seenHydrationIdentity = useRef(hydrationIdentity);
  if (seenRowKeys.current === null || seenHydrationIdentity.current !== hydrationIdentity) {
    seenHydrationIdentity.current = hydrationIdentity;
    seenRowKeys.current = new Set(entryKeys);
  }
  const [entrance, setEntrance] = useState(() => ({ identity: hydrationIdentity, keys: new Set<string>() }));

  useEffect(() => {
    const seen = seenRowKeys.current;
    if (!seen) return;
    const added = entryKeys.filter((key) => !seen.has(key));
    if (added.length === 0) return;
    for (const key of added) seen.add(key);
    setEntrance((current) => ({
      identity: hydrationIdentity,
      keys: new Set([...(current.identity === hydrationIdentity ? current.keys : []), ...added]),
    }));
  }, [entryKeys, hydrationIdentity]);

  useEffect(() => {
    if (entrance.keys.size === 0) return;
    const timeout = window.setTimeout(() => setEntrance({ identity: hydrationIdentity, keys: new Set() }), 220);
    return () => window.clearTimeout(timeout);
  }, [entrance, hydrationIdentity]);

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

  const [scrollState, setScrollState] = useState({ overflow: false, top: true, bottom: true, jump: false });
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
        const top = !overflow || target.scrollTop <= 2;
        const bottom = !overflow || distance <= 2;
        const jump = overflow && distance > jumpThreshold(target);
        setScrollState((current) =>
          current.overflow === overflow && current.top === top && current.bottom === bottom && current.jump === jump
            ? current
            : { overflow, top, bottom, jump },
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
    paddingStart: 32,
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
    <div className="flex min-h-0 flex-1 flex-col">
      <div data-testid="transcript-viewport" className="relative flex min-h-0 flex-1">
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
                strokeLinecap="square"
              />
            </svg>
          </button>
        ) : null}
        {/* The scroll container is focusable so scroll keys reach it (opencode scroll-view parity); biome.json scopes this in. */}
        <section
          ref={bindScrollRef}
          data-scrollable
          tabIndex={0}
          className="min-h-0 flex-1 overflow-y-auto"
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
            <p className="px-4 pt-6 text-center text-[length:var(--v2-chat-font-size)] text-v2-text-text-faint">
              {hint}
            </p>
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
                    data-row-key={key}
                    ref={virtualizer.measureElement}
                    className={`px-4 ${entrance.identity === hydrationIdentity && entrance.keys.has(key) ? "v2-transcript-row-enter" : ""}`}
                    onAnimationEnd={() => {
                      setEntrance((current) => {
                        if (current.identity !== hydrationIdentity || !current.keys.has(key)) return current;
                        const next = new Set(current.keys);
                        next.delete(key);
                        return { identity: current.identity, keys: next };
                      });
                    }}
                    // No min-height here: pinning the measured element at
                    // `virtualRow.size` makes ResizeObserver silent when content
                    // shrinks (window resize, collapsed bodies), leaving stale
                    // oversized rows and giant gaps between messages.
                    style={{ paddingBottom: ROW_GAP_PX }}
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
                        meta={messageMeta?.[entry.key]}
                        editing={editingKey === entry.key}
                        draft={draft}
                        onStartEdit={() => {
                          setEditingKey(entry.key);
                          setDraft(entry.text);
                        }}
                        onCancelEdit={() => setEditingKey(null)}
                        onDraftChange={setDraft}
                        onSubmitEdit={(text) => {
                          const meta = messageMeta?.[entry.key];
                          if (meta) onEditMessage?.(meta.entryId, text);
                          setEditingKey(null);
                        }}
                        onSwitchBranch={onSwitchBranch}
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
        {!scrollState.top ? (
          <div
            data-testid="transcript-top-fade"
            aria-hidden
            className="pointer-events-none absolute left-0 right-3 top-0 z-20 h-8 bg-gradient-to-b from-v2-background-bg-base via-v2-background-bg-base/75 to-transparent"
          />
        ) : null}
        {scrollState.overflow && !scrollState.bottom ? (
          <div
            data-testid="transcript-bottom-fade"
            aria-hidden
            className="pointer-events-none absolute bottom-0 left-0 right-3 z-20 h-10 bg-gradient-to-t from-v2-background-bg-base via-v2-background-bg-base/75 to-transparent"
          />
        ) : null}
      </div>
      {steers.length > 0 ? (
        <div
          role="status"
          aria-label={t("transcript.steerQueuedLabel")}
          className="shrink-0 border-t border-v2-grey-200/70 bg-v2-background-bg-base/85 px-4 py-2 backdrop-blur"
        >
          <ul className="mx-auto flex w-full max-w-[1000px] flex-col items-end gap-1.5">
            {steers.map((steer) => (
              <li key={steer.key} className="v2-steer-queued flex flex-col items-end gap-1">
                <span className="text-[11px] font-medium uppercase tracking-wide text-v2-text-text-faint">
                  {t("transcript.you")}
                </span>
                <div className="v2-md flex max-w-full items-center gap-2 whitespace-pre-wrap break-words rounded-lg bg-v2-blue-100/60 px-3 py-2 text-[length:var(--v2-chat-font-size)] text-v2-text-text-base">
                  {steer.skillInvocation ? (
                    <div className="min-w-0">
                      <SkillInvocationContent invocation={steer.skillInvocation} />
                    </div>
                  ) : (
                    <span>{steer.text}</span>
                  )}
                  <span className="shrink-0 rounded bg-v2-blue-200/60 px-1.5 py-0.5 text-[10px] font-medium text-v2-blue-700">
                    {t("transcript.steerQueued")}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
});
