import { elementScroll, useVirtualizer } from "@tanstack/react-virtual";
import { BookOpen, ChevronLeft, ChevronRight, Copy, Pencil } from "lucide-react";
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { ApiUsageStatisticsDto, ApiUsageTotalsDto, CompactionStateDto } from "../../../web/contracts";
import { isScrollKeyTarget, normalizeWheelDelta, scrollKey, scrollKeyOwner } from "../hooks/scrollGesture";
import { useAutoScroll } from "../hooks/useAutoScroll";
import { useScrollGesture } from "../hooks/useScrollGesture";
import { agentDisplayName } from "../i18n/agents";
import type { MessageKey } from "../i18n/messages";
import { useI18n } from "../i18n/useI18n";
import type { SessionMessageMeta } from "../message-tree";
import { usePreferences } from "../preferences/PreferencesProvider";
import type {
  SessionCompletionView,
  SessionMessageView,
  SessionSummaryView,
  SteerView,
  ToolView,
} from "../session-reducer";
import { getTimelineDetail, type TimelineDetail } from "../timeline-detail";
import { indexSubtreeUsage, mergeTranscriptEntries } from "../transcript-entries";
import { shouldAdjustTranscriptRow } from "../transcript-history";
import {
  isSummaryEntry,
  type PresentationEntry,
  presentationConcealsContent,
  presentationDefaultOpen,
  projectTranscript,
} from "../transcript-presentation";
import { ApiUsageLine, ApiUsageSummaryLine } from "./ApiUsageLine";
import { MarkdownBlock } from "./MarkdownBlock";
import { ActionGlyph } from "./studio/ActionGlyph";
import {
  CompactionActivity,
  deferredEntryIds,
  FullEntryLinks,
  SummaryRow,
  TranscriptActivity,
} from "./TranscriptActivityRows";
import "./chat-transcript.css";

export interface ChatTranscriptProps {
  messages: SessionMessageView[];
  tools: ToolView[];
  summaries?: SessionSummaryView[];
  completions?: SessionCompletionView[];
  hydrationRevision?: number;
  hydrationScope?: string;
  emptyHint?: string;
  /** While true, renders a working agent row under the newest user message. */
  pending?: boolean;
  compactionState?: CompactionStateDto;
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
  showApiUsageDetails?: boolean;
  apiUsage?: ApiUsageStatisticsDto;
  historyCursor?: string;
  historyLoading?: boolean;
  historyError?: boolean;
  onLoadOlder?: (beforePublish?: () => void) => Promise<void>;
  deferredEntries?: Record<string, number>;
  onReadEntry?: (entryId: string) => void;
}

export interface ChatTranscriptHandle {
  /** Re-pins the transcript to the latest message and resumes following. */
  scrollToLatest(): void;
  /** Freezes message layout while the surrounding chat shell is resized. */
  beginResizeSnapshot(): void;
  /** Releases a resize snapshot so messages reflow at the final shell width. */
  endResizeSnapshot(): void;
}

const ROLE_LABELS: Record<string, MessageKey> = {
  user: "transcript.you",
  assistant: "transcript.researchAssistant",
};

