import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export interface UseAutoScrollOptions {
  /** While true the scroll area is actively being written to (streaming). */
  working: boolean;
  onUserInteracted?: () => void;
  bottomThreshold?: number;
  /** OpenCode's default is "dynamic"; EasyResearch uses "dynamic" too. */
  overflowAnchor?: "none" | "auto" | "dynamic";
}

export interface AutoScrollController {
  scrollRef: (el: HTMLElement | null | undefined) => void;
  contentRef: (el: HTMLElement | null | undefined) => void;
  handleScroll: () => void;
  handleWheel: (event: WheelEvent) => void;
  handleInteraction: () => void;
  pause: () => void;
  resume: () => void;
  /** Optional force flag mirrors the internal two-arg form; default false. */
  scrollToBottom: (force?: boolean) => void;
  forceScrollToBottom: () => void;
  userScrolled: () => boolean;
}

const AUTO_GUARD_MS = 1500;
const SETTLING_MS = 300;

/**
 * Port of opencode (anomalyco/opencode) `packages/ui/src/hooks/create-auto-scroll.tsx`.
 *
 * The transcript pins to the bottom while the user stays there; any disengaged
 * gesture unpins immediately and every later passive content change preserves
 * the reading position. Programmatic scrolls are guarded with a 1500ms `markAuto`
 * window so the browser's async `scroll` events are not mistaken for the user.
 */
