import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { useModalLayer } from "../hooks/useModalLayer";
import { ViewActivityProvider } from "../view-activity";
import { FileActionMenu } from "./FileActionMenu";
import { FileRenameDialog } from "./FileRenameDialog";

const entry = { name: "paper.md", path: "/p/paper.md", kind: "file" as const };

function HigherModal() {
  const root = useRef<HTMLDivElement>(null);
  const layer = useModalLayer(() => {}, root);
  return (
    <div ref={root} role="dialog" aria-label="Other settings" {...layer.dialogProps}>
      <input aria-label="Other setting" />
    </div>
  );
}

function Harness({ active = true, modal = false }: { active?: boolean; modal?: boolean }) {
  const [rename, setRename] = useState(false);
  return (
    <>
      <button type="button">Before</button>
      <ViewActivityProvider visible={active} interactive={active}>
        <div data-testid="pane" hidden={!active}>
          <FileActionMenu entry={{ ...entry }} onRename={() => setRename(true)} onUpload={() => {}} />
          {rename && <FileRenameDialog cwd="/p" entry={entry} onClose={() => setRename(false)} onComplete={() => {}} />}
        </div>
      </ViewActivityProvider>
      <button type="button">After</button>
      {modal && <HigherModal />}
    </>
  );
}

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  const trigger = screen.getByRole("button", { name: "Actions for paper.md" });
  trigger.focus();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("menuitem", { name: "Download" })).toHaveFocus();
  return trigger;
}

