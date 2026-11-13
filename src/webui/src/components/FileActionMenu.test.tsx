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
          <FileActionMenu entry={entry} onRename={() => setRename(true)} onUpload={() => {}} />
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
  it.each(["scroll", "resize"])(
    "restores its keyboard position without scrolling after %s dismissal",
    async (event) => {
      const user = userEvent.setup();
      render(<Harness />);
      const trigger = await openMenu(user);
      const focus = vi.spyOn(trigger, "focus");
      if (event === "scroll") fireEvent.scroll(screen.getByTestId("pane"));
      else fireEvent.resize(window);
      expect(screen.queryByRole("menu")).toBeNull();
      expect(trigger).toHaveFocus();
      expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
      await user.tab();
      expect(screen.getByRole("button", { name: "After" })).toHaveFocus();
    },
  );

  it("does not steal focus after it has moved outside the menu", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = await openMenu(user);
    const focus = vi.spyOn(trigger, "focus");
    const after = screen.getByRole("button", { name: "After" });
    after.focus();
    fireEvent.resize(window);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(after).toHaveFocus();
    expect(focus).not.toHaveBeenCalled();
  });

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
