import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { useModalLayer } from "../hooks/useModalLayer";
import { ViewActivityProvider } from "../view-activity";
import { AgentConfigModal } from "./AgentConfigModal";
import { filterOptions, flipDirection, SearchableSelect, type SearchableSelectOption } from "./SearchableSelect";

describe("filterOptions", () => {
  const options: SearchableSelectOption[] = [
    { value: "openai/gpt-4o", label: "openai/gpt-4o" },
    { value: "anthropic/claude", label: "anthropic/claude" },
  ];
  it("matches provider or id case-insensitively", () => {
    expect(filterOptions("OPENAI", options).map((o) => o.value)).toEqual(["openai/gpt-4o"]);
    expect(filterOptions("gpt", options).map((o) => o.value)).toEqual(["openai/gpt-4o"]);
  });
  it("returns all options for a blank query", () => {
    expect(filterOptions("", options)).toHaveLength(2);
  });
});

describe("flipDirection", () => {
  it("opens down when there is room below", () => {
    expect(flipDirection({ top: 40, bottom: 60 }, 120, 600)).toBe("down");
  });
  it("flips up when the panel would overflow the viewport bottom", () => {
    expect(flipDirection({ top: 520, bottom: 540 }, 120, 600)).toBe("up");
  });
  it("picks the side with more room when neither fits", () => {
    expect(flipDirection({ top: 150, bottom: 170 }, 400, 300)).toBe("up");
    expect(flipDirection({ top: 80, bottom: 100 }, 400, 320)).toBe("down");
  });
});

const OPTIONS: SearchableSelectOption[] = [
  { value: "", label: "follow Research Assistant" },
  { value: "openai/gpt-4o", label: "openai/gpt-4o" },
  { value: "anthropic/claude", label: "anthropic/claude" },
];

function renderSelect(overrides: Partial<Parameters<typeof SearchableSelect>[0]> = {}) {
  const onSelect = vi.fn();
  render(
    <SearchableSelect
      value="openai/gpt-4o"
      options={OPTIONS}
      onSelect={onSelect}
      ariaLabel="Select model"
      emptyMessage="No matches"
      {...overrides}
    />,
  );
  return { onSelect };
}

