import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import * as api from "../api";
import { I18nProvider } from "../i18n/I18nProvider";
import { PreferencesProvider } from "../preferences/PreferencesProvider";
import { SessionTitleSetting } from "./SessionTitleSetting";

vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  getSessionTitleSettings: vi.fn(),
  patchSessionTitleSettings: vi.fn(),
}));
beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(api.getSessionTitleSettings).mockReset().mockResolvedValue({ autoSessionTitle: true });
  vi.mocked(api.patchSessionTitleSettings)
    .mockReset()
    .mockImplementation(async (value) => value);
});
const view = (generation: number) => (
  <PreferencesProvider>
    <I18nProvider>
      <SessionTitleSetting configurationGeneration={generation} />
    </I18nProvider>
  </PreferencesProvider>
);

it("shows the accepted default and retries the exact failed disable without changing the accepted value", async () => {
  render(view(1));
  const toggle = screen.getByRole("switch", { name: "Automatic session titles" });
  await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
  vi.mocked(api.patchSessionTitleSettings).mockRejectedValueOnce(new Error("offline"));
  fireEvent.click(toggle);
  await screen.findByRole("alert");
  expect(toggle).toHaveAttribute("aria-checked", "true");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
  expect(api.patchSessionTitleSettings).toHaveBeenLastCalledWith({ autoSessionTitle: false });
});

it("refetches external changes on accepted configuration generation changes", async () => {
  const rendered = render(view(1));
  const toggle = screen.getByRole("switch", { name: "Automatic session titles" });
  await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
  vi.mocked(api.getSessionTitleSettings).mockResolvedValue({ autoSessionTitle: false });
  rendered.rerender(view(2));
  await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
  expect(api.patchSessionTitleSettings).not.toHaveBeenCalled();
});
