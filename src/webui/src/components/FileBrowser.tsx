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

const TREE_MIN_WIDTH = 180;
const TREE_DEFAULT_WIDTH = 240;
const PREVIEW_MIN_WIDTH = 240;
const TREE_RESIZE_STEP = 16;

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
  const [treeWidth, setTreeWidth] = useState(TREE_DEFAULT_WIDTH);
  const [treeSizing, setTreeSizing] = useState(false);
  const [fileAreaWidth, setFileAreaWidth] = useState<number | null>(null);
  const treeOpened = isMobile ? mobileTreeVisible : treeVisible;
  const consumedFileEvents = useRef({ previews: 0, listings: 0, acknowledged: 0 });
  const treeNodeRef = useRef<HTMLDivElement>(null);
  const fileAreaRef = useRef<HTMLDivElement>(null);
  const appliedTreeWidth = useRef<number | null>(null);
  const liveTreeWidth = useRef<number | null>(null);
  const activeTreeResizeCleanup = useRef<(() => void) | null>(null);

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
    const node = fileAreaRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width;
      setFileAreaWidth(width !== undefined && width > 0 ? width : null);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(
    () => () => {
      activeTreeResizeCleanup.current?.();
    },
    [],
  );

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

  const treeMaxWidth = fileAreaWidth === null ? null : Math.max(TREE_MIN_WIDTH, fileAreaWidth - PREVIEW_MIN_WIDTH);
  const clampedTreeWidth = Math.min(Math.max(treeWidth, TREE_MIN_WIDTH), treeMaxWidth ?? Number.POSITIVE_INFINITY);
  const renderedTreeWidth =
    treeSizing && appliedTreeWidth.current !== null ? appliedTreeWidth.current : clampedTreeWidth;
  const keyboardTreeMax = treeMaxWidth ?? Math.max(TREE_DEFAULT_WIDTH * 2, renderedTreeWidth);

  const startTreeResize = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault();
      const handle = event.currentTarget;
      const treeNode = treeNodeRef.current;
      if (!treeNode) return;
      activeTreeResizeCleanup.current?.();
      const startX = event.clientX;
      const startWidth = clampedTreeWidth;
      const measuredArea = fileAreaRef.current?.getBoundingClientRect().width ?? 0;
      const maxWidth =
        treeMaxWidth ??
        (measuredArea > 0 ? Math.max(TREE_MIN_WIDTH, measuredArea - PREVIEW_MIN_WIDTH) : Number.POSITIVE_INFINITY);
      appliedTreeWidth.current = startWidth;
      liveTreeWidth.current = startWidth;
      setTreeSizing(true);
      document.body.style.userSelect = "none";
      let frame: number | null = null;
      let moved = false;
      let released = false;

      const applyWidth = () => {
        frame = null;
        const width = liveTreeWidth.current;
        if (width === null) return;
        appliedTreeWidth.current = width;
        treeNode.style.width = `${width}px`;
        handle.setAttribute("aria-valuenow", String(width));
      };

      const releaseInteraction = () => {
        if (released) return false;
        released = true;
        if (frame !== null) {
          cancelAnimationFrame(frame);
          frame = null;
        }
        document.body.style.userSelect = "";
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", stop);
        document.removeEventListener("pointercancel", cancel);
        activeTreeResizeCleanup.current = null;
        return true;
      };

      const stop = () => {
        if (released) return;
        if (frame !== null) {
          cancelAnimationFrame(frame);
          frame = null;
        }
        const width = liveTreeWidth.current;
        if (moved && width !== null) {
          applyWidth();
          setTreeWidth(width);
        }
        if (!releaseInteraction()) return;
        appliedTreeWidth.current = null;
        liveTreeWidth.current = null;
        setTreeSizing(false);
      };

      const cancel = () => {
        if (frame !== null) {
          cancelAnimationFrame(frame);
          frame = null;
        }
        if (!releaseInteraction()) return;
        appliedTreeWidth.current = startWidth;
        liveTreeWidth.current = startWidth;
        treeNode.style.width = `${startWidth}px`;
        handle.setAttribute("aria-valuenow", String(startWidth));
        appliedTreeWidth.current = null;
        liveTreeWidth.current = null;
        setTreeSizing(false);
      };

      const move = (moveEvent: PointerEvent) => {
        const next = Math.round(Math.min(maxWidth, Math.max(TREE_MIN_WIDTH, startWidth + moveEvent.clientX - startX)));
        liveTreeWidth.current = next;
        moved = true;
        if (frame === null) frame = requestAnimationFrame(applyWidth);
      };

      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", stop);
      document.addEventListener("pointercancel", cancel);
      activeTreeResizeCleanup.current = () => {
        if (!releaseInteraction()) return;
        appliedTreeWidth.current = null;
        liveTreeWidth.current = null;
      };
    },
    [clampedTreeWidth, treeMaxWidth],
  );

  const resizeTreeWithKeyboard = useCallback(
    (event: React.KeyboardEvent) => {
      let next: number | undefined;
      if (event.key === "ArrowRight") next = renderedTreeWidth + TREE_RESIZE_STEP;
      else if (event.key === "ArrowLeft") next = renderedTreeWidth - TREE_RESIZE_STEP;
      else if (event.key === "Home") next = TREE_MIN_WIDTH;
      else if (event.key === "End") next = keyboardTreeMax;
      if (next === undefined) return;
      event.preventDefault();
      setTreeWidth(Math.round(Math.min(keyboardTreeMax, Math.max(TREE_MIN_WIDTH, next))));
    },
    [keyboardTreeMax, renderedTreeWidth],
  );

  return (
    <div ref={fileAreaRef} className="flex h-full min-w-0 flex-col">
      <FileTabs
        tabs={tabs}
        active={isMobile && treeOpened ? null : activeTab}
        onActivate={activateTab}
        onClose={closeTab}
        toggle={{ opened: treeOpened, onToggle: () => (isMobile ? setMobileTreeVisible : setTreeVisible)((v) => !v) }}
      />
      <div className="flex min-h-0 min-w-0 flex-1">
        <div
          ref={treeNodeRef}
          data-files-tree
          hidden={!treeOpened}
          style={!isMobile ? { width: `${renderedTreeWidth}px` } : undefined}
          className={
            !treeOpened
              ? "hidden"
              : isMobile
                ? "flex min-w-0 flex-1 flex-col"
                : "flex min-w-0 shrink-0 flex-col border-r border-v2-grey-200"
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
        {!isMobile && treeOpened ? (
          <hr
            tabIndex={0}
            aria-orientation="vertical"
            aria-label={t("files.resizeTree")}
            aria-valuemin={TREE_MIN_WIDTH}
            aria-valuemax={Math.round(keyboardTreeMax)}
            aria-valuenow={Math.round(renderedTreeWidth)}
            title={t("files.resizeTree")}
            onPointerDown={startTreeResize}
            onKeyDown={resizeTreeWithKeyboard}
            className="-mx-1 h-auto w-2 shrink-0 cursor-col-resize border-0 bg-transparent transition-colors hover:bg-v2-grey-200 focus-visible:bg-v2-blue-600/30"
          />
        ) : null}
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