export function useAutoScroll(options: UseAutoScrollOptions): AutoScrollController {
  const { working, bottomThreshold = 10, overflowAnchor = "dynamic" } = options;
  const onUserInteractedRef = useRef(options.onUserInteracted);
  onUserInteractedRef.current = options.onUserInteracted;
  const workingRef = useRef(working);
  workingRef.current = working;

  const [scrollElement, setScrollElement] = useState<HTMLElement | undefined>(undefined);
  const [contentElement, setContentElement] = useState<HTMLElement | undefined>(undefined);
  const [userScrolled, setUserScrolledState] = useState(false);
  const userScrolledRef = useRef(false);

  const setUserScrolled = useCallback((next: boolean) => {
    userScrolledRef.current = next;
    setUserScrolledState(next);
  }, []);

  const settlingRef = useRef(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const autoTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const autoRef = useRef<{ top: number; time: number } | undefined>(undefined);

  const active = useCallback(() => workingRef.current || settlingRef.current, []);

  const distanceFromBottom = useCallback((el: HTMLElement) => {
    return el.scrollHeight - el.clientHeight - el.scrollTop;
  }, []);

  const canScroll = useCallback((el: HTMLElement) => {
    return el.scrollHeight - el.clientHeight > 1;
  }, []);

  const markAuto = useCallback((el: HTMLElement) => {
    autoRef.current = {
      top: Math.max(0, el.scrollHeight - el.clientHeight),
      time: Date.now(),
    };
    if (autoTimer.current) clearTimeout(autoTimer.current);
    autoTimer.current = setTimeout(() => {
      autoRef.current = undefined;
      autoTimer.current = undefined;
    }, AUTO_GUARD_MS);
  }, []);

  const isAuto = useCallback((el: HTMLElement) => {
    const entry = autoRef.current;
    if (!entry) return false;
    if (Date.now() - entry.time > AUTO_GUARD_MS) {
      autoRef.current = undefined;
      return false;
    }
    return Math.abs(el.scrollTop - entry.top) < 2;
  }, []);

  const scrollToBottomNow = useCallback(
    (behavior: ScrollBehavior) => {
      const el = scrollElement;
      if (!el) return;
      markAuto(el);
      if (behavior === "smooth") {
        el.scrollTo({ top: el.scrollHeight, behavior });
        return;
      }
      el.scrollTop = el.scrollHeight;
    },
    [markAuto, scrollElement],
  );

  const scrollToBottom = useCallback(
    (force: boolean) => {
      if (!force && !active()) return;
      if (force && userScrolledRef.current) setUserScrolled(false);

      const el = scrollElement;
      if (!el) return;
      if (!force && userScrolledRef.current) return;

      const distance = distanceFromBottom(el);
      if (distance < 2) {
        markAuto(el);
        return;
      }
      scrollToBottomNow("auto");
    },
    [active, distanceFromBottom, markAuto, scrollElement, scrollToBottomNow, setUserScrolled],
  );

  const stop = useCallback(() => {
    const el = scrollElement;
    if (!el) return;
    if (!canScroll(el)) {
      if (userScrolledRef.current) setUserScrolled(false);
      return;
    }
    if (userScrolledRef.current) return;

    setUserScrolled(true);
    onUserInteractedRef.current?.();
  }, [canScroll, scrollElement, setUserScrolled]);

  const handleWheel = useCallback(
    (event: WheelEvent) => {
      if (event.deltaY >= 0) return;
      const el = scrollElement;
      const target = event.target instanceof Element ? event.target : undefined;
      const nested = target?.closest("[data-scrollable]");
      if (el && nested && nested !== el) return;
      stop();
    },
    [scrollElement, stop],
  );

  const handleScroll = useCallback(() => {
    const el = scrollElement;
    if (!el) return;

    if (!canScroll(el)) {
      if (userScrolledRef.current) setUserScrolled(false);
      return;
    }

    if (distanceFromBottom(el) < bottomThreshold) {
      if (userScrolledRef.current) setUserScrolled(false);
      return;
    }

    if (!userScrolledRef.current && isAuto(el)) {
      scrollToBottom(false);
      return;
    }

    stop();
  }, [bottomThreshold, canScroll, distanceFromBottom, isAuto, scrollElement, scrollToBottom, setUserScrolled, stop]);

  const handleInteraction = useCallback(() => {
    if (!active()) return;
    const selection = window.getSelection();
    if (selection && selection.toString().length > 0) stop();
  }, [active, stop]);

  // Wheel listener on the scroll element (opencode uses an inline passive listener).
  useEffect(() => {
    const el = scrollElement;
    if (!el) return;
    el.addEventListener("wheel", handleWheel, { passive: true });
    return () => el.removeEventListener("wheel", handleWheel);
  }, [handleWheel, scrollElement]);

  // Observe content growth and pin to the bottom in the same frame while pinned.
  useEffect(() => {
    const content = contentElement;
    if (!content) return;
    const observer = new ResizeObserver(() => {
      const el = scrollElement;
      if (el && !canScroll(el)) {
        if (userScrolledRef.current) setUserScrolled(false);
        return;
      }
      if (!active()) return;
      if (userScrolledRef.current) return;
      scrollToBottom(false);
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [active, canScroll, contentElement, scrollElement, scrollToBottom, setUserScrolled]);

  // Working transitions: force to bottom on start; keep a settling window on end.
  useEffect(() => {
    settlingRef.current = false;
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = undefined;

    if (working) {
      if (!userScrolledRef.current) scrollToBottom(true);
      return;
    }

    settlingRef.current = true;
    settleTimer.current = setTimeout(() => {
      settlingRef.current = false;
    }, SETTLING_MS);
  }, [working, scrollToBottom]);

  // Track userScrolled even before scrollRef attaches so anchoring updates once it exists.
  useLayoutEffect(() => {
    const el = scrollElement;
    if (!el) return;
    const current = userScrolled;
    if (overflowAnchor === "none") {
      el.style.overflowAnchor = "none";
    } else if (overflowAnchor === "auto") {
      el.style.overflowAnchor = "auto";
    } else {
      el.style.overflowAnchor = current ? "auto" : "none";
    }
  }, [overflowAnchor, scrollElement, userScrolled]);

  useEffect(() => {
    return () => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
      if (autoTimer.current) clearTimeout(autoTimer.current);
    };
  }, []);

  const setScrollRef = useCallback((el: HTMLElement | null | undefined) => {
    setScrollElement(el ?? undefined);
  }, []);

  const setContentRef = useCallback((el: HTMLElement | null | undefined) => {
    setContentElement(el ?? undefined);
  }, []);

  const resume = useCallback(() => {
    if (userScrolledRef.current) setUserScrolled(false);
    scrollToBottom(true);
  }, [scrollToBottom, setUserScrolled]);

  return {
    scrollRef: setScrollRef,
    contentRef: setContentRef,
    handleScroll,
    handleWheel,
    handleInteraction,
    pause: stop,
    resume,
    scrollToBottom: useCallback((force?: boolean) => scrollToBottom(force ?? false), [scrollToBottom]),
    forceScrollToBottom: useCallback(() => scrollToBottom(true), [scrollToBottom]),
    userScrolled: useCallback(() => userScrolledRef.current, []),
  };
}
