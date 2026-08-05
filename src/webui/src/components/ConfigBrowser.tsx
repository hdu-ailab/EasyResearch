import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, FilePlus, FolderPlus, RefreshCw, Save, X } from "lucide-react";
import { createConfigDirectory, listConfig, readConfigFile, writeConfigFile } from "../api";
import type { ConfigEntryDto } from "../types";

export interface ConfigBrowserProps {
  onSaveApplied?: () => void;
}

interface EditedFile {
  path: string;
  original: string;
  current: string;
}

/**
 * Global-only config browser (ADR-020). Lists and edits the global
 * `~/.lazyresearch/agent/` root; saving never restarts the session.
 */
export function ConfigBrowser({ onSaveApplied = () => {} }: ConfigBrowserProps) {
  const [entries, setEntries] = useState<ConfigEntryDto[]>([]);
  const [dirPath, setDirPath] = useState<string | null>(null);
  const [edited, setEdited] = useState<EditedFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [creating, setCreating] = useState(false);
  const [folderName, setFolderName] = useState("");

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setEntries(await listConfig("global", undefined, dirPath ?? undefined));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [dirPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openFile = async (path: string) => {
    if (edited && edited.current !== edited.original && !window.confirm("Discard unsaved changes?")) return;
    try {
      const file = await readConfigFile("global", undefined, path);
      setEdited({ path: file.path, original: file.content, current: file.content });
      setSaved(false);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const save = async () => {
    if (!edited) return;
    try {
      JSON.parse(edited.current);
    } catch {
      setError("Invalid JSON — the file was not saved.");
      setSaved(false);
      return;
    }
    try {
      await writeConfigFile("global", undefined, edited.path, edited.current);
      setEdited({ ...edited, original: edited.current });
      setSaved(true);
      setError(null);
      onSaveApplied();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaved(false);
    }
  };

  const createFolder = async () => {
    const name = folderName.trim();
    if (!name) return;
    try {
      await createConfigDirectory("global", undefined, dirPath ? `${dirPath}/${name}` : name);
      setCreating(false);
      setFolderName("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className="mx-auto flex h-full w-full max-w-[980px] flex-col rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]" aria-label="Config browser">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-v2-grey-200 px-2">
        <span className="px-2 font-mono text-[12px] text-v2-text-text-muted">~/.lazyresearch/agent</span>
        <span className="ml-auto flex items-center gap-1">
          <button type="button" className="flex size-7 items-center justify-center rounded-md text-v2-icon-icon-muted transition-colors hover:bg-v2-grey-100 hover:text-v2-icon-icon-base" aria-label="Refresh" title="Refresh listing" onClick={() => void refresh()}>
            <RefreshCw size={15} />
          </button>
          <button type="button" className="flex size-7 items-center justify-center rounded-md text-v2-icon-icon-muted transition-colors hover:bg-v2-grey-100 hover:text-v2-icon-icon-base" aria-label="New folder" title="New folder" onClick={() => setCreating(true)}>
            <FolderPlus size={15} />
          </button>
          <button type="button" className="flex size-7 items-center justify-center rounded-md text-v2-icon-icon-muted transition-colors hover:bg-v2-grey-100 hover:text-v2-icon-icon-base" aria-label="New file" title="New file" onClick={() => {}}>
            <FilePlus size={15} />
          </button>
        </span>
      </div>

      {creating && (
        <form
          className="flex items-center gap-2 border-b border-v2-grey-200 px-3 py-2"
          onSubmit={(e) => {
            e.preventDefault();
            void createFolder();
          }}
        >
          <label htmlFor="folder-name" className="text-[12px] text-v2-text-text-muted">
            Folder name
          </label>
          <input
            id="folder-name"
            aria-label="Folder name"
            className="h-7 min-w-0 flex-1 rounded-md border border-v2-grey-200 px-2 text-[12px] text-v2-text-text-base outline-none focus:border-v2-blue-600"
            value={folderName}
            onChange={(e) => setFolderName(e.target.value)}
          />
          <button type="submit" className="flex h-7 items-center rounded-md bg-v2-grey-1100 px-3 text-[12px] font-medium text-v2-grey-50 hover:opacity-90" aria-label="Confirm">
            Confirm
          </button>
          <button type="button" className="flex size-7 items-center justify-center rounded-md text-v2-icon-icon-muted hover:bg-v2-grey-100" aria-label="Cancel" onClick={() => setCreating(false)}>
            <X size={15} />
          </button>
        </form>
      )}

      <div className="flex min-h-0 flex-1">
        <nav className="w-[260px] shrink-0 overflow-y-auto border-r border-v2-grey-200 p-2" aria-label="Config files">
          {dirPath && (
            <button
              type="button"
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-v2-icon-icon-muted transition-colors hover:bg-v2-grey-100"
              onClick={() => setDirPath(dirPath.includes("/") ? dirPath.slice(0, dirPath.lastIndexOf("/")) : null)}
            >
              <ChevronLeft size={13} />
              ..
            </button>
          )}
          <div className="flex flex-col gap-0.5">
            {entries.map((entry) =>
              entry.type === "directory" ? (
                <button
                  key={entry.path}
                  type="button"
                  className="flex w-full items-center rounded-md px-2 py-1 text-left text-[12px] text-v2-text-text-base transition-colors hover:bg-v2-grey-100"
                  onClick={() => setDirPath(entry.path)}
                >
                  <FolderPlus size={13} className="mr-1.5 text-v2-icon-icon-muted" />
                  {entry.name}/
                </button>
              ) : (
                <button
                  key={entry.path}
                  type="button"
                  className="flex w-full items-center rounded-md px-2 py-1 text-left font-mono text-[12px] text-v2-text-text-base transition-colors hover:bg-v2-grey-100"
                  onClick={() => void openFile(entry.path)}
                >
                  {entry.name}
                </button>
              ),
            )}
          </div>
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          {edited ? (
            <>
              <div className="flex h-9 shrink-0 items-center gap-2 border-b border-v2-grey-200 px-2">
                <button
                  type="button"
                  className="flex size-7 items-center justify-center rounded-md text-v2-icon-icon-muted transition-colors hover:bg-v2-grey-100"
                  aria-label="Back to files"
                  title="Back to files"
                  onClick={() => setEdited(null)}
                >
                  <ChevronLeft size={15} />
                </button>
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-v2-text-text-muted">{edited.path}</span>
              </div>
              <textarea
                className="min-h-0 flex-1 resize-none bg-transparent p-3 font-mono text-[12px] leading-[1.5] text-v2-text-text-base outline-none"
                aria-label="Editor"
                spellCheck={false}
                value={edited.current}
                onChange={(e) => setEdited({ ...edited, current: e.target.value })}
              />
              <div className="flex shrink-0 items-center gap-1 border-t border-v2-grey-200 p-2">
                <button type="button" className="flex h-7 items-center gap-1 rounded-md bg-v2-grey-1100 px-3 text-[12px] font-medium text-v2-grey-50 transition-opacity hover:opacity-90" aria-label="Save" onClick={() => void save()}>
                  <Save size={13} />
                  Save
                </button>
                <button type="button" className="flex size-7 items-center justify-center rounded-md text-v2-icon-icon-muted hover:bg-v2-grey-100" aria-label="Close" title="Close editor" onClick={() => setEdited(null)}>
                  <X size={15} />
                </button>
              </div>
            </>
          ) : (
            <p className="flex flex-1 items-center justify-center text-[13px] text-v2-text-text-faint">
              Select a file to edit its JSON.
            </p>
          )}
          {error && <p className="border-t border-v2-grey-200 px-3 py-2 text-[12px] text-v2-status-error" role="alert">{error}</p>}
          {saved && !error && <p className="border-t border-v2-grey-200 px-3 py-2 text-[12px] text-v2-text-text-muted">Saved — applies after restart.</p>}
        </div>
      </div>
    </section>
  );
}