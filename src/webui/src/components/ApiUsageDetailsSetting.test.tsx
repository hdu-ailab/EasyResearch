import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { I18nProvider } from "../i18n/I18nProvider";
import { PreferencesProvider } from "../preferences/PreferencesProvider";
import { ApiUsageDetailsSetting } from "./ApiUsageDetailsSetting";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    getApiUsageSettings: vi.fn(),
    patchApiUsageSettings: vi.fn(),
  };
});

function renderSetting(generation = 1) {
  return render(
    <PreferencesProvider>
      <I18nProvider>
        <ApiUsageDetailsSetting configurationGeneration={generation} />
      </I18nProvider>
    </PreferencesProvider>,
  );
}

describe("ApiUsageDetailsSetting", () => {
  beforeEach(() => {
    vi.mocked(api.getApiUsageSettings).mockReset().mockResolvedValue({ showApiUsageDetails: false });
    vi.mocked(api.patchApiUsageSettings)
      .mockReset()
      .mockImplementation(async ({ showApiUsageDetails }) => ({ showApiUsageDetails }));
  });

  it("loads the global value and persists the inverse boolean", async () => {
    const user = userEvent.setup();
    renderSetting();
    const toggle = await screen.findByRole("switch", { name: /show api usage details/i });
    expect(toggle).toHaveAttribute("aria-checked", "false");

    await user.click(toggle);

    await waitFor(() => expect(api.patchApiUsageSettings).toHaveBeenCalledWith({ showApiUsageDetails: true }));
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  it("restores the accepted value and retries a failed target", async () => {
    const user = userEvent.setup();
    vi.mocked(api.patchApiUsageSettings)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ showApiUsageDetails: true });
    renderSetting();
    const toggle = await screen.findByRole("switch", { name: /show api usage details/i });

    await user.click(toggle);
    const retry = await screen.findByRole("button", { name: /retry/i });
    expect(toggle).toHaveAttribute("aria-checked", "false");

    await user.click(retry);

    await waitFor(() => expect(api.patchApiUsageSettings).toHaveBeenCalledTimes(2));
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });
});
