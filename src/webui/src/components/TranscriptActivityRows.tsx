import {
  AlertTriangle,
  BookOpen,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  FilePenLine,
  FileText,
  GitBranch,
  Globe,
  Info,
  Layers3,
  Minimize2,
  Search,
  Terminal,
  Wrench,
} from "lucide-react";
import type { ReactNode } from "react";
import type { ApiUsageTotalsDto, CompactionStateDto } from "../../../web/contracts";
import { useExpandable } from "../hooks/useExpandable";
import { useI18n } from "../i18n/useI18n";
import type { SessionSummaryView, ToolView } from "../session-reducer";
import type { TimelineDetail } from "../timeline-detail";
import {
  type ActivityEntry,
  type ActivityGroup,
  type PresentationEntry,
  presentationConcealsContent,
} from "../transcript-presentation";
import { ApiUsageLine, ApiUsageSummaryLine } from "./ApiUsageLine";
import { MarkdownBlock } from "./MarkdownBlock";
import { SubagentCompletionCard } from "./SubagentCompletionCard";
import { SubagentToolCard } from "./SubagentToolCard";
import { ThinkingPreview } from "./ThinkingPreview";

function Chevron({ open }: { open: boolean }) {
  return open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />;
}

function ActivityBody({ open, children }: { open: boolean; children: ReactNode }) {
  const { mounted, phase } = useExpandable(open);
  return mounted ? (
    <div
      data-scrollable
      className={`er-chat-activity-body ${phase === "enter" ? "animate-v2-expand-down" : "animate-v2-collapse-up"} motion-reduce:animate-none`}
    >
      {children}
    </div>
  ) : null;
}

function ReasoningBlock({
  text,
  open,
  onToggle,
  active,
  markdownScope,
  markdownKey,
  onRendered,
}: {
  text: string;
  open: boolean;
  onToggle: (open: boolean) => void;
  active: boolean;
  markdownScope: string;
  markdownKey: string;
  onRendered: () => void;
}) {
  return (
    <li className="er-chat-activity" data-activity="thinking">
      <button type="button" className="er-chat-activity-trigger" aria-expanded={open} onClick={() => onToggle(!open)}>
        {active ? <span className="v2-spinner" aria-hidden /> : <Brain size={15} aria-hidden />}
        <ThinkingPreview text={text} active={active} open={open} />
        <Chevron open={open} />
      </button>
      <ActivityBody open={open}>
        <div className="v2-md text-[12.5px] font-normal text-v2-text-text-muted">
          <MarkdownBlock
            text={text}
            scope={markdownScope}
            cacheKey={markdownKey}
            streaming={active}
            onRendered={onRendered}
          />
        </div>
      </ActivityBody>
    </li>
  );
}

export function SummaryRow({
  entry,
  open,
  onToggle,
  showApiUsageDetails,
  markdownScope,
  markdownKey,
  onRendered,
}: {
  entry: SessionSummaryView;
  open: boolean;
  onToggle: (open: boolean) => void;
  showApiUsageDetails: boolean;
  markdownScope: string;
  markdownKey: string;
  onRendered: () => void;
}) {
  const { t } = useI18n();
  const label = entry.kind === "compaction" ? t("transcript.sessionCompacted") : t("chat.branchSummary");
  const content =
    entry.summary?.trim() ||
    t(entry.kind === "compaction" ? "transcript.compactionSummaryUnavailable" : "transcript.branchSummaryUnavailable");
  return (
    <li className="er-chat-summary" data-summary-kind={entry.kind}>
      <button
        type="button"
        className="er-chat-divider er-chat-summary-trigger"
        aria-expanded={open}
        onClick={() => onToggle(!open)}
      >
        <span className="er-chat-divider-line" aria-hidden />
        {entry.kind === "compaction" ? <Minimize2 size={14} aria-hidden /> : <GitBranch size={14} aria-hidden />}
        <span>{label}</span>
        <Chevron open={open} />
        <span className="er-chat-divider-line" aria-hidden />
      </button>
      <ActivityBody open={open}>
        <div className="v2-md text-[12.5px] font-normal text-v2-text-text-muted">
          <MarkdownBlock text={content} scope={markdownScope} cacheKey={markdownKey} onRendered={onRendered} />
        </div>
      </ActivityBody>
      {showApiUsageDetails && entry.apiUsage ? <ApiUsageLine record={entry.apiUsage} /> : null}
    </li>
  );
}

export function CompactionActivity({ state }: { state: Exclude<CompactionStateDto, "idle"> }) {
  const { t } = useI18n();
  return (
    <li className="er-chat-divider er-chat-compaction-active" role="status">
      <span className="er-chat-divider-line" aria-hidden />
      {state === "running" ? <span className="v2-spinner" aria-hidden /> : <Minimize2 size={14} aria-hidden />}
      <span>{t(state === "running" ? "chat.compactionRunning" : "chat.compactionQueued")}</span>
      <span className="er-chat-divider-line" aria-hidden />
    </li>
  );
}

