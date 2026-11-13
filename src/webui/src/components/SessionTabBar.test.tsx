import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useId, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeSessionTab,
  isSessionTabs,
  reorderSessionTabs,
  type SessionTabItem,
  sessionPanelDomId,
  sessionTabDomId,
} from "../session-tabs";
import { SessionTabBar, type SessionTabBarProps } from "./SessionTabBar";

const initial: SessionTabItem[] = [
  { id: "a", cwd: "/workspace/Alpha", name: "Alpha" },
  { id: "b", cwd: "C:\\研究 空间\\Beta", name: "Beta" },
  { id: "c", cwd: "\\\\server\\share\\Gamma", name: "Gamma" },
];
const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");

function Harness({
  initialActive = "a",
  onSelect = () => {},
  onClose = () => {},
  onNew = () => {},
  onReorder = () => {},
}: {
  initialActive?: string;
  onSelect?: (id: string) => void;
  onClose?: (id: string) => void;
  onNew?: () => void;
  onReorder?: (from: string, to: string) => void;
}) {
  const [state, setState] = useState({ tabs: initial, selectedId: initialActive as string | null });
  return (
    <SessionTabBar
      tabs={state.tabs}
      activeId={state.selectedId}
      onSelect={(id) => {
        onSelect(id);
        setState((current) => ({ ...current, selectedId: id }));
      }}
      onClose={(id) => {
        onClose(id);
        setState((current) => closeSessionTab(current.tabs, id, current.selectedId));
      }}
      onNew={onNew}
      onReorder={(from, to) => {
        onReorder(from, to);
        setState((current) => ({ ...current, tabs: reorderSessionTabs(current.tabs, from, to) }));
      }}
    />
  );
}

function renderStrip(overrides: Partial<SessionTabBarProps> = {}) {
  const props = {
    tabs: initial,
    activeId: "a",
    onSelect: vi.fn(),
    onClose: vi.fn(),
    onNew: vi.fn(),
    onReorder: vi.fn(),
    ...overrides,
  };
  return { ...render(<SessionTabBar {...props} />), props };
}

function rect(left: number, width: number, top = 0, height = 30): DOMRect {
  return { left, right: left + width, top, bottom: top + height, width, height, x: left, y: top, toJSON: () => ({}) };
}

beforeEach(() => {
  // jsdom does not provide native pointer capture. Exercise the real component
  // event handlers with PointerEvent properties and explicit capture operations.
  class TestPointerEvent extends MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;
    readonly isPrimary: boolean;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.pointerType = init.pointerType ?? "mouse";
      this.isPrimary = init.isPrimary ?? true;
    }
  }
  vi.stubGlobal("PointerEvent", TestPointerEvent);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false })),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScrollIntoView);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

