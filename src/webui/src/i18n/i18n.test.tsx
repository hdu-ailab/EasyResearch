// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { I18nProvider } from "./I18nProvider";
import { useI18n } from "./useI18n";
import { STORAGE_KEY } from "../preferences";

function Probe() {
  const { t, language, setLanguage } = useI18n();
  return (
    <div>
      <span data-testid="lang">{language}</span>
      <span data-testid="label">{t("settings.language.title")}</span>
      <button type="button" onClick={() => setLanguage("zh-CN")}>
        switch
      </button>
    </div>
  );
}

describe("i18n", () => {
  beforeEach(() => window.localStorage.clear());

  it("defaults to the browser language when nothing is stored", () => {
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByTestId("lang").textContent).toBe("en");
    expect(screen.getByTestId("label").textContent).toBe("Language");
  });

  it("switches language, persists it, and updates html lang", async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    await user.click(screen.getByRole("button", { name: "switch" }));
    expect(screen.getByTestId("lang").textContent).toBe("zh-CN");
    expect(screen.getByTestId("label").textContent).toBe("语言");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}")).toMatchObject({ language: "zh-CN" });
  });

  it("reads a stored language on mount", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ chatFontSize: 13, filesFontSize: 12, language: "zh-CN" }));
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByTestId("label").textContent).toBe("语言");
  });

  it("falls back to en without a provider", () => {
    render(<Probe />);
    expect(screen.getByTestId("label").textContent).toBe("Language");
  });
});
