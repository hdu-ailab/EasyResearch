import { act } from "@testing-library/react";

export interface FakeRO {
  __fire: (width: number) => void;
  __fireEntries: (entries: ResizeObserverEntry[]) => void;
  __observed: Element[];
  disconnect: () => void;
}

const fakeRO = () => (globalThis as unknown as { FakeResizeObserver: { instances: FakeRO[] } }).FakeResizeObserver;

/** The ResizeObserver observing a specific element, if any. */
export function observerFor(target: Element): FakeRO | undefined {
  return allObservers().find((observer) => observer.__observed.includes(target));
}

/** Every ResizeObserver constructed so far in this test run. */
export function allObservers(): FakeRO[] {
  return fakeRO().instances;
}

/**
 * Stub scroll/layout metrics on the transcript scroll container. jsdom reports
 * zeroes for everything; the virtualizer and the auto-scroll state machine
 * read these getters.
 */
export function metricStub(
  el: HTMLElement,
  options: { scrollHeight?: number; clientHeight?: number; scrollTop?: number } = {},
) {
  const clientHeight = options.clientHeight ?? 10000;
  const scrollHeight = options.scrollHeight ?? 10000;
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => clientHeight });
  Object.defineProperty(el, "offsetHeight", { configurable: true, get: () => clientHeight });
  Object.defineProperty(el, "offsetWidth", { configurable: true, get: () => 800 });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => (el as HTMLElement & { __scrollTop?: number }).__scrollTop ?? 0,
    set: (value: number) => {
      (el as HTMLElement & { __scrollTop?: number }).__scrollTop = value;
    },
  });
  if (options.scrollTop !== undefined) {
    (el as HTMLElement & { __scrollTop?: number }).__scrollTop = options.scrollTop;
  }
}

const conversationSection = (container: HTMLElement): HTMLDivElement | undefined =>
  container.querySelector<HTMLDivElement>('[aria-label="Conversation"]') ?? undefined;

const contentDiv = (container: HTMLElement): HTMLElement | undefined => {
  const section = conversationSection(container);
  return section?.querySelector<HTMLElement>(".relative.mx-auto.w-full") ?? undefined;
};

/**
 * Make the virtualized transcript render rows under jsdom: give the scroll
 * container real metrics and push the virtualizer's viewport rect to it.
 * Uses a huge viewport so every row (not just the windowed tail) is in the
 * DOM, keeping text queries stable across tests.
 */
export function hydrateTranscript(container: HTMLElement) {
  const section = conversationSection(container);
  if (!section) return;
  const rectObserver = allObservers().find((observer) => observer.__observed.includes(section));
  act(() => {
    metricStub(section);
    rectObserver?.__fireEntries([
      {
        target: section,
        borderBoxSize: [{ inlineSize: 800, blockSize: 10000 }],
      } as unknown as ResizeObserverEntry,
    ]);
    // Reset the virtualizer's cached scroll offset to the top so the whole
    // list falls inside the (huge) viewport.
    section.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
}

/**
 * The ResizeObserver that watches the transcript content div for growth
 * (useAutoScroll's content observer). Firing it simulates streamed content
 * growth in tests.
 */
export function transcriptContentObserver(container: HTMLElement): FakeRO | undefined {
  const content = contentDiv(container);
  if (!content) return undefined;
  return allObservers().find((observer) => observer.__observed.includes(content));
}

/** Pin the transcript to the bottom via a content-growth notification. */
export function fireTranscriptGrowth(container: HTMLElement) {
  const observer = transcriptContentObserver(container);
  if (!observer) return;
  act(() => observer.__fireEntries([]));
}

/** An upward wheel gesture over the scroll container (stops following). */
export function wheelUp(section: HTMLElement) {
  const event = new WheelEvent("wheel", { deltaY: -120, bubbles: true, cancelable: true });
  section.dispatchEvent(event);
}

/** Set the transcript container metrics to a small scrollable viewport. */
export function smallTranscript(container: HTMLElement, scrollHeight = 400) {
  const section = conversationSection(container);
  if (!section) return;
  act(() => metricStub(section, { scrollHeight, clientHeight: 200 }));
}