const ROW_ESTIMATE = 60;
const ROW_GAP_PX = 12;

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
  const composing = useRef(false);
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);
  return (
    <div className="flex w-full max-w-[85%] flex-col items-end gap-1.5">
      <textarea
        ref={textareaRef}
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onBlur={() => {
          composing.current = false;
        }}
        onKeyDown={(e) => {
          if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
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
      <div className="er-chat-skill flex items-center gap-1.5 text-[12px]">
        <BookOpen size={14} aria-hidden />
        <span className="font-medium text-v2-text-text-base">{t("transcript.skillInvocation")}</span>
        <span className="font-mono text-v2-text-text-muted">{invocation.name}</span>
      </div>
      {invocation.args ? <p className="mt-1 text-[12px] text-v2-text-text-muted">{invocation.args}</p> : null}
    </>
  );
}

/** User bubbles and unboxed assistant prose share left-aligned metadata.
 * Both roles retain message time and Copy;
 * human messages with tree metadata also gain Edit and a version switcher. Skill-invoked
 * messages render a compact card instead of the expanded content. */
function MessageRow({
  message,
  today,
  meta,
  editing,
  draft,
  onStartEdit,
  onCancelEdit,
  onDraftChange,
  onSubmitEdit,
  onSwitchBranch,
  showApiUsageDetails,
  markdownScope,
  onRendered,
}: {
  message: SessionMessageView;
  today: Date;
  meta?: SessionMessageMeta;
  editing: boolean;
  draft: string;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onDraftChange: (text: string) => void;
  onSubmitEdit: (text: string) => void;
  onSwitchBranch?: (entryId: string, direction: -1 | 1) => void;
  showApiUsageDetails: boolean;
  markdownScope: string;
  onRendered: () => void;
}) {
  const { t } = useI18n();
  const roleKey = ROLE_LABELS[message.role];
  const label = message.label ? agentDisplayName(t, message.label) : roleKey ? t(roleKey) : message.role;
  const isYou = message.role === "user" && message.label == null;
  const hasBody = Boolean(message.text.trim()) || (message.streaming && !message.reasoning && !message.isThinking);
  const isChatMessage = message.role === "user" || message.role === "assistant";
  const canEdit = isYou && !message.streaming && !message.error && meta !== undefined;
  const canCopy = isChatMessage && !message.streaming && Boolean(message.text.trim());
  const sentAt = message.timestamp === undefined ? undefined : new Date(message.timestamp);
  const sameYear = sentAt?.getFullYear() === today.getFullYear();
  const sameDay = sameYear && sentAt?.getMonth() === today.getMonth() && sentAt?.getDate() === today.getDate();
  const localDateTime = sentAt
    ? [
        [sentAt.getFullYear(), sentAt.getMonth() + 1, sentAt.getDate()]
          .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, "0"))
          .slice(sameDay ? 3 : sameYear ? 1 : 0)
          .join("-"),
        [sentAt.getHours(), sentAt.getMinutes()].map((part) => String(part).padStart(2, "0")).join(":"),
      ]
        .filter(Boolean)
        .join(" ")
    : undefined;
  if (message.usageOnly && message.apiUsage) {
    return (
      <li className="flex flex-col items-start gap-1">
        {showApiUsageDetails ? <ApiUsageLine record={message.apiUsage} /> : null}
      </li>
    );
  }
  return (
    <li
      className="group er-chat-message"
      data-message-role={isYou ? "user" : "assistant"}
      data-error={message.error || undefined}
    >
      <span className="er-chat-message-label">{label}</span>
      {editing && isYou ? (
        <EditMessageDraft
          draft={draft}
          onDraftChange={onDraftChange}
          onCancelEdit={onCancelEdit}
          onSubmitEdit={onSubmitEdit}
        />
      ) : hasBody && (message.role === "assistant" || message.role === "user") ? (
        <div data-message-body={isYou ? "user" : "assistant"} className="v2-md er-chat-message-body">
          {message.skillInvocation ? (
            <SkillInvocationContent invocation={message.skillInvocation} />
          ) : (
            <MarkdownBlock
              text={message.text}
              scope={markdownScope}
              cacheKey={`${message.key}:text`}
              streaming={message.streaming}
              onRendered={onRendered}
            />
          )}
        </div>
      ) : hasBody ? (
        <span
          className={`rounded-md px-2 py-1 font-mono text-[12px] ${
            message.error ? "text-v2-status-error" : "text-v2-text-text-muted"
          }`}
        >
          {message.text}
        </span>
      ) : null}
      {showApiUsageDetails && message.apiUsage ? <ApiUsageLine record={message.apiUsage} /> : null}
      {isChatMessage && (sentAt || canCopy || canEdit) ? (
        <div className="er-chat-message-meta mt-1 flex max-w-full flex-wrap items-center gap-1">
          {sentAt ? (
            <time
              dateTime={sentAt.toISOString()}
              tabIndex={canEdit || canCopy ? undefined : 0}
              className="mr-1 whitespace-nowrap font-mono text-[11px] text-v2-text-text-faint"
            >
              {localDateTime}
            </time>
          ) : null}
          {canEdit || canCopy ? (
            <span className="flex shrink-0 items-center gap-1">
              {canEdit ? (
                <button
                  type="button"
                  aria-label={t("transcript.editMessage")}
                  title={t("transcript.editMessage")}
                  className="flex size-6 items-center justify-center rounded-md text-v2-text-text-muted hover:bg-v2-grey-100"
                  onClick={onStartEdit}
                >
                  <ActionGlyph label={t("studio.edit")}>
                    <Pencil size={12} />
                  </ActionGlyph>
                </button>
              ) : null}
              {canCopy ? (
                <button
                  type="button"
                  aria-label={t("transcript.copyMessage")}
                  title={t("transcript.copyMessage")}
                  className="flex size-6 items-center justify-center rounded-md text-v2-text-text-muted hover:bg-v2-grey-100"
                  onClick={() => void navigator.clipboard?.writeText(message.text).catch(() => {})}
                >
                  <ActionGlyph label={t("studio.copy")}>
                    <Copy size={12} />
                  </ActionGlyph>
                </button>
              ) : null}
            </span>
          ) : null}
        </div>
      ) : null}
      {canEdit && meta.version && meta.version.count > 1 ? (
        <span className="-mt-1 flex items-center gap-1 text-[11px] text-v2-text-text-faint">
          <button
            type="button"
            aria-label={t("transcript.previousVersion")}
            title={t("transcript.previousVersion")}
            disabled={meta.version.index <= 1}
            className="flex size-5 items-center justify-center rounded hover:bg-v2-grey-100 disabled:opacity-30"
            onClick={() => onSwitchBranch?.(meta.entryId, -1)}
          >
            <ActionGlyph label={t("studio.previous")}>
              <ChevronLeft size={12} />
            </ActionGlyph>
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
            <ActionGlyph label={t("studio.next")}>
              <ChevronRight size={12} />
            </ActionGlyph>
          </button>
        </span>
      ) : null}
    </li>
  );
}

