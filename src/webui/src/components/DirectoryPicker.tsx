import { useEffect, useState } from "react";
import { ChevronUp, Folder, FolderOpen, Plus, RefreshCw } from "lucide-react";
import { listDirectories } from "../api";

export interface DirectoryPickerProps {
  homeDir: string;
  onSelect: (path: string) => void;
  onNavigate: (path: string) => void;
}

/**
 * Server-backed local directory navigation. Emits canonical paths only; the
 * project root is never inferred from an ancestor.
 */
export function DirectoryPicker({ homeDir, onSelect, onNavigate }: DirectoryPickerProps) {
  const [current, setCurrent] = useState<string>(homeDir);
  const [entries, setEntries] = useState<Array<{ name: string; path: string }>>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = (path: string) => {
    setError(null);
    listDirectories(path).then(setEntries).catch((e: unknown) => {
      setEntries([]);
      setError(e instanceof Error ? e.message : String(e));
    });
  };

  useEffect(() => {
    load(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  return (
    <section className="directory-picker" aria-label="Project directory">
      <header className="directory-picker__header">
        <span className="directory-picker__path" title={current}>
          {current}
        </span>
        <div className="directory-picker__actions">
          <button
            className="icon-button"
            aria-label="Go up one directory"
            title="Go up one directory"
            onClick={() => {
              const parent = current.split("/").slice(0, -1).join("/") || "/";
              setCurrent(parent);
              setSelected(null);
              onNavigate(parent);
            }}
          >
            <ChevronUp size={16} />
          </button>
          <button
            className="icon-button"
            aria-label="Refresh listing"
            title="Refresh listing"
            onClick={() => load(current)}
          >
            <RefreshCw size={16} />
          </button>
        </div>
      </header>
      {error && <p className="directory-picker__error">{error}</p>}
      <ul className="directory-picker__list">
        {entries.map((entry) => (
          <li key={entry.path}>
            <button
              type="button"
              className={`directory-row${selected === entry.path ? " is-selected" : ""}`}
              aria-selected={selected === entry.path}
              onClick={() => {
                setCurrent(entry.path);
                setSelected(entry.path);
                onNavigate(entry.path);
              }}
            >
              {selected === entry.path ? <FolderOpen size={16} /> : <Folder size={16} />}
              <span className="directory-row__name">{entry.name}</span>
            </button>
          </li>
        ))}
      </ul>
      <footer className="directory-picker__footer">
        <button
          className="button button--primary"
          disabled={!selected}
          onClick={() => selected && onSelect(selected)}
        >
          <Plus size={16} />
          Create session
        </button>
      </footer>
    </section>
  );
}
