import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight, File as FileIcon, Folder, FolderOpen, RefreshCw, Search } from "lucide-react";
import { listEntries } from "../api";
import type { FileEntryDto } from "../../../web/contracts";

export interface FilesPanelProps {
  root: string;
  onOpenFile: (entry: FileEntryDto) => void;
}

interface TreeRow {
  entry: FileEntryDto;
  depth: number;
  loading: boolean;
}

export function FilesPanel({ root, onOpenFile }: FilesPanelProps) {
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [childrenByPath, setChildrenByPath] = useState<Map<string, FileEntryDto[]>>(new Map());
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    (path: string) => {
      if (childrenByPath.has(path)) return;
      setChildrenByPath((current) => new Map(current).set(path, []));
      listEntries(path)
        .then((entries) => {
          setChildrenByPath((current) => new Map(current).set(path, entries));
          setError(null);
        })
        .catch((e: unknown) => {
          setChildrenByPath((current) => new Map(current).set(path, []));
          setError(e instanceof Error ? e.message : String(e));
        });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [childrenByPath],
  );

  useEffect(() => {
    load(root);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);

  const rows = useMemo(() => {
    const out: TreeRow[] = [];
    const walk = (path: string, depth: number) => {
      const children = childrenByPath.get(path);
      if (!children) return;
      for (const child of children) {
        out.push({ entry: child, depth, loading: child.kind === "directory" && !childrenByPath.has(child.path) });
        if (child.kind === "directory" && expanded.has(child.path)) walk(child.path, depth + 1);
      }
    };
    walk(root, 0);
    return out;
  }, [root, expanded, childrenByPath]);

  const matches = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return [];
    const out: { entry: FileEntryDto; rel: string }[] = [];
    const walk = (path: string) => {
      const children = childrenByPath.get(path);
      if (!children) return;
      for (const child of children) {
        out.push({ entry: child, rel: path === root ? child.name : `${path.slice(root.length + 1)}/${child.name}` });
        if (child.kind === "directory") walk(child.path);
      }
    };
    walk(root);
    return out.filter((item) => item.entry.name.toLowerCase().includes(query)).slice(0, 100);
  }, [root, filter, childrenByPath]);

  const toggle = (entry: FileEntryDto) => {
    if (entry.kind !== "directory") return;
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(entry.path)) {
        next.delete(entry.path);
      } else {
        next.add(entry.path);
      }
      return next;
    });
    load(entry.path);
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
            aria-label="Filter files"
            placeholder="Filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            spellCheck={false}
          />
        </div>
        <button
          type="button"
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-v2-icon-icon-muted transition-colors hover:bg-v2-grey-100 hover:text-v2-icon-icon-base"
          aria-label="Refresh listing"
          title="Refresh listing"
          onClick={() => {
            const next = new Map<string, FileEntryDto[]>();
            next.set(root, []);
            setChildrenByPath(next);
            load(root);
          }}
        >
          <RefreshCw size={13} />
        </button>
      </div>
      {error && <p className="px-2 pt-2 text-[12px] text-v2-status-error">{error}</p>}
      <div className="min-h-0 flex-1 overflow-y-auto p-2" role="tree" aria-label="Project files tree">
        {filter.trim() ? (
          matches.length === 0 ? (
            <p className="px-2 py-1 text-[12px] text-v2-text-text-faint">No matches.</p>
          ) : (
            <div className="flex flex-col gap-0.5">
              {matches.map(({ entry, rel }) => (
                <button
                  key={entry.path}
                  type="button"
                  role="treeitem"
                  className={rowClass(entry.kind === "directory")}
                  onClick={() => (entry.kind === "directory" ? toggle(entry) : onOpenFile(entry))}
                  title={entry.path}
                >
                  {entry.kind === "directory" ? <Folder size={13} className="shrink-0 text-v2-icon-icon-muted" /> : <FileIcon size={13} className="shrink-0 text-v2-icon-icon-muted" />}
                  <span className="min-w-0 truncate text-[12px]">{entry.name}</span>
                  <span className="ml-auto shrink-0 truncate font-mono text-[11px] text-v2-text-text-faint">{rel}</span>
                </button>
              ))}
            </div>
          )
        ) : rows.length === 0 && !error ? (
          <p className="px-2 py-1 text-[12px] text-v2-text-text-faint">No files.</p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {rows.map(({ entry, depth, loading }) => {
              const isExpanded = expanded.has(entry.path);
              const isDirectory = entry.kind === "directory";
              return (
                <div
                  key={entry.path}
                  role="treeitem"
                  aria-expanded={isDirectory ? isExpanded : undefined}
                  className="group flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-v2-grey-100"
                  style={{ paddingLeft: `${8 + depth * 14}px` }}
                  onClick={() => (isDirectory ? toggle(entry) : onOpenFile(entry))}
                  title={entry.path}
                >
                  {isDirectory ? (
                    <button
                      type="button"
                      className="flex size-4 shrink-0 items-center justify-center rounded text-v2-icon-icon-muted hover:bg-v2-grey-200"
                      aria-label={isExpanded ? "Collapse" : "Expand"}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggle(entry);
                      }}
                    >
                      {loading ? (
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
                    <FolderOpen size={13} className={`shrink-0 ${isExpanded ? "text-v2-blue-600" : "text-v2-icon-icon-muted"}`} />
                  ) : (
                    <FileIcon size={13} className="shrink-0 text-v2-icon-icon-muted" />
                  )}
                  <span className="min-w-0 truncate text-[12px]">{entry.name}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
