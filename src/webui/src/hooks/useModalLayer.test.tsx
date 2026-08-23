import { fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { useModalLayer } from "./useModalLayer";

function Layer({ onClose, label }: { onClose: () => void; label: string }) {
  const zIndex = useModalLayer(onClose);
  return (
    <div role="dialog" aria-label={label} style={{ zIndex }}>
      {label}
    </div>
  );
}

function Stack() {
  const [open, setOpen] = useState<Record<string, boolean>>({ a: true, b: false, c: false });
  return (
    <>
      {open.a && <Layer label="a" onClose={() => setOpen((s) => ({ ...s, a: false }))} />}
      {open.b && <Layer label="b" onClose={() => setOpen((s) => ({ ...s, b: false }))} />}
      {open.c && <Layer label="c" onClose={() => setOpen((s) => ({ ...s, c: false }))} />}
      <button type="button" onClick={() => setOpen((s) => ({ ...s, b: true }))}>
        open-b
      </button>
      <button type="button" onClick={() => setOpen((s) => ({ ...s, c: true }))}>
        open-c
      </button>
    </>
  );
}

function FocusLayer({ onClose }: { onClose: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const zIndex = useModalLayer(onClose, rootRef);
  return (
    <div ref={rootRef} role="dialog" aria-label="focus-layer" style={{ zIndex }}>
      <button type="button">first</button>
      <button type="button">last</button>
    </div>
  );
}

function FocusHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        opener
      </button>
      {open ? <FocusLayer onClose={() => setOpen(false)} /> : null}
    </>
  );
}

describe("useModalLayer", () => {
  it("assigns increasing z-index so later modals paint above earlier ones", () => {
    render(
      <>
        <Layer label="first" onClose={() => {}} />
        <Layer label="second" onClose={() => {}} />
        <Layer label="third" onClose={() => {}} />
      </>,
    );
    const dialogs = screen.getAllByRole("dialog");
    const zs = dialogs.map((d) => Number((d as HTMLElement).style.zIndex));
    expect(zs[0]).toBeLessThan(zs[1]!);
    expect(zs[1]).toBeLessThan(zs[2]!);
  });

  it("Escape closes only the top-most modal", () => {
    const onClose = { a: vi.fn(), b: vi.fn(), c: vi.fn() };
    const { rerender } = render(
      <>
        <Layer label="a" onClose={onClose.a} />
        <Layer label="b" onClose={onClose.b} />
        <Layer label="c" onClose={onClose.c} />
      </>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose.c).toHaveBeenCalledTimes(1);
    expect(onClose.a).not.toHaveBeenCalled();
    expect(onClose.b).not.toHaveBeenCalled();

    // Close c by unmounting it; Escape now targets b.
    rerender(
      <>
        <Layer label="a" onClose={onClose.a} />
        <Layer label="b" onClose={onClose.b} />
      </>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose.b).toHaveBeenCalledTimes(1);
    expect(onClose.a).not.toHaveBeenCalled();
  });

  it("Esc unwinds a nested stack one layer at a time", () => {
    render(<Stack />);
    // open b then c on top of a
    fireEvent.click(screen.getByText("open-b"));
    fireEvent.click(screen.getByText("open-c"));
    const dialogs = screen.getAllByRole("dialog");
    expect(dialogs).toHaveLength(3);
    const zs = dialogs.map((d) => Number((d as HTMLElement).style.zIndex));
    expect(zs[0]! < zs[1]! && zs[1]! < zs[2]!).toBe(true);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getAllByRole("dialog")).toHaveLength(2);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryAllByRole("dialog")).toHaveLength(0);
  });

  it("removes the document listener when the last modal unmounts", () => {
    const { unmount } = render(<Layer label="only" onClose={() => {}} />);
    const removeSpy = vi.spyOn(document, "removeEventListener");
    unmount();
    expect(removeSpy).toHaveBeenCalledWith("keydown", expect.any(Function));
  });

  it("moves focus inside, traps Tab, and restores the opener when closing", () => {
    render(<FocusHarness />);
    const opener = screen.getByRole("button", { name: "opener" });
    opener.focus();
    fireEvent.click(opener);
    const first = screen.getByRole("button", { name: "first" });
    const last = screen.getByRole("button", { name: "last" });

    expect(first).toHaveFocus();
    opener.focus();
    expect(first).toHaveFocus();
    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(first).toHaveFocus();
    first.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(opener).toHaveFocus();
  });
});