function PendingRow() {
  const { t } = useI18n();
  return (
    <li className="er-chat-message" aria-label={t("transcript.working")}>
      <span className="er-chat-message-label">{t("transcript.researchAssistant")}</span>
      <div className="er-chat-activity-trigger">
        <span className="v2-spinner" aria-hidden />
        <span className="text-[12px] text-v2-text-text-faint">{t("transcript.workingInProgress")}</span>
      </div>
    </li>
  );
}

interface TranscriptVirtualRowProps {
  entry: PresentationEntry;
  detail: TimelineDetail;
  today: Date;
  index: number;
  start: number;
  rowKey: string;
  getOpen: (entry: PresentationEntry) => boolean;
  editing: boolean;
  draft: string;
  messageMeta?: SessionMessageMeta;
  subtreeUsage: ReadonlyMap<string, ApiUsageTotalsDto>;
  showApiUsageDetails: boolean;
  markdownScope: string;
  animate: boolean;
  onMeasure: (element: HTMLDivElement | null) => void;
  onToggle: (key: string, open: boolean) => void;
  onStartEdit: (key: string, text: string) => void;
  onCancelEdit: () => void;
  onDraftChange: (text: string) => void;
  onSubmitEdit: (key: string, text: string) => void;
  onAnimationEnd: (key: string) => void;
  onSwitchBranch?: (entryId: string, direction: -1 | 1) => void;
  onViewDetails?: (toolCallId: string, step?: number) => void;
  deferredEntries?: Record<string, number>;
  onReadEntry?: (entryId: string) => void;
}

