import { Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  SessionTreeDto,
  TreeNavigationOptionsDto,
  TreeNavigationResultDto,
  WebTreeEntryDto,
} from "../../../web/contracts";
import { useModalLayer } from "../hooks/useModalLayer";
import { useI18n } from "../i18n/useI18n";

interface HistoryRow {
  entry: WebTreeEntryDto;
  depth: number;
  active: boolean;
  parentId: string | null;
  children: string[];
}

export interface SessionHistoryDialogProps {
  value: SessionTreeDto;
  busy: boolean;
  initialQuery?: string;
  onNavigate(entryId: string, options: TreeNavigationOptionsDto): Promise<TreeNavigationResultDto>;
  onRestoreDraft(text: string): void;
  onClose(): void;
}

const SETTINGS_KINDS = new Set<WebTreeEntryDto["kind"]>([
  "label",
  "custom",
  "model-change",
  "thinking-change",
  "session-info",
]);

export function SessionHistoryDialog({
  value,
  busy,
  initialQuery = "",
  onNavigate,
  onRestoreDraft,
  onClose,
}: SessionHistoryDialogProps) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLElement>(null);
  const zIndex = useModalLayer(onClose, dialogRef);
  const [query, setQuery] = useState(initialQuery);
  const [filterMode, setFilterMode] = useState<SessionTreeDto["filterMode"]>(value.filterMode);
  const [folded, setFolded] = useState<Set<string>>(() => new Set());
  const [selectedId, setSelectedId] = useState<string | null>(value.leafId);
  const [summaryTarget, setSummaryTarget] = useState<string | null>(null);
  const [customSummary, setCustomSummary] = useState(false);
  const [customInstructions, setCustomInstructions] = useState("");
  const [error, setError] = useState<string | null>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const focusTreeSelection = useRef(true);
  const rows = useMemo(
    () => historyRows(value.tree, value.leafId, filterMode, query, folded),
    [filterMode, folded, query, value.leafId, value.tree],
  );

  const selectedIndex = Math.max(
    0,
    rows.findIndex((row) => row.entry.id === selectedId),
  );
  const selectedRow = rows[selectedIndex];

  useEffect(() => {
    if (rows.length === 0) return;
    if (!rows.some((row) => row.entry.id === selectedId)) {
      setSelectedId(nearestVisibleId(value.tree, rows, selectedId ?? value.leafId));
      return;
    }
    if (focusTreeSelection.current) {
      itemRefs.current.get(selectedRow?.entry.id ?? "")?.focus();
      focusTreeSelection.current = false;
    }
  }, [rows, selectedId, selectedRow?.entry.id, value.leafId, value.tree]);

  const moveTo = (index: number) => {
    const row = rows[index];
    if (row) {
      focusTreeSelection.current = true;
      setSelectedId(row.entry.id);
    }
  };

  const navigate = async (entryId: string, options: TreeNavigationOptionsDto) => {
    if (busy) return;
    setError(null);
    try {
      const result = await onNavigate(entryId, options);
      if (result.cancelled) return;
      if (result.editorText !== undefined) onRestoreDraft(result.editorText);
      onClose();
    } catch (navigationError) {
      setError(navigationError instanceof Error ? navigationError.message : String(navigationError));
    }
  };

  const select = (entryId: string) => {
    if (busy) return;
    if (entryId === value.leafId) {
      onClose();
      return;
    }
    if (value.skipBranchSummaryPrompt) {
      void navigate(entryId, { summarize: false });
      return;
    }
    setSummaryTarget(entryId);
  };

  const handleTreeKey = (event: React.KeyboardEvent, row: HistoryRow) => {
    if (rows.length === 0) return;
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      moveTo((selectedIndex + delta + rows.length) % rows.length);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      moveTo(event.key === "Home" ? 0 : rows.length - 1);
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (row.children.length > 0 && !folded.has(row.entry.id)) {
        focusTreeSelection.current = true;
        setFolded((current) => new Set(current).add(row.entry.id));
      } else if (row.parentId) {
        focusTreeSelection.current = true;
        setSelectedId(row.parentId);
      }
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      if (folded.has(row.entry.id)) {
        focusTreeSelection.current = true;
        setFolded((current) => {
          const next = new Set(current);
          next.delete(row.entry.id);
          return next;
        });
      } else if (row.children[0]) {
        focusTreeSelection.current = true;
        setSelectedId(row.children[0]);
      }
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      select(row.entry.id);
    }
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-v2-grey-1200/25 p-3" style={{ zIndex }}>
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="history-dialog-title"
        className="flex max-h-[min(760px,calc(100vh-24px))] w-full max-w-[820px] flex-col overflow-hidden rounded-[14px] border border-v2-grey-200 bg-v2-background-bg-base shadow-[var(--v2-elevation-overlay)]"
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-v2-grey-200 px-4 py-3">
          <h2 id="history-dialog-title" className="text-[14px] font-semibold text-v2-text-text-base">
            {t("history.title")}
          </h2>
          <span className="font-mono text-[11px] text-v2-text-text-faint">
            {rows.length}/{value.tree.length}
          </span>
          <button
            type="button"
            aria-label={t("history.close")}
            className="ml-auto flex size-7 items-center justify-center rounded-md text-v2-icon-icon-muted hover:bg-v2-grey-100"
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </header>
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-v2-grey-200 px-3 py-2">
          <label className="flex h-8 min-w-[180px] flex-1 items-center gap-2 rounded-md border border-v2-grey-200 px-2 focus-within:border-v2-blue-600">
            <Search size={14} className="text-v2-icon-icon-muted" aria-hidden />
            <input
              type="search"
              aria-label={t("history.search")}
              className="min-w-0 flex-1 bg-transparent text-[12px] text-v2-text-text-base outline-none"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <select
            aria-label={t("history.filter")}
            className="h-8 rounded-md border border-v2-grey-200 bg-v2-background-bg-base px-2 text-[12px] text-v2-text-text-base"
            value={filterMode}
            onChange={(event) => {
              setFilterMode(event.target.value as SessionTreeDto["filterMode"]);
              setFolded(new Set());
            }}
          >
            <option value="default">{t("history.filterDefault")}</option>
            <option value="no-tools">{t("history.filterNoTools")}</option>
            <option value="user-only">{t("history.filterUser")}</option>
            <option value="labeled-only">{t("history.filterLabeled")}</option>
            <option value="all">{t("history.filterAll")}</option>
          </select>
        </div>
        {busy ? (
          <p className="shrink-0 border-b border-v2-grey-200 bg-v2-blue-50 px-4 py-2 text-[12px] text-v2-text-text-muted">
            {t("history.busy")}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="px-4 py-2 text-[12px] text-v2-status-error">
            {error}
          </p>
        ) : null}
        <div role="tree" aria-label={t("history.tree")} className="min-h-0 flex-1 overflow-auto p-2">
          {rows.length === 0 ? (
            <p className="px-2 py-6 text-center text-[12px] text-v2-text-text-faint">{t("history.empty")}</p>
          ) : (
            rows.map((row) => {
              const selected = row.entry.id === selectedRow?.entry.id;
              return (
                <button
                  key={row.entry.id}
                  ref={(element) => {
                    if (element) itemRefs.current.set(row.entry.id, element);
                    else itemRefs.current.delete(row.entry.id);
                  }}
                  type="button"
                  role="treeitem"
                  aria-level={row.depth + 1}
                  aria-selected={selected}
                  aria-current={row.entry.id === value.leafId ? "true" : undefined}
                  aria-expanded={row.children.length > 0 ? !folded.has(row.entry.id) : undefined}
                  aria-disabled={busy || undefined}
                  tabIndex={selected ? 0 : -1}
                  className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-[12px] ${
                    selected ? "bg-v2-blue-100 text-v2-text-text-base" : "text-v2-text-text-muted hover:bg-v2-grey-100"
                  }`}
                  style={{ paddingLeft: `${8 + row.depth * 18}px` }}
                  onFocus={() => setSelectedId(row.entry.id)}
                  onClick={() => select(row.entry.id)}
                  onKeyDown={(event) => handleTreeKey(event, row)}
                >
                  <span className="w-3 shrink-0 text-center text-v2-text-text-faint" aria-hidden>
                    {row.children.length > 0 ? (folded.has(row.entry.id) ? "+" : "-") : row.active ? "•" : "·"}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-v2-text-text-faint">
                    {entryLabel(row.entry, t)}:
                  </span>
                  <span className="min-w-0 flex-1 truncate">{entryText(row.entry, t)}</span>
                  {row.entry.label ? (
                    <span className="shrink-0 rounded bg-v2-status-warning/10 px-1 text-[10px] text-v2-status-warning">
                      {row.entry.label}
                    </span>
                  ) : null}
                </button>
              );
            })
          )}
        </div>
      </section>
      {summaryTarget ? (
        <BranchSummaryDialog
          custom={customSummary}
          instructions={customInstructions}
          onInstructions={setCustomInstructions}
          onCustom={() => setCustomSummary(true)}
          onBack={() => {
            setCustomSummary(false);
            setCustomInstructions("");
          }}
          onCancel={() => {
            setSummaryTarget(null);
            setCustomSummary(false);
            setCustomInstructions("");
          }}
          onChoose={(options) => {
            const target = summaryTarget;
            setSummaryTarget(null);
            setCustomSummary(false);
            setCustomInstructions("");
            void navigate(target, options);
          }}
        />
      ) : null}
    </div>
  );
}

function BranchSummaryDialog({
  custom,
  instructions,
  onInstructions,
  onCustom,
  onBack,
  onCancel,
  onChoose,
}: {
  custom: boolean;
  instructions: string;
  onInstructions(value: string): void;
  onCustom(): void;
  onBack(): void;
  onCancel(): void;
  onChoose(options: TreeNavigationOptionsDto): void;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLElement>(null);
  const zIndex = useModalLayer(onCancel, dialogRef);
  const customInputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (custom) customInputRef.current?.focus();
  }, [custom]);
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-v2-grey-1200/20 p-4" style={{ zIndex }}>
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="branch-summary-title"
        className="w-full max-w-[420px] rounded-[10px] border border-v2-grey-200 bg-v2-background-bg-base p-4 shadow-[var(--v2-elevation-overlay)]"
      >
        <h2 id="branch-summary-title" className="text-[13px] font-semibold text-v2-text-text-base">
          {t("history.summaryTitle")}
        </h2>
        {custom ? (
          <form
            className="mt-3"
            onSubmit={(event) => {
              event.preventDefault();
              onChoose({ summarize: true, customInstructions: instructions.trim() });
            }}
          >
            <textarea
              ref={customInputRef}
              aria-label={t("history.customInstructions")}
              className="min-h-24 w-full resize-y rounded-md border border-v2-grey-200 p-2 text-[12px] text-v2-text-text-base outline-none focus:border-v2-blue-600"
              value={instructions}
              onChange={(event) => onInstructions(event.target.value)}
            />
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-md px-3 py-1.5 text-[12px] hover:bg-v2-grey-100"
                onClick={onBack}
              >
                {t("history.back")}
              </button>
              <button type="submit" className="rounded-md bg-v2-grey-1100 px-3 py-1.5 text-[12px] text-v2-grey-50">
                {t("history.summarize")}
              </button>
            </div>
          </form>
        ) : (
          <div className="mt-3 grid gap-2">
            <button
              type="button"
              className="rounded-md border border-v2-grey-200 px-3 py-2 text-left text-[12px] hover:bg-v2-grey-100"
              onClick={() => onChoose({ summarize: false })}
            >
              {t("history.noSummary")}
            </button>
            <button
              type="button"
              className="rounded-md border border-v2-grey-200 px-3 py-2 text-left text-[12px] hover:bg-v2-grey-100"
              onClick={() => onChoose({ summarize: true })}
            >
              {t("history.summarize")}
            </button>
            <button
              type="button"
              className="rounded-md border border-v2-grey-200 px-3 py-2 text-left text-[12px] hover:bg-v2-grey-100"
              onClick={onCustom}
            >
              {t("history.summarizeCustom")}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function historyRows(
  entries: WebTreeEntryDto[],
  leafId: string | null,
  filterMode: SessionTreeDto["filterMode"],
  query: string,
  folded: Set<string>,
): HistoryRow[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const activePath = new Set<string>();
  let activeId = leafId;
  while (activeId) {
    activePath.add(activeId);
    activeId = byId.get(activeId)?.parentId ?? null;
  }
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const visible = entries.filter((entry) => {
    if (entry.kind === "assistant" && entry.id !== leafId && !entry.text.trim()) {
      if (!entry.stopReason || entry.stopReason === "stop" || entry.stopReason === "toolUse") return false;
    }
    if (filterMode === "user-only" && entry.kind !== "user") return false;
    if (filterMode === "labeled-only" && !entry.label) return false;
    if (filterMode !== "all" && SETTINGS_KINDS.has(entry.kind)) return false;
    if (filterMode === "no-tools" && entry.kind === "tool") return false;
    if (tokens.length > 0) {
      const searchable = `${entry.kind} ${entry.label ?? ""} ${entry.text}`.toLowerCase();
      if (!tokens.every((token) => searchable.includes(token))) return false;
    }
    return true;
  });
  const visibleIds = new Set(visible.map((entry) => entry.id));
  const nearestVisibleParent = (entry: WebTreeEntryDto): string | null => {
    let parentId = entry.parentId;
    while (parentId && !visibleIds.has(parentId)) parentId = byId.get(parentId)?.parentId ?? null;
    return parentId;
  };
  const children = new Map<string | null, string[]>();
  for (const entry of visible) {
    const parentId = nearestVisibleParent(entry);
    const list = children.get(parentId) ?? [];
    list.push(entry.id);
    children.set(parentId, list);
  }
  for (const list of children.values()) {
    list.sort((left, right) => Number(activePath.has(right)) - Number(activePath.has(left)));
  }
  const rows: HistoryRow[] = [];
  const visit = (id: string, depth: number) => {
    const entry = byId.get(id);
    if (!entry) return;
    const childIds = children.get(id) ?? [];
    rows.push({ entry, depth, active: activePath.has(id), parentId: nearestVisibleParent(entry), children: childIds });
    if (folded.has(id)) return;
    for (const childId of childIds) visit(childId, depth + 1);
  };
  for (const rootId of children.get(null) ?? []) visit(rootId, 0);
  return rows;
}

function nearestVisibleId(entries: WebTreeEntryDto[], rows: HistoryRow[], startId: string | null): string | null {
  if (rows.length === 0) return null;
  const visible = new Set(rows.map((row) => row.entry.id));
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  let current = startId;
  while (current) {
    if (visible.has(current)) return current;
    current = byId.get(current)?.parentId ?? null;
  }
  return rows.at(-1)?.entry.id ?? null;
}

function entryLabel(entry: WebTreeEntryDto, t: (key: never) => string): string {
  if (entry.kind === "user") return t("history.user" as never);
  if (entry.kind === "assistant") return t("history.assistant" as never);
  if (entry.kind === "tool") return t("history.tool" as never);
  if (entry.kind === "bash") return t("history.bash" as never);
  if (entry.kind === "compaction") return t("history.compaction" as never);
  if (entry.kind === "branch-summary") return t("history.branchSummary" as never);
  return entry.kind;
}

function entryText(entry: WebTreeEntryDto, t: (key: never) => string): string {
  if (entry.text.trim()) return entry.text.replace(/[\n\t]+/g, " ").trim();
  if (entry.errorMessage) return entry.errorMessage;
  if (entry.stopReason === "aborted") return t("history.aborted" as never);
  if (entry.kind === "compaction" && entry.tokensBefore !== undefined) {
    return `${Math.round(entry.tokensBefore / 1000)}k`;
  }
  return t("history.noContent" as never);
}
