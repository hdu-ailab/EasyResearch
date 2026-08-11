import { useCallback, useEffect, useState } from "react";
import type { FileContentDto, FileEntryDto } from "../../../web/contracts";
import { readFileContent } from "../api";
import { useI18n } from "../i18n/useI18n";
import { FilesPanel } from "./FilesPanel";
import { type FileTab, FileTabs } from "./FileTabs";
import { FilePreview } from "./previews/FilePreview";

export interface FileBrowserProps {
  root: string;
}

const PDF_RE = /\.pdf$/i;

function entryName(path: string): string {
  return path.split("/").at(-1) ?? path;
}

/**
 * File browser (opencode SessionFileBrowserTab equivalent): file tab bar on
 * top, below a split of the lazy file tree (with filter) and the content-aware
 * preview of the active tab. Markdown/text preview content is fetched once per
 * tab; PDF previews stream the raw bytes and never fetch the bounded text
 * route.
 */
export function FileBrowser({ root }: FileBrowserProps) {
  const { t } = useI18n();
  const [tabs, setTabs] = useState<FileTab[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [contents, setContents] = useState<Record<string, FileContentDto>>({});
  const [treeVisible, setTreeVisible] = useState(true);

  useEffect(() => {
    if (!activeTab) return;
    if (contents[activeTab]) return;
    if (PDF_RE.test(activeTab)) {
      setContents((current) => ({
        ...current,
        [activeTab]: { path: activeTab, content: "", byteCount: 0, truncated: false, binary: false },
      }));
      return;
    }
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
            [activeTab]: {
              path: activeTab,
              content: t("files.loadError").replace("{message}", message),
              byteCount: 0,
              truncated: false,
              binary: false,
            },
          }));
        }
      });
    return () => {
      stale = true;
    };
  }, [activeTab, contents, t]);

  const openFile = useCallback((entry: FileEntryDto) => {
    setTabs((current) => (current.some((tab) => tab.path === entry.path) ? current : [...current, entry]));
    setActiveTab(entry.path);
  }, []);

  const openPath = useCallback(
    (path: string) => {
      openFile({ kind: "file", path, name: entryName(path) });
    },
    [openFile],
  );

  const closeTab = useCallback((path: string) => {
    setTabs((current) => {
      const next = current.filter((tab) => tab.path !== path);
      setActiveTab((active) => (active === path ? (next.at(-1)?.path ?? null) : active));
      return next;
    });
  }, []);

  return (
    <div className="flex h-full min-w-0 flex-col">
      <FileTabs
        tabs={tabs}
        active={activeTab}
        onActivate={setActiveTab}
        onClose={closeTab}
        toggle={{ opened: treeVisible, onToggle: () => setTreeVisible((v) => !v) }}
      />
      <div className="flex min-h-0 min-w-0 flex-1">
        <div className={treeVisible ? "flex w-[240px] shrink-0 flex-col border-r border-v2-grey-200" : "hidden"}>
          <FilesPanel root={root} onOpenFile={openFile} />
        </div>
        <div className="min-w-0 flex-1">
          {activeTab ? (
            <FilePreview path={activeTab} textFile={contents[activeTab] ?? null} onOpenFile={openPath} />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              <p className="text-[13px] font-medium text-v2-text-text-base">{t("files.emptyTitle")}</p>
              <p className="text-[12px] text-v2-text-text-faint">{t("files.emptyHint")}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
