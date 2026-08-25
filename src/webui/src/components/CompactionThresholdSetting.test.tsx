import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { I18nProvider } from "../i18n/I18nProvider";
import { PreferencesProvider } from "../preferences/PreferencesProvider";
import { CompactionThresholdSetting } from "./CompactionThresholdSetting";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    getCompactionSettings: vi.fn(),
    patchCompactionSettings: vi.fn(),
  };
});

function renderSetting(generation = 1) {
  return render(
    <PreferencesProvider>
      <I18nProvider>
        <CompactionThresholdSetting configurationGeneration={generation} />
      </I18nProvider>
    </PreferencesProvider>,
  );
}

describe("CompactionThresholdSetting", () => {
  beforeEach(() => {
    vi.mocked(api.getCompactionSettings).mockReset().mockResolvedValue({
      triggerPercent: 70,
      globalEnabled: true,
    });
    vi.mocked(api.patchCompactionSettings)
      .mockReset()
      .mockImplementation(async ({ triggerPercent }) => ({
        triggerPercent,
        globalEnabled: true,
      }));
  });

  it("commits any valid integer on blur", async () => {
    const user = userEvent.setup();
    renderSetting();
    const input = await screen.findByRole("spinbutton", { name: /automatic compaction/i });

    await user.clear(input);
    await user.type(input, "73");
    await user.tab();

    await waitFor(() => expect(api.patchCompactionSettings).toHaveBeenCalledWith({ triggerPercent: 73 }));
    expect(input).toHaveValue(73);
  });

  it("persists five-point step buttons immediately without a duplicate blur write", async () => {
    const user = userEvent.setup();
    renderSetting();
    const input = await screen.findByRole("spinbutton", { name: /automatic compaction/i });
    await user.click(input);

    await user.click(screen.getByRole("button", { name: /increase automatic compaction/i }));

    await waitFor(() => expect(api.patchCompactionSettings).toHaveBeenCalledTimes(1));
    expect(api.patchCompactionSettings).toHaveBeenCalledWith({ triggerPercent: 75 });
    expect(input).toHaveValue(75);
  });

  it("rejects invalid input and restores the last accepted value", async () => {
    const user = userEvent.setup();
    renderSetting();
    const input = await screen.findByRole("spinbutton", { name: /automatic compaction/i });

    await user.clear(input);
    await user.type(input, "91");
    await user.tab();

    expect(api.patchCompactionSettings).not.toHaveBeenCalled();
    expect(input).toHaveValue(70);
    expect(screen.getByRole("alert")).toHaveTextContent(/10.*90/i);
  });

  it("restores the accepted value and retries the failed target", async () => {
    const user = userEvent.setup();
    vi.mocked(api.patchCompactionSettings)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ triggerPercent: 80, globalEnabled: true });
    renderSetting();
    const input = await screen.findByRole("spinbutton", { name: /automatic compaction/i });

    await user.clear(input);
    await user.type(input, "80");
    await user.tab();
    await screen.findByRole("button", { name: /retry/i });
    expect(input).toHaveValue(70);

    await user.click(screen.getByRole("button", { name: /retry/i }));

    await waitFor(() => expect(api.patchCompactionSettings).toHaveBeenCalledTimes(2));
    expect(api.patchCompactionSettings).toHaveBeenLastCalledWith({ triggerPercent: 80 });
    expect(input).toHaveValue(80);
  });

  it("reports global native disable while keeping the percentage editable", async () => {
    vi.mocked(api.getCompactionSettings).mockResolvedValue({ triggerPercent: 70, globalEnabled: false });
    renderSetting();

    const input = await screen.findByRole("spinbutton", { name: /automatic compaction/i });
    expect(input).toBeEnabled();
    expect(screen.getByText(/disabled globally/i)).toBeInTheDocument();
  });

  it("keeps a visible keyboard focus indicator and disables editing during persistence", async () => {
    let resolve!: (value: { triggerPercent: number; globalEnabled: boolean }) => void;
    vi.mocked(api.patchCompactionSettings).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const user = userEvent.setup();
    renderSetting();
    const input = await screen.findByRole("spinbutton", { name: /automatic compaction/i });

    await user.tab();
    await user.tab();
    expect(input).toHaveFocus();
    expect(input).toHaveClass("focus-visible:outline-2", "focus-visible:outline-v2-blue-600");
    expect(input).not.toHaveClass("outline-none");
    await user.click(screen.getByRole("button", { name: /increase automatic compaction/i }));
    expect(input).toBeDisabled();

    resolve({ triggerPercent: 75, globalEnabled: true });
    await waitFor(() => expect(input).toBeEnabled());
  });
});
