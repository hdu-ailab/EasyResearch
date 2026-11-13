import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import * as api from "../api";
import { I18nProvider } from "../i18n/I18nProvider";
import { PreferencesProvider } from "../preferences/PreferencesProvider";
import { ProviderTimeoutSetting } from "./ProviderTimeoutSetting";

vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  getProviderTimeoutSettings: vi.fn(),
  patchProviderTimeoutSettings: vi.fn(),
}));
beforeEach(() => {
  vi.mocked(api.getProviderTimeoutSettings).mockReset().mockResolvedValue({ timeoutMs: 3_600_000, source: "default" });
  vi.mocked(api.patchProviderTimeoutSettings)
    .mockReset()
    .mockImplementation(async ({ timeoutMs }) => ({ timeoutMs: timeoutMs ?? 3_600_000, source: "provider" }));
});
const view = (generation: number) => (
  <PreferencesProvider>
    <I18nProvider>
      <ProviderTimeoutSetting configurationGeneration={generation} />
    </I18nProvider>
  </PreferencesProvider>
);

it("converts seconds to native milliseconds and preserves a failed zero edit for retry", async () => {
  render(view(1));
  const input = await screen.findByRole("spinbutton", { name: /LLM request timeout/i });
  await waitFor(() => expect(input).toHaveValue(3600));
  fireEvent.change(input, { target: { value: "1.001" } });
  fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
  await waitFor(() => expect(api.patchProviderTimeoutSettings).toHaveBeenCalledWith({ timeoutMs: 1001 }));
  await waitFor(() => expect(input).not.toBeDisabled());
  vi.mocked(api.patchProviderTimeoutSettings).mockRejectedValueOnce(new Error("offline"));
  fireEvent.change(input, { target: { value: "0" } });
  fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
  await screen.findByRole("alert");
  expect(input).toHaveValue(0);
  fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  expect(api.patchProviderTimeoutSettings).toHaveBeenLastCalledWith({ timeoutMs: 0 });
});

it("keeps a local draft during an external update and rejects invalid input without a write", async () => {
  const rendered = render(view(1));
  const input = await screen.findByRole("spinbutton", { name: /LLM request timeout/i });
  await waitFor(() => expect(input).toHaveValue(3600));
  fireEvent.change(input, { target: { value: "42" } });
  vi.mocked(api.getProviderTimeoutSettings).mockResolvedValue({ timeoutMs: 8000, source: "provider" });
  rendered.rerender(view(2));
  await waitFor(() => expect(api.getProviderTimeoutSettings).toHaveBeenCalledTimes(2));
  expect(input).toHaveValue(42);
  fireEvent.change(input, { target: { value: "-1" } });
  fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
  await screen.findByRole("alert");
  expect(api.patchProviderTimeoutSettings).not.toHaveBeenCalled();
});

it.each([
  { isComposing: true, keyCode: 13, tracked: false },
  { isComposing: false, keyCode: 229, tracked: false },
  { isComposing: false, keyCode: 13, tracked: true },
])("does not commit a numeric timeout on synthetic IME Enter (%j)", async (flags) => {
  const user = userEvent.setup();
  render(view(1));
  const input = await screen.findByRole("spinbutton", { name: /LLM request timeout/i });
  await waitFor(() => expect(input).toBeEnabled());
  await user.click(input);
  fireEvent.change(input, { target: { value: "42.001" } });
  if (flags.tracked) fireEvent.compositionStart(input);
  expect(fireEvent.keyDown(input, { key: "Enter", ...flags })).toBe(true);
  expect(api.patchProviderTimeoutSettings).not.toHaveBeenCalled();
  expect(input).toHaveValue(42.001);
  expect(input).toHaveFocus();
  if (flags.tracked) fireEvent.compositionEnd(input);
  await user.keyboard("{Enter}");
  expect(api.patchProviderTimeoutSettings).toHaveBeenCalledExactlyOnceWith({ timeoutMs: 42001 });
  await waitFor(() => expect(input).toBeEnabled());
});
