// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "./SettingsPage";
import * as api from "../api";
import { I18nProvider } from "../i18n/I18nProvider";
import { readPreferences, STORAGE_KEY } from "../preferences";
import { PreferencesProvider } from "../preferences/PreferencesProvider";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    getWebuiSettings: vi.fn(),
    updateWebuiSettings: vi.fn(),
    listAgents: vi.fn(),
    listModels: vi.fn(),
  };
});

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(api.getWebuiSettings).mockReset();
  vi.mocked(api.updateWebuiSettings).mockReset();
  vi.mocked(api.listAgents).mockReset();
  vi.mocked(api.listModels).mockReset();
  vi.mocked(api.getWebuiSettings).mockResolvedValue({
    agentModels: { search: "openai/gpt-4o" },
    orchestratorModel: null,
    effectiveOrchestratorModel: "openai/gpt-4o",
  } as never);
  vi.mocked(api.listAgents).mockResolvedValue([
    { name: "orchestrator", description: "Coordinates" },
    { name: "search", description: "Searches" },
    { name: "writing", description: "Writes" },
  ] as never);
  vi.mocked(api.listModels).mockResolvedValue([
    { provider: "openai", id: "gpt-4o" },
    { provider: "anthropic", id: "claude-sonnet-4" },
  ] as never);
});

function renderSettings(onOpenConfigPage: () => void = () => {}, onHome: () => void = () => {}) {
  return render(
    <PreferencesProvider>
      <I18nProvider>
        <SettingsPage onBack={onHome} onOpenConfigPage={onOpenConfigPage} />
      </I18nProvider>
    </PreferencesProvider>,
  );
}

