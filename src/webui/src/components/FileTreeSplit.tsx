import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/useI18n";
import { useClassicUi } from "../ui-version";

const TREE_MIN_WIDTH = 180;
const TREE_DEFAULT_WIDTH = 240;
const PREVIEW_MIN_WIDTH = 240;
const RESIZE_STEP = 16;

interface TreeDrag {
  handle: HTMLElement;
  pointerId: number;
  startX: number;
  startWidth: number;
  previousWidth: number;
  clientX: number;
  frame: number | null;
  restoreSelection: () => void;
}

interface FileTreeSplitProps {
  isMobile: boolean;
  treeOpened: boolean;
  tree: ReactNode;
  children: ReactNode;
}

// Keeping resize state here lets unchanged tree/preview elements skip drag-frame renders.
export function FileTreeSplit({ isMobile, treeOpened, tree, children }: FileTreeSplitProps) {
  const { t } = useI18n();
  const classic = useClassicUi();
  const areaRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<TreeDrag | null>(null);
  const [treeWidth, setTreeWidth] = useState(TREE_DEFAULT_WIDTH);
  const [areaWidth, setAreaWidth] = useState<number | null>(null);
  const maxWidth =
    areaWidth === null
      ? Math.max(TREE_DEFAULT_WIDTH * 2, treeWidth)
      : Math.max(TREE_MIN_WIDTH, Math.floor(areaWidth) - PREVIEW_MIN_WIDTH);
  const clamp = (width: number) => Math.min(maxWidth, Math.max(TREE_MIN_WIDTH, Math.round(width)));
  const renderedWidth = clamp(treeWidth);

  const releaseDrag = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return null;
    dragRef.current = null;
    if (drag.frame !== null) cancelAnimationFrame(drag.frame);
    drag.restoreSelection();
    if (drag.handle.hasPointerCapture(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId);
    return drag;
  }, []);

  const cancelResize = useCallback(() => {
    const drag = releaseDrag();
    if (drag) setTreeWidth(drag.previousWidth);
  }, [releaseDrag]);

  useLayoutEffect(() => {
    if (isMobile || !treeOpened) cancelResize();
  }, [isMobile, treeOpened, cancelResize]);

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? 0;
      if (width <= 0) cancelResize();
      setAreaWidth(width > 0 ? width : null);
    });
    if (areaRef.current) observer.observe(areaRef.current);
    const visibilityChanged = () => {
      if (document.visibilityState === "hidden") cancelResize();
    };
    window.addEventListener("blur", cancelResize);
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      observer.disconnect();
      window.removeEventListener("blur", cancelResize);
      document.removeEventListener("visibilitychange", visibilityChanged);
      releaseDrag();
    };
  }, [cancelResize, releaseDrag]);

  const startResize = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !event.isPrimary || dragRef.current) return;
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
    handle.focus({ preventScroll: true });
    const style = document.body.style;
    const selection = style.getPropertyValue("user-select");
    const priority = style.getPropertyPriority("user-select");
    dragRef.current = {
      handle,
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: renderedWidth,
      previousWidth: treeWidth,
      clientX: event.clientX,
      frame: null,
      restoreSelection: () => style.setProperty("user-select", selection, priority),
    };
    style.setProperty("user-select", "none");
  };

  const moveResize = (event: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if ((event.buttons & 1) === 0) {
      cancelResize();
      return;
    }
    drag.clientX = event.clientX;
    if (drag.frame !== null) return;
    drag.frame = requestAnimationFrame(() => {
      drag.frame = null;
      if (dragRef.current !== drag) return;
      // Render-time clamping also applies bounds that change after this frame was queued.
      setTreeWidth(drag.startWidth + drag.clientX - drag.startX);
    });
  };

  const stopResize = (event: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    releaseDrag();
    setTreeWidth(
      event.clientX === drag.startX ? drag.previousWidth : clamp(drag.startWidth + event.clientX - drag.startX),
    );
  };

  const cancelPointerResize = (event: React.PointerEvent<HTMLElement>) => {
    if (event.pointerId === dragRef.current?.pointerId) cancelResize();
  };

  const resizeWithKeyboard = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && dragRef.current) {
      event.preventDefault();
      cancelResize();
      return;
    }
    let next: number;
    if (event.key === "ArrowRight") next = renderedWidth + RESIZE_STEP;
    else if (event.key === "ArrowLeft") next = renderedWidth - RESIZE_STEP;
    else if (event.key === "Home") next = TREE_MIN_WIDTH;
    else if (event.key === "End") next = maxWidth;
    else return;
    event.preventDefault();
    cancelResize();
    setTreeWidth(clamp(next));
  };

  return (
    <div ref={areaRef} className="flex min-h-0 min-w-0 flex-1">
      <div
        data-files-tree
        hidden={!treeOpened}
        style={isMobile ? undefined : { width: `${renderedWidth}px` }}
        className={
          !treeOpened
            ? "hidden"
            : isMobile
              ? "flex min-w-0 flex-1 flex-col"
              : classic
                ? "flex min-w-0 shrink-0 flex-col border-r border-v2-grey-200"
                : "flex min-w-0 shrink-0 flex-col border-r border-v2-grey-200/70 bg-v2-background-bg-deep"
        }
      >
        {tree}
      </div>
      {!isMobile && treeOpened && (
        <hr
          tabIndex={0}
          aria-orientation="vertical"
          aria-label={t("files.resizeTree")}
          aria-valuemin={TREE_MIN_WIDTH}
          aria-valuemax={maxWidth}
          aria-valuenow={renderedWidth}
          title={t("files.resizeTree")}
          onPointerDown={startResize}
          onPointerMove={moveResize}
          onPointerUp={stopResize}
          onPointerCancel={cancelPointerResize}
          onLostPointerCapture={cancelPointerResize}
          onKeyDown={resizeWithKeyboard}
          className="relative z-10 -mx-1 h-auto w-2 shrink-0 touch-none cursor-col-resize border-0 bg-transparent transition-colors hover:bg-v2-grey-200 focus-visible:bg-v2-blue-600/30"
        />
      )}
      <div hidden={isMobile && treeOpened} className={isMobile && treeOpened ? "hidden" : "min-w-0 flex-1"}>
        {children}
      </div>
    </div>
  );
}
