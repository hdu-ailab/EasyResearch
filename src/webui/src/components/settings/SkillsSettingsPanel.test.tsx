import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillResourceDto } from "../../../../web/contracts";
import { SkillsSettingsPanel } from "./SkillsSettingsPanel";

const resource = (name: string, description = "", extra: Partial<SkillResourceDto> = {}): SkillResourceDto => ({
  name,
  description,
  source: "global",
  enabled: true,
  canDelete: true,
  path: `/agent/skills/${name}`,
  skillPath: `/agent/skills/${name}/SKILL.md`,
  ...extra,
});
const defaults = {
  active: true,
  skills: [resource("paper-search", "Retrieve literature"), resource("unknown", "An unfamiliar capability")],
  projects: [],
  diagnosticScope: "global",
  diagnostics: [],
  diagnosticError: null,
  onScopeChange: vi.fn(),
  onEdit: vi.fn().mockResolvedValue(undefined),
  onToggle: vi.fn().mockResolvedValue(undefined),
  onDelete: vi.fn().mockResolvedValue(undefined),
};
beforeEach(() => {
  defaults.onEdit.mockReset().mockResolvedValue(undefined);
  defaults.onToggle.mockReset().mockResolvedValue(undefined);
  defaults.onDelete.mockReset().mockResolvedValue(undefined);
});