function TestModal({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const layer = useModalLayer(() => {}, root);
  return (
    <div ref={root} role="dialog" aria-label="Picker boundaries" {...layer.dialogProps}>
      {children}
    </div>
  );
}

function AgentModalHarness({ onClose, onSelect }: { onClose(): void; onSelect(value: string): void }) {
  const [editing, setEditing] = useState(false);
  const agent = {
    name: "search",
    description: "Searches",
    enabled: true,
    builtin: true,
    source: "bundled" as const,
    filePath: "src/agents/search.md",
    effectiveTools: [],
    effectiveSkills: [],
    missingSkills: [],
  };
  return (
    <AgentConfigModal
      agent={agent}
      busy={false}
      modelOptions={[{ provider: "provider", id: "model", reasoning: false, available: true, authRequired: false }]}
      modelValue="provider/model"
      thinkingValue=""
      thinkingLevels={["off", "high"]}
      isResearchAssistant={false}
      editorResource={editing ? { ...agent, content: "Original prompt" } : null}
      onClose={onClose}
      onToggle={() => {}}
      onModelChange={onSelect}
      onThinkingChange={() => {}}
      onEditMarkdown={() => setEditing(true)}
      onSaveMarkdown={() => {}}
      onCloseEditor={() => setEditing(false)}
      onShowDetails={() => {}}
    />
  );
}

describe("SearchableSelect", () => {
  it.each([
    ["End", 2, 0],
    ["Home", 0, 2],
    ["ArrowDown", 2, 0],
  ] as const)(
    "keeps %s selection through stationary hover retargeting and resumes on real movement",
    async (key, expectedIndex, underPointerIndex) => {
      const user = userEvent.setup();
      const { onSelect } = renderSelect({ value: "" });
      await user.click(screen.getByRole("combobox"));
      const input = screen.getByRole("searchbox");
      const options = screen.getAllByRole("option");
      const point = { clientX: 40, clientY: 80 };
      fireEvent.mouseEnter(options[1]!, point);
      fireEvent.mouseMove(options[1]!, point);
      expect(options[1]).toHaveAttribute("aria-selected", "true");
      await user.keyboard(`{${key}}`);
      expect(options[expectedIndex]).toHaveAttribute("aria-selected", "true");

      // Scrolling/layout can retarget mouseover at the same viewport coordinate.
      fireEvent.mouseEnter(options[underPointerIndex]!, point);
      fireEvent.mouseMove(options[underPointerIndex]!, point);
      expect(options[expectedIndex]).toHaveAttribute("aria-selected", "true");
      expect(input).toHaveAttribute("aria-activedescendant", options[expectedIndex]!.id);
      expect(input).toHaveFocus();
      expect(onSelect).not.toHaveBeenCalled();

      fireEvent.mouseMove(options[underPointerIndex]!, { ...point, clientX: point.clientX + 1 });
      expect(options[underPointerIndex]).toHaveAttribute("aria-selected", "true");
      expect(input).toHaveFocus();
      await user.keyboard(`{${key}}`);
      fireEvent.mouseDown(options[underPointerIndex]!, { ...point, clientX: point.clientX + 1 });
      expect(onSelect).toHaveBeenCalledExactlyOnceWith(OPTIONS[underPointerIndex]!.value);
    },
  );

  it("does not let stationary hover replace filtering/catalog selection and tracks movement outside the popup", async () => {
    const user = userEvent.setup();
    const options = Array.from({ length: 8 }, (_, index) => ({ value: `model-${index}`, label: `Model ${index}` }));
    const onSelect = vi.fn();
    const view = (shown: typeof options) => (
      <SearchableSelect value="model-7" options={shown} onSelect={onSelect} ariaLabel="Select model" />
    );
    const { rerender } = render(view(options));
    await user.click(screen.getByRole("combobox"));
    const input = screen.getByRole("searchbox");
    const point = { clientX: 50, clientY: 90 };
    const hovered = screen.getByRole("option", { name: "Model 2" });
    fireEvent.mouseEnter(hovered, point);
    fireEvent.mouseMove(hovered, point);
    await user.keyboard("{End}");
    rerender(view(options.slice(0, 5)));
    fireEvent.mouseEnter(hovered, point);
    fireEvent.mouseMove(hovered, point);
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent("Model 4");
    fireEvent.change(input, { target: { value: "Model" } });
    fireEvent.mouseEnter(hovered, point);
    fireEvent.mouseMove(hovered, point);
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent("Model 0");

    // Returning to an old option coordinate is still genuine movement after leaving the popup.
    fireEvent.mouseMove(document.body, { clientX: 500, clientY: 500 });
    fireEvent.mouseEnter(hovered, point);
    fireEvent.mouseMove(hovered, point);
    expect(hovered).toHaveAttribute("aria-selected", "true");
    expect(input).toHaveFocus();
    expect(input).toHaveValue("Model");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it.each(["pointer", "keyboard"])("accepts first pointer movement after %s opening and reopening", async (opening) => {
    const user = userEvent.setup();
    renderSelect({ value: "" });
    const trigger = screen.getByRole("combobox");
    if (opening === "pointer") await user.click(trigger);
    else {
      trigger.focus();
      await user.keyboard("{Enter}");
    }
    const point = { clientX: 20, clientY: 40 };
    const firstHover = screen.getAllByRole("option")[1]!;
    fireEvent.mouseEnter(firstHover, point);
    fireEvent.mouseMove(firstHover, point);
    expect(firstHover).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Escape}{Enter}");
    const nextHover = screen.getAllByRole("option")[2]!;
    fireEvent.mouseEnter(nextHover, point);
    fireEvent.mouseMove(nextHover, point);
    expect(nextHover).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("searchbox")).toHaveFocus();
  });

  it.each([false, true])(
    "preserves native model-picker Tab progression inside the Agent modal (shift=%s)",
    async (shift) => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      const onSelect = vi.fn();
      render(<AgentModalHarness onClose={onClose} onSelect={onSelect} />);
      const trigger = screen.getByRole("combobox", { name: "Select model for Search" });
      const thinking = screen.getByRole("combobox", { name: "Select thinking for Search" });
      await user.click(trigger);
      await user.tab({ shift });
      expect(shift ? trigger : thinking).toHaveFocus();
      expect(screen.queryByRole("listbox")).toBeNull();
      expect(screen.getByRole("dialog", { name: "Agents" })).toBeVisible();
      expect(onClose).not.toHaveBeenCalled();
      expect(onSelect).not.toHaveBeenCalled();
    },
  );

  it.each(["first", "last", "only"])("keeps modal boundary wrapping when the selector is %s", async (position) => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <>
        <button type="button">Outside before</button>
        <TestModal>
          {position === "last" && <button type="button">First inside</button>}
          <SearchableSelect value="" options={OPTIONS} onSelect={onSelect} ariaLabel="Select model" />
          {position === "first" && <button type="button">Last inside</button>}
        </TestModal>
        <button type="button">Outside after</button>
      </>,
    );
    const trigger = screen.getByRole("combobox");
    const first = position === "last" ? screen.getByRole("button", { name: "First inside" }) : trigger;
    const last = position === "first" ? screen.getByRole("button", { name: "Last inside" }) : trigger;
    await user.click(trigger);
    await user.tab();
    expect(position === "first" ? last : first).toHaveFocus();
    expect(screen.queryByRole("listbox")).toBeNull();
    await user.click(trigger);
    await user.tab({ shift: true });
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("listbox")).toBeNull();
    first.focus();
    await user.tab({ shift: true });
    expect(last).toHaveFocus();
    await user.tab();
    expect(first).toHaveFocus();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("preserves a nested editor's dirty-close guard after picker Tab navigation", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onSelect = vi.fn();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    try {
      render(<AgentModalHarness onClose={onClose} onSelect={onSelect} />);
      const trigger = screen.getByRole("combobox", { name: "Select model for Search" });
      await user.click(trigger);
      await user.tab();
      expect(screen.getByRole("combobox", { name: "Select thinking for Search" })).toHaveFocus();
      await user.click(screen.getByRole("button", { name: "Edit Search" }));
      const editor = screen.getByRole("textbox", { name: "Agent Markdown" });
      await user.type(editor, " revised");
      await user.keyboard("{Escape}");
      expect(confirm).toHaveBeenCalledOnce();
      expect(editor).toHaveFocus();
      expect(onClose).not.toHaveBeenCalled();
      confirm.mockReturnValue(true);
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("textbox", { name: "Agent Markdown" })).toBeNull();
      await user.click(trigger);
      await user.tab({ shift: true });
      expect(trigger).toHaveFocus();
      expect(onClose).not.toHaveBeenCalled();
      expect(onSelect).not.toHaveBeenCalled();
    } finally {
      confirm.mockRestore();
    }
  });

  it.each([
    { isComposing: true, keyCode: 13 },
    { isComposing: false, keyCode: 229 },
  ])("leaves IME confirmation and navigation with the input (%j)", async (flags) => {
    const user = userEvent.setup();
    const { onSelect } = renderSelect();
    await user.click(screen.getByRole("combobox"));
    const input = screen.getByRole("searchbox");
    const active = input.getAttribute("aria-activedescendant");
    for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "Escape", "Enter"]) {
      expect(fireEvent.keyDown(input, { key, ...flags })).toBe(true);
      expect(input).toHaveFocus();
      expect(input).toHaveAttribute("aria-activedescendant", active);
      expect(screen.getByRole("listbox")).toBeVisible();
      expect(onSelect).not.toHaveBeenCalled();
    }
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("openai/gpt-4o");
  });

  it("keeps a containing modal open during composition and consumes only the later popup Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onSelect = vi.fn();
    function Modal() {
      const root = useRef<HTMLDivElement>(null);
      const layer = useModalLayer(onClose, root);
      return (
        <div ref={root} role="dialog" aria-label="Model settings" {...layer.dialogProps}>
          <SearchableSelect value="" options={OPTIONS} onSelect={onSelect} ariaLabel="Select model" />
        </div>
      );
    }
    render(<Modal />);
    await user.click(screen.getByRole("combobox"));
    const input = screen.getByRole("searchbox");
    fireEvent.compositionStart(input);
    for (const key of ["ArrowDown", "Escape", "Enter"]) fireEvent.keyDown(input, { key });
    expect(input).toHaveFocus();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent(OPTIONS[0]!.label);
    fireEvent.compositionEnd(input);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it.each(["pointer", "inactive"])("clears interrupted composition after %s dismissal", async (dismissal) => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const view = (interactive: boolean) => (
      <>
        <button type="button">Outside</button>
        <ViewActivityProvider visible={interactive} interactive={interactive}>
          <SearchableSelect value="" options={OPTIONS} onSelect={onSelect} ariaLabel="Select model" />
        </ViewActivityProvider>
      </>
    );
    const { rerender } = render(view(true));
    await user.click(screen.getByRole("combobox"));
    fireEvent.compositionStart(screen.getByRole("searchbox"));
    if (dismissal === "pointer") await user.click(screen.getByRole("button", { name: "Outside" }));
    else rerender(view(false));
    expect(screen.queryByRole("listbox")).toBeNull();
    rerender(view(true));
    await user.click(screen.getByRole("combobox"));
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("");
  });

  it("keeps active-descendant, selection, and keyboard movement aligned through catalog replacement", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const view = (options: readonly SearchableSelectOption[]) => (
      <SearchableSelect value={OPTIONS[2]!.value} options={options} onSelect={onSelect} ariaLabel="Select model" />
    );
    const { rerender } = render(view(OPTIONS));
    await user.click(screen.getByRole("combobox"));
    const input = screen.getByRole("searchbox");
    const expectActive = (label: string) => {
      const selected = within(screen.getByRole("listbox")).getByRole("option", { selected: true });
      expect(selected).toHaveTextContent(label);
      expect(selected).toHaveClass("bg-v2-blue-100");
      expect(input).toHaveAttribute("aria-activedescendant", selected.id);
      expect(input).toHaveFocus();
    };
    rerender(view(OPTIONS.slice(0, 2)));
    expectActive(OPTIONS[1]!.label);
    rerender(view(OPTIONS));
    expectActive(OPTIONS[1]!.label);
    await user.keyboard("{ArrowDown}");
    expectActive(OPTIONS[2]!.label);
    rerender(view(OPTIONS.slice(0, 2)));
    await user.keyboard("{ArrowDown}");
    expectActive(OPTIONS[0]!.label);
    rerender(view([]));
    expect(input).not.toHaveAttribute("aria-activedescendant");
    expect(screen.queryByRole("option", { selected: true })).toBeNull();
    await user.keyboard("{ArrowDown}{ArrowUp}{Home}{End}{Enter}");
    expect(onSelect).not.toHaveBeenCalled();
    rerender(view(OPTIONS));
    await user.type(input, "gpt");
    rerender(view([...OPTIONS].reverse()));
    expect(input).toHaveValue("gpt");
    expectActive(OPTIONS[1]!.label);
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(OPTIONS[1]!.value);
  });

  it("renders the current value as the trigger and opens a listbox on click", async () => {
    const user = userEvent.setup();
    renderSelect();
    const trigger = screen.getByRole("combobox");
    expect(trigger).toHaveTextContent("openai/gpt-4o");
    await user.click(trigger);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "anthropic/claude" })).toBeInTheDocument();
    const search = screen.getByRole("searchbox");
    const activeOption = document.getElementById(search.getAttribute("aria-activedescendant") ?? "");
    expect(activeOption).toHaveRole("option");
    expect(activeOption).toHaveAttribute("aria-selected", "true");
  });

  it("filters options by typing in the search box", async () => {
    const user = userEvent.setup();
    renderSelect();
    await user.click(screen.getByRole("combobox"));
    await user.type(screen.getByRole("searchbox"), "claude");
    expect(screen.getByRole("option", { name: "anthropic/claude" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "openai/gpt-4o" })).not.toBeInTheDocument();
  });

  it("keeps the focused search outside the options list it controls", async () => {
    const user = userEvent.setup();
    const options = Array.from({ length: 180 }, (_, index) => ({
      value: `provider/model-${index}`,
      label: `provider/model-${index}`,
    }));
    const { onSelect } = renderSelect({ options, value: options.at(-1)!.value });
    await user.click(screen.getByRole("combobox"));
    const search = screen.getByRole("searchbox");
    const listbox = screen.getByRole("listbox");
    expect(search).toHaveFocus();
    expect(search).toHaveAttribute("aria-controls", listbox.id);
    expect(listbox).not.toContainElement(search);

    await user.type(search, "MODEL-42");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith("provider/model-42");
    expect(screen.getByRole("combobox")).toHaveFocus();
  });

  it("shows the empty message when the query matches nothing", async () => {
    const user = userEvent.setup();
    renderSelect();
    await user.click(screen.getByRole("combobox"));
    await user.type(screen.getByRole("searchbox"), "zzz");
    expect(screen.getByText("No matches")).toBeInTheDocument();
  });

  it("selects an option with the keyboard and calls onSelect", async () => {
    const user = userEvent.setup();
    const { onSelect } = renderSelect({ value: "" });
    await user.click(screen.getByRole("combobox"));
    await user.type(screen.getByRole("searchbox"), "claude");
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith("anthropic/claude");
    expect(screen.getByRole("combobox")).toHaveFocus();
  });

  it("moves to list boundaries with Home and End", async () => {
    const user = userEvent.setup();
    const { onSelect } = renderSelect({ value: "" });
    await user.click(screen.getByRole("combobox"));
    const search = screen.getByRole("searchbox");

    await user.keyboard("{End}");
    expect(document.getElementById(search.getAttribute("aria-activedescendant") ?? "")).toHaveTextContent(
      "anthropic/claude",
    );
    await user.keyboard("{Home}");
    expect(document.getElementById(search.getAttribute("aria-activedescendant") ?? "")).toHaveTextContent(
      "follow Research Assistant",
    );
    await user.keyboard("{End}{Enter}");
    expect(onSelect).toHaveBeenCalledWith("anthropic/claude");
  });

  it("shows the placeholder when value is not among options", () => {
    renderSelect({ value: "" });
    expect(screen.getByRole("combobox")).toHaveTextContent("follow Research Assistant");
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    renderSelect();
    await user.click(screen.getByRole("combobox"));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox")).toHaveFocus();
  });

  it("consumes Escape so a containing modal stays open", async () => {
    const user = userEvent.setup();
    renderSelect();
    await user.click(screen.getByRole("combobox"));
    const parentEscape = vi.fn();
    const listener = (event: KeyboardEvent) => {
      if (event.key === "Escape") parentEscape();
    };
    document.addEventListener("keydown", listener);

    await user.keyboard("{Escape}");

    expect(parentEscape).not.toHaveBeenCalled();
    document.removeEventListener("keydown", listener);
  });
});
