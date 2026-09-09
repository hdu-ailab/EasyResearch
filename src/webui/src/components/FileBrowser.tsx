import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { FileContentDto, FileEntryDto } from "../../../web/contracts";
import { readFileContent } from "../api";
import { EMPTY_FILE_EVENTS, parentPath, type QueuedFileWatcherEvent } from "../file-watcher";
import { filesystemPathName } from "../filesystem-path";
import { useI18n } from "../i18n/useI18n";
import { FilesPanel } from "./FilesPanel";
import { type FileTab, FileTabs } from "./FileTabs";
import { FilePreview } from "./previews/FilePreview";
import { previewKind } from "./previews/preview-kind";

export interface FileBrowserProps {
  root: string;
  loadEnabled?: boolean;
  sessionId?: string;
  fileWatchLeaseId?: string | null;
  fileEvents?: readonly QueuedFileWatcherEvent[];
  onFileEventsConsumed?: (through: number) => void;
}

/**
 * File browser (opencode SessionFileBrowserTab equivalent): file tab bar on
 * top, below a split of the lazy file tree (with filter) and the content-aware
 * preview of the active tab. Markdown/text preview content is fetched once per
 * tab; PDF previews stream the raw bytes and never fetch the bounded text
 * route.
 */
export const FileBrowser = memo(function FileBrowser({
  root,
  loadEnabled = true,
  sessionId,
  fileWatchLeaseId,
  fileEvents = EMPTY_FILE_EVENTS,
  onFileEventsConsumed,
}: FileBrowserProps) {
  const { t } = useI18n();
  const [tabs, setTabs] = useState<FileTab[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [contents, setContents] = useState<Record<string, FileContentDto>>({});
  const [contentRevision, setContentRevision] = useState<Record<string, number>>({});
  const [treeVisible, setTreeVisible] = useState(true);
  const [mobileTreeVisible, setMobileTreeVisible] = useState(true);
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 820);
  const treeOpened = isMobile ? mobileTreeVisible : treeVisible;
  const consumedFileEvents = useRef({ previews: 0, listings: 0, acknowledged: 0 });

  const consumeFileEvents = useCallback(
    (consumer: "previews" | "listings", through: number) => {
      const consumed = consumedFileEvents.current;
      consumed[consumer] = Math.max(consumed[consumer], through);
      // Both consumers must own the invalidations before Work can release the queue prefix.
      const acknowledged = Math.min(consumed.previews, consumed.listings);
      if (acknowledged <= consumed.acknowledged) return;
      consumed.acknowledged = acknowledged;
      onFileEventsConsumed?.(acknowledged);
    },
    [onFileEventsConsumed],
  );
  const consumeListingEvents = useCallback(
    (through: number) => consumeFileEvents("listings", through),
    [consumeFileEvents],
  );

  useEffect(() => {
    const resize = () => setIsMobile(window.innerWidth < 820);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  useEffect(() => {
    if (!loadEnabled) return;
    const pending = fileEvents.filter((entry) => entry.sequence > consumedFileEvents.current.previews);
    const through = pending.at(-1)?.sequence;
    if (through === undefined) return;
    const affected = tabs
      .filter(
        (tab) =>
          previewKind(tab.path) !== "pdf" &&
          pending.some(
            ({ event }) => tab.path === event.properties.file || parentPath(tab.path) === event.properties.file,
          ),
      )
      .map((tab) => tab.path);
    if (affected.length > 0) {
      setContents((current) => {
        if (!affected.some((candidate) => candidate in current)) return current;
        const next = { ...current };
        for (const candidate of affected) delete next[candidate];
        return next;
      });
      setContentRevision((current) => {
        const next = { ...current };
        for (const candidate of affected) next[candidate] = (current[candidate] ?? 0) + 1;
        return next;
      });
    }
    consumeFileEvents("previews", through);
  }, [consumeFileEvents, fileEvents, loadEnabled, tabs]);

  const activeRevision = activeTab ? (contentRevision[activeTab] ?? 0) : 0;
  const activeContent = activeTab ? contents[activeTab] : undefined;

  useEffect(() => {
    // A watcher revision also supersedes a read whose content has not arrived yet.
    void activeRevision;
    if (!activeTab) return;
    if (activeContent) return;
    const kind = previewKind(activeTab);
    if (kind === "pdf" || kind === "docx") {
      setContents((current) => ({
        ...current,
        [activeTab]: { path: activeTab, content: "", byteCount: 0, truncated: false, binary: false },
      }));
      return;
    }
    let stale = false;
    readFileContent(activeTab)
      .then((file) => {
        if (!stale) {
          setContents((current) => ({ ...current, [activeTab]: file }));
        }
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
  }, [activeTab, activeRevision, activeContent, t]);

  const activateTab = useCallback((path: string) => {
    setActiveTab(path);
    setMobileTreeVisible(false);
  }, []);

  const openFile = useCallback(
    (entry: FileEntryDto) => {
      setTabs((current) => (current.some((tab) => tab.path === entry.path) ? current : [...current, entry]));
      activateTab(entry.path);
    },
    [activateTab],
  );

  const openPath = useCallback(
    (path: string) => {
      openFile({ kind: "file", path, name: filesystemPathName(path) });
    },
    [openFile],
  );

  const closeTab = useCallback(
    (path: string) => {
      const index = tabs.findIndex((tab) => tab.path === path);
      const next = tabs.filter((tab) => tab.path !== path);
      setTabs(next);
      setActiveTab((active) => (active === path ? (next[Math.min(index, next.length - 1)]?.path ?? null) : active));
      if (next.length === 0) setMobileTreeVisible(true);
      setContents((current) => {
        const next = { ...current };
        delete next[path];
        return next;
      });
      setContentRevision((current) => {
        const next = { ...current };
        delete next[path];
        return next;
      });
    },
    [tabs],
  );

  return (
    <div className="flex h-full min-w-0 flex-col">
      <FileTabs
        tabs={tabs}
        active={isMobile && treeOpened ? null : activeTab}
        onActivate={activateTab}
        onClose={closeTab}
        toggle={{ opened: treeOpened, onToggle: () => (isMobile ? setMobileTreeVisible : setTreeVisible)((v) => !v) }}
      />
      <div className="flex min-h-0 min-w-0 flex-1">
        <div
          hidden={!treeOpened}
          className={
            !treeOpened
              ? "hidden"
              : isMobile
                ? "flex min-w-0 flex-1 flex-col"
                : "flex w-[240px] shrink-0 flex-col border-r border-v2-grey-200"
          }
        >
          <FilesPanel
            root={root}
            loadEnabled={loadEnabled}
            sessionId={sessionId}
            fileWatchLeaseId={fileWatchLeaseId}
            onOpenFile={openFile}
            fileEvents={fileEvents}
            onFileEventsConsumed={consumeListingEvents}
          />
        </div>
        <div hidden={isMobile && treeOpened} className={isMobile && treeOpened ? "hidden" : "min-w-0 flex-1"}>
          {activeTab ? (
            <FilePreview
              path={activeTab}
              revision={activeRevision}
              textFile={contents[activeTab] ?? null}
              onOpenFile={openPath}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-center">
              <p className="text-[13px] font-medium text-v2-text-text-base">{t("files.emptyTitle")}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
