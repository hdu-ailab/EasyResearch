export const normalizeWheelDelta = (input: { deltaY: number; deltaMode: number; rootHeight: number }): number => {
  if (input.deltaMode === 1) return input.deltaY * 40;
  if (input.deltaMode === 2) return input.deltaY * input.rootHeight;
  return input.deltaY;
};

export const shouldMarkBoundaryGesture = (input: {
  delta: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}): boolean => {
  const max = input.scrollHeight - input.clientHeight;
  if (max <= 1) return true;
  if (!input.delta) return false;

  if (input.delta < 0) return input.scrollTop + input.delta <= 0;

  const remaining = max - input.scrollTop;
  return input.delta > remaining;
};

export type ScrollKey = "page-down" | "page-up" | "home" | "end" | "up" | "down";

export const scrollKey = (
  event: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">,
): ScrollKey | undefined => {
  if (event.altKey || event.ctrlKey || event.metaKey) return undefined;
  if (event.shiftKey && event.key !== " ") return undefined;

  switch (event.key) {
    case "PageDown":
      return "page-down";
    case "PageUp":
      return "page-up";
    case "Home":
      return "home";
    case "End":
      return "end";
    case "ArrowUp":
      return "up";
    case "ArrowDown":
      return "down";
    case " ":
      return event.shiftKey ? "page-up" : "page-down";
  }
  return undefined;
};

export function canScrollKey(element: HTMLElement, key: ScrollKey): boolean {
  const up = key === "up" || key === "page-up" || key === "home";
  return up ? element.scrollTop > 0 : element.scrollTop + element.clientHeight < element.scrollHeight;
}

export function scrollKeyOwner(root: HTMLElement, target: EventTarget | null, key: ScrollKey): HTMLElement {
  const element = target instanceof Element ? target : undefined;
  const owner = element?.closest<HTMLElement>("[data-scrollable]");
  if (!owner || owner === root) return root;
  if (!root.contains(owner)) return owner;
  return canScrollKey(owner, key) ? owner : root;
}

export function isScrollKeyTarget(target: EventTarget | null, key: ScrollKey): boolean {
  const element = target instanceof HTMLElement ? target : undefined;
  if (!element) return true;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName) || element.isContentEditable) return false;
  if ((key === "page-up" || key === "page-down") && element.closest('button, a[href], [role="button"]')) return false;
  return true;
}
