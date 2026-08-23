import { ChevronRight, File as FileIcon, Folder, FolderOpen, RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FileEntryDto, FileWatcherEvent } from "../../../web/contracts";
import { listEntries } from "../api";
import { parentPath } from "../file-watcher";
import { useLazyTree } from "../hooks/useLazyTree";
import { useI18n } from "../i18n/useI18n";

export interface FilesPanelProps {
  root: string;
  onOpenFile: (entry: FileEntryDto) => void;
  fileEvent?: FileWatcherEvent | null;
}

interface TreeRow {
  entry: FileEntryDto;
  depth: number;
}

export function FilesPanel({ root, onOpenFile, fileEvent = null }: FilesPanelProps) {
  const { t } = useI18n();
  const [filter, setFilter] = useState("");
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const tree = useLazyTree<FileEntryDto>({ root, loadChildren: listEntries });
  const handledEvent = useRef<FileWatcherEvent | null>(null);
  const rowRefs = useRef(new Map<string, HTMLElement>());

  useEffect(() => {
    if (!fileEvent || handledEvent.current === fileEvent) return;
    handledEvent.current = fileEvent;
    const changedPath = fileEvent.properties.file;
    const target =
      fileEvent.properties.event === "add" || fileEvent.properties.event === "unlink"
        ? parentPath(changedPath)
        : changedPath === root ||
            tree
              .children(parentPath(changedPath))
              .some((entry) => entry.path === changedPath && entry.kind === "directory")
          ? changedPath
          : null;
    if (target && tree.status(target) === "loaded") tree.refreshDirectory(target);
  }, [fileEvent, root, tree.children, tree.refreshDirectory, tree.status]);

  const rows = useMemo(() => {
    const out: TreeRow[] = [];
    const walk = (path: string, depth: number) => {
      for (const child of tree.children(path)) {
        out.push({ entry: child, depth });
        if (child.kind === "directory" && tree.expanded.has(child.path)) walk(child.path, depth + 1);
      }
    };
    walk(root, 0);
    return out;
  }, [root, tree.children, tree.expanded]);

  const matches = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return [];
    const out: { entry: FileEntryDto; rel: string }[] = [];
    const walk = (path: string) => {
      for (const child of tree.children(path)) {
        out.push({ entry: child, rel: path === root ? child.name : `${path.slice(root.length + 1)}/${child.name}` });
        if (child.kind === "directory") walk(child.path);
      }
    };
    walk(root);
    return out.filter((item) => item.entry.name.toLowerCase().includes(query)).slice(0, 100);
  }, [root, filter, tree.children]);

  const toggle = (entry: FileEntryDto) => {
    if (entry.kind !== "directory") return;
    tree.toggle(entry.path);
  };

  const rootError = tree.error(root);
  const displayedRows: TreeRow[] = filter.trim() ? matches.map(({ entry }) => ({ entry, depth: 0 })) : rows;
  const rovingPath = displayedRows.some(({ entry }) => entry.path === focusedPath)
    ? focusedPath
    : (displayedRows[0]?.entry.path ?? null);

  const focusRow = (path: string) => {
    setFocusedPath(path);
    rowRefs.current.get(path)?.focus();
  };

  const handleTreeKey = (event: React.KeyboardEvent<HTMLElement>, row: TreeRow) => {
    if (event.target !== event.currentTarget) return;
    const index = displayedRows.findIndex(({ entry }) => entry.path === row.entry.path);
    const focusAt = (nextIndex: number) => {
      const next = displayedRows[Math.max(0, Math.min(displayedRows.length - 1, nextIndex))];
      if (next) focusRow(next.entry.path);
    };
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      focusAt(index + (event.key === "ArrowDown" ? 1 : -1));
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      focusAt(event.key === "Home" ? 0 : displayedRows.length - 1);
      return;
    }
    if (event.key === "ArrowRight" && row.entry.kind === "directory") {
      event.preventDefault();
      if (!tree.expanded.has(row.entry.path)) toggle(row.entry);
      else {
        const child = displayedRows[index + 1];
        if (child && child.depth > row.depth) focusRow(child.entry.path);
      }
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (row.entry.kind === "directory" && tree.expanded.has(row.entry.path)) {
        toggle(row.entry);
      } else {
        const parent = displayedRows.find(({ entry }) => entry.path === parentPath(row.entry.path));
        if (parent) focusRow(parent.entry.path);
      }
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (row.entry.kind === "directory") toggle(row.entry);
      else onOpenFile(row.entry);
    }
  };

  const rowClass = (isDirectory: boolean) =>
    `group flex w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-v2-grey-100 ${
      isDirectory ? "" : "text-v2-text-text-base"
    }`;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 px-2 pt-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-v2-grey-200 bg-v2-background-bg-base px-2 py-1 focus-within:border-v2-blue-600">
          <Search size={12} className="shrink-0 text-v2-text-text-faint" aria-hidden />
          <input
            className="min-w-0 flex-1 bg-transparent text-[12px] text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint"
            aria-label={t("files.filter")}
            placeholder={t("files.filterPlaceholder")}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            spellCheck={false}
          />
        </div>
        <button
          type="button"
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-v2-icon-icon-muted transition-colors hover:bg-v2-grey-100 hover:text-v2-icon-icon-base"
          aria-label={t("files.refresh")}
          title={t("files.refresh")}
          onClick={() => tree.refresh(root)}
        >
          <RefreshCw size={13} />
        </button>
      </div>
      {rootError && (
        <p role="alert" className="px-2 pt-2 text-[12px] text-v2-status-error">
          {rootError}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-2" role="tree" aria-label={t("files.tree")}>
        {filter.trim() ? (
          matches.length === 0 ? (
            <p className="px-2 py-1 text-[12px] text-v2-text-text-faint">{t("files.noMatches")}</p>
          ) : (
            <div className="flex flex-col gap-0.5">
              {matches.map(({ entry, rel }) => (
                <button
                  key={entry.path}
                  ref={(element) => {
                    if (element) rowRefs.current.set(entry.path, element);
                    else rowRefs.current.delete(entry.path);
                  }}
                  type="button"
                  role="treeitem"
                  aria-level={1}
                  aria-expanded={entry.kind === "directory" ? tree.expanded.has(entry.path) : undefined}
                  tabIndex={rovingPath === entry.path ? 0 : -1}
                  className={rowClass(entry.kind === "directory")}
                  onFocus={() => setFocusedPath(entry.path)}
                  onClick={() => {
                    setFocusedPath(entry.path);
                    if (entry.kind === "directory") toggle(entry);
                    else onOpenFile(entry);
                  }}
                  onKeyDown={(event) => handleTreeKey(event, { entry, depth: 0 })}
                  title={entry.path}
                >
                  {entry.kind === "directory" ? (
                    <Folder size={13} className="shrink-0 text-v2-icon-icon-muted" />
                  ) : (
                    <FileIcon size={13} className="shrink-0 text-v2-icon-icon-muted" />
                  )}
                  <span className="min-w-0 truncate text-[length:var(--v2-files-font-size)]">{entry.name}</span>
                  <span className="ml-auto shrink-0 truncate font-mono text-[11px] text-v2-text-text-faint">{rel}</span>
                </button>
              ))}
            </div>
          )
        ) : rows.length === 0 && !rootError ? (
          tree.status(root) === "loading" ? (
            <p className="px-2 py-1 text-[12px] text-v2-text-text-faint">{t("files.loading")}</p>
          ) : (
            <p className="px-2 py-1 text-[12px] text-v2-text-text-faint">{t("files.empty")}</p>
          )
        ) : (
          <div className="flex flex-col gap-0.5">
            {rows.map(({ entry, depth }) => {
              const isExpanded = tree.expanded.has(entry.path);
              const isDirectory = entry.kind === "directory";
              const state = tree.status(entry.path);
              return (
                <div
                  key={entry.path}
                  ref={(element) => {
                    if (element) rowRefs.current.set(entry.path, element);
                    else rowRefs.current.delete(entry.path);
                  }}
                  role="treeitem"
                  aria-level={depth + 1}
                  aria-expanded={isDirectory ? isExpanded : undefined}
                  tabIndex={rovingPath === entry.path ? 0 : -1}
                  className="group flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-v2-grey-100"
                  style={{ paddingLeft: `${8 + depth * 14}px` }}
                  onFocus={() => setFocusedPath(entry.path)}
                  onClick={() => {
                    setFocusedPath(entry.path);
                    if (isDirectory) toggle(entry);
                    else onOpenFile(entry);
                  }}
                  onKeyDown={(event) => handleTreeKey(event, { entry, depth })}
                  title={entry.path}
                >
                  {isDirectory ? (
                    <button
                      type="button"
                      tabIndex={-1}
                      className="flex size-4 shrink-0 items-center justify-center rounded text-v2-icon-icon-muted hover:bg-v2-grey-200"
                      aria-label={
                        state === "loading"
                          ? t("files.loadingRow").replace("{name}", entry.name)
                          : isExpanded
                            ? t("files.collapseRow").replace("{name}", entry.name)
                            : t("files.expandRow").replace("{name}", entry.name)
                      }
                      onClick={(event) => {
                        event.stopPropagation();
                        toggle(entry);
                      }}
                    >
                      {state === "loading" ? (
                        <span className="v2-spinner" aria-hidden />
                      ) : (
                        <ChevronRight
                          size={12}
                          className={`shrink-0 transition-transform ${isExpanded ? "rotate-90" : ""}`}
                        />
                      )}
                    </button>
                  ) : (
                    <span className="w-4 shrink-0" aria-hidden />
                  )}
                  {isDirectory ? (
                    <FolderOpen
                      size={13}
                      className={`shrink-0 ${isExpanded ? "text-v2-blue-600" : "text-v2-icon-icon-muted"}`}
                    />
                  ) : (
                    <FileIcon size={13} className="shrink-0 text-v2-icon-icon-muted" />
                  )}
                  <span className="min-w-0 truncate text-[length:var(--v2-files-font-size)]">{entry.name}</span>
                  {state === "error" && (
                    <button
                      type="button"
                      tabIndex={-1}
                      className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[11px] text-v2-text-text-muted hover:bg-v2-grey-200"
                      aria-label={t("files.retryRow").replace("{name}", entry.name)}
                      onClick={(event) => {
                        event.stopPropagation();
                        tree.retry(entry.path);
                      }}
                    >
                      {t("files.retry")}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
