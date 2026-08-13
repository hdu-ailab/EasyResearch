import { describe, expect, it } from "vitest";
import {
  canScrollKey,
  isScrollKeyTarget,
  normalizeWheelDelta,
  scrollKey,
  scrollKeyOwner,
  shouldMarkBoundaryGesture,
} from "./scrollGesture";

describe("normalizeWheelDelta", () => {
  it("passes through pixel deltaMode unmodified", () => {
    expect(normalizeWheelDelta({ deltaY: 120, deltaMode: 0, rootHeight: 800 })).toBe(120);
  });

  it("multiplies line deltaMode by 40", () => {
    expect(normalizeWheelDelta({ deltaY: 3, deltaMode: 1, rootHeight: 800 })).toBe(120);
  });

  it("multiplies page deltaMode by root height", () => {
    expect(normalizeWheelDelta({ deltaY: 1.5, deltaMode: 2, rootHeight: 800 })).toBe(1200);
  });
});

describe("shouldMarkBoundaryGesture", () => {
  const base = { scrollHeight: 1000, clientHeight: 200 };

  it("marks when the container cannot scroll", () => {
    expect(shouldMarkBoundaryGesture({ delta: 0, scrollTop: 0, scrollHeight: 0, clientHeight: 100 })).toBe(true);
  });

  it("does not mark a zero delta", () => {
    expect(shouldMarkBoundaryGesture({ delta: 0, scrollTop: 0, ...base })).toBe(false);
  });

  it("marks only when an upward wheel pushes past the top", () => {
    expect(shouldMarkBoundaryGesture({ delta: -50, scrollTop: 0, ...base })).toBe(true);
    expect(shouldMarkBoundaryGesture({ delta: -50, scrollTop: 200, ...base })).toBe(false);
  });

  it("keeps marking when up-scroll is still at the top edge", () => {
    expect(shouldMarkBoundaryGesture({ delta: -50, scrollTop: 30, ...base })).toBe(true);
  });

  it("marks only when a downward wheel pushes past the bottom", () => {
    const max = 800;
    expect(shouldMarkBoundaryGesture({ delta: 50, scrollTop: max, ...base })).toBe(true);
    expect(shouldMarkBoundaryGesture({ delta: 50, scrollTop: max - 100, ...base })).toBe(false);
  });

  it("does not mark a downward delta that stays within range", () => {
    expect(shouldMarkBoundaryGesture({ delta: 10, scrollTop: 100, ...base })).toBe(false);
  });
});

const element = (scrollTop: number, clientHeight = 100, scrollHeight = 150): HTMLElement => {
  const el = document.createElement("div");
  Object.defineProperty(el, "scrollTop", { configurable: true, get: () => scrollTop });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => clientHeight });
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => scrollHeight });
  return el;
};

describe("scrollKey", () => {
  const key = (partial: Partial<KeyboardEvent>) =>
    scrollKey({
      key: "PageDown",
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      ...partial,
    });

  it("recognizes page, home, end, arrow, and space keys", () => {
    expect(key({ key: "PageDown" })).toBe("page-down");
    expect(key({ key: "PageUp" })).toBe("page-up");
    expect(key({ key: "Home" })).toBe("home");
    expect(key({ key: "End" })).toBe("end");
    expect(key({ key: "ArrowUp" })).toBe("up");
    expect(key({ key: "ArrowDown" })).toBe("down");
    expect(key({ key: " " })).toBe("page-down");
  });

  it("ignores modifier combinations except Shift+Space", () => {
    expect(key({ key: "PageDown", altKey: true })).toBeUndefined();
    expect(key({ key: "End", ctrlKey: true })).toBeUndefined();
    expect(key({ key: "ArrowUp", metaKey: true })).toBeUndefined();
    expect(key({ key: "End", shiftKey: true })).toBeUndefined();
    expect(key({ key: " ", shiftKey: true })).toBe("page-up");
  });
});

describe("canScrollKey", () => {
  it("is false for up-keys already at the top", () => {
    expect(canScrollKey(element(0), "page-up")).toBe(false);
    expect(canScrollKey(element(0), "home")).toBe(false);
    expect(canScrollKey(element(0), "up")).toBe(false);
  });

  it("is true for up-keys when scrolled down", () => {
    expect(canScrollKey(element(50), "page-up")).toBe(true);
  });

  it("is false for down-keys already at the bottom", () => {
    expect(canScrollKey(element(50), "page-down")).toBe(false);
    expect(canScrollKey(element(50), "down")).toBe(false);
    expect(canScrollKey(element(50), "end")).toBe(false);
  });

  it("is true for down-keys when not at the bottom", () => {
    expect(canScrollKey(element(20), "page-down")).toBe(true);
    expect(canScrollKey(element(0, 100, 1000), "down")).toBe(true);
  });
});

describe("scrollKeyOwner", () => {
  it("returns the root when the target has no nested scroller", () => {
    const root = element(0);
    const target = document.createElement("div");
    root.appendChild(target);
    expect(scrollKeyOwner(root, target, "page-down")).toBe(root);
  });

  it("returns the nested scroller when it can scroll", () => {
    const root = element(0);
    const nested = element(10, 100, 500);
    nested.setAttribute("data-scrollable", "");
    const target = document.createElement("div");
    root.appendChild(nested);
    nested.appendChild(target);
    expect(scrollKeyOwner(root, target, "page-down")).toBe(nested);
  });

  it("falls back to the root when the nested scroller cannot scroll", () => {
    const root = element(0);
    const nested = element(400, 100, 400);
    nested.setAttribute("data-scrollable", "");
    const target = document.createElement("div");
    root.appendChild(nested);
    nested.appendChild(target);
    expect(scrollKeyOwner(root, target, "page-down")).toBe(root);
  });
});

describe("isScrollKeyTarget", () => {
  it("allows non-interactive targets", () => {
    expect(isScrollKeyTarget(element(0), "page-down")).toBe(true);
  });

  it("rejects editable targets", () => {
    const input = document.createElement("input");
    expect(isScrollKeyTarget(input, "page-down")).toBe(false);
    const textarea = document.createElement("textarea");
    expect(isScrollKeyTarget(textarea, "page-up")).toBe(false);
  });

  it("rejects page keys targeted inside buttons/links", () => {
    const button = document.createElement("button");
    expect(isScrollKeyTarget(button, "page-up")).toBe(false);
    const link = document.createElement("a");
    link.href = "#";
    expect(isScrollKeyTarget(link, "page-down")).toBe(false);
  });

  it("allows arrow keys inside buttons", () => {
    const button = document.createElement("button");
    expect(isScrollKeyTarget(button, "up")).toBe(true);
  });
});
