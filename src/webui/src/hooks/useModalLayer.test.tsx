import { fireEvent, render, screen } from "@testing-library/react";
import { createRef, type RefObject, useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { hasModalAbove, requestModalCloseAbove, useModalLayer } from "./useModalLayer";

function Layer({
  onClose,
  label,
  rootRef,
}: {
  onClose: () => void;
  label: string;
  rootRef?: RefObject<HTMLDivElement | null>;
}) {
  const ownRef = useRef<HTMLDivElement>(null);
  const dialogRef = rootRef ?? ownRef;
  const { zIndex, isTop, dialogProps } = useModalLayer(onClose, dialogRef);
  return (
    <div ref={dialogRef} role="dialog" aria-label={label} data-is-top={isTop} {...dialogProps} style={{ zIndex }}>
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

function BlockedFocusCandidates({ position }: { position: "before" | "after" }) {
  return (
    <>
      <div hidden>
        <button type="button">hidden-{position}</button>
      </div>
      <div aria-hidden="true">
        <button type="button">aria-hidden-{position}</button>
      </div>
      <div inert>
        <button type="button">inert-{position}</button>
      </div>
      <button type="button" disabled tabIndex={0}>
        disabled-{position}
      </button>
    </>
  );
}

function FocusLayer({
  onClose,
  withBlockedCandidates = false,
}: {
  onClose: () => void;
  withBlockedCandidates?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const { zIndex, dialogProps } = useModalLayer(onClose, rootRef);
  return (
    <div ref={rootRef} role="dialog" aria-label="focus-layer" {...dialogProps} style={{ zIndex }}>
      {withBlockedCandidates && <BlockedFocusCandidates position="before" />}
      <button type="button">first</button>
      <button type="button">last</button>
      {withBlockedCandidates && <BlockedFocusCandidates position="after" />}
    </div>
  );
}

function FocusHarness({ withBlockedCandidates = false }: { withBlockedCandidates?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        opener
      </button>
      {open ? <FocusLayer onClose={() => setOpen(false)} withBlockedCandidates={withBlockedCandidates} /> : null}
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
    const dialogs = screen.getAllByRole("dialog", { hidden: true });
    const zs = dialogs.map((d) => Number((d as HTMLElement).style.zIndex));
    expect(zs[0]).toBeLessThan(zs[1]!);
    expect(zs[1]).toBeLessThan(zs[2]!);
  });

  it("exposes modal semantics only on the top layer and promotes the layer below", () => {
    const { rerender } = render(
      <>
        <Layer label="lower" onClose={() => {}} />
        <Layer label="upper" onClose={() => {}} />
      </>,
    );

    const [lower, upper] = screen.getAllByRole("dialog", { hidden: true });
    expect(lower).toHaveAttribute("aria-hidden", "true");
    expect(lower).toHaveAttribute("inert");
    expect(lower).not.toHaveAttribute("aria-modal");
    expect(lower).toHaveAttribute("data-is-top", "false");
    expect(upper).toHaveAttribute("aria-modal", "true");
    expect(upper).not.toHaveAttribute("aria-hidden");
    expect(upper).not.toHaveAttribute("inert");
    expect(upper).toHaveAttribute("data-is-top", "true");

    rerender(<Layer label="lower" onClose={() => {}} />);
    const promoted = screen.getByRole("dialog");
    expect(promoted).toHaveAttribute("aria-modal", "true");
    expect(promoted).not.toHaveAttribute("aria-hidden");
    expect(promoted).not.toHaveAttribute("inert");
    expect(promoted).toHaveAttribute("data-is-top", "true");
  });

  it("detects and requests closure of only the modal above a registered root", () => {
    const lowerRef = createRef<HTMLDivElement>();
    const upperRef = createRef<HTMLDivElement>();
    const onCloseLower = vi.fn();
    const onCloseUpper = vi.fn();
    render(
      <>
        <Layer label="lower" rootRef={lowerRef} onClose={onCloseLower} />
        <Layer label="upper" rootRef={upperRef} onClose={onCloseUpper} />
      </>,
    );

    expect(hasModalAbove(lowerRef.current)).toBe(true);
    expect(requestModalCloseAbove(lowerRef.current)).toBe(true);
    expect(onCloseUpper).toHaveBeenCalledOnce();
    expect(onCloseLower).not.toHaveBeenCalled();
    expect(hasModalAbove(upperRef.current)).toBe(false);
    expect(requestModalCloseAbove(upperRef.current)).toBe(false);
    expect(onCloseUpper).toHaveBeenCalledOnce();
  });

  it("does not query or close the stack for null and unregistered roots", () => {
    const onClose = vi.fn();
    render(<Layer label="top" onClose={onClose} />);
    const unregistered = document.createElement("div");

    expect(hasModalAbove(null)).toBe(false);
    expect(requestModalCloseAbove(null)).toBe(false);
    expect(hasModalAbove(unregistered)).toBe(false);
    expect(requestModalCloseAbove(unregistered)).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
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
    const dialogs = screen.getAllByRole("dialog", { hidden: true });
    expect(dialogs).toHaveLength(3);
    const zs = dialogs.map((d) => Number((d as HTMLElement).style.zIndex));
    expect(zs[0]! < zs[1]! && zs[1]! < zs[2]!).toBe(true);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(2);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(1);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryAllByRole("dialog", { hidden: true })).toHaveLength(0);
  });

  it("removes the document listener when the last modal unmounts", () => {
    const { unmount } = render(<Layer label="only" onClose={() => {}} />);
    const removeSpy = vi.spyOn(document, "removeEventListener");
    unmount();
    expect(removeSpy).toHaveBeenCalledWith("keydown", expect.any(Function));
  });

  it("removes inert before initially focusing a newly registered top dialog", () => {
    const nativeFocus = HTMLElement.prototype.focus;
    const focusSpy = vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (
      this: HTMLElement,
      options?: FocusOptions,
    ) {
      if (this.closest('[role="dialog"][inert]')) return;
      nativeFocus.call(this, options);
    });

    try {
      render(<FocusHarness />);
      const opener = screen.getByRole("button", { name: "opener" });
      opener.focus();
      fireEvent.click(opener);

      expect(screen.getByRole("button", { name: "first" })).toHaveFocus();
    } finally {
      focusSpy.mockRestore();
    }
  });

  it("wraps Tab only between visible controls when retained descendants are interaction-hidden", () => {
    render(<FocusHarness withBlockedCandidates />);
    const opener = screen.getByRole("button", { name: "opener" });
    opener.focus();
    fireEvent.click(opener);
    const first = screen.getByRole("button", { name: "first" });
    const last = screen.getByRole("button", { name: "last" });

    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(first).toHaveFocus();

    first.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
  });

  it("redirects programmatic focus escape to the first visible control", () => {
    render(<FocusHarness withBlockedCandidates />);
    const opener = screen.getByRole("button", { name: "opener" });
    opener.focus();
    fireEvent.click(opener);
    const first = screen.getByRole("button", { name: "first" });
    const last = screen.getByRole("button", { name: "last" });

    last.focus();
    opener.focus();

    expect(first).toHaveFocus();
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