const TranscriptVirtualRow = memo(function TranscriptVirtualRow({
  entry,
  detail,
  today,
  index,
  start,
  rowKey,
  getOpen,
  editing,
  draft,
  messageMeta,
  subtreeUsage,
  showApiUsageDetails,
  markdownScope,
  animate,
  onMeasure,
  onToggle,
  onStartEdit,
  onCancelEdit,
  onDraftChange,
  onSubmitEdit,
  onAnimationEnd,
  onSwitchBranch,
  onViewDetails,
  deferredEntries,
  onReadEntry,
}: TranscriptVirtualRowProps) {
  const deferred = deferredEntryIds(entry, deferredEntries);
  const hiddenSubtreeUsage =
    "kind" in entry && entry.kind === "subtree-usage" ? subtreeUsage.get(entry.sessionId) : undefined;
  const element = useRef<HTMLDivElement | null>(null);
  const measureFrame = useRef<number | null>(null);
  const bindMeasure = useCallback(
    (node: HTMLDivElement | null) => {
      element.current = node;
      if (measureFrame.current !== null) cancelAnimationFrame(measureFrame.current);
      measureFrame.current = null;
      if (!node) return;
      measureFrame.current = requestAnimationFrame(() => {
        measureFrame.current = null;
        if (element.current === node) onMeasure(node);
      });
    },
    [onMeasure],
  );
  const remeasure = useCallback(() => onMeasure(element.current), [onMeasure]);
  useEffect(
    () => () => {
      if (measureFrame.current !== null) cancelAnimationFrame(measureFrame.current);
    },
    [],
  );

  return (
    <div style={{ position: "absolute", top: `${start}px`, left: 0, width: "100%" }}>
      <div
        data-index={index}
        data-row-key={rowKey}
        data-testid={`transcript-row-${rowKey}`}
        ref={bindMeasure}
        className={`px-4 ${animate ? "v2-transcript-row-enter" : ""}`}
        onAnimationEnd={() => onAnimationEnd(rowKey)}
        style={{ paddingBottom: ROW_GAP_PX }}
      >
        {"kind" in entry && entry.kind === "pending" ? (
          <PendingRow />
        ) : "kind" in entry && entry.kind === "compaction-state" ? (
          <CompactionActivity state={entry.state} />
        ) : "kind" in entry && entry.kind === "usage" ? (
          <ApiUsageLine record={entry.record} />
        ) : "kind" in entry && entry.kind === "subtree-usage" ? (
          hiddenSubtreeUsage ? (
            <ApiUsageSummaryLine totals={hiddenSubtreeUsage} />
          ) : null
        ) : isSummaryEntry(entry) ? (
          <>
            <SummaryRow
              entry={entry}
              open={getOpen(entry)}
              onToggle={(next) => onToggle(rowKey, next)}
              showApiUsageDetails={showApiUsageDetails}
              markdownScope={markdownScope}
              markdownKey={`${rowKey}:summary`}
              onRendered={remeasure}
            />
            <FullEntryLinks ids={deferred} onReadEntry={onReadEntry} />
          </>
        ) : "kind" in entry || "name" in entry ? (
          <TranscriptActivity
            entry={entry}
            detail={detail}
            getOpen={getOpen}
            onToggle={onToggle}
            markdownScope={markdownScope}
            onRendered={remeasure}
            onViewDetails={onViewDetails}
            subtreeUsage={subtreeUsage}
            showApiUsageDetails={showApiUsageDetails}
            deferredEntries={deferredEntries}
            onReadEntry={onReadEntry}
          />
        ) : (
          <>
            <MessageRow
              message={entry}
              today={today}
              meta={deferred.length ? undefined : messageMeta}
              editing={editing}
              draft={draft}
              onStartEdit={() => onStartEdit(rowKey, entry.text)}
              onCancelEdit={onCancelEdit}
              onDraftChange={onDraftChange}
              onSubmitEdit={(text) => onSubmitEdit(rowKey, text)}
              onSwitchBranch={onSwitchBranch}
              showApiUsageDetails={showApiUsageDetails}
              markdownScope={markdownScope}
              onRendered={remeasure}
            />
            <FullEntryLinks ids={deferred} onReadEntry={onReadEntry} />
          </>
        )}
      </div>
    </div>
  );
});

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
    summaries = [],
    completions = [],
    hydrationRevision = 0,
    hydrationScope = "default",
    emptyHint,
    pending = false,
    compactionState = "idle",
    onViewDetails,
    messageMeta,
    onEditMessage,
    onSwitchBranch,
    steers = [],
    showApiUsageDetails = false,
    apiUsage,
    historyCursor,
    historyLoading = false,
    historyError = false,
    onLoadOlder,
    deferredEntries,
    onReadEntry,
  },
  ref,
) {
  const { t } = useI18n();
  const { preferences } = usePreferences();
  const detail = useMemo(() => getTimelineDetail(preferences), [preferences]);
  const hint = emptyHint ?? t("transcript.sendToStart");
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [openByKey, setOpenByKey] = useState<Record<string, boolean>>({});
  const disclosureKey = useCallback((key: string) => JSON.stringify([hydrationScope, key]), [hydrationScope]);
  const getOpen = useCallback(
    (entry: PresentationEntry) =>
      presentationConcealsContent(entry, detail)
        ? false
        : (openByKey[disclosureKey("kind" in entry && entry.kind === "pending" ? "pending" : entry.key)] ??
          presentationDefaultOpen(entry, detail)),
    [openByKey, disclosureKey, detail],
  );
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [today, setToday] = useState(() => new Date());

  useEffect(() => {
    let midnightTimer: number | undefined;
    const refreshDate = () => {
      const now = new Date();
      setToday(now);
      // Local midnight may be 23 or 25 hours away across daylight-saving changes.
      const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      window.clearTimeout(midnightTimer);
      midnightTimer = window.setTimeout(refreshDate, nextMidnight.getTime() - now.getTime());
    };
    refreshDate();
    window.addEventListener("focus", refreshDate);
    document.addEventListener("visibilitychange", refreshDate);
    return () => {
      window.clearTimeout(midnightTimer);
      window.removeEventListener("focus", refreshDate);
      document.removeEventListener("visibilitychange", refreshDate);
    };
  }, []);

  const timeline = useMemo(
    () => mergeTranscriptEntries(messages, tools, summaries, pending, completions),
    [messages, tools, summaries, pending, completions],
  );
  // One latest projection per visited session, owned only for this component's lifetime.
  // Returning to a child/root must retain prepend-stabilized group keys as well as disclosures.
  const previousProjections = useRef(new Map<string, PresentationEntry[]>());
  const subtreeUsage = useMemo(() => indexSubtreeUsage(apiUsage), [apiUsage]);
  const entries = useMemo(
    () =>
      projectTranscript(timeline, detail, {
        showApiUsageDetails,
        subtreeUsage,
        compactionState,
        previous: previousProjections.current.get(hydrationScope),
      }),
    [timeline, detail, showApiUsageDetails, subtreeUsage, compactionState, hydrationScope],
  );
  useEffect(() => {
    previousProjections.current.set(hydrationScope, entries);
  }, [entries, hydrationScope]);
  const entryKeys = useMemo(
    () =>
      entries.map((entry, index) =>
        "kind" in entry && entry.kind === "pending" ? "pending" : (entry.key ?? `removed:${index}`),
      ),
    [entries],
  );
  const seenRowKeys = useRef<Set<string> | null>(null);
  const introducedRowKeys = useRef(new Set<string>());
  const hydrationIdentity = `${hydrationScope}\u0000${hydrationRevision}`;
  const seenHydrationIdentity = useRef(hydrationIdentity);
  if (seenRowKeys.current === null || seenHydrationIdentity.current !== hydrationIdentity) {
    seenHydrationIdentity.current = hydrationIdentity;
    seenRowKeys.current = new Set(entryKeys);
    introducedRowKeys.current.clear();
  }
  for (const key of entryKeys) if (!seenRowKeys.current.has(key)) introducedRowKeys.current.add(key);
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
    pause: pauseAutoScroll,
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

  const rowKey = useCallback((entry: PresentationEntry | undefined, index: number) => {
    if (!entry) return `removed:${index}`;
    return "kind" in entry && entry.kind === "pending" ? "pending" : entry.key;
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
    paddingStart: historyCursor ? 64 : 32,
    paddingEnd: 64,
    initialOffset: () => (shouldAnchorBottom() ? Number.MAX_SAFE_INTEGER : 0),
    scrollToFn: (offset, options, instance) => {
      // Expose the computed range before core writes an anchor correction so the browser does not clamp it to the old height.
      const content = contentRef.current;
      if (content) content.style.height = `${instance.getTotalSize()}px`;
      elementScroll(offset, options, instance);
    },
  });
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
    if (shouldAnchorBottom()) return false;
    return shouldAdjustTranscriptRow({
      introduced: introducedRowKeys.current.has(String(item.key)),
      index: item.index,
      end: item.end,
      firstVisible: instance.range?.startIndex,
      offset: instance.scrollOffset ?? 0,
      adjustments: instance.scrollAdjustments,
      header: instance.options.paddingStart,
    });
  };

  const loadOlder = useCallback(() => {
    if (!historyCursor || historyLoading || !onLoadOlder) return;
    // The virtualizer's key-based anchorTo:"end" already preserves prepends,
    // including later size measurements. An absolute scroll here races that
    // correction; only pause live following before publishing the older page.
    void onLoadOlder(pauseAutoScroll);
  }, [historyCursor, historyLoading, onLoadOlder, pauseAutoScroll]);

  const measureRow = useCallback(
    (element: HTMLDivElement | null) => {
      if (element) virtualizer.measureElement(element);
    },
    [virtualizer],
  );
  const toggleRow = useCallback(
    (key: string, next: boolean) => {
      setOpenByKey((current) => ({ ...current, [disclosureKey(key)]: next }));
    },
    [disclosureKey],
  );
  const startEdit = useCallback((key: string, text: string) => {
    setEditingKey(key);
    setDraft(text);
  }, []);
  const cancelEdit = useCallback(() => setEditingKey(null), []);
  const submitEdit = useCallback(
    (key: string, text: string) => {
      const meta = messageMeta?.[key];
      if (meta) onEditMessage?.(meta.entryId, text);
      setEditingKey(null);
    },
    [messageMeta, onEditMessage],
  );
  const finishEntrance = useCallback(
    (key: string) => {
      setEntrance((current) => {
        if (current.identity !== hydrationIdentity || !current.keys.has(key)) return current;
        const next = new Set(current.keys);
        next.delete(key);
        return { identity: current.identity, keys: next };
      });
    },
    [hydrationIdentity],
  );

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
      beginResizeSnapshot() {
        const content = contentRef.current;
        if (!content) return;
        const width = Math.round(content.getBoundingClientRect().width);
        if (width <= 0) return;
        content.style.setProperty("--transcript-snapshot-w", `${width}px`);
        content.dataset.resizeSnapshot = "true";
      },
      endResizeSnapshot() {
        const content = contentRef.current;
        if (!content) return;
        content.style.removeProperty("--transcript-snapshot-w");
        delete content.dataset.resizeSnapshot;
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
      if (event.currentTarget.scrollTop < 160 && !historyError) loadOlder();
    },
    [handleAutoScroll, hasScrollGesture, markScrollGesture, scheduleScrollState, historyError, loadOlder],
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
      if (
        delta < 0 &&
        root.scrollTop < 160 &&
        !historyError &&
        (!(event.target instanceof Element) || event.target.closest("[data-scrollable]") === root)
      )
        loadOlder();
    },
    [markBoundaryWheel, historyError, loadOlder],
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
    <div className="er-chat-transcript flex min-h-0 flex-1 flex-col">
      <div data-testid="transcript-viewport" className="relative flex min-h-0 flex-1">
        {scrollState.overflow && scrollState.jump ? (
          <button
            type="button"
            aria-label={t("transcript.jumpToLatest")}
            onClick={resumeScroll}
            title={t("transcript.jumpToLatest")}
            className="pointer-events-auto absolute bottom-6 left-1/2 z-50 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full bg-v2-background-bg-layer text-v2-blue-700 shadow-[var(--v2-elevation-raised)] backdrop-blur transition-all duration-200 hover:scale-105 hover:bg-v2-background-bg-layer-2 focus-visible:outline-2 focus-visible:outline-v2-blue-600 focus-visible:outline-offset-2"
          >
            <ActionGlyph label={t("transcript.jumpToLatest")}>
              <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden>
                <title>{t("transcript.jumpToLatest")}</title>
                <path
                  d="M12.3333 8.66665L8 13L3.66667 8.66665M8 12.6667V2.83332"
                  stroke="currentColor"
                  strokeLinecap="square"
                />
              </svg>
            </ActionGlyph>
          </button>
        ) : null}
        {/* The scroll container is focusable so scroll keys reach it (opencode scroll-view parity); biome.json scopes this in. */}
        <section
          ref={bindScrollRef}
          data-scrollable
          tabIndex={0}
          className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
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
          {entries.length === 0 && timeline.length === 0 ? (
            <p className="px-4 pt-6 text-center text-[length:var(--v2-chat-font-size)] text-v2-text-text-faint">
              {hint}
            </p>
          ) : null}
          <div
            ref={bindContentRef}
            className="relative mx-auto w-full max-w-[1000px]"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {historyCursor ? (
              <div className="absolute inset-x-0 top-3 z-10 flex items-center justify-center gap-2 text-[12px]">
                {historyError ? (
                  <span role="alert" className="text-v2-status-error">
                    {t("transcript.historyError")}
                  </span>
                ) : null}
                <button
                  type="button"
                  disabled={historyLoading}
                  onClick={loadOlder}
                  className="rounded-md px-3 py-1 text-v2-text-text-muted hover:bg-v2-grey-100 disabled:opacity-60"
                >
                  {historyLoading ? t("dialog.loading") : t("transcript.loadOlder")}
                </button>
              </div>
            ) : null}
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const entry = entries[virtualRow.index];
              if (!entry) return null;
              const key = rowKey(entry, virtualRow.index);
              return (
                <TranscriptVirtualRow
                  key={key}
                  entry={entry}
                  detail={detail}
                  today={today}
                  index={virtualRow.index}
                  start={virtualRow.start}
                  rowKey={key}
                  getOpen={getOpen}
                  editing={!("kind" in entry) && !("name" in entry) && editingKey === entry.key}
                  draft={!("kind" in entry) && !("name" in entry) && editingKey === entry.key ? draft : ""}
                  messageMeta={!("kind" in entry) && !("name" in entry) ? messageMeta?.[entry.key] : undefined}
                  subtreeUsage={subtreeUsage}
                  showApiUsageDetails={showApiUsageDetails}
                  markdownScope={hydrationIdentity}
                  animate={entrance.identity === hydrationIdentity && entrance.keys.has(key)}
                  onMeasure={measureRow}
                  onToggle={toggleRow}
                  onStartEdit={startEdit}
                  onCancelEdit={cancelEdit}
                  onDraftChange={setDraft}
                  onSubmitEdit={submitEdit}
                  onAnimationEnd={finishEntrance}
                  onSwitchBranch={onSwitchBranch}
                  onViewDetails={onViewDetails}
                  deferredEntries={deferredEntries}
                  onReadEntry={onReadEntry}
                />
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
          <ul className="mx-auto flex w-full max-w-[1000px] flex-col items-start gap-1.5">
            {steers.map((steer) => (
              <li key={steer.key} className="v2-steer-queued er-chat-message" data-message-role="user">
                <span className="er-chat-message-label">{t("transcript.you")}</span>
                <div className="v2-md er-chat-message-body flex items-center gap-2 whitespace-pre-wrap break-words">
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
