import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { type ContextBlock, ContextStrip } from "./ContextStrip";

describe("context item selector", () => {
  it("repositions a focused preview through auto-scroll, hides clipped triggers, and restores only retained focus interest", () => {
    const block: ContextBlock = {
      id: "last",
      type: "assistant",
      label: "Last reply",
      preview: "Focused preview",
      tokens: 10,
      percent: 1,
      width: 1,
    };
    const view = render(<ContextStrip label="Details" blocks={[block]} onSelect={vi.fn()} />);
    const strip = screen.getByRole("group", { name: "Details" });
    const trigger = within(strip).getByRole("button");
    strip.style.overflowX = "auto";
    vi.spyOn(strip, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 200, 80));
    let rect = new DOMRect(10, 110, 30, 30);
    vi.spyOn(trigger, "getBoundingClientRect").mockImplementation(() => rect);
    act(() => trigger.focus());
    expect(screen.getByRole("tooltip")).toHaveTextContent("Focused preview");
    rect = new DOMRect(120, 120, 30, 30);
    fireEvent.scroll(strip);
    expect(screen.getByRole("tooltip")).toHaveStyle({ left: "120px", top: "158px" });
    expect(trigger).toHaveAttribute("aria-describedby", screen.getByRole("tooltip").id);
    rect = new DOMRect(300, 120, 30, 30); // Inside the viewport, outside its scrolling strip.
    fireEvent.scroll(strip);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(trigger).not.toHaveAttribute("aria-describedby");
    rect = new DOMRect(80, 120, 30, 30);
    fireEvent.scroll(strip);
    expect(screen.getByRole("tooltip")).toHaveStyle({ left: "80px" });
    fireEvent.pointerLeave(trigger);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.keyDown(trigger, { key: "Escape" });
    fireEvent.scroll(strip);
    expect(screen.queryByRole("tooltip")).toBeNull();
    act(() => trigger.blur());
    fireEvent.pointerEnter(trigger);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.scroll(strip);
    expect(screen.queryByRole("tooltip")).toBeNull();
    act(() => trigger.focus());
    rect = new DOMRect(80, -100, 30, 30);
    fireEvent.scroll(window);
    expect(screen.queryByRole("tooltip")).toBeNull();
    view.unmount();
    fireEvent.scroll(window);
  });
  it("bounds mounted choices while keeping every message and server share reachable across pages", () => {
    const blocks: ContextBlock[] = Array.from({ length: 1000 }, (_, i) => ({
      id: `item-${i}`,
      type: "assistant",
      label: `Reply ${i}`,
      preview: `Body ${i}`,
      tokens: 37,
      percent: 0.123,
      width: 0.1,
    }));
    const select = vi.fn();
    render(<ContextStrip label="Details" blocks={blocks} chips onSelect={select} />);
    const strip = screen.getByRole("group", { name: "Details" });
    expect(within(strip).getAllByRole("button")).toHaveLength(blocks.length);
    const choices = screen.getByRole("group", { name: "Select a message" });
    const seen = new Set<string>();
    const last = blocks.at(-1)!;
    while (true) {
      const items = within(choices)
        .getAllByRole("button")
        .filter((button) => button.getAttribute("aria-pressed") !== null);
      expect(items.length).toBeLessThanOrEqual(50);
      for (const item of items) {
        expect(item.getAttribute("aria-label")).toContain("37 tokens · 0.1%");
        seen.add(item.getAttribute("aria-label")!);
      }
      const next = within(choices).getByRole("button", { name: "Next" });
      if (next.hasAttribute("disabled")) break;
      fireEvent.click(next);
    }
    expect(seen.size).toBe(blocks.length);
    fireEvent.click(within(choices).getByRole("button", { name: /^Reply 999 ·/ }));
    expect(select).toHaveBeenLastCalledWith(last.id);
    fireEvent.click(within(strip).getByRole("button", { name: /^Reply 0 ·/ }));
    expect(within(choices).getByRole("button", { name: /^Reply 0 ·/ })).toBeInTheDocument();
    expect(within(choices).queryByRole("button", { name: /^Reply 999 ·/ })).toBeNull();
  });
});
