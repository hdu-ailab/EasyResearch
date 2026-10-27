import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observerFor } from "../testing/transcriptTest";
import { FileTreeSplit } from "./FileTreeSplit";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.style.removeProperty("user-select");
  document.body.style.removeProperty("overflow");
});

function mountSplit() {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
  const view = render(
    <FileTreeSplit isMobile={false} treeOpened tree={<div>Tree</div>}>
      <iframe title="Report" />
    </FileTreeSplit>,
  );
  const handle = screen.getByRole("separator", { name: "Resize file tree" });
  const area = handle.parentElement!;
  const tree = area.querySelector<HTMLElement>("[data-files-tree]")!;
  const captured = new Set<number>();
  Object.defineProperties(handle, {
    setPointerCapture: { value: (id: number) => captured.add(id) },
    hasPointerCapture: { value: (id: number) => captured.has(id) },
    releasePointerCapture: { value: (id: number) => captured.delete(id) },
  });
  const observer = observerFor(area)!;
  act(() => observer.__fire(700));
  return { ...view, handle, area, tree, observer };
}

describe("file-tree resize iframe ownership", () => {
  it.each([
    "cancel",
    "capture",
    "escape",
    "blur",
    "visibility",
    "collapse",
    "mobile",
    "paneHidden",
    "unmount",
    "buttons",
  ])("restores the pane, style priority and width on %s", (reason) => {
    const view = mountSplit();
    document.body.style.setProperty("user-select", "text", "important");
    document.body.style.setProperty("overflow", "scroll", "important");
    fireEvent.pointerDown(view.handle, { pointerId: 7, clientX: 400, button: 0, isPrimary: true });
    expect(view.handle).toHaveFocus();
    expect(view.area).toHaveAttribute("data-resize-iframe-shield");
    fireEvent.pointerMove(view.handle, { pointerId: 7, clientX: 480, buttons: 1 });
    act(() => vi.advanceTimersToNextFrame());
    expect(view.tree.style.width).toBe("320px");
    fireEvent.pointerMove(view.handle, { pointerId: 7, clientX: 520, buttons: 1 });
    if (reason === "cancel") fireEvent.pointerCancel(view.handle, { pointerId: 7 });
    else if (reason === "capture") fireEvent.lostPointerCapture(view.handle, { pointerId: 7 });
    else if (reason === "escape") fireEvent.keyDown(document, { key: "Escape" });
    else if (reason === "blur") fireEvent(window, new Event("blur"));
    else if (reason === "visibility") {
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      fireEvent(document, new Event("visibilitychange"));
    } else if (reason === "collapse" || reason === "mobile")
      view.rerender(
        <FileTreeSplit isMobile={reason === "mobile"} treeOpened={reason !== "collapse"} tree={<div>Tree</div>}>
          <iframe title="Report" />
        </FileTreeSplit>,
      );
    else if (reason === "paneHidden") act(() => view.observer.__fire(0));
    else if (reason === "unmount") view.unmount();
    else fireEvent.pointerMove(view.handle, { pointerId: 7, clientX: 520, buttons: 0 });
    expect(view.area).not.toHaveAttribute("data-resize-iframe-shield");
    expect(view.handle.hasPointerCapture(7)).toBe(false);
    expect(document.body.style.getPropertyValue("user-select")).toBe("text");
    expect(document.body.style.getPropertyPriority("user-select")).toBe("important");
    expect(document.body.style.getPropertyValue("overflow")).toBe("scroll");
    expect(document.body.style.getPropertyPriority("overflow")).toBe("important");
    act(() => vi.advanceTimersToNextFrame());
    if (reason !== "unmount") expect(view.tree.style.width).toBe(reason === "mobile" ? "" : "240px");
  });

  it("keeps the same shield for replacement frames and ignores foreign pointers before an owned release", () => {
    const view = mountSplit();
    fireEvent.pointerDown(view.handle, { pointerId: 7, clientX: 400, button: 0, isPrimary: true });
    const owner = view.area.getAttribute("data-resize-iframe-shield");
    view.rerender(
      <FileTreeSplit isMobile={false} treeOpened tree={<div>Tree</div>}>
        <iframe key="replacement" title="Replacement" />
      </FileTreeSplit>,
    );
    expect(screen.getByTitle("Replacement").closest("[data-resize-iframe-shield]")).toBe(view.area);
    fireEvent.pointerMove(view.handle, { pointerId: 8, clientX: 600, buttons: 1 });
    fireEvent.pointerUp(view.handle, { pointerId: 8, clientX: 600 });
    fireEvent.pointerCancel(view.handle, { pointerId: 8 });
    fireEvent.lostPointerCapture(view.handle, { pointerId: 8 });
    expect(view.area.getAttribute("data-resize-iframe-shield")).toBe(owner);
    expect(view.tree.style.width).toBe("240px");
    fireEvent.pointerMove(view.handle, { pointerId: 7, clientX: 480, buttons: 1 });
    fireEvent.pointerUp(view.handle, { pointerId: 7, clientX: 490 });
    expect(view.tree.style.width).toBe("330px");
    expect(view.area).not.toHaveAttribute("data-resize-iframe-shield");
    fireEvent.lostPointerCapture(view.handle, { pointerId: 7 });
    act(() => vi.advanceTimersToNextFrame());
    expect(view.tree.style.width).toBe("330px");
    fireEvent.keyDown(view.handle, { key: "ArrowRight" });
    expect(view.tree.style.width).toBe("346px");
  });
});