describe("Installed Skills", () => {
  it("keeps the positioned menu through metadata refresh and delayed pre-open, sibling and internal scroll events", async () => {
    const user = userEvent.setup();
    const fixture = (description: string) => (
      <>
        <div data-testid="skills-scroll">
          <SkillsSettingsPanel {...defaults} skills={[resource("paper-search", description)]} />
        </div>
        <div data-testid="sibling-scroll" />
      </>
    );
    const view = render(fixture("Initial metadata"));
    const trigger = screen.getByRole("button", { name: "Actions for paper-search" });
    const pane = screen.getByTestId("skills-scroll");
    // Position changes before click; the associated scroll event is delivered
    // after the menu opens, matching the compiled-browser failure.
    pane.scrollTop = 393;
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(new DOMRect(991, 511, 32, 32));
    await user.click(trigger);
    const menu = screen.getByRole("menu");
    const position = menu.getAttribute("style");
    view.rerender(fixture("Refreshed local metadata"));
    expect(screen.getByRole("menu")).toBe(menu);
    expect(screen.getByText("Refreshed local metadata")).toBeVisible();
    const focus = vi.spyOn(trigger, "focus");
    for (const scroller of [pane, screen.getByTestId("sibling-scroll"), menu]) {
      fireEvent.scroll(scroller);
      expect(screen.getByRole("menu")).toBe(menu);
      expect(menu).toHaveAttribute("style", position);
      expect(trigger).toHaveAttribute("aria-expanded", "true");
    }
    expect(focus).not.toHaveBeenCalled();
    await user.click(within(menu).getByRole("menuitem", { name: "Disable" }));
    expect(defaults.onToggle).toHaveBeenCalledOnce();
  });

  it.each(["x", "y", "width", "height"] as const)(
    "dismisses on actual anchor %s movement and uses the newly positioned geometry on reopening",
    async (dimension) => {
      const user = userEvent.setup();
      render(
        <div data-testid="skills-scroll">
          <SkillsSettingsPanel {...defaults} />
        </div>,
      );
      const trigger = screen.getByRole("button", { name: "Actions for paper-search" });
      const original = { x: 200, y: 300, width: 32, height: 32 };
      let rect = DOMRect.fromRect(original);
      vi.spyOn(trigger, "getBoundingClientRect").mockImplementation(() => rect);
      trigger.focus();
      await user.keyboard("{ArrowDown}");
      expect(screen.getByRole("menuitem", { name: "Edit skill paper-search" })).toHaveFocus();
      const focus = vi.spyOn(trigger, "focus");
      rect = DOMRect.fromRect({ ...original, [dimension]: original[dimension] + 25 });
      fireEvent.scroll(screen.getByTestId("skills-scroll"));
      expect(screen.queryByRole("menu")).toBeNull();
      expect(trigger).toHaveFocus();
      expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
      await user.keyboard("{ArrowDown}");
      fireEvent.scroll(screen.getByTestId("skills-scroll"));
      expect(screen.getByRole("menu")).toBeVisible();
      expect(screen.getByRole("menuitem", { name: "Edit skill paper-search" })).toHaveFocus();
    },
  );

  it("keeps resize dismissal even with unchanged anchor geometry", async () => {
    const user = userEvent.setup();
    render(<SkillsSettingsPanel {...defaults} />);
    const trigger = screen.getByRole("button", { name: "Actions for paper-search" });
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(new DOMRect(200, 300, 32, 32));
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    const focus = vi.spyOn(trigger, "focus");
    fireEvent.resize(window);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveFocus();
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });

  it("does not steal focus when scrolling after the user leaves the menu or the panel deactivates", async () => {
    const user = userEvent.setup();
    const fixture = (active: boolean) => (
      <>
        <SkillsSettingsPanel {...defaults} active={active} />
        <button type="button">Next control</button>
      </>
    );
    const view = render(fixture(true));
    const trigger = screen.getByRole("button", { name: "Actions for paper-search" });
    let rect = new DOMRect(200, 300, 32, 32);
    vi.spyOn(trigger, "getBoundingClientRect").mockImplementation(() => rect);
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    const focus = vi.spyOn(trigger, "focus");
    const next = screen.getByRole("button", { name: "Next control" });
    act(() => next.focus());
    rect = new DOMRect(200, 250, 32, 32);
    fireEvent.scroll(window);
    expect(next).toHaveFocus();
    expect(focus).not.toHaveBeenCalled();
    await user.click(trigger);
    focus.mockClear();
    view.rerender(fixture(false));
    act(() => next.focus());
    fireEvent.scroll(window);
    fireEvent.resize(window);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(next).toHaveFocus();
    expect(focus).not.toHaveBeenCalled();
  });

  it.each(["detached", "hidden", "inert", "disabled"] as const)(
    "dismisses safely when a %s anchor receives a scroll without a usable geometry change",
    async (state) => {
      const user = userEvent.setup();
      render(<SkillsSettingsPanel {...defaults} />);
      const trigger = screen.getByRole("button", { name: "Actions for paper-search" });
      vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(new DOMRect(200, 300, 32, 32));
      trigger.focus();
      await user.keyboard("{ArrowDown}");
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

  it("filters local metadata deterministically, preserving unknown and ambiguous cards in Other", async () => {
    const user = userEvent.setup();
    const rows = [
      resource("paper-search", "Search and writing tools"), // known bundled role wins
      resource("diagram-maker", "Draw diagrams"),
      resource("custom-literature", "Retrieve and search papers"),
      resource("mixed", "Search and writing"),
      resource("unknown"),
      resource("constructor"),
      resource("private", "Experiments and datasets"),
      resource("manuscript", "Manuscript writing"),
      resource("critique", "Peer review"),
      resource("convert", "Convert documents"),
    ];
    render(<SkillsSettingsPanel {...defaults} skills={rows} />);
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(screen.getByRole("heading", { name: "paper-search" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "custom-literature" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "mixed" })).not.toBeInTheDocument();
    for (const [category, name] of [
      ["Figures", "diagram-maker"],
      ["Experiments", "private"],
      ["Writing", "manuscript"],
      ["Review", "critique"],
      ["Utilities", "convert"],
    ]) {
      await user.click(screen.getByRole("button", { name: category }));
      expect(screen.getByRole("heading", { name })).toBeVisible();
      expect(screen.queryByRole("heading", { name: "paper-search" })).not.toBeInTheDocument();
    }
    await user.click(screen.getByRole("button", { name: "Other" }));
    expect(screen.getByRole("heading", { name: "mixed" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "unknown" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "constructor" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getAllByRole("article")).toHaveLength(rows.length);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(defaults.onEdit).not.toHaveBeenCalled();
    expect(defaults.onToggle).not.toHaveBeenCalled();
  });

  it("retains the filter across activation while dismissing a menu", async () => {
    const user = userEvent.setup();
    const view = render(<SkillsSettingsPanel {...defaults} />);
    await user.click(screen.getByRole("button", { name: "Search" }));
    await user.click(screen.getByRole("button", { name: "Actions for paper-search" }));
    expect(screen.getByRole("menu")).toBeVisible();
    view.rerender(<SkillsSettingsPanel {...defaults} active={false} />);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    view.rerender(<SkillsSettingsPanel {...defaults} />);
    expect(screen.getByRole("button", { name: "Search" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("heading", { name: "unknown" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("supports keyboard entry, Arrow/Home/End, Escape, Tab exit and outside dismissal", async () => {
    const user = userEvent.setup();
    render(<SkillsSettingsPanel {...defaults} />);
    const trigger = screen.getByRole("button", { name: "Actions for paper-search" });
    trigger.focus();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Edit skill paper-search" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Disable" })).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(screen.getByRole("menuitem", { name: "Edit skill paper-search" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Actions for unknown" })).toHaveFocus();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await user.click(trigger);
    expect(trigger).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Edit skill paper-search" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "All" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("edits through the existing owner and leaves disabled bundled resources restorable", async () => {
    const user = userEvent.setup();
    const bundled = resource("paper-search", "Retrieve papers", {
      source: "bundled",
      enabled: false,
      canDelete: false,
    });
    render(<SkillsSettingsPanel {...defaults} skills={[bundled]} />);
    expect(screen.getByText("Disabled")).toBeVisible();
    expect(screen.getByText("Bundled")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Actions for paper-search" }));
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeDisabled();
    expect(screen.getByText("Only writable global Skill directories can be deleted.")).toBeVisible();
    await user.click(screen.getByRole("menuitem", { name: "Edit skill paper-search" }));
    expect(defaults.onEdit).toHaveBeenCalledExactlyOnceWith("paper-search");
    await user.click(screen.getByRole("button", { name: "Actions for paper-search" }));
    await user.click(screen.getByRole("menuitem", { name: "Enable" }));
    expect(defaults.onToggle).toHaveBeenCalledExactlyOnceWith(bundled);
    expect(defaults.onDelete).not.toHaveBeenCalled();
  });

  it("preserves failed toggle actions for direct retry and keeps other cards usable", async () => {
    const user = userEvent.setup();
    const pending = Promise.withResolvers<void>();
    defaults.onToggle.mockRejectedValueOnce(new Error("Settings changed")).mockReturnValueOnce(pending.promise);
    render(<SkillsSettingsPanel {...defaults} />);
    await user.click(screen.getByRole("button", { name: "Actions for paper-search" }));
    await user.click(screen.getByRole("menuitem", { name: "Disable" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Settings changed");
    await user.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(screen.getByRole("button", { name: "Actions for paper-search" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Actions for unknown" })).toBeEnabled();
    await act(async () => pending.resolve());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Actions for paper-search" })).toHaveAttribute(
        "aria-disabled",
        "false",
      ),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(defaults.onToggle).toHaveBeenCalledTimes(2);
    expect(defaults.onToggle.mock.calls[0]).toEqual(defaults.onToggle.mock.calls[1]);
  });

  it("confirms only deletion, names the Skill, and retains a failed deletion for retry", async () => {
    const user = userEvent.setup();
    defaults.onDelete.mockRejectedValueOnce(new Error("Directory changed"));
    render(<SkillsSettingsPanel {...defaults} />);
    const trigger = screen.getByRole("button", { name: "Actions for paper-search" });
    await user.click(trigger);
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    let dialog = screen.getByRole("dialog", { name: "Delete paper-search?" });
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(defaults.onDelete).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    await user.click(trigger);
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    dialog = screen.getByRole("dialog", { name: "Delete paper-search?" });
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Directory changed");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(defaults.onDelete).toHaveBeenCalledTimes(2);
    expect(trigger).toHaveFocus();
  });

  it("does not infer deletion authority from the source label alone", async () => {
    render(<SkillsSettingsPanel {...defaults} skills={[resource("custom", "", { canDelete: undefined })]} />);
    fireEvent.click(screen.getByRole("button", { name: "Actions for custom" }));
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeDisabled();
  });
});