describe("SessionTabBar interactions", () => {
  it.each(["newDisabled", "newPending"] as const)("limits %s to plus and preserves navigation/close", (state) => {
    const { props, rerender } = renderStrip({ [state]: true, newLabel: "New session in this workspace" });
    const plus = screen.getByRole("button", { name: "New session in this workspace" });
    expect(plus).toBeDisabled();
    expect(plus).toHaveAttribute("title", "New session in this workspace");
    if (state === "newPending") expect(plus).toHaveAttribute("aria-busy", "true");
    else expect(plus).not.toHaveAttribute("aria-busy");
    fireEvent.click(plus);
    expect(props.onNew).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "Beta" }));
    fireEvent.click(screen.getByRole("button", { name: "Close Gamma" }));
    expect(props.onSelect).toHaveBeenCalledExactlyOnceWith("b");
    expect(props.onClose).toHaveBeenCalledExactlyOnceWith("c");
    rerender(<SessionTabBar {...props} newDisabled={false} newPending={false} />);
    expect(plus).toBeEnabled();
    expect(plus).not.toHaveAttribute("aria-busy");
    fireEvent.click(plus);
    expect(props.onNew).toHaveBeenCalledOnce();
  });

  it("pairs tabs with their instance-owned panels without colliding across identical session catalogs", () => {
    function PairedViews() {
      const prefix = useId();
      return (
        <section>
          <SessionTabBar
            tabs={initial}
            activeId="a"
            idPrefix={prefix}
            onSelect={() => {}}
            onClose={() => {}}
            onNew={() => {}}
          />
          {initial.map((tab) => (
            <div
              key={tab.id}
              role="tabpanel"
              id={sessionPanelDomId(prefix, tab.id)}
              aria-labelledby={sessionTabDomId(prefix, tab.id)}
            >
              {tab.cwd}
            </div>
          ))}
        </section>
      );
    }
    render(
      <>
        <PairedViews />
        <PairedViews />
      </>,
    );
    const tabs = screen.getAllByRole("tab");
    expect(new Set(tabs.map((tab) => tab.id)).size).toBe(tabs.length);
    for (const tab of tabs) {
      const panel = document.getElementById(tab.getAttribute("aria-controls")!);
      expect(panel).toHaveAttribute("role", "tabpanel");
      expect(panel).toHaveAttribute("aria-labelledby", tab.id);
      expect(tab.closest("section")).toContainElement(panel);
      expect(panel).toHaveAccessibleName(tab.getAttribute("aria-label")!);
    }
  });

  it("reconciles resized/reordered/font-sized geometry without changing selection, focus or unrelated scroll", () => {
    let viewportWidth = 900;
    let slotWidth = 100;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute("role") === "tablist") return rect(0, viewportWidth);
      if (this.firstElementChild?.getAttribute("role") === "tab") {
        const index = Array.from(this.parentElement!.children).indexOf(this);
        return rect(index * slotWidth - this.parentElement!.scrollLeft, slotWidth);
      }
      return rect(0, 0);
    });
    const tabs = Array.from({ length: 10 }, (_, i) => ({ id: String(i), cwd: `/project/${i}`, name: `Session ${i}` }));
    const { props, rerender, unmount } = renderStrip({ tabs, activeId: "5" });
    const strip = screen.getByRole("tablist");
    const selected = screen.getByRole("tab", { selected: true });
    const outside = document.createElement("textarea");
    document.body.append(outside);
    outside.scrollTop = 120;
    const observers = (
      globalThis as unknown as { FakeResizeObserver: { instances: { __fire: (width: number) => void }[] } }
    ).FakeResizeObserver.instances;
    const fireResize = () =>
      act(() => {
        for (const observer of observers) observer.__fire(viewportWidth);
      });
    try {
      act(() => outside.focus());
      expect(strip.scrollLeft).toBe(0);
      viewportWidth = 368;
      fireEvent(window, new Event("resize"));
      expect(selected.parentElement!.getBoundingClientRect().right).toBeLessThanOrEqual(viewportWidth);
      expect(strip.scrollLeft).toBeGreaterThan(0);
      strip.scrollLeft = 300;
      fireResize();
      expect(strip.scrollLeft).toBe(300);
      rerender(<SessionTabBar {...props} tabs={reorderSessionTabs(tabs, "5", "9")} />);
      expect(selected.parentElement!.getBoundingClientRect().right).toBeLessThanOrEqual(viewportWidth);
      slotWidth = 150;
      fireResize();
      expect(selected.parentElement!.getBoundingClientRect().left).toBeGreaterThanOrEqual(0);
      expect(selected.parentElement!.getBoundingClientRect().right).toBeLessThanOrEqual(viewportWidth);
      expect(selected).toHaveAttribute("aria-selected", "true");
      expect(outside).toHaveFocus();
      expect(outside.scrollTop).toBe(120);
      expect(props.onSelect).not.toHaveBeenCalled();
      rerender(<SessionTabBar {...props} disabled />);
      strip.scrollLeft = 0;
      fireEvent(window, new Event("resize"));
      expect(strip.scrollLeft).toBe(0);
      unmount();
      fireEvent(window, new Event("resize"));
      expect(strip.scrollLeft).toBe(0);
    } finally {
      outside.remove();
    }
  });

  it("uses manual roving keyboard selection, native Enter/Space, boundaries and Delete", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    const a = screen.getByRole("tab", { name: "Alpha" });
    const b = screen.getByRole("tab", { name: "Beta" });
    const c = screen.getByRole("tab", { name: "Gamma" });
    expect(screen.getAllByRole("tab").filter((tab) => tab.tabIndex === 0)).toEqual([a]);
    await user.tab();
    expect(a).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(b).toHaveFocus();
    expect(b).toHaveAttribute("tabindex", "0");
    expect(a).toHaveAttribute("aria-selected", "true");
    expect(onSelect).not.toHaveBeenCalled();
    await user.keyboard("{Enter}");
    expect(b).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{End}");
    expect(c).toHaveFocus();
    await user.keyboard(" ");
    expect(c).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Home}{ArrowLeft}");
    expect(c).toHaveFocus();
    await user.keyboard("{Delete}");
    expect(screen.queryByRole("tab", { name: "Gamma" })).toBeNull();
    expect(b).toHaveFocus();
    expect(b).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Home}{Delete}"); // focused background close preserves selected Beta
    expect(b).toHaveAttribute("aria-selected", "true");
    expect(b).toHaveFocus();
    await user.keyboard("{Delete}");
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "New or open session" })).toHaveFocus();
  });

  it("closes right then left without nesting buttons or taking background focus", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const a = screen.getByRole("tab", { name: "Alpha" });
    act(() => a.focus());
    await user.click(screen.getByRole("button", { name: "Close Beta" }));
    expect(a).toHaveFocus();
    expect(a).toHaveAttribute("aria-selected", "true");
    expect(within(a).queryByRole("button")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Close Alpha" }));
    expect(screen.getByRole("tab", { name: "Gamma" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Gamma" })).toHaveAttribute("aria-selected", "true");
  });

  it("middle-closes only the clicked tab; plus delegates to the existing chooser", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onNew = vi.fn();
    const onSelect = vi.fn();
    render(<Harness onClose={onClose} onNew={onNew} onSelect={onSelect} />);
    const a = screen.getByRole("tab", { name: "Alpha" });
    await user.pointer({ target: screen.getByRole("tab", { name: "Beta" }), keys: "[MouseMiddle]" });
    expect(onClose).toHaveBeenCalledExactlyOnceWith("b");
    expect(onSelect).not.toHaveBeenCalled();
    expect(a).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByRole("button", { name: "New or open session" }));
    expect(onNew).toHaveBeenCalledOnce();
    expect(screen.getAllByRole("tab")).toHaveLength(2);
  });

  it("does not intercept browser shortcuts", () => {
    const { props } = renderStrip();
    const a = screen.getByRole("tab", { name: "Alpha" });
    for (const key of ["w", "t", "Tab", "ArrowRight", "Delete"]) {
      const event = new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true, cancelable: true });
      act(() => a.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(false);
    }
    expect(props.onClose).not.toHaveBeenCalled();
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it("keeps known labels during loading/errors and exposes stable activation identity", () => {
    const { rerender, props } = renderStrip({ tabs: [{ ...initial[0]!, loading: true }] });
    const a = screen.getByRole("tab", { name: "Alpha" });
    expect(a).toHaveAttribute("data-session-tab-id", "a");
    expect(a).toHaveAttribute("data-loading", "true");
    expect(a).toHaveAttribute("aria-description", "Loading session…");
    rerender(<SessionTabBar {...props} tabs={[{ ...initial[0]!, error: true }]} />);
    expect(screen.getByRole("tab", { name: "Alpha" })).toBe(a);
    expect(a).not.toHaveAttribute("data-loading");
    expect(a).toHaveAttribute("data-error", "true");
    expect(a).toHaveAttribute("aria-description", "Could not open session");
    rerender(<SessionTabBar {...props} tabs={[{ ...initial[0]!, name: undefined, status: "running" }]} />);
    expect(screen.getByRole("tab", { name: "Untitled session" })).toBe(a);
    expect(a).toHaveAttribute("aria-description", "Running");
  });

  it("reorders a normal pointer drag without selecting, and cancels Escape/lost capture", () => {
    const onReorder = vi.fn();
    const onSelect = vi.fn();
    render(<Harness onReorder={onReorder} onSelect={onSelect} />);
    for (const [i, tab] of screen.getAllByRole("tab").entries()) {
      vi.spyOn(tab.parentElement!, "getBoundingClientRect").mockReturnValue(rect(i * 100, 100));
    }
    const a = screen.getByRole("tab", { name: "Alpha" });
    const capture = vi.fn();
    Object.assign(a, { setPointerCapture: capture, hasPointerCapture: () => true, releasePointerCapture: vi.fn() });
    fireEvent.pointerDown(a, { pointerId: 7, button: 0, clientX: 20 });
    fireEvent.pointerMove(a, { pointerId: 8, clientX: 250 });
    fireEvent.pointerMove(a, { pointerId: 7, clientX: 22 });
    expect(a.parentElement).not.toHaveAttribute("data-dragging");
    fireEvent.pointerMove(a, { pointerId: 7, clientX: 250 });
    expect(a.parentElement).toHaveAttribute("data-dragging", "true");
    fireEvent.pointerUp(a, { pointerId: 7, clientX: 250 });
    fireEvent.click(a, { detail: 1 });
    expect(capture).toHaveBeenCalledWith(7);
    expect(onReorder).toHaveBeenCalledExactlyOnceWith("a", "c");
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getAllByRole("tab").map((tab) => tab.dataset.sessionTabId)).toEqual(["b", "c", "a"]);
    expect(a).toHaveAttribute("aria-selected", "true");
    fireEvent.pointerDown(a, { pointerId: 9, button: 0, clientX: 20 });
    fireEvent.pointerMove(a, { pointerId: 9, clientX: 150 });
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(a, { pointerId: 9, clientX: 150 });
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(a.parentElement).not.toHaveAttribute("data-dragging");
    fireEvent.pointerDown(a, { pointerId: 10, button: 0, clientX: 20 });
    fireEvent.pointerMove(a, { pointerId: 10, clientX: 150 });
    fireEvent.lostPointerCapture(a, { pointerId: 10 });
    fireEvent.pointerUp(a, { pointerId: 10 });
    expect(onReorder).toHaveBeenCalledTimes(1);
    fireEvent.click(a, { detail: 0 }); // Keyboard activation still works after a canceled gesture.
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("a");
  });

  it("auto-reveals initial/changed active tabs by scrolling only the strip", () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { value: scrollIntoView, configurable: true });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute("role") === "tablist") return rect(100, 200);
      if (this.classList.contains("er-session-tab")) {
        const index = Array.from(this.parentElement!.children).indexOf(this);
        return rect(100 + index * 100 - this.parentElement!.scrollLeft, 100);
      }
      return rect(0, 0);
    });
    const { rerender, props } = renderStrip({ activeId: "c" });
    const strip = screen.getByRole("tablist");
    expect(strip.scrollLeft).toBe(100);
    rerender(<SessionTabBar {...props} tabs={initial.map((tab) => ({ ...tab, status: "running" }))} />);
    expect(strip.scrollLeft).toBe(100);
    rerender(<SessionTabBar {...props} activeId="a" />);
    expect(strip.scrollLeft).toBe(0);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});

