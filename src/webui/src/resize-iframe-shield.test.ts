import { afterEach, expect, it } from "vitest";
import { shieldResizeIframes, suppressResizeSelection } from "./resize-iframe-shield";

afterEach(() => document.body.replaceChildren());

it("keeps nested pane leases independent and restores only the releasing owner's marker", () => {
  const outer = document.createElement("section");
  const inner = document.createElement("div");
  const outside = document.createElement("aside");
  outer.append(inner);
  document.body.append(outer, outside);
  const frame = document.createElement("iframe");
  frame.style.pointerEvents = "auto";
  inner.append(frame);
  const releaseOuter = shieldResizeIframes(outer);
  const releaseInner = shieldResizeIframes(inner);
  const innerOwner = inner.getAttribute("data-resize-iframe-shield");
  expect(innerOwner).toBeTruthy();
  expect(outside.hasAttribute("data-resize-iframe-shield")).toBe(false);
  releaseOuter();
  expect(outer.hasAttribute("data-resize-iframe-shield")).toBe(false);
  expect(inner.getAttribute("data-resize-iframe-shield")).toBe(innerOwner);
  expect(inner.firstChild).toBe(frame);
  expect(frame.style.pointerEvents).toBe("auto");
  releaseInner();
  const releaseNext = shieldResizeIframes(inner);
  const nextOwner = inner.getAttribute("data-resize-iframe-shield");
  expect(nextOwner).not.toBe(innerOwner);
  releaseInner();
  expect(inner.getAttribute("data-resize-iframe-shield")).toBe(nextOwner);
  releaseNext();
  expect(inner.hasAttribute("data-resize-iframe-shield")).toBe(false);
});

it("restores a prior marker and leaves a replacement owner untouched", () => {
  const pane = document.createElement("section");
  pane.setAttribute("data-resize-iframe-shield", "preexisting");
  const release = shieldResizeIframes(pane);
  release();
  expect(pane.getAttribute("data-resize-iframe-shield")).toBe("preexisting");
  const releaseOld = shieldResizeIframes(pane);
  pane.setAttribute("data-resize-iframe-shield", "replacement");
  releaseOld();
  expect(pane.getAttribute("data-resize-iframe-shield")).toBe("replacement");
});

it.each([false, true])("restores selection only after the last owner, in reverse order=%s", (reverse) => {
  const style = document.createElement("div").style;
  style.setProperty("user-select", "text", "important");
  const first = suppressResizeSelection(style);
  const second = suppressResizeSelection(style);
  const releases = reverse ? [second, first] : [first, second];
  expect(style.userSelect).toBe("none");
  releases[0]!();
  expect(style.userSelect).toBe("none");
  // A third owner joins while one of the original gestures is still live.
  const third = suppressResizeSelection(style);
  releases[1]!();
  first();
  second();
  expect(style.userSelect).toBe("none");
  third();
  expect(style.userSelect).toBe("text");
  expect(style.getPropertyPriority("user-select")).toBe("important");

  // A fresh generation captures a fresh baseline; old cleanup cannot decrement it.
  style.setProperty("user-select", "all");
  const next = suppressResizeSelection(style);
  first();
  second();
  third();
  expect(style.userSelect).toBe("none");
  next();
  expect(style.userSelect).toBe("all");
  expect(style.getPropertyPriority("user-select")).toBe("");
});

it("isolates selection leases by body style and restores an originally absent declaration", () => {
  const a = document.implementation.createHTMLDocument().body.style;
  const b = document.implementation.createHTMLDocument().body.style;
  b.setProperty("user-select", "all", "important");
  const releaseA = suppressResizeSelection(a);
  const releaseB = suppressResizeSelection(b);
  releaseA();
  expect(a.userSelect).toBe("");
  expect(b.userSelect).toBe("none");
  releaseB();
  expect(b.userSelect).toBe("all");
  expect(b.getPropertyPriority("user-select")).toBe("important");
});
