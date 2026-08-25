import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { STORAGE_KEY } from "../preferences";
import { PreferencesProvider, usePreferences } from "../preferences/PreferencesProvider";
import { I18nProvider } from "./I18nProvider";
import { messages } from "./messages";
import { useI18n } from "./useI18n";

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

function SharedPreferenceSwitch() {
  const { updatePreferences } = usePreferences();
  return (
    <button type="button" onClick={() => updatePreferences({ language: "zh-CN" })}>
      update shared language
    </button>
  );
}

function NewCopyProbe() {
  const { t } = useI18n();
  return (
    <div>
      <span data-testid="conversation-copy">{t("settings.conversation.title")}</span>
      <span data-testid="subagent-copy">{t("transcript.subagentProgress")}</span>
    </div>
  );
}

function renderWithProviders(children: React.ReactNode) {
  return render(
    <PreferencesProvider>
      <I18nProvider>{children}</I18nProvider>
    </PreferencesProvider>,
  );
}

describe("i18n", () => {
  beforeEach(() => window.localStorage.clear());

  it("defaults to the browser language when nothing is stored", () => {
    renderWithProviders(<Probe />);
    expect(screen.getByTestId("lang").textContent).toBe("en");
    expect(screen.getByTestId("label").textContent).toBe("Language");
  });

  it("switches language, persists it, and updates html lang", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Probe />);
    await user.click(screen.getByRole("button", { name: "switch" }));
    expect(screen.getByTestId("lang").textContent).toBe("zh-CN");
    expect(screen.getByTestId("label").textContent).toBe("语言");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}")).toMatchObject({ language: "zh-CN" });
  });

  it("reads a stored language on mount", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ chatFontSize: 13, filesFontSize: 12, language: "zh-CN" }),
    );
    renderWithProviders(<Probe />);
    expect(screen.getByTestId("label").textContent).toBe("语言");
  });

  it("follows language updates from the shared preferences source", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <Probe />
        <SharedPreferenceSwitch />
      </>,
    );

    await user.click(screen.getByRole("button", { name: "update shared language" }));

    expect(screen.getByTestId("lang").textContent).toBe("zh-CN");
    expect(screen.getByTestId("label").textContent).toBe("语言");
  });

  it("translates conversation settings and subagent transcript copy", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <Probe />
        <NewCopyProbe />
      </>,
    );
    expect(screen.getByTestId("conversation-copy")).toHaveTextContent("Conversation");
    expect(screen.getByTestId("subagent-copy")).toHaveTextContent("Subagent progress");

    await user.click(screen.getByRole("button", { name: "switch" }));

    expect(screen.getByTestId("conversation-copy")).toHaveTextContent("对话");
    expect(screen.getByTestId("subagent-copy")).toHaveTextContent("子智能体进展");
  });

  it("keeps project, session, and reasoning-state terms distinct in both languages", () => {
    const english = messages.en as Record<string, string>;
    const chinese = messages["zh-CN"] as Record<string, string>;

    expect(english["home.newProject"]).toBe("New project");
    expect(english["home.newSession"]).toBe("New session");
    expect(english["dialog.createProject"]).toBe("New project");
    expect(english["dialog.createSession"]).toBe("Create session");
    expect(english["config.newFolder"]).toBe("New folder");
    expect(english["transcript.thinkingProcess"]).toBe("Thinking process");
    expect(english["transcript.showDetails"]).toBe("Show details");
    expect(english["transcript.hideDetails"]).toBe("Hide details");
    expect(chinese["home.newProject"]).toBe("新增项目");
    expect(chinese["home.newSession"]).toBe("新增会话");
    expect(chinese["dialog.createProject"]).toBe("新增项目");
    expect(chinese["dialog.createSession"]).toBe("创建会话");
    expect(chinese["config.newFolder"]).toBe("新建文件夹");
    expect(chinese["transcript.thinking"]).toBe("思考中");
    expect(chinese["transcript.thinkingProcess"]).toBe("思考过程");
    expect(chinese["transcript.showDetails"]).toBe("显示详情");
    expect(chinese["transcript.hideDetails"]).toBe("隐藏详情");
  });

  it("falls back to en without a provider", () => {
    render(<Probe />);
    expect(screen.getByTestId("label").textContent).toBe("Language");
  });

  it("translates retry banner strings in both languages", () => {
    expect(messages.en["work.retrying"].replace("{attempt}", "2").replace("{maxAttempts}", "3")).toBe(
      "Retrying API call 2/3",
    );
    expect(messages["zh-CN"]["work.retrying"].replace("{attempt}", "2").replace("{maxAttempts}", "3")).toBe(
      "API 调用失败，正在重试 2/3",
    );
  });
});
