import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/I18nProvider";
import { PreferencesProvider } from "../preferences/PreferencesProvider";
import type { RetryView } from "../session-reducer";
import { RetryBanner } from "./RetryBanner";

const retryView: RetryView = {
  attempt: 2,
  maxAttempts: 3,
  errorMessage: "rate limit exceeded",
  endsAt: Date.now() + 3000,
};

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
});

describe("RetryBanner", () => {
  it("renders attempt count and error summary", () => {
    renderBanner(retryView);
    expect(screen.getByText("Retrying API call 2/3")).toBeTruthy();
    expect(screen.getByText("rate limit exceeded")).toBeTruthy();
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("shows the full error in the title attribute", () => {
    renderBanner(retryView);
    expect(screen.getByText("rate limit exceeded").getAttribute("title")).toBe("rate limit exceeded");
  });

  it("counts down every second from the endsAt deadline", () => {
    renderBanner(retryView);
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
    renderBanner({ ...retryView, endsAt: Date.now() - 1000 });
    expect(screen.getByText("retrying now…")).toBeTruthy();
  });
});
