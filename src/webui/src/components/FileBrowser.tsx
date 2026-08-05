import { useCallback, useEffect, useState } from "react";
import { FileTabs, FileViewer, type FileTab } from "./FileTabs";
import { FilesPanel } from "./FilesPanel";
import { readFileContent } from "../api";
import type { FileContentDto, FileEntryDto } from "../../../web/contracts";

export interface FileBrowserProps {
  root: string;
}

/**
 * File browser (opencode SessionFileBrowserTab equivalent): file tab bar on
 * top, below a split of the lazy file tree (with filter) and the read-only
 * preview of the active tab. Preview content is fetched once per tab.
 */
export function FileBrowser({ root }: FileBrowserProps) {
  const [tabs, setTabs] = useState<FileTab[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [contents, setContents] = useState<Record<string, FileContentDto>>({});

  useEffect(() => {
    if (!activeTab) return;
    if (contents[activeTab]) return;
    let stale = false;
    readFileContent(activeTab)
      .then((file) => {
        if (!stale) setContents((current) => ({ ...current, [file.path]: file }));
      })
      .catch((e: unknown) => {
        if (!stale) {
          const message = e instanceof Error ? e.message : String(e);
          setContents((current) => ({
            ...current,
            [activeTab]: { path: activeTab, content: `Error: ${message}`, byteCount: 0, truncated: false },
          }));
        }
      });
    return () => {
      stale = true;
    };
  }, [activeTab, contents]);

  const openFile = useCallback((entry: FileEntryDto) => {
    setTabs((current) => (current.some((tab) => tab.path === entry.path) ? current : [...current, entry]));
    setActiveTab(entry.path);
  }, []);

  const closeTab = useCallback((path: string) => {
    setTabs((current) => {
      const next = current.filter((tab) => tab.path !== path);
      setActiveTab((active) => (active === path ? (next.at(-1)?.path ?? null) : active));
      return next;
    });
  }, []);

  return (
    <div className="flex h-full min-w-0 flex-col">
      <FileTabs tabs={tabs} active={activeTab} onActivate={setActiveTab} onClose={closeTab} />
      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="flex w-[240px] shrink-0 flex-col border-r border-v2-grey-200">
          <FilesPanel root={root} onOpenFile={openFile} />
        </div>
        <div className="min-w-0 flex-1">
          {activeTab ? (
            <FileViewer file={contents[activeTab] ?? null} />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              <p className="text-[13px] font-medium text-v2-text-text-base">Open a file</p>
              <p className="text-[12px] text-v2-text-text-faint">Select a file from the tree to preview it.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
