import { type RefObject, useCallback, useRef } from "react";
import { shouldMarkBoundaryGesture } from "./scrollGesture";

/**
 * Port of opencode `session.tsx` `markScrollGesture`/`hasScrollGesture` plus
 * the `markBoundaryGesture` wheel logic from `message-timeline.tsx`.
 *
 * A "scroll gesture" is any disengaged user input that warrants pausing the
 * auto-scroll follower: wheel/trackpad, pointer press or drag, touch, or a
 * scroll key. Gestures targeting a nested `[data-scrollable]` region are
 * ignored unless the wheel reaches that region's boundary, so scrolling
 * inside a tool output never unpins the transcript follower.
 */
export function useScrollGesture(scrollRef: RefObject<HTMLDivElement | null>, windowMs = 250) {
  const lastGestureRef = useRef(0);

  /** session.tsx `markScrollGesture`: ignore targets inside nested scrollers. */
  const markScrollGesture = useCallback(
    (target?: EventTarget | null) => {
      const root = scrollRef.current;
      if (!root) return;
      const el = target instanceof Element ? target : undefined;
      const nested = el?.closest("[data-scrollable]");
      if (nested && nested !== root) return;
      lastGestureRef.current = Date.now();
    },
    [scrollRef],
  );

  /** Wheel boundary math: only arm when the gesture hits a nested boundary or the root itself. */
  const markBoundaryWheel = useCallback(
    (target: EventTarget | null, delta: number) => {
      const root = scrollRef.current;
      if (!root) return;
      const el = target instanceof Element ? target : undefined;
      const nested = el?.closest<HTMLElement>("[data-scrollable]");
      if (!nested || nested === root) {
        markScrollGesture(root);
        return;
      }
      if (
        shouldMarkBoundaryGesture({
          delta,
          scrollTop: nested.scrollTop,
          scrollHeight: nested.scrollHeight,
          clientHeight: nested.clientHeight,
        })
      ) {
        markScrollGesture(root);
      }
    },
    [markScrollGesture, scrollRef],
  );

  const hasScrollGesture = useCallback(() => {
    return Date.now() - lastGestureRef.current < windowMs;
  }, [windowMs]);

  return { markScrollGesture, markBoundaryWheel, hasScrollGesture };
}
