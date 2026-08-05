import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Folder, FolderOpen, Home, RefreshCw, X } from "lucide-react";
import { listDirectories } from "../api";
import type { DirectoryEntryDto } from "../../../web/contracts";

export interface DirectoryDialogProps {
  homeDir: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}

interface TreeRow {
  path: string;
  name: string;
  depth: number;
  loading: boolean;
}

function parentOf(path: string): string {
  const normalized = path.replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "/" : normalized.slice(0, index);
}

function nameOf(path: string): string {
  const normalized = path.replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return normalized.slice(index + 1) || normalized;
}

function expandHome(input: string, homeDir: string): string {
  if (input === "~") return homeDir;
  if (input.startsWith("~/")) return `${homeDir}/${input.slice(2)}`;
  if (input.startsWith("/")) return input;
  return input === "" ? homeDir : `${homeDir}/${input}`;
}

export function DirectoryDialog({ homeDir, onSelect, onClose }: DirectoryDialogProps) {
  const [input, setInput] = useState(homeDir);
  const [selected, setSelected] = useState<string | null>(null);
  const [viewPath, setViewPath] = useState(homeDir);
  const [suggestions, setSuggestions] = useState<DirectoryEntryDto[]>([]);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [childrenByPath, setChildrenByPath] = useState<Map<string, DirectoryEntryDto[]>>(new Map());
  const [treeError, setTreeError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const loadTree = useCallback(
    (path: string) => {
      if (childrenByPath.has(path)) return;
      setChildrenByPath((current) => new Map(current).set(path, []));
      listDirectories(path)
        .then((entries) => {
          setChildrenByPath((current) => new Map(current).set(path, entries));
          setTreeError(null);
        })
        .catch((e: unknown) => {
          setChildrenByPath((current) => new Map(current).set(path, []));
          setTreeError(e instanceof Error ? e.message : String(e));
        });
    },
    [childrenByPath],
  );

  useEffect(() => {
    loadTree(viewPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewPath]);

  const rows = useMemo(() => {
    const out: TreeRow[] = [];
    const walk = (path: string, depth: number) => {
      const children = childrenByPath.get(path);
      if (!children) return;
      for (const child of children) {
        out.push({ path: child.path, name: child.name, depth, loading: !childrenByPath.has(child.path) });
        if (expanded.has(child.path)) walk(child.path, depth + 1);
      }
    };
    walk(viewPath, 0);
    return out;
  }, [viewPath, expanded, childrenByPath]);

  const navigate = useCallback(
    (path: string) => {
      const target = path === "~" ? homeDir : path;
      listDirectories(target)
        .then(() => {
          setViewPath(target);
          setInput(target);
          setSelected(target);
          setTreeError(null);
        })
        .catch((e: unknown) => setTreeError(e instanceof Error ? e.message : String(e)));
    },
    [homeDir],
  );

  const refreshSuggestions = useCallback(
    (raw: string) => {
      const target = expandHome(raw.trim(), homeDir);
      const parent = parentOf(target);
      const prefix = nameOf(target).toLowerCase();
      listDirectories(parent)
        .then((entries) => {
          const filtered = prefix
            ? entries.filter((entry) => entry.name.toLowerCase().startsWith(prefix))
            : entries;
          setSuggestions(filtered.slice(0, 12));
          setSuggestionsOpen(true);
        })
        .catch(() => {
          setSuggestions([]);
          setSuggestionsOpen(false);
        });
    },
    [homeDir],
  );

  const moveSuggestion = (delta: number) => {
    if (suggestions.length === 0) return;
    setSuggestionsOpen(true);
    setActiveSuggestion((current) => {
      const next = current + delta;
      if (next < 0) return suggestions.length - 1;
      if (next >= suggestions.length) return 0;
      return next;
    });
  };

  const chooseSuggestion = (suggestion: DirectoryEntryDto) => {
    setSelected(suggestion.path);
    setInput(suggestion.path);
    setSuggestionsOpen(false);
    setActiveSuggestion(-1);
    navigate(suggestion.path);
  };

  const activeSuggestionPath = () => (activeSuggestion >= 0 ? suggestions[activeSuggestion] : suggestions[0]);

  const handleInputKey = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSuggestion(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSuggestion(-1);
    } else if (event.key === "Tab") {
      const suggestion = activeSuggestionPath();
      if (suggestion) {
        event.preventDefault();
        setInput(suggestion.path);
        setActiveSuggestion(-1);
      }
    } else if (event.key === "Enter") {
      const suggestion = activeSuggestionPath();
      if (suggestionsOpen && suggestion) {
        event.preventDefault();
        chooseSuggestion(suggestion);
      } else if (input.trim()) {
        event.preventDefault();
        navigate(expandHome(input.trim(), homeDir));
        setSuggestionsOpen(false);
        setActiveSuggestion(-1);
      }
    }
  };

  const toggleExpand = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
    loadTree(path);
  };

  const selectRow = (path: string) => {
    setSelected(path);
    setInput(path);
  };

  const confirm = () => {
    if (!selected) return;
    onSelect(selected);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-v2-grey-1200/30 p-0 sm:p-6" role="presentation" onMouseDown={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <section className="flex h-full w-full flex-col overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-overlay)] sm:h-auto sm:max-h-[84vh] sm:max-w-[640px]" role="dialog" aria-modal="true" aria-label="Choose project directory">
        <header className="flex h-10 shrink-0 items-center justify-between border-b border-v2-grey-200 px-3">
          <h2 className="text-[13px] font-semibold text-v2-text-text-base">Choose project directory</h2>
          <button type="button" className="flex size-7 items-center justify-center rounded-md text-v2-icon-icon-muted transition-colors hover:bg-v2-grey-100 hover:text-v2-icon-icon-base" aria-label="Close" title="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className="relative flex shrink-0 flex-col gap-2 border-b border-v2-grey-200 p-3">
          <input
            ref={inputRef}
            className="h-9 w-full rounded-md border border-v2-grey-200 bg-v2-background-bg-base px-3 font-mono text-[13px] text-v2-text-text-base outline-none focus:border-v2-blue-600"
            value={input}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={suggestionsOpen}
            aria-activedescendant={
              activeSuggestion >= 0 ? `directory-suggestion-${activeSuggestion}` : undefined
            }
            spellCheck={false}
            onChange={(event) => {
              const value = event.target.value;
              setInput(value);
              setSelected(null);
              setActiveSuggestion(-1);
              refreshSuggestions(value);
            }}
            onKeyDown={handleInputKey}
            onBlur={() => setTimeout(() => setSuggestionsOpen(false), 120)}
          />
          <div className="flex items-center gap-1">
            <button className="flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-v2-text-text-muted transition-colors hover:bg-v2-grey-100" title="Home" onClick={() => navigate(homeDir)}>
              <Home size={14} />
              ~
            </button>
            <button className="flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-v2-text-text-muted transition-colors hover:bg-v2-grey-100" title="Root" onClick={() => navigate("/")}>
              /
            </button>
            <button
              className="flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-v2-text-text-muted transition-colors hover:bg-v2-grey-100"
              title="Parent directory"
              onClick={() => navigate(parentOf(viewPath))}
            >
              ↑
            </button>
            <button className="flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-v2-text-text-muted transition-colors hover:bg-v2-grey-100" title="Refresh" onClick={() => {
              setChildrenByPath((current) => {
                const next = new Map(current);
                next.delete(viewPath);
                return next;
              });
              loadTree(viewPath);
            }}>
              <RefreshCw size={14} />
            </button>
          </div>
          {suggestionsOpen && suggestions.length > 0 && (
            <ul className="absolute left-3 right-3 top-[calc(100%+8px)] z-10 max-h-[240px] overflow-y-auto rounded-md border border-v2-grey-200 bg-v2-background-bg-base p-1 shadow-[var(--v2-elevation-floating)]" role="listbox">
              {suggestions.map((suggestion, index) => (
                <li key={suggestion.path} role="option" aria-selected={index === activeSuggestion}>
                  <button
                    id={`directory-suggestion-${index}`}
                    className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-v2-text-text-base transition-colors ${index === activeSuggestion ? "bg-v2-blue-100 text-v2-blue-600" : "hover:bg-v2-grey-100"}`}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      chooseSuggestion(suggestion);
                    }}
                    onMouseEnter={() => setActiveSuggestion(index)}
                  >
                    <Folder size={14} />
                    <span>{suggestion.name}/</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5" role="tree" aria-label="Directory tree">
          {treeError && <p className="px-2 py-1 text-[12px] text-v2-status-error">{treeError}</p>}
          {rows.length === 0 && !treeError && <p className="px-2 py-1 text-[12px] text-v2-text-text-faint">No subdirectories.</p>}
          {rows.map((row) => {
            const isExpanded = expanded.has(row.path);
            const isSelected = selected === row.path;
            return (
              <div
                key={row.path}
                role="treeitem"
                aria-expanded={isExpanded}
                aria-selected={isSelected}
                className={`group flex cursor-pointer items-center gap-1.5 rounded-md py-1 pr-2 text-left transition-colors hover:bg-v2-grey-100 ${isSelected ? "bg-v2-blue-100/50" : ""}`}
                style={{ paddingLeft: `${8 + row.depth * 16}px` }}
                onClick={() => selectRow(row.path)}
              >
                <button
                  className="flex size-4 shrink-0 items-center justify-center rounded text-v2-icon-icon-muted hover:bg-v2-grey-200"
                  aria-label={isExpanded ? "Collapse" : "Expand"}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleExpand(row.path);
                  }}
                >
                  {row.loading ? (
                    <span className="v2-spinner" aria-hidden />
                  ) : (
                    <ChevronRight
                      size={14}
                      className={`shrink-0 transition-transform ${isExpanded ? "rotate-90" : ""}`}
                    />
                  )}
                </button>
                {isSelected ? <FolderOpen size={15} /> : <Folder size={15} />}
                <span className="truncate text-[12px]">{row.name}</span>
              </div>
            );
          })}
        </div>
        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-v2-grey-200 px-3 py-2.5">
          <button type="button" className="flex h-7 items-center rounded-md px-3 text-[12px] text-v2-text-text-muted transition-colors hover:bg-v2-grey-100" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="flex h-7 items-center rounded-md bg-v2-grey-1100 px-3 text-[12px] font-medium text-v2-grey-50 transition-opacity hover:opacity-90 disabled:opacity-40" disabled={!selected} onClick={confirm}>
            Create session
          </button>
        </footer>
      </section>
    </div>
  );
}