describe("SettingsPage", () => {
  it("navigates Home and starts settings content 4px below the topbar", async () => {
    const onHome = vi.fn();
    const user = userEvent.setup();
    renderSettings(() => {}, onHome);

    await user.click(screen.getByRole("button", { name: /back to home/i }));
    expect(onHome).toHaveBeenCalledOnce();
    const appearance = screen.getByRole("region", { name: "Appearance" });
    const pageContent = appearance.parentElement?.parentElement;
    expect(pageContent).toHaveClass("px-4", "pb-4", "pt-[4px]");
    expect(pageContent).not.toHaveClass("p-4");
  });

  it("renders default font sizes with steppers and a preview", async () => {
    renderSettings();
    expect(screen.getByText("Chat font size")).toBeTruthy();
    expect(screen.getByText("Files font size")).toBeTruthy();
    expect(screen.getByText("13px")).toBeTruthy();
    expect(screen.getByText("12px")).toBeTruthy();
    expect(screen.getByText(/lazy dog/)).toBeTruthy();
    expect(screen.getByText(/index\.ts/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Decrease chat font size" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Increase chat font size" })).not.toBeDisabled();
  });

  it("reads stored font sizes from localStorage", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ chatFontSize: 16, filesFontSize: 11, language: "en" }));
    renderSettings();
    expect(screen.getByText("16px")).toBeTruthy();
    expect(screen.getByText("11px")).toBeTruthy();
  });

  it("persists and applies font size changes without a backend call", async () => {
    const user = userEvent.setup();
    renderSettings();
    await user.click(screen.getByRole("button", { name: "Increase chat font size" }));
    expect(screen.getByText("14px")).toBeTruthy();
    expect(document.documentElement.style.getPropertyValue("--v2-chat-font-size")).toBe("14px");
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}")).toMatchObject({ chatFontSize: 14 });
    expect(api.updateWebuiSettings).not.toHaveBeenCalled();
  });

  it("persists each conversation expansion preference independently", async () => {
    const user = userEvent.setup();
    renderSettings();

    const thinking = screen.getByRole("switch", { name: /auto-expand thinking/i });
    const tools = screen.getByRole("switch", { name: /auto-expand tool output/i });
    const subagent = screen.getByRole("switch", { name: /expand subagent output/i });
    expect(thinking).toHaveAttribute("aria-checked", "false");
    expect(tools).toHaveAttribute("aria-checked", "false");
    expect(subagent).toHaveAttribute("aria-checked", "false");

    await user.click(thinking);
    expect(readPreferences(window.localStorage, () => "en")).toMatchObject({
      autoExpandThinking: true,
      autoExpandTools: false,
      expandSubagentOutput: false,
    });

    await user.click(tools);
    expect(readPreferences(window.localStorage, () => "en")).toMatchObject({
      autoExpandThinking: true,
      autoExpandTools: true,
      expandSubagentOutput: false,
    });

    await user.click(subagent);
    expect(readPreferences(window.localStorage, () => "en")).toMatchObject({
      autoExpandThinking: true,
      autoExpandTools: true,
      expandSubagentOutput: true,
    });
  });

  it("contains all switch thumbs with fixed pixel geometry in both states", async () => {
    const user = userEvent.setup();
    renderSettings();
    const switches = [
      screen.getByRole("switch", { name: /auto-expand thinking/i }),
      screen.getByRole("switch", { name: /auto-expand tool output/i }),
      screen.getByRole("switch", { name: /expand subagent output/i }),
    ];

    for (const track of switches) {
      const thumb = track.querySelector("[aria-hidden]");
      expect(track).toHaveClass("h-[20px]", "w-[36px]", "overflow-hidden");
      expect(thumb).toHaveClass("left-0", "top-[2px]", "size-[16px]", "translate-x-[2px]");
      await user.click(track);
      expect(thumb).toHaveClass("translate-x-[18px]");
      expect(track).toHaveAttribute("aria-checked", "true");
    }
  });

  it("follows font preference changes from another tab", async () => {
    renderSettings();
    await screen.findByRole("combobox", { name: "Select model for Search" });
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      chatFontSize: 16,
      filesFontSize: 11,
      language: "en",
      autoExpandThinking: false,
      autoExpandTools: false,
      expandSubagentOutput: false,
    }));

    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
    });

    expect(screen.getByText("16px")).toBeTruthy();
    expect(screen.getByText("11px")).toBeTruthy();
  });

  it("disables the increase button at the max bound", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ chatFontSize: 20, filesFontSize: 12, language: "en" }));
    const user = userEvent.setup();
    renderSettings();
    expect(screen.getByRole("button", { name: "Increase chat font size" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Decrease chat font size" }));
    expect(screen.getByText("19px")).toBeTruthy();
  });

  it("disables the decrease button at the min bound", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ chatFontSize: 10, filesFontSize: 12, language: "en" }));
    const user = userEvent.setup();
    renderSettings();
    expect(screen.getByRole("button", { name: "Decrease chat font size" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Increase chat font size" }));
    expect(screen.getByText("11px")).toBeTruthy();
  });

  it("switches the interface language and persists it", async () => {
    const user = userEvent.setup();
    renderSettings();
    await user.click(screen.getByRole("button", { name: "简体中文" }));
    expect(screen.getByText("外观")).toBeTruthy();
    expect(screen.getByText("语言")).toBeTruthy();
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}")).toMatchObject({ language: "zh-CN" });
  });

  it("shows stage agents with their configured model and the orchestrator settable", async () => {
    renderSettings();
    await screen.findByRole("combobox", { name: "Select model for Search" });
    expect(screen.getByRole("combobox", { name: "Select model for Search" })).toHaveValue("openai/gpt-4o");
    expect(screen.getByRole("combobox", { name: "Select model for Writing" })).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "Select model for Orchestrator" })).toHaveValue("openai/gpt-4o");
  });

  it("includes a configured stage model that is absent from the model catalog", async () => {
    vi.mocked(api.getWebuiSettings).mockResolvedValue({
      agentModels: { search: "custom/missing-model" },
      orchestratorModel: null,
      effectiveOrchestratorModel: "openai/gpt-4o",
    } as never);
    renderSettings();

    const searchModel = await screen.findByRole("combobox", { name: "Select model for Search" });
    expect(searchModel).toHaveValue("custom/missing-model");
    expect(within(searchModel).getByRole("option", { name: "custom/missing-model" })).toBeTruthy();
  });

  it("localizes model select labels with localized agent names", async () => {
    const user = userEvent.setup();
    renderSettings();
    await user.click(screen.getByRole("button", { name: "简体中文" }));

    expect(await screen.findByRole("combobox", { name: "选择模型： 编排者" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "选择模型： 检索" })).toBeTruthy();
  });

  it("pins the orchestrator to the first Agent models row regardless of API order", async () => {
    vi.mocked(api.listAgents).mockResolvedValue([
      { name: "writing", description: "Writes" },
      { name: "orchestrator", description: "Coordinates" },
      { name: "search", description: "Searches" },
    ] as never);
    renderSettings();
    await screen.findByRole("combobox", { name: "Select model for Orchestrator" });
    const orchestratorBox = screen.getByRole("combobox", { name: "Select model for Orchestrator" });
    const searchBox = screen.getByRole("combobox", { name: "Select model for Search" });
    expect(orchestratorBox.compareDocumentPosition(searchBox) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("shows the configured orchestrator default without any inherit option", async () => {
    vi.mocked(api.getWebuiSettings).mockResolvedValue({
      agentModels: { search: "openai/gpt-4o" },
      orchestratorModel: "openai/gpt-4o",
      effectiveOrchestratorModel: "openai/gpt-4o",
    } as never);
    renderSettings();
    const combobox = await screen.findByRole("combobox", { name: "Select model for Orchestrator" });
    expect(combobox).toHaveValue("openai/gpt-4o");
    expect(within(combobox).queryAllByRole("option", { name: /inherit/i })).toHaveLength(0);
  });

  it("auto-selects the effective Pi model when no orchestrator default is configured", async () => {
    vi.mocked(api.getWebuiSettings).mockResolvedValue({
      agentModels: {},
      orchestratorModel: null,
      effectiveOrchestratorModel: "anthropic/claude-opus-4-8",
    } as never);
    renderSettings();
    const combobox = await screen.findByRole("combobox", { name: "Select model for Orchestrator" });
    expect(combobox).toHaveValue("anthropic/claude-opus-4-8");
    expect(within(combobox).getAllByRole("option", { name: "anthropic/claude-opus-4-8" })).toHaveLength(1);
    expect(within(combobox).queryAllByRole("option", { name: /inherit/i })).toHaveLength(0);
  });

  it("auto-selects a default already in the catalog without duplicating it", async () => {
    vi.mocked(api.getWebuiSettings).mockResolvedValue({
      agentModels: {},
      orchestratorModel: null,
      effectiveOrchestratorModel: "openai/gpt-4o",
    } as never);
    renderSettings();
    const combobox = await screen.findByRole("combobox", { name: "Select model for Orchestrator" });
    expect(combobox).toHaveValue("openai/gpt-4o");
    expect(within(combobox).queryAllByRole("option", { name: "openai/gpt-4o" })).toHaveLength(1);
  });

  it("sets the orchestrator default via an orchestratorModel patch", async () => {
    const user = userEvent.setup();
    vi.mocked(api.updateWebuiSettings).mockResolvedValue({
      agentModels: { search: "openai/gpt-4o" },
      orchestratorModel: "anthropic/claude-sonnet-4",
      effectiveOrchestratorModel: "anthropic/claude-sonnet-4",
    } as never);
    renderSettings();
    await screen.findByRole("combobox", { name: "Select model for Orchestrator" });
    await user.selectOptions(screen.getByRole("combobox", { name: "Select model for Orchestrator" }), "anthropic/claude-sonnet-4");
    await waitFor(() =>
      expect(api.updateWebuiSettings).toHaveBeenCalledWith({ orchestratorModel: "anthropic/claude-sonnet-4" }),
    );
    expect(screen.getByRole("combobox", { name: "Select model for Orchestrator" })).toHaveValue("anthropic/claude-sonnet-4");
  });

  it("sets a stage agent model via agentModels patch", async () => {
    const user = userEvent.setup();
    vi.mocked(api.updateWebuiSettings).mockResolvedValue({
      agentModels: { search: "openai/gpt-4o", writing: "anthropic/claude-sonnet-4" },
    } as never);
    renderSettings();
    await screen.findByRole("combobox", { name: "Select model for Writing" });
    await user.selectOptions(screen.getByRole("combobox", { name: "Select model for Writing" }), "anthropic/claude-sonnet-4");
    await waitFor(() =>
      expect(api.updateWebuiSettings).toHaveBeenCalledWith({
        agentModels: { search: "openai/gpt-4o", writing: "anthropic/claude-sonnet-4" },
      }),
    );
  });

  it("surfaces an agentModels update failure", async () => {
    const user = userEvent.setup();
    vi.mocked(api.updateWebuiSettings).mockRejectedValueOnce(new Error("boom"));
    renderSettings();
    await screen.findByRole("combobox", { name: "Select model for Search" });
    await user.selectOptions(screen.getByRole("combobox", { name: "Select model for Search" }), "");
    expect(await screen.findByText(/boom/)).toBeTruthy();
  });

  it("opens the JSON config editor from its button", async () => {
    const user = userEvent.setup();
    const onOpenConfigPage = vi.fn();
    renderSettings(onOpenConfigPage);
    await user.click(screen.getByRole("button", { name: /edit.*json/i }));
    expect(onOpenConfigPage).toHaveBeenCalled();
  });
});
