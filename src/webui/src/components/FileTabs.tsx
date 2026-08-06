import { File as FileIcon, FolderTree, X } from "lucide-react";
import type { FileContentDto } from "../../../web/contracts";

export interface FileTab {
  path: string;
  name: string;
}

export interface FileTabsProps {
  tabs: FileTab[];
  active: string | null;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
  toggle?: { opened: boolean; onToggle: () => void };
}

export function FileTabs({ tabs, active, onActivate, onClose, toggle }: FileTabsProps) {
  return (
    <div
      className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-v2-grey-200 px-1.5 py-1"
      role="tablist"
      aria-label="Open files"
    >
      {toggle && (
        <div className="sticky left-0 z-10 shrink-0 bg-v2-background-bg-base">
          <button
            type="button"
            className="flex size-7 shrink-0 items-center justify-center rounded text-v2-icon-icon-muted transition-colors hover:bg-v2-grey-100"
            aria-label="Toggle file tree"
            title="Toggle file tree"
            aria-expanded={toggle.opened}
            data-expanded={toggle.opened}
            onClick={toggle.onToggle}
          >
            <FolderTree size={14} />
          </button>
        </div>
      )}
      {tabs.map((tab) => {
        const isActive = active === tab.path;
        return (
          <div
            key={tab.path}
            role="tab"
            aria-selected={isActive}
            className={`group flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px] transition-colors ${
              isActive ? "bg-v2-blue-100 text-v2-blue-600" : "text-v2-text-text-muted hover:bg-v2-grey-100"
            }`}
          >
            <button type="button" className="flex min-w-0 items-center gap-1" onClick={() => onActivate(tab.path)} title={tab.path}>
              <FileIcon size={12} className="shrink-0" />
              <span className="max-w-[160px] truncate">{tab.name}</span>
            </button>
            <button
              type="button"
              className="flex size-4 shrink-0 items-center justify-center rounded text-v2-text-text-faint opacity-0 transition-opacity hover:bg-v2-grey-200 hover:text-v2-text-text-base group-hover:opacity-100"
              aria-label={`Close ${tab.name}`}
              title="Close"
              onClick={() => onClose(tab.path)}
            >
              <X size={11} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function FileViewer({ file }: { file: FileContentDto | null }) {
  if (!file) return <p className="p-3 text-[12px] text-v2-text-text-faint">Loading…</p>;
  return (
    <div className="flex h-full min-w-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-v2-grey-200 px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-v2-text-text-muted" title={file.path}>
          {file.path}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-v2-text-text-faint">{file.byteCount} bytes</span>
      </header>
      {file.truncated && (
        <p className="shrink-0 border-b border-v2-grey-200 bg-v2-status-warning/10 px-3 py-1 text-[12px] text-v2-status-warning">
          File preview truncated to the first 1 MiB.
        </p>
      )}
      <pre className="min-h-0 flex-1 overflow-auto p-3 font-mono text-[12px] leading-[1.5] text-v2-text-text-base whitespace-pre">
        {file.content}
      </pre>
    </div>
  );
}
