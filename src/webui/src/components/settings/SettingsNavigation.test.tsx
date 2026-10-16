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

it("moves focus to the next visible desktop category and the last category", () => {
  vi.stubGlobal("innerWidth", 1200);
  const onSelect = renderNavigation();
  const tablist = screen.getByRole("tablist", { name: "Settings" });
  const tabs = within(tablist).getAllByRole("tab");
  const general = tabs[0]!;
  general.focus();
  fireEvent.keyDown(general, { key: "ArrowDown" });

  expect(tabs[1]).toHaveFocus();
  expect(onSelect).toHaveBeenLastCalledWith(tabs[1]!.id.replace("settings-tab-", ""));

  fireEvent.keyDown(screen.getByRole("tab", { name: "Network" }), { key: "End" });
  expect(tabs.at(-1)).toHaveFocus();
  expect(onSelect).toHaveBeenLastCalledWith(tabs.at(-1)!.id.replace("settings-tab-", ""));
});

it("selects Network from the mobile category stack", async () => {
  vi.stubGlobal("innerWidth", 390);
  const user = userEvent.setup();
  const onSelect = renderNavigation();
  const navigation = screen.getByRole("navigation", { name: "Settings" });
  await user.click(within(navigation).getByRole("button", { name: "Network" }));
  expect(onSelect).toHaveBeenCalledWith("network");
});
