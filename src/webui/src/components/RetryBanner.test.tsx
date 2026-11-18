import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/I18nProvider";
import { PreferencesProvider } from "../preferences/PreferencesProvider";
import type { RetryView } from "../session-reducer";
import { ViewActivityProvider } from "../view-activity";
import { RetryBanner } from "./RetryBanner";

function createRetryView(): RetryView {
  return {
    attempt: 2,
    maxAttempts: 3,
    errorMessage: "rate limit exceeded",
    endsAt: Date.now() + 3000,
  };
}

function renderBanner(retry: RetryView) {
  return render(
    <PreferencesProvider>
      <I18nProvider>
        <RetryBanner retry={retry} />
      </I18nProvider>
    </PreferencesProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("RetryBanner", () => {
  it("renders attempt count and error summary", () => {
    renderBanner(createRetryView());
    expect(screen.getByText("Retrying API call 2/3")).toBeTruthy();
    expect(screen.getByText("rate limit exceeded")).toBeTruthy();
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("shows the full error in the title attribute", () => {
    renderBanner(createRetryView());
    expect(screen.getByText("rate limit exceeded").getAttribute("title")).toBe("rate limit exceeded");
  });

  it("counts down every second from the endsAt deadline", () => {
    renderBanner(createRetryView());
    expect(screen.getByText("retrying in 3s")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText("retrying in 2s")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByText("retrying now…")).toBeTruthy();
  });

  it("renders the countdown from an already-elapsed deadline", () => {
    renderBanner({ ...createRetryView(), endsAt: Date.now() - 1000 });
    expect(screen.getByText("retrying now…")).toBeTruthy();
  });

  it("announces attempts without per-second live-region updates and stops when hidden or elapsed", () => {
    const retry = createRetryView();
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    const view = (visible: boolean) => (
      <ViewActivityProvider visible={visible} interactive={visible}>
        <RetryBanner retry={retry} agentLabel="custom_2" />
      </ViewActivityProvider>
    );
    const mounted = render(view(true));
    const announcement = screen.getByRole("status").textContent;
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByRole("status").textContent).toBe(announcement);
    expect(screen.getByText("retrying in 2s")).toHaveAttribute("aria-live", "off");
    visibility = "hidden";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText("retrying in 2s")).toBeTruthy();
    visibility = "visible";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(screen.getByText("retrying in 1s")).toBeTruthy();
    mounted.rerender(view(false));
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(2000));
    mounted.rerender(view(true));
    expect(screen.getByText("retrying now…")).toBeTruthy();
    expect(vi.getTimerCount()).toBe(0);
  });
});
