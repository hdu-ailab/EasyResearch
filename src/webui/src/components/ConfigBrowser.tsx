import { useCallback, useEffect, useState } from "react";
import { FilePlus, FolderPlus, RefreshCw, Save, X } from "lucide-react";
import { createConfigDirectory, listConfig, readConfigFile, writeConfigFile } from "../api";
import type { ConfigEntryDto, ConfigScope } from "../types";

export interface ConfigBrowserProps {
  cwd: string;
  onSaveApplied: () => void;
}

interface EditedFile {
  path: string;
  original: string;
  current: string;
}

/**
 * Split-pane config browser for the exact project cwd plus the global
 * settings root. Scope, listing and file paths are always passed through to
 * the Phase 2 config APIs; saving never restarts the session.
 */
export function ConfigBrowser({ cwd, onSaveApplied }: ConfigBrowserProps) {
  const [scope, setScope] = useState<ConfigScope>("project");
  const [entries, setEntries] = useState<ConfigEntryDto[]>([]);
  const [dirPath, setDirPath] = useState<string | null>(null);
  const [edited, setEdited] = useState<EditedFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [creating, setCreating] = useState(false);
  const [folderName, setFolderName] = useState("");

  const scopeCwd = scope === "project" ? cwd : undefined;

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setEntries(await listConfig(scope, scopeCwd, dirPath ?? undefined));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [scope, scopeCwd, dirPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const switchScope = (next: ConfigScope) => {
    if (edited && edited.current !== edited.original && !window.confirm("Discard unsaved changes?")) return;
    setEdited(null);
    setDirPath(null);
    setScope(next);
  };

  const openFile = async (path: string) => {
    if (edited && edited.current !== edited.original && !window.confirm("Discard unsaved changes?")) return;
    try {
      const file = await readConfigFile(scope, scopeCwd, path);
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
      await writeConfigFile(scope, scopeCwd, edited.path, edited.current);
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
      await createConfigDirectory(scope, scopeCwd, dirPath ? `${dirPath}/${name}` : name);
      setCreating(false);
      setFolderName("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className="config-browser" aria-label="Config browser">
      <div className="config-browser__toolbar">
        <div className="segmented" role="tablist" aria-label="Config scope">
          <button
            role="tab"
            aria-selected={scope === "project"}
            className="segmented__option"
            onClick={() => switchScope("project")}
          >
            Project
          </button>
          <button
            role="tab"
            aria-selected={scope === "global"}
            className="segmented__option"
            onClick={() => switchScope("global")}
          >
            Global
          </button>
        </div>
        <button className="icon-button" aria-label="Refresh" title="Refresh listing" onClick={() => void refresh()}>
          <RefreshCw size={16} />
        </button>
        <button className="icon-button" aria-label="New folder" title="New folder" onClick={() => setCreating(true)}>
          <FolderPlus size={16} />
        </button>
        <button className="icon-button" aria-label="New file" title="New file" onClick={() => {}}>
          <FilePlus size={16} />
        </button>
      </div>

      {creating && (
        <form
          className="config-browser__create"
          onSubmit={(e) => {
            e.preventDefault();
            void createFolder();
          }}
        >
          <label htmlFor="folder-name">Folder name</label>
          <input
            id="folder-name"
            aria-label="Folder name"
            value={folderName}
            onChange={(e) => setFolderName(e.target.value)}
          />
          <button type="submit" className="button button--primary" aria-label="Confirm">
            Confirm
          </button>
          <button type="button" className="icon-button" aria-label="Cancel" onClick={() => setCreating(false)}>
            <X size={16} />
          </button>
        </form>
      )}

      <div className="config-browser__body">
        <nav className="config-browser__tree" aria-label="Config files">
          {dirPath && (
            <button
              className="config-browser__entry config-browser__entry--dir"
              onClick={() => setDirPath(dirPath.includes("/") ? dirPath.slice(0, dirPath.lastIndexOf("/")) : null)}
            >
              ..
            </button>
          )}
          {entries.map((entry) =>
            entry.type === "directory" ? (
              <button
                key={entry.path}
                className="config-browser__entry config-browser__entry--dir"
                onClick={() => setDirPath(entry.path)}
              >
                {entry.name}/
              </button>
            ) : (
              <button
                key={entry.path}
                className="config-browser__entry config-browser__entry--file"
                onClick={() => void openFile(entry.path)}
              >
                {entry.name}
              </button>
            ),
          )}
        </nav>

        <div className="config-browser__editor">
          {edited ? (
            <>
              <div className="config-browser__filename">{edited.path}</div>
              <textarea
                className="config-browser__textarea"
                aria-label="Editor"
                spellCheck={false}
                value={edited.current}
                onChange={(e) => setEdited({ ...edited, current: e.target.value })}
              />
              <div className="config-browser__editor-actions">
                <button className="button button--primary" aria-label="Save" onClick={() => void save()}>
                  <Save size={14} />
                  Save
                </button>
                <button className="icon-button" aria-label="Close" title="Close editor" onClick={() => setEdited(null)}>
                  <X size={16} />
                </button>
              </div>
            </>
          ) : (
            <p className="config-browser__placeholder">Select a file to edit its JSON.</p>
          )}
        </div>
      </div>

      {error && <p className="config-browser__error" role="alert">{error}</p>}
      {saved && <p className="config-browser__saved">Saved — applies after restart.</p>}
    </section>
  );
}