function toolIcon(tool: ToolView) {
  if (tool.skillName) return BookOpen;
  if (["bash", "powershell", "ssh-bash"].includes(tool.name)) return Terminal;
  if (["edit", "write", "patch", "apply_patch"].includes(tool.name)) return FilePenLine;
  if (["read", "find", "ls"].includes(tool.name)) return FileText;
  if (["grep", "web-search", "websearch", "search"].includes(tool.name)) return Search;
  if (["webfetch", "fetch"].includes(tool.name)) return Globe;
  return Wrench;
}

function ToolRow({
  tool,
  open,
  onToggle,
  concealed,
}: {
  tool: ToolView;
  open: boolean;
  onToggle: (open: boolean) => void;
  concealed: boolean;
}) {
  const { t } = useI18n();
  const Icon = toolIcon(tool);
  const inputKind = tool.skillName
    ? "skill"
    : ["bash", "powershell", "ssh-bash"].includes(tool.name)
      ? "command"
      : ["read", "write", "edit"].includes(tool.name)
        ? "file"
        : "tool";
  const inputLabel =
    inputKind === "command"
      ? t("chat.command")
      : inputKind === "skill"
        ? t("chat.skillDescriptor")
        : inputKind === "file"
          ? t("chat.file")
          : tool.name;
  return (
    <li
      className="er-chat-activity"
      data-activity={tool.skillName ? "skill" : tool.name}
      data-error={tool.error || tool.interrupted || undefined}
    >
      <button
        type="button"
        className="er-chat-activity-trigger"
        disabled={concealed}
        aria-expanded={open}
        onClick={() => onToggle(!open)}
      >
        <Icon size={15} aria-hidden />
        <span className="er-chat-activity-title">{tool.skillName ? t("transcript.readingSkill") : tool.name}</span>{" "}
        {!concealed ? <span className="er-chat-activity-args">{tool.skillName ?? tool.args}</span> : null}
        {tool.running && !tool.done ? <span className="v2-spinner" aria-hidden /> : null}
        {concealed && tool.running && !tool.done ? <span>{t("transcript.running")}</span> : null}
        {tool.interrupted ? <span className="er-chat-activity-state">{t("transcript.interruptedTool")}</span> : null}
        {tool.error && !tool.interrupted ? <span className="er-chat-activity-state">{t("chat.failed")}</span> : null}
        {tool.error || tool.interrupted ? (
          <AlertTriangle size={14} aria-hidden />
        ) : tool.done ? (
          <Check size={13} aria-hidden />
        ) : null}
        {!concealed ? <Chevron open={open} /> : null}
      </button>
      {!concealed ? (
        <ActivityBody open={open}>
          {tool.args ? (
            <div className="er-chat-tool-input" data-input-kind={inputKind}>
              <div className="er-chat-tool-input-label">
                <Icon size={13} aria-hidden />
                <span>{inputLabel}</span>
              </div>
              <pre>{tool.args}</pre>
            </div>
          ) : null}
          {tool.interrupted ? (
            <p className="text-[12px] text-v2-status-error">{t("transcript.interruptedToolDetails")}</p>
          ) : null}
          {tool.output ? (
            <pre className="er-chat-tool-output">{tool.output}</pre>
          ) : tool.running ? (
            <p className="text-[12px] text-v2-text-text-muted">{t("transcript.running")}</p>
          ) : !tool.interrupted ? (
            <p className="text-[12px] text-v2-text-text-faint">{t("transcript.noOutput")}</p>
          ) : null}
        </ActivityBody>
      ) : null}
    </li>
  );
}

export function deferredEntryIds(entry: PresentationEntry, deferred?: Record<string, number>): string[] {
  const ids =
    "name" in entry
      ? [entry.callEntryId, entry.resultEntryId]
      : "kind" in entry && (entry.kind === "thinking" || entry.kind === "notice")
        ? [entry.message.entryId]
        : "entryId" in entry
          ? [entry.entryId]
          : [];
  return [...new Set(ids.filter((id): id is string => id !== undefined && deferred?.[id] !== undefined))];
}

export function FullEntryLinks({ ids, onReadEntry }: { ids: string[]; onReadEntry?: (id: string) => void }) {
  const { t } = useI18n();
  return onReadEntry
    ? ids.map((id, index) => (
        <button
          key={id}
          type="button"
          onClick={() => onReadEntry(id)}
          className="mt-1 mr-3 text-[12px] text-v2-blue-600 underline underline-offset-2"
        >
          {t("transcript.fullEntry")}
          {ids.length > 1 ? ` · ${index + 1}` : ""}
        </button>
      ))
    : null;
}

interface ActivityProps {
  entry: ActivityEntry | ActivityGroup;
  detail: TimelineDetail;
  getOpen: (entry: PresentationEntry) => boolean;
  onToggle: (key: string, open: boolean) => void;
  markdownScope: string;
  onRendered: () => void;
  onViewDetails?: (toolCallId: string, step?: number) => void;
  subtreeUsage: ReadonlyMap<string, ApiUsageTotalsDto>;
  showApiUsageDetails: boolean;
  deferredEntries?: Record<string, number>;
  onReadEntry?: (id: string) => void;
}

