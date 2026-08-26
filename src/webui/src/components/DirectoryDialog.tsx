import { ChevronRight, Folder, FolderOpen, FolderPlus, Home, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { DirectoryEntryDto } from "../../../web/contracts";
import { createDirectory, listDirectories, listDirectoryRoots } from "../api";
import { expandFilesystemPath, filesystemPathName, joinFilesystemPath, parentFilesystemPath } from "../filesystem-path";
import { useLazyTree } from "../hooks/useLazyTree";
import { useModalLayer } from "../hooks/useModalLayer";
import { useI18n } from "../i18n/useI18n";

export interface DirectoryDialogProps {
  homeDir: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}

interface TreeRow {
  path: string;
  name: string;
  depth: number;
}

export function DirectoryDialog({ homeDir, onSelect, onClose }: DirectoryDialogProps) {
  const { t } = useI18n();
  const [input, setInput] = useState(homeDir);
  const [selected, setSelected] = useState<string | null>(null);
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [viewPath, setViewPath] = useState(homeDir);
  const [suggestions, setSuggestions] = useState<DirectoryEntryDto[]>([]);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [roots, setRoots] = useState<DirectoryEntryDto[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const navigationGeneration = useRef(0);
  const suggestionGeneration = useRef(0);
  const suggestionsId = `directory-suggestions-${useId().replaceAll(":", "")}`;
  const loadChildren = useCallback(async (path: string) => (await listDirectories(path)).entries, []);
  const tree = useLazyTree<DirectoryEntryDto>({ root: viewPath, loadChildren });

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    let active = true;
    listDirectoryRoots()
      .then((next) => {
        if (active) setRoots(next);
      })
      .catch((error: unknown) => {
        if (active) setTreeError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      active = false;
    };
  }, []);

  const { zIndex, dialogProps } = useModalLayer(onClose, dialogRef);

  const rows = useMemo(() => {
    const out: TreeRow[] = [];
    const walk = (path: string, depth: number) => {
      for (const child of tree.children(path)) {
        out.push({ path: child.path, name: child.name, depth });
        if (tree.expanded.has(child.path)) walk(child.path, depth + 1);
      }
    };
    walk(viewPath, 0);
    return out;
  }, [viewPath, tree.children, tree.expanded]);

  const navigate = useCallback(
    (path: string) => {
      const generation = ++navigationGeneration.current;
      suggestionGeneration.current += 1;
      const target = path === "~" ? homeDir : path;
      listDirectories(target)
        .then((listing) => {
          if (navigationGeneration.current !== generation) return;
          setViewPath(listing.path);
          setInput(listing.path);
          setSelected(listing.path);
          setTreeError(null);
        })
        .catch((e: unknown) => {
          if (navigationGeneration.current === generation) {
            setTreeError(e instanceof Error ? e.message : String(e));
          }
        });
    },
    [homeDir],
  );

  const refreshSuggestions = useCallback(
    (raw: string) => {
      const generation = ++suggestionGeneration.current;
      const target = expandFilesystemPath(raw.trim(), homeDir);
      const parent = parentFilesystemPath(target);
      const prefix = filesystemPathName(target).toLowerCase();
      listDirectories(parent)
        .then((listing) => {
          if (suggestionGeneration.current !== generation) return;
          const filtered = prefix
            ? listing.entries.filter((entry) => entry.name.toLowerCase().startsWith(prefix))
            : listing.entries;
          const next = filtered.slice(0, 12);
          setSuggestions(next);
          setSuggestionsOpen(next.length > 0);
          setActiveSuggestion(next.length > 0 ? 0 : -1);
        })
        .catch(() => {
          if (suggestionGeneration.current !== generation) return;
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
    if (event.key === "Escape") {
      suggestionGeneration.current += 1;
      if (suggestionsOpen) {
        event.preventDefault();
        event.stopPropagation();
        setSuggestionsOpen(false);
        setActiveSuggestion(-1);
      }
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSuggestion(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSuggestion(-1);
    } else if (suggestionsOpen && (event.key === "Home" || event.key === "End")) {
      event.preventDefault();
      setActiveSuggestion(event.key === "Home" ? 0 : Math.max(0, suggestions.length - 1));
    } else if (event.key === "Tab" && suggestionsOpen) {
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
        navigate(expandFilesystemPath(input.trim(), homeDir));
        setSuggestionsOpen(false);
        setActiveSuggestion(-1);
      }
    }
  };

  const toggleExpand = (path: string) => tree.toggle(path);

  const selectRow = (path: string) => {
    setSelected(path);
    setInput(path);
  };

  const rovingPath = rows.some((row) => row.path === focusedPath) ? focusedPath : (rows[0]?.path ?? null);
  const focusRow = (path: string) => {
    setFocusedPath(path);
    rowRefs.current.get(path)?.focus();
  };
  const handleTreeKey = (event: React.KeyboardEvent<HTMLDivElement>, row: TreeRow) => {
    if (event.target !== event.currentTarget) return;
    const index = rows.findIndex((candidate) => candidate.path === row.path);
    const focusAt = (nextIndex: number) => {
      const next = rows[Math.max(0, Math.min(rows.length - 1, nextIndex))];
      if (next) focusRow(next.path);
    };
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      focusAt(index + (event.key === "ArrowDown" ? 1 : -1));
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      focusAt(event.key === "Home" ? 0 : rows.length - 1);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      if (!tree.expanded.has(row.path)) toggleExpand(row.path);
      else {
        const child = rows[index + 1];
        if (child && child.depth > row.depth) focusRow(child.path);
      }
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (tree.expanded.has(row.path)) toggleExpand(row.path);
      else {
        const parent = rows.find((candidate) => candidate.path === parentFilesystemPath(row.path));
        if (parent) focusRow(parent.path);
      }
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectRow(row.path);
    }
  };

  const confirm = () => {
    if (!selected) return;
    onSelect(selected);
  };

  const rootError = tree.error(viewPath);

  const createFolder = async () => {
    const relative = createName.trim();
    if (!relative || relative.includes("\0")) {
      setCreateError("Invalid folder name");
      return;
    }
    try {
      const created = await createDirectory(joinFilesystemPath(viewPath, relative));
      setCreateOpen(false);
      setCreateName("");
      setCreateError(null);
      tree.refresh(viewPath);
      navigate(created.path);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop intentionally closes the dialog on pointer dismissal.
    <div
      className="fixed inset-0 flex items-center justify-center bg-v2-grey-1200/30 p-0 sm:p-6"
      style={{ zIndex }}
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="flex h-full w-full flex-col overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-overlay)] sm:h-auto sm:max-h-[84vh] sm:max-w-[640px]"
        role="dialog"
        {...dialogProps}
        aria-label={t("dialog.title")}
      >
        <header className="flex h-10 shrink-0 items-center justify-between border-b border-v2-grey-200 px-3">
          <h2 className="text-[13px] font-semibold text-v2-text-text-base">{t("dialog.title")}</h2>
          <button
            type="button"
            className="flex size-7 items-center justify-center rounded-md text-v2-icon-icon-muted transition-colors hover:bg-v2-grey-100 hover:text-v2-icon-icon-base"
            aria-label={t("dialog.close")}
            title={t("dialog.close")}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>
        <div className="relative flex shrink-0 flex-col gap-2 border-b border-v2-grey-200 p-3">
          <input
            ref={inputRef}
            className="h-9 w-full rounded-md border border-v2-grey-200 bg-v2-background-bg-base px-3 font-mono text-[13px] text-v2-text-text-base outline-none focus:border-v2-blue-600"
            value={input}
            role="combobox"
            aria-label={t("dialog.path")}
            aria-autocomplete="list"
            aria-expanded={suggestionsOpen}
            aria-controls={suggestionsOpen ? suggestionsId : undefined}
            aria-activedescendant={activeSuggestion >= 0 ? `directory-suggestion-${activeSuggestion}` : undefined}
            spellCheck={false}
            onChange={(event) => {
              const value = event.target.value;
              navigationGeneration.current += 1;
              setInput(value);
              setSelected(null);
              setSuggestions([]);
              setSuggestionsOpen(false);
              setActiveSuggestion(-1);
              refreshSuggestions(value);
            }}
            onKeyDown={handleInputKey}
            onBlur={() => {
              suggestionGeneration.current += 1;
              setTimeout(() => setSuggestionsOpen(false), 120);
            }}
          />
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-v2-text-text-muted transition-colors hover:bg-v2-grey-100"
              title={t("dialog.home")}
              aria-label={t("dialog.home")}
              onClick={() => navigate(homeDir)}
            >
              <Home size={14} />~
            </button>
            <button
              type="button"
              className="flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-v2-text-text-muted transition-colors hover:bg-v2-grey-100"
              title={t("dialog.createProject")}
              aria-label={t("dialog.createProject")}
              onClick={() => {
                setCreateOpen(true);
                setCreateError(null);
              }}
            >
              <FolderPlus size={14} />
            </button>
            {roots.length > 1 ? (
              <select
                value=""
                className="h-7 rounded-md border border-v2-grey-200 bg-v2-background-bg-base px-2 font-mono text-[12px] text-v2-text-text-muted"
                title={t("dialog.root")}
                aria-label={t("dialog.root")}
                onChange={(event) => navigate(event.target.value)}
              >
                <option value="" disabled>
                  {t("dialog.root")}
                </option>
                {roots.map((root) => (
                  <option key={root.path} value={root.path}>
                    {root.name}
                  </option>
                ))}
              </select>
            ) : (
              <button
                type="button"
                className="flex h-7 items-center gap-1 rounded-md px-2 font-mono text-[12px] text-v2-text-text-muted transition-colors hover:bg-v2-grey-100 disabled:opacity-40"
                title={t("dialog.root")}
                aria-label={t("dialog.root")}
                disabled={roots.length === 0}
                onClick={() => roots[0] && navigate(roots[0].path)}
              >
                {roots[0]?.name ?? t("dialog.root")}
              </button>
            )}
            <button
              type="button"
              className="flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-v2-text-text-muted transition-colors hover:bg-v2-grey-100"
              title={t("dialog.parent")}
              aria-label={t("dialog.parent")}
              onClick={() => navigate(parentFilesystemPath(viewPath))}
            >
              ↑
            </button>
            <button
              type="button"
              className="flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-v2-text-text-muted transition-colors hover:bg-v2-grey-100"
              title={t("dialog.refresh")}
              aria-label={t("dialog.refresh")}
              onClick={() => tree.refresh(viewPath)}
            >
              <RefreshCw size={14} />
            </button>
          </div>
          {suggestionsOpen && suggestions.length > 0 && (
            <div
              id={suggestionsId}
              className="absolute left-3 right-3 top-[calc(100%+8px)] z-10 max-h-[240px] overflow-y-auto rounded-md border border-v2-grey-200 bg-v2-background-bg-base p-1 shadow-[var(--v2-elevation-floating)]"
              role="listbox"
            >
              {suggestions.map((suggestion, index) => (
                <button
                  key={suggestion.path}
                  type="button"
                  id={`directory-suggestion-${index}`}
                  role="option"
                  aria-selected={index === activeSuggestion}
                  tabIndex={-1}
                  className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-v2-text-text-base transition-colors ${index === activeSuggestion ? "bg-v2-blue-100 text-v2-blue-600" : "hover:bg-v2-grey-100"}`}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    chooseSuggestion(suggestion);
                  }}
                  onMouseEnter={() => setActiveSuggestion(index)}
                >
                  <Folder size={14} aria-hidden />
                  <span>{suggestion.name}/</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5" role="tree" aria-label={t("dialog.tree")}>
          {treeError && (
            <p role="alert" className="px-2 py-1 text-[12px] text-v2-status-error">
              {treeError}
            </p>
          )}
          {rootError && (
            <p role="alert" className="px-2 py-1 text-[12px] text-v2-status-error">
              {rootError}
            </p>
          )}
          {rows.length === 0 &&
            !treeError &&
            !rootError &&
            (tree.status(viewPath) === "loading" ? (
              <p className="px-2 py-1 text-[12px] text-v2-text-text-faint">{t("dialog.loading")}</p>
            ) : (
              <p className="px-2 py-1 text-[12px] text-v2-text-text-faint">{t("dialog.empty")}</p>
            ))}
          {rows.map((row) => {
            const isExpanded = tree.expanded.has(row.path);
            const isSelected = selected === row.path;
            const state = tree.status(row.path);
            return (
              <div
                key={row.path}
                ref={(element) => {
                  if (element) rowRefs.current.set(row.path, element);
                  else rowRefs.current.delete(row.path);
                }}
                role="treeitem"
                aria-level={row.depth + 1}
                aria-expanded={isExpanded}
                aria-selected={isSelected}
                tabIndex={rovingPath === row.path ? 0 : -1}
                className={`group flex cursor-pointer items-center gap-1.5 rounded-md py-1 pr-2 text-left transition-colors hover:bg-v2-grey-100 ${isSelected ? "bg-v2-blue-100/50" : ""}`}
                style={{ paddingLeft: `${8 + row.depth * 16}px` }}
                onFocus={() => setFocusedPath(row.path)}
                onClick={() => {
                  setFocusedPath(row.path);
                  selectRow(row.path);
                }}
                onKeyDown={(event) => handleTreeKey(event, row)}
              >
                <button
                  type="button"
                  tabIndex={-1}
                  className="flex size-4 shrink-0 items-center justify-center rounded text-v2-icon-icon-muted hover:bg-v2-grey-200"
                  aria-label={
                    state === "loading"
                      ? t("dialog.loadingRow").replace("{name}", row.name)
                      : isExpanded
                        ? t("dialog.collapse").replace("{name}", row.name)
                        : t("dialog.expand").replace("{name}", row.name)
                  }
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleExpand(row.path);
                  }}
                >
                  {state === "loading" ? (
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
                {state === "error" && (
                  <button
                    type="button"
                    tabIndex={-1}
                    className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[11px] text-v2-text-text-muted hover:bg-v2-grey-200"
                    aria-label={t("dialog.retryRow").replace("{name}", row.name)}
                    onClick={(event) => {
                      event.stopPropagation();
                      tree.retry(row.path);
                    }}
                  >
                    {t("dialog.retry")}
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-v2-grey-200 px-3 py-2.5">
          <button
            type="button"
            className="flex h-7 items-center rounded-md px-3 text-[12px] text-v2-text-text-muted transition-colors hover:bg-v2-grey-100"
            onClick={onClose}
          >
            {t("dialog.cancel")}
          </button>
          <button
            type="button"
            className="flex h-7 items-center rounded-md bg-v2-grey-1100 px-3 text-[12px] font-medium text-v2-grey-50 transition-opacity hover:opacity-90 disabled:opacity-40"
            disabled={!selected}
            onClick={confirm}
          >
            {t("dialog.createSession")}
          </button>
        </footer>
      </section>
      {createOpen && (
        <CreateFolderDialog
          name={createName}
          error={createError}
          onNameChange={setCreateName}
          onCreate={() => void createFolder()}
          onCancel={() => setCreateOpen(false)}
        />
      )}
    </div>
  );
}

function CreateFolderDialog({
  name,
  error,
  onNameChange,
  onCreate,
  onCancel,
}: {
  name: string;
  error: string | null;
  onNameChange: (value: string) => void;
  onCreate: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDivElement>(null);
  const { zIndex, dialogProps } = useModalLayer(onCancel, dialogRef);
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-v2-grey-1200/20 p-4" style={{ zIndex }}>
      <div
        ref={dialogRef}
        role="dialog"
        {...dialogProps}
        aria-label={t("dialog.createProject")}
        className="w-full max-w-[360px] rounded-[10px] bg-v2-background-bg-base p-4 shadow-[var(--v2-elevation-overlay)]"
      >
        <h2 className="mb-3 text-[13px] font-semibold">{t("dialog.createProject")}</h2>
        <input
          aria-label={t("dialog.folderName")}
          className="h-8 w-full rounded-md border border-v2-grey-200 px-2 font-mono text-[12px]"
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && onCreate()}
        />
        {error && (
          <p role="alert" className="mt-2 text-[12px] text-v2-status-error">
            {error}
          </p>
        )}
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" className="px-3 py-1 text-[12px]" onClick={onCancel}>
            {t("dialog.cancel")}
          </button>
          <button
            type="button"
            className="rounded-md bg-v2-grey-1100 px-3 py-1 text-[12px] text-v2-grey-50"
            onClick={onCreate}
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