describe("FileActionMenu focus ownership", () => {
  it("preserves its positioned menu through same-file metadata refresh and delayed ancestor, sibling and internal scroll", async () => {
    const user = userEvent.setup();
    const view = render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Actions for paper.md" });
    const pane = screen.getByTestId("pane");
    pane.scrollTop = 393;
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(new DOMRect(991, 511, 32, 32));
    await openMenu(user);
    const menu = screen.getByRole("menu");
    const position = menu.getAttribute("style");
    view.rerender(<Harness />);
    expect(screen.getByRole("menu")).toBe(menu);
    const focus = vi.spyOn(trigger, "focus");
    for (const scroller of [pane, screen.getByRole("button", { name: "After" }), menu]) {
      fireEvent.scroll(scroller);
      expect(screen.getByRole("menu")).toBe(menu);
      expect(menu).toHaveAttribute("style", position);
      expect(screen.getByRole("menuitem", { name: "Download" })).toHaveFocus();
    }
    expect(focus).not.toHaveBeenCalled();
  });

  it.each(["scroll", "resize"])(
    "restores its keyboard position without scrolling after %s dismissal",
    async (event) => {
      const user = userEvent.setup();
      render(<Harness />);
      let rect = new DOMRect(200, 300, 32, 32);
      vi.spyOn(
        screen.getByRole("button", { name: "Actions for paper.md" }),
        "getBoundingClientRect",
      ).mockImplementation(() => rect);
      const trigger = await openMenu(user);
      const focus = vi.spyOn(trigger, "focus");
      if (event === "scroll") {
        rect = new DOMRect(200, 250, 32, 32);
        fireEvent.scroll(screen.getByTestId("pane"));
      } else fireEvent.resize(window);
      expect(screen.queryByRole("menu")).toBeNull();
      expect(trigger).toHaveFocus();
      expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
      await user.tab();
      expect(screen.getByRole("button", { name: "After" })).toHaveFocus();
    },
  );

  it.each(["x", "y", "width", "height"] as const)(
    "dismisses on real anchor %s movement and captures fresh geometry on reopening",
    async (dimension) => {
      const user = userEvent.setup();
      render(<Harness />);
      const original = { x: 200, y: 300, width: 32, height: 32 };
      let rect = DOMRect.fromRect(original);
      vi.spyOn(
        screen.getByRole("button", { name: "Actions for paper.md" }),
        "getBoundingClientRect",
      ).mockImplementation(() => rect);
      const trigger = await openMenu(user);
      rect = DOMRect.fromRect({ ...original, [dimension]: original[dimension] + 25 });
      fireEvent.scroll(screen.getByTestId("pane"));
      expect(screen.queryByRole("menu")).toBeNull();
      expect(trigger).toHaveFocus();
      await openMenu(user);
      fireEvent.scroll(screen.getByTestId("pane"));
      expect(screen.getByRole("menu")).toBeVisible();
      expect(screen.getByRole("menuitem", { name: "Download" })).toHaveFocus();
    },
  );

  it.each(["scroll", "resize"])("does not steal focus after it has moved outside the menu on %s", async (event) => {
    const user = userEvent.setup();
    render(<Harness />);
    let rect = new DOMRect(200, 300, 32, 32);
    vi.spyOn(screen.getByRole("button", { name: "Actions for paper.md" }), "getBoundingClientRect").mockImplementation(
      () => rect,
    );
    const trigger = await openMenu(user);
    const focus = vi.spyOn(trigger, "focus");
    const after = screen.getByRole("button", { name: "After" });
    after.focus();
    rect = new DOMRect(200, 250, 32, 32);
    if (event === "scroll") fireEvent.scroll(screen.getByTestId("pane"));
    else fireEvent.resize(window);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(after).toHaveFocus();
    expect(focus).not.toHaveBeenCalled();
  });

  it.each(["detached", "hidden", "inert", "disabled"] as const)(
    "dismisses without restoring a %s anchor even when reported geometry is unchanged",
    async (state) => {
      const user = userEvent.setup();
      render(<Harness />);
      vi.spyOn(screen.getByRole("button", { name: "Actions for paper.md" }), "getBoundingClientRect").mockReturnValue(
        new DOMRect(200, 300, 32, 32),
      );
      const trigger = await openMenu(user);
      const parent = trigger.parentElement!;
      const sibling = trigger.nextSibling;
      const focus = vi.spyOn(trigger, "focus");
      if (state === "detached") trigger.remove();
      else trigger.setAttribute(state, "");
      try {
        fireEvent.scroll(window);
        expect(screen.queryByRole("menu")).toBeNull();
        expect(focus).not.toHaveBeenCalled();
      } finally {
        if (state === "detached") parent.insertBefore(trigger, sibling?.isConnected ? sibling : null);
        else trigger.removeAttribute(state);
      }
    },
  );

  it.each(["pointer", "Tab"])("keeps the ordinary %s exit destination", async (exit) => {
    const user = userEvent.setup();
    render(<Harness />);
    await openMenu(user);
    const after = screen.getByRole("button", { name: "After" });
    if (exit === "pointer") await user.click(after);
    else {
      // Native Tab uses the focus restored by keydown; user-event chooses its target before that handler.
      expect(fireEvent.keyDown(document.activeElement!, { key: "Tab" })).toBe(true);
      await user.tab();
    }
    expect(screen.queryByRole("menu")).toBeNull();
    expect(after).toHaveFocus();
  });

  it("does not restore a trigger after its retained view becomes inactive", async () => {
    const user = userEvent.setup();
    const view = render(<Harness />);
    const trigger = await openMenu(user);
    const focus = vi.spyOn(trigger, "focus");
    view.rerender(<Harness active={false} />);
    const after = screen.getByRole("button", { name: "After" });
    after.focus();
    fireEvent.resize(window);
    fireEvent.scroll(window);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(after).toHaveFocus();
    expect(focus).not.toHaveBeenCalled();
    view.rerender(<Harness />);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(after).toHaveFocus();
  });

  it("leaves focus with a higher modal when the old menu is dismissed", async () => {
    const user = userEvent.setup();
    const view = render(<Harness />);
    const trigger = await openMenu(user);
    const focus = vi.spyOn(trigger, "focus");
    view.rerender(<Harness modal />);
    const setting = screen.getByRole("textbox", { name: "Other setting" });
    expect(setting).toHaveFocus();
    fireEvent.resize(window);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(setting).toHaveFocus();
    expect(focus).not.toHaveBeenCalled();
  });

  it("hands keyboard focus to Rename and cleans up menu listeners", async () => {
    const user = userEvent.setup();
    const view = render(<Harness />);
    const trigger = await openMenu(user);
    await user.keyboard("{End}{Enter}");
    const name = screen.getByRole("textbox", { name: "File name" });
    expect(name).toHaveFocus();
    expect(screen.queryByRole("menu")).toBeNull();
    const focus = vi.spyOn(trigger, "focus");
    fireEvent.resize(window);
    fireEvent.scroll(window);
    expect(name).toHaveFocus();
    expect(focus).not.toHaveBeenCalled();
    act(() => view.unmount());
    fireEvent.resize(window);
    expect(focus).not.toHaveBeenCalled();
  });
});
