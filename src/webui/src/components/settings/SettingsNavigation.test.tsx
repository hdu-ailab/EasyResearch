import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsNavigation } from "./SettingsNavigation";

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderNavigation(onSelect = vi.fn()) {
  render(
    <SettingsNavigation
      active="general"
      mobileDetailOpen={false}
      onSelect={onSelect}
      onOpenConfig={() => {}}
      registerMobileButton={() => {}}
    />,
  );
  return onSelect;
}

it("orders Network after General and includes it in desktop roving focus", () => {
  vi.stubGlobal("innerWidth", 1200);
  const onSelect = renderNavigation();
  const tablist = screen.getByRole("tablist", { name: "Settings" });
  expect(
    within(tablist)
      .getAllByRole("tab")
      .map((tab) => tab.textContent),
  ).toEqual(["General", "Network", "Conversation", "Model providers", "Agents", "Skills and tools"]);

  const general = within(tablist).getByRole("tab", { name: "General" });
  general.focus();
  fireEvent.keyDown(general, { key: "ArrowDown" });

  expect(within(tablist).getByRole("tab", { name: "Network" })).toHaveFocus();
  expect(onSelect).toHaveBeenLastCalledWith("network");

  fireEvent.keyDown(screen.getByRole("tab", { name: "Network" }), { key: "End" });
  expect(screen.getByRole("tab", { name: "Skills and tools" })).toHaveFocus();
  expect(onSelect).toHaveBeenLastCalledWith("resources");
});

it("orders and selects Network from the mobile category stack", async () => {
  vi.stubGlobal("innerWidth", 390);
  const user = userEvent.setup();
  const onSelect = renderNavigation();
  const navigation = screen.getByRole("navigation", { name: "Settings" });
  const categoryNames = within(navigation)
    .getAllByRole("button")
    .slice(0, 6)
    .map((button) => button.textContent);

  expect(categoryNames).toEqual([
    "General",
    "Network",
    "Conversation",
    "Model providers",
    "Agents",
    "Skills and tools",
  ]);

  await user.click(within(navigation).getByRole("button", { name: "Network" }));
  expect(onSelect).toHaveBeenCalledWith("network");
});
