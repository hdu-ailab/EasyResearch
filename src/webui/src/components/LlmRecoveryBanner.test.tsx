import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LlmRecoveryDto } from "../../../web/contracts";
import * as api from "../api";
import { I18nProvider } from "../i18n/I18nProvider";
import { STORAGE_KEY } from "../preferences";
import { PreferencesProvider } from "../preferences/PreferencesProvider";
import { ViewActivityProvider } from "../view-activity";
import { LlmRecoveryBanner } from "./LlmRecoveryBanner";

vi.mock("../api", async (original) => ({ ...(await original<typeof import("../api")>()), retryModelRequest: vi.fn() }));
beforeEach(() => {
  vi.mocked(api.retryModelRequest).mockReset();
});
afterEach(() => window.localStorage.clear());

const recovery: LlmRecoveryDto = {
  targetSessionId: "child",
  failureId: "f1",
  failedEntryId: "entry",
  status: "available",
};
const props = () => ({
  rootId: "root",
  targetSessionId: "child",
  agentLabel: "custom_2",
  parentHydrationRevision: 1,
  hydrationRevision: 1,
  recovery: recovery as LlmRecoveryDto | null,
  enabled: true,
  refresh: vi.fn(),
  returnFocus: vi.fn(),
});

it("keeps native button focus during admission and rejects repeated keyboard activation", async () => {
  const user = userEvent.setup();
  let resolve!: (value: { accepted: true; targetSessionId: string; failureId: string }) => void;
  vi.mocked(api.retryModelRequest).mockReturnValue(
    new Promise((yes) => {
      resolve = yes;
    }),
  );
  const initial = props();
  const mounted = render(<LlmRecoveryBanner {...initial} />);
  const button = screen.getByRole("button", { name: "Retry model request" });
  button.focus();
  await user.keyboard("{Enter}{Enter} ");
  expect(api.retryModelRequest).toHaveBeenCalledOnce();
  expect(button).toHaveFocus();
  expect(button).toHaveAttribute("aria-disabled", "true");
  expect(button).toHaveAccessibleDescription("custom_2 · Starting retry…");
  await act(async () => resolve({ accepted: true, targetSessionId: "child", failureId: "f1" }));
  expect(button).toHaveFocus();
  mounted.rerender(<LlmRecoveryBanner {...initial} recovery={null} />);
  expect(initial.returnFocus).toHaveBeenCalledOnce();
  expect(screen.queryByRole("button", { name: "Retry model request" })).toBeNull();
});

it("does not restore focus from an inactive or disposed view", () => {
  const initial = props();
  const view = (visible: boolean) => (
    <ViewActivityProvider visible={visible} interactive={visible}>
      <LlmRecoveryBanner {...initial} />
    </ViewActivityProvider>
  );
  const mounted = render(view(true));
  screen.getByRole("button", { name: "Retry model request" }).focus();
  mounted.rerender(view(false));
  mounted.unmount();
  expect(initial.returnFocus).not.toHaveBeenCalled();
});

it("renders the Chinese action label with the same scoped authority", () => {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ language: "zh-CN" }));
  render(
    <PreferencesProvider>
      <I18nProvider>
        <LlmRecoveryBanner {...props()} />
      </I18nProvider>
    </PreferencesProvider>,
  );
  expect(screen.getByRole("button", { name: "重试模型请求" })).toBeTruthy();
});