describe("portalled session disclosure", () => {
  it("keeps a valid oversized descriptor inside the viewport and reaches its exact suffix by keyboard scrolling", async () => {
    const user = userEvent.setup();
    const tab = {
      id: "long",
      name: "Research ".repeat(57).slice(0, 512),
      cwd: `/${"ordinary-workspace-folder/".repeat(120)}exact-final-suffix`,
    };
    expect(isSessionTabs([tab])).toBe(true);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute("role") === "tooltip") {
        return rect(
          Number.parseFloat(this.style.left) || 0,
          Math.min(480, Number.parseFloat(this.style.maxWidth) || 480),
          Number.parseFloat(this.style.top) || 0,
          Math.min(1068, Number.parseFloat(this.style.maxHeight) || 1068),
        );
      }
      return rect(0, 200);
    });
    const { props } = renderStrip({ tabs: [tab], activeId: "long" });
    const trigger = screen.getByRole("tab");
    act(() => trigger.focus());
    const popup = screen.getByRole("tooltip");
    Object.defineProperties(popup, {
      clientHeight: { get: () => popup.getBoundingClientRect().height - 22 },
      scrollHeight: { get: () => 1068 },
    });
    expect(popup.textContent).toBe(tab.name + tab.cwd);
    expect(popup.getBoundingClientRect().top).toBeGreaterThanOrEqual(8);
    expect(popup.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight - 8);
    expect(popup.scrollHeight).toBeGreaterThan(popup.clientHeight);
    await user.keyboard("{PageDown}{PageDown}{PageDown}");
    expect(popup.scrollTop + popup.clientHeight).toBe(popup.scrollHeight);
    fireEvent.scroll(popup);
    expect(screen.getByRole("tooltip")).toBe(popup);
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-selected", "true");
    expect(props.onSelect).not.toHaveBeenCalled();
    await user.keyboard("{PageUp}");
    expect(popup.scrollTop).toBeLessThan(popup.scrollHeight - popup.clientHeight);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("owns a cancellable pointer handoff into scrollable metadata and clears delayed hides on disable/unmount", () => {
    vi.useFakeTimers();
    const { props, rerender, unmount } = renderStrip();
    const trigger = screen.getByRole("tab", { name: "Alpha" });
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    const popup = screen.getByRole("tooltip");
    fireEvent.pointerLeave(trigger);
    act(() => vi.advanceTimersByTime(100));
    expect(popup).toBeInTheDocument();
    fireEvent.pointerEnter(popup);
    act(() => vi.advanceTimersByTime(300));
    expect(popup).toBeInTheDocument();
    popup.scrollTop = 40;
    fireEvent.scroll(popup);
    expect(screen.getByRole("tooltip")).toBe(popup);
    fireEvent.pointerLeave(popup);
    act(() => vi.advanceTimersByTime(300));
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    fireEvent.pointerLeave(trigger);
    rerender(<SessionTabBar {...props} disabled />);
    act(() => vi.runAllTimers());
    expect(screen.queryByRole("tooltip")).toBeNull();
    rerender(<SessionTabBar {...props} />);
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    fireEvent.pointerLeave(trigger);
    unmount();
    act(() => vi.runAllTimers());
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("surrenders interaction and its body portal to an overlay, including late pointer events/timers", () => {
    vi.useFakeTimers();
    const { props, rerender, unmount } = renderStrip();
    const a = screen.getByRole("tab", { name: "Alpha" });
    fireEvent.pointerEnter(a, { pointerType: "mouse" });
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.pointerDown(a, { pointerId: 1, button: 0, clientX: 10 });
    fireEvent.pointerUp(a, { pointerId: 1, button: 0, clientX: 10 });
    fireEvent.pointerEnter(a, { pointerType: "mouse" });
    rerender(<SessionTabBar {...props} disabled />);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(a).toBeDisabled();
    act(() => vi.runAllTimers());
    fireEvent.pointerEnter(a, { pointerType: "mouse" });
    fireEvent.focus(a);
    fireEvent.click(a);
    fireEvent.keyDown(a, { key: "Delete" });
    fireEvent(a, new MouseEvent("auxclick", { button: 1, bubbles: true }));
    fireEvent.click(screen.getByRole("button", { name: "Close Alpha" }));
    fireEvent.click(screen.getByRole("button", { name: "New or open session" }));
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
    expect(props.onNew).not.toHaveBeenCalled();
    expect(props.onReorder).not.toHaveBeenCalled();
    rerender(<SessionTabBar {...props} />);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.pointerEnter(a, { pointerType: "mouse" });
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.pointerDown(a, { pointerId: 2, button: 0 });
    fireEvent.pointerUp(a, { pointerId: 2 });
    unmount();
    act(() => vi.runAllTimers());
    fireEvent.pointerEnter(a, { pointerType: "mouse" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("cancels an in-progress reorder and pending close focus without stealing overlay focus", () => {
    const { props, rerender } = renderStrip();
    const a = screen.getByRole("tab", { name: "Alpha" });
    const b = screen.getByRole("tab", { name: "Beta" });
    vi.spyOn(a.parentElement!, "getBoundingClientRect").mockReturnValue(rect(0, 100));
    vi.spyOn(b.parentElement!, "getBoundingClientRect").mockReturnValue(rect(100, 100));
    fireEvent.pointerDown(a, { pointerId: 1, button: 0, clientX: 10 });
    fireEvent.pointerMove(a, { pointerId: 1, clientX: 150 });
    expect(a.parentElement).toHaveAttribute("data-dragging", "true");
    rerender(<SessionTabBar {...props} disabled />);
    fireEvent.pointerUp(a, { pointerId: 1, clientX: 150 });
    expect(a.parentElement).not.toHaveAttribute("data-dragging");
    expect(props.onReorder).not.toHaveBeenCalled();
    rerender(<SessionTabBar {...props} />);
    act(() => a.focus());
    fireEvent.click(screen.getByRole("button", { name: "Close Alpha" }));
    const overlay = document.createElement("input");
    document.body.append(overlay);
    try {
      act(() => overlay.focus());
      rerender(<SessionTabBar {...props} tabs={initial.slice(1)} activeId="b" disabled />);
      expect(overlay).toHaveFocus();
      rerender(<SessionTabBar {...props} tabs={initial.slice(1)} activeId="b" />);
      expect(overlay).toHaveFocus();
    } finally {
      overlay.remove();
    }
  });

  it("shows the full current name and exact cwd outside clipping, then hides on scroll/resize/unmount", async () => {
    const user = userEvent.setup();
    const name = "Long untruncated research title ".repeat(8);
    const { props, rerender, unmount } = renderStrip({ tabs: [{ ...initial[1]!, name }] });
    const tab = screen.getByRole("tab", { name: name.trim() });
    await user.hover(tab);
    let tooltip = screen.getByRole("tooltip");
    expect(tooltip.parentElement).toBe(document.body);
    expect(screen.getByRole("tablist")).not.toContainElement(tooltip);
    expect(tooltip).toHaveTextContent(name.trim());
    expect(tooltip).toHaveTextContent(initial[1]!.cwd);
    expect(tab).toHaveAttribute("aria-describedby", tooltip.id);
    rerender(
      <SessionTabBar {...props} tabs={[{ ...initial[1]!, name: "Renamed now", cwd: "/exact/../moved 研究/" }]} />,
    );
    tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("Renamed now");
    expect(tooltip).toHaveTextContent("/exact/../moved 研究/");
    fireEvent.scroll(screen.getByRole("tablist"));
    expect(screen.queryByRole("tooltip")).toBeNull();
    await user.unhover(tab);
    await user.hover(tab);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent(window, new Event("resize"));
    expect(screen.queryByRole("tooltip")).toBeNull();
    await user.unhover(tab);
    await user.hover(tab);
    unmount();
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("clamps disclosure to the viewport and hides it after observed reflow", async () => {
    const user = userEvent.setup();
    let left = window.innerWidth - 10;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("role") === "tooltip" ? rect(0, 300, 0, 80) : rect(left, 100, window.innerHeight - 10);
    });
    renderStrip();
    await user.hover(screen.getByRole("tab", { name: "Alpha" }));
    const tooltip = screen.getByRole("tooltip");
    expect(Number.parseFloat(tooltip.style.left)).toBe(window.innerWidth - 308);
    expect(Number.parseFloat(tooltip.style.top)).toBeGreaterThanOrEqual(8);
    expect(Number.parseFloat(tooltip.style.top) + 80).toBeLessThanOrEqual(window.innerHeight - 8);
    left -= 20;
    const observers = (
      globalThis as unknown as { FakeResizeObserver: { instances: { __fire: (width: number) => void }[] } }
    ).FakeResizeObserver.instances;
    act(() => {
      for (const observer of observers) observer.__fire(200);
    });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("discloses on keyboard focus and dismisses on Escape or focus leaving the tab", async () => {
    const user = userEvent.setup();
    renderStrip();
    await user.tab();
    expect(screen.getByRole("tooltip")).toHaveTextContent("/workspace/Alpha");
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tooltip")).toHaveTextContent(initial[1]!.cwd);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).toBeNull();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    await user.tab();
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("keeps coarse/touch taps free of hover overlays and preserves touch scrolling", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })),
    );
    const { props } = renderStrip();
    const a = screen.getByRole("tab", { name: "Alpha" });
    await user.pointer([
      { target: a, keys: "[TouchA>]" },
      { target: a, coords: { clientX: 200 } },
      { keys: "[/TouchA]" },
    ]);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(props.onReorder).not.toHaveBeenCalled();
    await user.hover(a);
    expect(screen.queryByRole("tooltip")).toBeNull();
    await user.tab();
    await user.tab({ shift: true });
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
  });
});
