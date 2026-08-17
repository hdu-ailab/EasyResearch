import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
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
  { value: "", label: "follow Paper Assistant" },
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

describe("SearchableSelect", () => {
  it("renders the current value as the trigger and opens a listbox on click", async () => {
    const user = userEvent.setup();
    renderSelect();
    const trigger = screen.getByRole("combobox");
    expect(trigger).toHaveTextContent("openai/gpt-4o");
    await user.click(trigger);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "anthropic/claude" })).toBeInTheDocument();
  });

  it("filters options by typing in the search box", async () => {
    const user = userEvent.setup();
    renderSelect();
    await user.click(screen.getByRole("combobox"));
    await user.type(screen.getByRole("searchbox"), "claude");
    expect(screen.getByRole("option", { name: "anthropic/claude" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "openai/gpt-4o" })).not.toBeInTheDocument();
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
  });

  it("shows the placeholder when value is not among options", () => {
    renderSelect({ value: "" });
    expect(screen.getByRole("combobox")).toHaveTextContent("follow Paper Assistant");
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    renderSelect();
    await user.click(screen.getByRole("combobox"));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});