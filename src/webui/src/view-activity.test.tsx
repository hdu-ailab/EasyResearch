import { act, fireEvent, render, screen } from "@testing-library/react";
import { createRef, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { describe, expect, it, vi } from "vitest";
import { ChatComposer, type ChatComposerHandle } from "./components/ChatComposer";
import { useModalLayer } from "./hooks/useModalLayer";
import { useViewActivity, ViewActivityProvider } from "./view-activity";

function Activity() {
  const activity = useViewActivity();
  return <output>{JSON.stringify(activity)}</output>;
}

function DraftDialog({ name, onClose }: { name: string; onClose(): void }) {
  const root = useRef<HTMLDivElement>(null);
  const layer = useModalLayer(onClose, root);
  const [draft, setDraft] = useState("");
  return createPortal(
    <div data-testid={`layer-${name}`} {...layer.layerProps}>
      <div ref={root} role="dialog" aria-label={name} {...layer.dialogProps}>
        <input aria-label={`${name} draft`} value={draft} onChange={(event) => setDraft(event.target.value)} />
      </div>
    </div>,
    document.body,
  );
}

describe("retained view activity", () => {
  it("defaults to standalone activity and composes nested presentation ownership", () => {
    const { rerender } = render(<Activity />);
    expect(screen.getByRole("status")).toHaveTextContent('{"visible":true,"interactive":true}');
    rerender(
      <ViewActivityProvider visible interactive={false}>
        <ViewActivityProvider visible interactive>
          <Activity />
        </ViewActivityProvider>
      </ViewActivityProvider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent('{"visible":true,"interactive":false}');
    rerender(
      <ViewActivityProvider visible={false} interactive>
        <Activity />
      </ViewActivityProvider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent('{"visible":false,"interactive":false}');
  });

  it("suspends portal/backdrop and modal keyboard ownership without discarding either draft", () => {
    const closeA = vi.fn();
    const closeB = vi.fn();
    const views = (selected: string) => (
      <>
        <ViewActivityProvider visible={selected === "a"} interactive={selected === "a"}>
          <DraftDialog name="a" onClose={closeA} />
        </ViewActivityProvider>
        <ViewActivityProvider visible={selected === "b"} interactive={selected === "b"}>
          <DraftDialog name="b" onClose={closeB} />
        </ViewActivityProvider>
      </>
    );
    const { rerender } = render(views("a"));
    const first = screen.getByRole("textbox", { name: "a draft" });
    fireEvent.change(first, { target: { value: "unsaved A" } });
    expect(first).toHaveFocus();
    rerender(views("b"));
    const second = screen.getByRole("textbox", { name: "b draft" });
    fireEvent.change(second, { target: { value: "unsaved B" } });
    expect(second).toHaveFocus();
    expect(screen.getByTestId("layer-a")).toHaveStyle({ visibility: "hidden" });
    expect(screen.getByTestId("layer-a")).toHaveAttribute("inert");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(closeB).toHaveBeenCalledOnce();
    expect(closeA).not.toHaveBeenCalled();
    rerender(views("a"));
    expect(first).toHaveValue("unsaved A");
    expect(first).toHaveFocus();
    expect(second).toHaveValue("unsaved B");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(closeA).toHaveBeenCalledOnce();
  });

  it("lets an owned draft completion update its inactive composer without focus, suggestions, submit or Stop", () => {
    const ref = createRef<ChatComposerHandle>();
    const send = vi.fn();
    const stop = vi.fn();
    const views = (interactive: boolean, disabled = false) => (
      <>
        <button type="button">selected owner</button>
        <ViewActivityProvider visible={interactive} interactive={interactive}>
          <ChatComposer ref={ref} cwd="/p" disabled={disabled} streaming onSend={send} onAbort={stop} />
        </ViewActivityProvider>
      </>
    );
    const { rerender } = render(views(true));
    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "first" } });
    fireEvent.submit(input.closest("form")!);
    expect(send).toHaveBeenCalledOnce();
    rerender(views(false, true));
    const selected = screen.getByRole("button", { name: "selected owner" });
    selected.focus();
    rerender(views(false));
    act(() => {
      ref.current?.setDraft("/name recovered");
      ref.current?.focus();
      ref.current?.insertPath("/p/no.txt");
    });
    expect(input).toHaveValue("/name recovered");
    expect(selected).toHaveFocus();
    fireEvent.submit(input.closest("form")!);
    expect(send).toHaveBeenCalledOnce();
    act(() => ref.current?.setDraft(""));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(stop).not.toHaveBeenCalled();
    rerender(views(true));
    expect(selected).toHaveFocus();
  });

  it("does not restore a still-connected opener while its entire owning view is being disposed", () => {
    function Owner() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            open owned dialog
          </button>
          {open && <DraftDialog name="owned" onClose={() => setOpen(false)} />}
        </>
      );
    }
    const view = render(
      <ViewActivityProvider visible interactive>
        <Owner />
      </ViewActivityProvider>,
    );
    const opener = screen.getByRole("button", { name: "open owned dialog" });
    opener.focus();
    fireEvent.click(opener);
    const focus = vi.spyOn(opener, "focus");
    view.rerender(<button type="button">next view</button>);
    expect(focus).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps global modal focus when an interactive root's composer finishes an imperative draft update", () => {
    const ref = createRef<ChatComposerHandle>();
    render(
      <>
        <ViewActivityProvider visible interactive>
          <ChatComposer ref={ref} disabled={false} streaming={false} onSend={() => {}} onAbort={() => {}} />
        </ViewActivityProvider>
        <DraftDialog name="global settings" onClose={() => {}} />
      </>,
    );
    const settings = screen.getByRole("textbox", { name: "global settings draft" });
    expect(settings).toHaveFocus();
    act(() => {
      ref.current?.setDraft("owned completion");
      ref.current?.focus();
    });
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("owned completion");
    expect(settings).toHaveFocus();
  });
});