function ActivityUsage({ entry, subtreeUsage }: Pick<ActivityProps, "subtreeUsage"> & { entry: ActivityEntry }) {
  if ("name" in entry && entry.name === "subagent" && entry.sessionId) {
    const totals = subtreeUsage.get(entry.sessionId);
    if (totals) return <ApiUsageSummaryLine totals={totals} />;
  }
  const record =
    "name" in entry
      ? entry.apiUsage
      : entry.kind === "notice" || (entry.kind === "thinking" && !entry.message.text.trim() && !entry.message.error)
        ? entry.message.apiUsage
        : undefined;
  return record ? <ApiUsageLine record={record} /> : null;
}

export function TranscriptActivity(props: ActivityProps) {
  const { entry, getOpen, onToggle, markdownScope, onRendered } = props;
  const { t } = useI18n();
  const open = getOpen(entry);
  const concealed = presentationConcealsContent(entry, props.detail);
  const toggle = (next: boolean) => onToggle(entry.key, next);
  if ("kind" in entry && entry.kind === "activity-group") {
    const names = [
      ...new Set(
        entry.entries.map((item) =>
          "name" in item
            ? (item.skillName ?? item.name)
            : item.kind === "thinking"
              ? t("transcript.thinkingProcess")
              : item.kind === "notice"
                ? t("chat.notice")
                : item.agentId,
        ),
      ),
    ].join(" · ");
    return (
      <li className="er-chat-activity-group">
        <button type="button" className="er-chat-activity-trigger" aria-expanded={open} onClick={() => toggle(!open)}>
          <Layers3 size={15} aria-hidden />
          <span className="er-chat-activity-title">
            {t("chat.activityCount").replace("{count}", String(entry.entries.length))}
          </span>{" "}
          <span className="er-chat-activity-args">{names}</span>
          <Chevron open={open} />
        </button>
        <ActivityBody open={open}>
          <ul className="er-chat-activity-list">
            {entry.entries.map((item) => (
              <TranscriptActivity {...props} key={item.key} entry={item} showApiUsageDetails={false} />
            ))}
          </ul>
        </ActivityBody>
        {props.showApiUsageDetails
          ? entry.entries.map((item) => <ActivityUsage key={item.key} entry={item} subtreeUsage={props.subtreeUsage} />)
          : null}
      </li>
    );
  }
  return (
    <>
      {"name" in entry ? (
        entry.name === "subagent" ? (
          <SubagentToolCard
            compact
            hideThinking={props.detail.thinking.placement === "hidden"}
            concealContent={concealed}
            tool={entry}
            open={open}
            initialOpen={open}
            onToggle={toggle}
            onViewDetails={props.onViewDetails}
            markdownScope={markdownScope}
            markdownCacheKey={`${entry.key}:subagent`}
            onMarkdownRendered={onRendered}
          />
        ) : (
          <ToolRow tool={entry} open={open} onToggle={toggle} concealed={concealed} />
        )
      ) : entry.kind === "subagent-completion" ? (
        <SubagentCompletionCard
          entry={entry}
          open={open}
          onToggle={toggle}
          markdownScope={markdownScope}
          onRendered={onRendered}
        />
      ) : entry.kind === "thinking" ? (
        entry.concealed ? (
          <li className="er-chat-activity-trigger" role="status">
            <span className="v2-spinner" aria-hidden />
            {t(entry.message.isThinking ? "transcript.thinking" : "transcript.workingInProgress")}
          </li>
        ) : (
          <ReasoningBlock
            text={entry.message.reasoning ?? ""}
            active={entry.message.isThinking === true}
            open={open}
            onToggle={toggle}
            markdownScope={markdownScope}
            markdownKey={entry.key}
            onRendered={onRendered}
          />
        )
      ) : (
        <li className="er-chat-activity" data-error={entry.message.error || undefined}>
          <button
            type="button"
            className="er-chat-activity-trigger"
            disabled={concealed}
            aria-expanded={open}
            onClick={() => toggle(!open)}
          >
            {entry.message.error ? <AlertTriangle size={15} aria-hidden /> : <Info size={15} aria-hidden />}
            <span className="er-chat-activity-title">{entry.message.label ?? t("chat.notice")}</span>{" "}
            {concealed ? (
              <span className="v2-spinner" aria-hidden />
            ) : (
              <span className="er-chat-activity-args">{entry.message.text}</span>
            )}
            {!concealed ? <Chevron open={open} /> : null}
          </button>
          {!concealed ? (
            <ActivityBody open={open}>
              <MarkdownBlock
                text={entry.message.text}
                scope={markdownScope}
                cacheKey={`${entry.key}:notice`}
                onRendered={onRendered}
              />
            </ActivityBody>
          ) : null}
        </li>
      )}
      {props.showApiUsageDetails ? <ActivityUsage entry={entry} subtreeUsage={props.subtreeUsage} /> : null}
      {!concealed ? (
        <FullEntryLinks ids={deferredEntryIds(entry, props.deferredEntries)} onReadEntry={props.onReadEntry} />
      ) : null}
    </>
  );
}
