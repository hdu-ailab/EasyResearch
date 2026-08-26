import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { I18nProvider } from "../i18n/I18nProvider";
import { readPreferences, STORAGE_KEY } from "../preferences";
import { PreferencesProvider } from "../preferences/PreferencesProvider";
import { SettingsPage } from "./SettingsPage";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    patchAgent: vi.fn(),
    getCompactionSettings: vi.fn(),
    patchCompactionSettings: vi.fn(),
    getApiUsageSettings: vi.fn(),
    patchApiUsageSettings: vi.fn(),
    listAgents: vi.fn(),
    listModels: vi.fn(),
    listAgentResources: vi.fn(),
    readAgentResource: vi.fn(),
    writeAgentResource: vi.fn(),
    createAgentResource: vi.fn(),
    listConfigProjects: vi.fn(),
    listSkillResources: vi.fn(),
    readSkillResource: vi.fn(),
    writeSkillResource: vi.fn(),
    listAuthProviders: vi.fn(),
  };
});

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(api.patchAgent).mockReset();
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
  vi.mocked(api.getApiUsageSettings).mockReset().mockResolvedValue({ showApiUsageDetails: false });
  vi.mocked(api.patchApiUsageSettings)
    .mockReset()
    .mockImplementation(async ({ showApiUsageDetails }) => ({ showApiUsageDetails }));
  vi.mocked(api.listAgents).mockReset();
  vi.mocked(api.listModels).mockReset();
  vi.mocked(api.listAgentResources).mockReset();
  vi.mocked(api.readAgentResource).mockReset();
  vi.mocked(api.writeAgentResource).mockReset();
  vi.mocked(api.createAgentResource).mockReset();
  vi.mocked(api.listConfigProjects).mockReset();
  vi.mocked(api.listSkillResources).mockReset();
  vi.mocked(api.readSkillResource).mockReset();
  vi.mocked(api.writeSkillResource).mockReset();
  vi.mocked(api.listAuthProviders).mockReset();
  vi.mocked(api.listAgents).mockResolvedValue([
    {
      name: "research-assistant",
      description: "Coordinates",
      enabled: true,
      builtin: true,
      source: "bundled",
      filePath: "src/agents/research-assistant.md",
      effectiveModel: "openai/gpt-4o",
      effectiveTools: [],
      effectiveSkills: [],
      missingSkills: [],
    },
    {
      name: "search",
      description: "Searches",
      enabled: true,
      builtin: true,
      source: "global",
      filePath: "/agent/agents/search.md",
      model: "openai/gpt-4o",
      effectiveModel: "openai/gpt-4o",
      thinking: "high",
      effectiveTools: ["read", "web-search"],
      effectiveSkills: ["paper-search", "arxiv"],
      missingSkills: [],
    },
    {
      name: "writing",
      description: "Writes",
      enabled: true,
      builtin: true,
      source: "bundled",
      filePath: "src/agents/writing.md",
      effectiveModel: "openai/gpt-4o",
      effectiveTools: [],
      effectiveSkills: [],
      missingSkills: [],
    },
  ]);
  vi.mocked(api.listModels).mockResolvedValue([
    { provider: "openai", id: "gpt-4o", reasoning: true, thinkingLevelMap: {} },
    { provider: "anthropic", id: "claude-sonnet-4", reasoning: false, thinkingLevelMap: {} },
  ] as never);
  vi.mocked(api.patchAgent).mockImplementation(async (name, patch) => {
    const agent = (await api.listAgents()).find((item) => item.name === name)!;
    const next = { ...agent };
    if (patch.model === null) delete next.model;
    else if (patch.model !== undefined) next.model = patch.model;
    if (patch.thinking === null) delete next.thinking;
    else if (patch.thinking !== undefined) next.thinking = patch.thinking;
    return next;
  });
  vi.mocked(api.listAgentResources).mockResolvedValue([] as never);
  vi.mocked(api.readAgentResource).mockResolvedValue({
    name: "search",
    description: "Searches",
    enabled: true,
    builtin: true,
    source: "bundled",
    filePath: "src/agents/search.md",
    effectiveTools: ["read", "web-search"],
    effectiveSkills: ["paper-search", "arxiv"],
    missingSkills: [],
    content: "---\nname: search\ndescription: Searches\nenable: true\n---\nPrompt\n",
  });
  vi.mocked(api.writeAgentResource).mockResolvedValue({} as never);
  vi.mocked(api.createAgentResource).mockResolvedValue({
    name: "reviewer",
    description: "reviewer agent",
    enabled: true,
    builtin: false,
    source: "global",
    filePath: "/agent/agents/reviewer.md",
    effectiveTools: [],
    effectiveSkills: [],
    missingSkills: [],
    content: "---\nname: reviewer\ndescription: reviewer agent\nenable: true\n---\n",
  });
  vi.mocked(api.listConfigProjects).mockResolvedValue({
    home: "/agent",
    projects: [{ cwd: "/papers/project-a" }, { cwd: "/papers/project-b" }],
  });
  vi.mocked(api.listSkillResources).mockResolvedValue([
    {
      name: "paper-search",
      source: "bundled",
      path: "src/skills/paper-search",
      skillPath: "src/skills/paper-search/SKILL.md",
    },
  ] as never);
  vi.mocked(api.readSkillResource).mockResolvedValue({
    name: "paper-search",
    source: "bundled",
    path: "src/skills/paper-search",
    skillPath: "src/skills/paper-search/SKILL.md",
    content: "# Search skill\n",
  });
  vi.mocked(api.writeSkillResource).mockResolvedValue({} as never);
  vi.mocked(api.listAuthProviders).mockResolvedValue([
    {
      id: "anthropic",
      name: "Anthropic",
      authMethods: ["api_key"],
      connectable: true,
      authStatus: { configured: true },
      modelsJson: false,
    },
    {
      id: "xai",
      name: "xAI",
      authMethods: ["api_key", "oauth"],
      connectable: true,
      authStatus: { configured: false },
      modelsJson: false,
    },
  ] as never);
});

function settingsElement(
  onOpenConfigPage: () => void = () => {},
  onHome: () => void = () => {},
  configurationGeneration = 1,
  configurationError: string | null = null,
) {
  return (
    <PreferencesProvider>
      <I18nProvider>
        <SettingsPage
          onBack={onHome}
          onOpenConfigPage={onOpenConfigPage}
          configurationGeneration={configurationGeneration}
          configurationError={configurationError}
        />
      </I18nProvider>
    </PreferencesProvider>
  );
}

function renderSettings(onOpenConfigPage: () => void = () => {}, onHome: () => void = () => {}) {
  return render(settingsElement(onOpenConfigPage, onHome));
}

async function openAgentConfig(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole("button", { name: `Configure ${name}` }));
  return screen.getByRole("dialog", { name: "Agents" });
}

async function selectModelOption(user: ReturnType<typeof userEvent.setup>, agentName: string, optionName: string) {
  const trigger = screen.getByRole("combobox", { name: `Select model for ${agentName}` });
  await user.click(trigger);
  await user.click(within(screen.getByRole("listbox")).getByRole("option", { name: optionName }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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
    expect(api.patchAgent).not.toHaveBeenCalled();
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

  it("shows the global automatic compaction threshold with conversation preferences", async () => {
    renderSettings();

    const input = await screen.findByRole("spinbutton", { name: /automatic compaction/i });
    expect(input).toHaveValue(70);
    expect(api.getCompactionSettings).toHaveBeenCalledOnce();
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
    await screen.findByRole("button", { name: "Configure Search" });
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        chatFontSize: 16,
        filesFontSize: 11,
        language: "en",
        autoExpandThinking: false,
        autoExpandTools: false,
        expandSubagentOutput: false,
      }),
    );

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

  it("shows stage agents with their configured model while the Research Assistant has no disable switch", async () => {
    const user = userEvent.setup();
    renderSettings();
    await openAgentConfig(user, "Search");
    expect(screen.getByRole("combobox", { name: "Select model for Search" })).toHaveTextContent("openai/gpt-4o");
    expect(screen.getByRole("switch", { name: "Enable Search" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Close editor" }));
    await openAgentConfig(user, "Writing");
    expect(screen.getByRole("combobox", { name: "Select model for Writing" })).toHaveTextContent(
      "inherit (Research Assistant's model)",
    );
    await user.click(screen.getByRole("button", { name: "Close editor" }));
    await openAgentConfig(user, "Research Assistant");
    expect(screen.getByRole("combobox", { name: "Select model for Research Assistant" })).toHaveTextContent(
      "openai/gpt-4o",
    );
    expect(screen.queryByRole("switch", { name: "Enable Research Assistant" })).toBeNull();
  });

  it("includes a configured stage model that is absent from the model catalog", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listAgents).mockResolvedValueOnce([
      {
        name: "search",
        description: "Searches",
        enabled: true,
        builtin: true,
        source: "global",
        filePath: "/agent/agents/search.md",
        model: "custom/missing-model",
        effectiveTools: [],
        effectiveSkills: [],
        missingSkills: [],
      },
    ]);
    renderSettings();

    await openAgentConfig(user, "Search");
    const searchModel = screen.getByRole("combobox", { name: "Select model for Search" });
    expect(searchModel).toHaveTextContent("custom/missing-model");
    await user.click(searchModel);
    expect(screen.getByRole("option", { name: "custom/missing-model" })).toBeTruthy();
  });

  it("localizes model select labels with localized agent names", async () => {
    const user = userEvent.setup();
    renderSettings();
    await user.click(screen.getByRole("button", { name: "简体中文" }));

    await user.click(await screen.findByRole("button", { name: "配置 研究助手" }));
    expect(screen.getByRole("combobox", { name: "选择模型： 研究助手" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "关闭编辑器" }));
    await user.click(await screen.findByRole("button", { name: "配置 检索" }));
    expect(screen.getByRole("combobox", { name: "选择模型： 检索" })).toBeTruthy();
  });

  it("pins the Research Assistant card to the first position regardless of API order", async () => {
    vi.mocked(api.listAgents).mockResolvedValue([
      { name: "writing", description: "Writes" },
      { name: "research-assistant", description: "Coordinates" },
      { name: "search", description: "Searches" },
    ] as never);
    renderSettings();
    await screen.findByRole("button", { name: "Configure Research Assistant" });
    const assistantCard = screen.getByRole("button", { name: "Configure Research Assistant" });
    const searchCard = screen.getByRole("button", { name: "Configure Search" });
    expect(assistantCard.compareDocumentPosition(searchCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("shows the configured Research Assistant default without any inherit option", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listAgents).mockResolvedValueOnce([
      {
        name: "research-assistant",
        description: "Coordinates",
        enabled: true,
        builtin: true,
        source: "global",
        filePath: "/agent/agents/research-assistant.md",
        model: "openai/gpt-4o",
        effectiveTools: [],
        effectiveSkills: [],
        missingSkills: [],
      },
    ]);
    renderSettings();
    await openAgentConfig(user, "Research Assistant");
    const combobox = screen.getByRole("combobox", { name: "Select model for Research Assistant" });
    expect(combobox).toHaveTextContent("openai/gpt-4o");
    await user.click(combobox);
    expect(screen.queryAllByRole("option", { name: /inherit/i })).toHaveLength(0);
  });

  it("selects Pi's resolved Research Assistant model once without persisting it", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listAgents).mockResolvedValueOnce([
      {
        name: "research-assistant",
        description: "Coordinates",
        enabled: true,
        builtin: true,
        source: "bundled",
        filePath: "src/agents/research-assistant.md",
        effectiveModel: "deepseek/deepseek-v4-pro",
        effectiveTools: [],
        effectiveSkills: [],
        missingSkills: [],
      },
    ]);
    vi.mocked(api.listModels).mockResolvedValueOnce([{ provider: "deepseek", id: "deepseek-v4-pro", reasoning: true }]);
    renderSettings();
    await openAgentConfig(user, "Research Assistant");
    const combobox = screen.getByRole("combobox", { name: "Select model for Research Assistant" });
    expect(combobox).toHaveTextContent("deepseek/deepseek-v4-pro");
    await user.click(combobox);
    expect(screen.getAllByRole("option", { name: "deepseek/deepseek-v4-pro" })).toHaveLength(1);
    expect(screen.queryByRole("option", { name: "Automatic (Pi default)" })).toBeNull();
    expect(screen.queryAllByRole("option", { name: /inherit/i })).toHaveLength(0);
    expect(api.patchAgent).not.toHaveBeenCalled();
  });

  it("keeps the Research Assistant model empty and reports when Pi resolves no default", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listAgents).mockResolvedValueOnce([
      {
        name: "research-assistant",
        description: "Coordinates",
        enabled: true,
        builtin: true,
        source: "bundled",
        filePath: "src/agents/research-assistant.md",
        effectiveTools: [],
        effectiveSkills: [],
        missingSkills: [],
      },
    ]);
    renderSettings();
    await openAgentConfig(user, "Research Assistant");
    const combobox = screen.getByRole("combobox", { name: "Select model for Research Assistant" });
    expect(combobox).not.toHaveTextContent("openai/gpt-4o");
    expect(screen.queryByText("Automatic (Pi default)")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not resolve a default model. Configure a model or credentials.",
    );
    expect(screen.getByRole("dialog", { name: "Agents" })).not.toHaveTextContent(/\bPi\b/);
  });

  it("sets the Research Assistant model through the global Agent patch", async () => {
    const user = userEvent.setup();
    vi.mocked(api.patchAgent).mockResolvedValueOnce({
      ...(await api.listAgents())[0]!,
      model: "anthropic/claude-sonnet-4",
    });
    renderSettings();
    await openAgentConfig(user, "Research Assistant");
    await selectModelOption(user, "Research Assistant", "anthropic/claude-sonnet-4");
    await waitFor(() =>
      expect(api.patchAgent).toHaveBeenCalledWith("research-assistant", { model: "anthropic/claude-sonnet-4" }),
    );
    expect(screen.getByRole("combobox", { name: "Select model for Research Assistant" })).toHaveTextContent(
      "anthropic/claude-sonnet-4",
    );
  });

  it("sets a stage model through the same global Agent patch", async () => {
    const user = userEvent.setup();
    vi.mocked(api.patchAgent).mockResolvedValueOnce({
      ...(await api.listAgents())[2]!,
      model: "anthropic/claude-sonnet-4",
    });
    renderSettings();
    await openAgentConfig(user, "Writing");
    await selectModelOption(user, "Writing", "anthropic/claude-sonnet-4");
    await waitFor(() => expect(api.patchAgent).toHaveBeenCalledWith("writing", { model: "anthropic/claude-sonnet-4" }));
  });

  it("renders and patches the per-Agent thinking field", async () => {
    const user = userEvent.setup();
    vi.mocked(api.patchAgent).mockResolvedValueOnce({ ...(await api.listAgents())[1]!, thinking: "low" });
    renderSettings();
    await openAgentConfig(user, "Search");
    const searchThinking = screen.getByRole("combobox", { name: "Select thinking for Search" });
    expect(searchThinking).toHaveValue("high");
    await user.selectOptions(searchThinking, "low");
    await waitFor(() => expect(api.patchAgent).toHaveBeenCalledWith("search", { thinking: "low" }));
  });

  it("clears a thinking default to the off fallback via the empty option", async () => {
    const user = userEvent.setup();
    vi.mocked(api.patchAgent).mockResolvedValueOnce({ ...(await api.listAgents())[1]!, thinking: undefined });
    renderSettings();
    await openAgentConfig(user, "Search");
    const searchThinking = screen.getByRole("combobox", { name: "Select thinking for Search" });
    await user.selectOptions(searchThinking, "");
    await waitFor(() => expect(api.patchAgent).toHaveBeenCalledWith("search", { thinking: null }));
  });

  it("labels empty thinking as highest-supported for Research Assistant and inherited for stages", async () => {
    const user = userEvent.setup();
    renderSettings();
    await openAgentConfig(user, "Search");
    const searchThinking = screen.getByRole("combobox", { name: "Select thinking for Search" });
    expect(within(searchThinking).getByText("inherit (Research Assistant's thinking)")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Close editor" }));
    await openAgentConfig(user, "Research Assistant");
    const assistantThinking = screen.getByRole("combobox", { name: "Select thinking for Research Assistant" });
    expect(within(assistantThinking).getByText("Automatic (highest supported)")).toBeTruthy();
    expect(within(assistantThinking).getByRole("option", { name: "high" })).toBeTruthy();
    expect(within(assistantThinking).queryByRole("option", { name: "max" })).toBeNull();
    expect(within(assistantThinking).queryByText("inherit (Research Assistant's model)")).toBeNull();
  });

  it("surfaces a global Agent patch failure", async () => {
    const user = userEvent.setup();
    vi.mocked(api.patchAgent).mockRejectedValueOnce(new Error("boom"));
    renderSettings();
    await openAgentConfig(user, "Search");
    await selectModelOption(user, "Search", "inherit (Research Assistant's model)");
    expect(await screen.findByText(/boom/)).toBeTruthy();
  });

  it("refreshes the Settings roster on a newer configuration generation", async () => {
    const reviewer = {
      name: "reviewer",
      description: "Reviews evidence",
      enabled: true,
      builtin: false,
      source: "global" as const,
      filePath: "/agent/agents/reviewer.md",
      effectiveTools: [],
      effectiveSkills: [],
      missingSkills: [],
    };
    const view = renderSettings();
    expect(await screen.findByRole("button", { name: "Configure Search" })).toBeVisible();
    vi.mocked(api.listAgentResources).mockResolvedValueOnce([reviewer]);
    vi.mocked(api.listAgents).mockResolvedValueOnce([reviewer]);

    view.rerender(settingsElement(undefined, undefined, 2));

    expect(await screen.findByRole("button", { name: "Configure reviewer" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Configure Search" })).toBeNull();
  });

  it("refreshes the connected provider count on a newer configuration generation", async () => {
    const view = renderSettings();
    expect(await screen.findByText("1 providers connected")).toBeVisible();
    vi.mocked(api.listAuthProviders).mockResolvedValueOnce([
      {
        id: "anthropic",
        name: "Anthropic",
        authMethods: ["api_key"],
        connectable: true,
        authStatus: { configured: true },
        modelsJson: false,
      },
      {
        id: "xai",
        name: "xAI",
        authMethods: ["api_key", "oauth"],
        connectable: true,
        authStatus: { configured: true },
        modelsJson: false,
      },
    ] as never);

    view.rerender(settingsElement(undefined, undefined, 2));

    expect(await screen.findByText("2 providers connected")).toBeVisible();
  });

  it("retains last-good Settings controls while configuration is malformed", async () => {
    const view = renderSettings();
    expect(await screen.findByRole("button", { name: "Configure Search" })).toBeVisible();

    view.rerender(settingsElement(undefined, undefined, 1, "Invalid Agent configuration"));

    expect(screen.getByRole("alert")).toHaveTextContent("Invalid Agent configuration");
    expect(screen.getByRole("button", { name: "Configure Search" })).toBeVisible();
  });

  it("opens the JSON config editor from its button", async () => {
    const user = userEvent.setup();
    const onOpenConfigPage = vi.fn();
    renderSettings(onOpenConfigPage);
    await user.click(screen.getByRole("button", { name: /open config browser/i }));
    expect(onOpenConfigPage).toHaveBeenCalled();
  });

  it("shows pinned agents with effective tool and skill counts and details", async () => {
    vi.mocked(api.listAgents).mockResolvedValue([
      {
        name: "reviewer",
        description: "Reviews",
        enabled: false,
        builtin: false,
        source: "global",
        filePath: "/agent/agents/reviewer.md",
        effectiveTools: ["read"],
        effectiveSkills: ["review"],
      },
      {
        name: "search",
        description: "Searches",
        enabled: true,
        builtin: true,
        source: "bundled",
        filePath: "src/agents/search.md",
        effectiveTools: ["read", "web-search"],
        effectiveSkills: ["paper-search", "arxiv"],
      },
      {
        name: "research-assistant",
        description: "Coordinates",
        enabled: true,
        builtin: true,
        source: "bundled",
        filePath: "src/agents/research-assistant.md",
        effectiveTools: ["read"],
        effectiveSkills: ["workflow"],
      },
    ] as never);
    renderSettings();
    expect(await screen.findByText("2 tools, 2 skills")).toBeTruthy();
    expect(screen.getByText("2 tools, 2 skills")).toBeTruthy();
    expect(screen.getAllByText("1 tools, 1 skills").length).toBeGreaterThan(0);
    const names = screen
      .getAllByRole("button", { name: /configure .*assistant|configure search|configure reviewer/i })
      .map((node) => node.getAttribute("aria-label"));
    expect(names.indexOf("Configure Research Assistant")).toBeLessThan(names.indexOf("Configure reviewer"));
  });

  it("opens and saves a complete agent Markdown definition", async () => {
    const user = userEvent.setup();
    renderSettings();
    await openAgentConfig(user, "Search");
    await user.click(screen.getByRole("button", { name: "Edit Search" }));
    const editor = await screen.findByRole("textbox", { name: /agent markdown/i });
    await user.clear(editor);
    await user.type(editor, "---\nname: search\ndescription: Updated\nenable: true\n---\nNew prompt\n");
    await user.click(screen.getByRole("button", { name: /save agent/i }));
    expect(api.writeAgentResource).toHaveBeenCalledWith(
      "search",
      "---\nname: search\ndescription: Updated\nenable: true\n---\nNew prompt\n",
    );
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "search" })).toBeNull());
  });

  it("creates a new agent and opens its Markdown editor", async () => {
    const user = userEvent.setup();
    renderSettings();
    await user.click(screen.getByRole("button", { name: /add agent/i }));
    await user.type(screen.getByRole("dialog").querySelector("input")!, "reviewer");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /create/i }));
    expect(api.createAgentResource).toHaveBeenCalledWith("reviewer");
    expect(await screen.findByRole("textbox", { name: /agent markdown/i })).toHaveValue(
      "---\nname: reviewer\ndescription: reviewer agent\nenable: true\n---\n",
    );
  });

  it("copies a bundled skill when its editor is opened and saves its Markdown", async () => {
    const user = userEvent.setup();
    renderSettings();
    await user.click(await screen.findByRole("button", { name: /edit skill.*paper-search/i }));
    const editor = await screen.findByRole("textbox", { name: /skill markdown/i });
    await user.clear(editor);
    await user.type(editor, "# Updated skill\n");
    await user.click(screen.getByRole("button", { name: /save skill/i }));
    expect(api.writeSkillResource).toHaveBeenCalledWith("paper-search", "# Updated skill\n");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "paper-search" })).toBeNull());
  });

  it("refreshes current Global diagnostics after a successful Agent save", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listAgents)
      .mockResolvedValueOnce([{ name: "search", description: "Searches", missingSkills: ["before-save"] }] as never)
      .mockResolvedValueOnce([{ name: "search", description: "Searches", missingSkills: ["after-save"] }] as never);
    renderSettings();
    expect(await screen.findByText("before-save")).toBeVisible();

    await openAgentConfig(user, "Search");
    await user.click(screen.getByRole("button", { name: "Edit Search" }));
    await user.click(screen.getByRole("button", { name: /save agent/i }));

    expect(await screen.findByText("after-save")).toBeVisible();
    expect(screen.queryByText("before-save")).toBeNull();
    expect(api.listAgents).toHaveBeenLastCalledWith(undefined);
  });

  it("refreshes the selected project diagnostics after a successful global Skill save", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listAgents)
      .mockResolvedValueOnce([{ name: "search", description: "Searches", missingSkills: ["global-missing"] }] as never)
      .mockResolvedValueOnce([
        { name: "writing", description: "Writes", missingSkills: ["before-skill-save"] },
      ] as never)
      .mockResolvedValueOnce([
        { name: "writing", description: "Writes", missingSkills: ["after-skill-save"] },
      ] as never);
    renderSettings();
    const scope = await screen.findByRole("combobox", { name: "Skill diagnostic scope" });
    await user.selectOptions(scope, "/papers/project-a");
    expect(await screen.findByText("before-skill-save")).toBeVisible();

    await user.click(await screen.findByRole("button", { name: /edit skill.*paper-search/i }));
    await user.click(screen.getByRole("button", { name: /save skill/i }));

    expect(await screen.findByText("after-skill-save")).toBeVisible();
    expect(api.listAgents).toHaveBeenLastCalledWith("/papers/project-a");
    expect(api.listSkillResources).toHaveBeenCalledTimes(2);
  });

  it("does not let a pre-save diagnostic response overwrite the post-save refresh", async () => {
    const user = userEvent.setup();
    const stale = deferred<Awaited<ReturnType<typeof api.listAgents>>>();
    vi.mocked(api.listAgents)
      .mockResolvedValueOnce([{ name: "search", description: "Searches", missingSkills: ["global-missing"] }] as never)
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce([
        { name: "writing", description: "Writes", missingSkills: ["fresh-after-save"] },
      ] as never);
    renderSettings();
    const scope = await screen.findByRole("combobox", { name: "Skill diagnostic scope" });
    await user.selectOptions(scope, "/papers/project-a");
    await user.click(await screen.findByRole("button", { name: /edit skill.*paper-search/i }));
    await user.click(screen.getByRole("button", { name: /save skill/i }));
    expect(await screen.findByText("fresh-after-save")).toBeVisible();

    await act(async () => {
      stale.resolve([{ name: "writing", description: "Writes", missingSkills: ["stale-before-save"] }] as never);
      await stale.promise;
    });
    expect(screen.getByText("fresh-after-save")).toBeVisible();
    expect(screen.queryByText("stale-before-save")).toBeNull();
  });

  it("defaults Skill diagnostics to Global and groups affected Agents by missing Skill", async () => {
    vi.mocked(api.listAgents).mockResolvedValue([
      { name: "search", description: "Searches", missingSkills: ["missing-skill"] },
      { name: "writing", description: "Writes", missingSkills: ["missing-skill"] },
    ] as never);

    renderSettings();

    const scope = await screen.findByRole("combobox", { name: "Skill diagnostic scope" });
    expect(scope).toHaveValue("global");
    expect(scope).toHaveClass("focus:outline-2", "focus:outline-offset-2", "focus:outline-v2-blue-600");
    const warning = (await screen.findByText("missing-skill")).parentElement!;
    expect(within(warning).getByText(/Search/)).toBeVisible();
    expect(within(warning).getByText(/Writing/)).toBeVisible();
  });

  it("refetches only diagnostic Agents when a project scope is selected", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listAgents)
      .mockResolvedValueOnce([{ name: "search", description: "Searches", missingSkills: ["global-missing"] }] as never)
      .mockResolvedValueOnce([{ name: "writing", description: "Writes", missingSkills: ["project-missing"] }] as never);

    renderSettings();
    const scope = await screen.findByRole("combobox", { name: "Skill diagnostic scope" });
    expect(screen.getByText("global-missing")).toBeVisible();

    await user.selectOptions(scope, "/papers/project-a");

    await waitFor(() => expect(api.listAgents).toHaveBeenCalledWith("/papers/project-a"));
    expect(await screen.findByText("project-missing")).toBeVisible();
    expect(screen.queryByText("global-missing")).toBeNull();
    expect(api.listSkillResources).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Edit skill paper-search" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Edit skill project-missing" })).toBeNull();
  });

  it("keeps the latest diagnostic scope when an earlier request resolves last", async () => {
    const user = userEvent.setup();
    const projectA = deferred<Awaited<ReturnType<typeof api.listAgents>>>();
    const projectB = deferred<Awaited<ReturnType<typeof api.listAgents>>>();
    vi.mocked(api.listAgents)
      .mockResolvedValueOnce([{ name: "search", description: "Searches", missingSkills: ["global-missing"] }] as never)
      .mockReturnValueOnce(projectA.promise)
      .mockReturnValueOnce(projectB.promise);

    renderSettings();
    const scope = await screen.findByRole("combobox", { name: "Skill diagnostic scope" });
    await user.selectOptions(scope, "/papers/project-a");
    await user.selectOptions(scope, "/papers/project-b");

    await act(async () => {
      projectB.resolve([{ name: "writing", description: "Writes", missingSkills: ["project-b-missing"] }] as never);
      await projectB.promise;
    });
    expect(screen.getByText("project-b-missing")).toBeVisible();

    await act(async () => {
      projectA.resolve([{ name: "search", description: "Searches", missingSkills: ["project-a-missing"] }] as never);
      await projectA.promise;
    });
    expect(scope).toHaveValue("/papers/project-b");
    expect(screen.getByText("project-b-missing")).toBeVisible();
    expect(screen.queryByText("project-a-missing")).toBeNull();
    expect(api.listSkillResources).toHaveBeenCalledTimes(1);
  });

  it("clears stale diagnostics on failure and clears the diagnostic error after recovery", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listAgents)
      .mockResolvedValueOnce([{ name: "search", description: "Searches", missingSkills: ["global-missing"] }] as never)
      .mockRejectedValueOnce(new Error("diagnostic failed"))
      .mockResolvedValueOnce([
        { name: "writing", description: "Writes", missingSkills: ["recovered-missing"] },
      ] as never);

    renderSettings();
    const scope = await screen.findByRole("combobox", { name: "Skill diagnostic scope" });
    expect(await screen.findByText("global-missing")).toBeVisible();

    await user.selectOptions(scope, "/papers/project-a");
    expect(await screen.findByRole("alert")).toHaveTextContent("diagnostic failed");
    expect(screen.queryByText("global-missing")).toBeNull();

    await user.selectOptions(scope, "/papers/project-b");
    expect(await screen.findByText("recovered-missing")).toBeVisible();
    expect(screen.queryByText("diagnostic failed")).toBeNull();
    expect(api.listSkillResources).toHaveBeenCalledTimes(1);
  });

  it("keeps global Skill resources available when diagnostic project discovery fails", async () => {
    vi.mocked(api.listConfigProjects).mockRejectedValueOnce(new Error("project discovery failed"));

    renderSettings();

    expect(await screen.findByRole("button", { name: "Edit skill paper-search" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("project discovery failed");
  });

  it("shows deduplicated resource lists and opens agent resource details", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listAgents).mockResolvedValue([
      {
        name: "research-assistant",
        description: "Coordinates",
        enabled: true,
        builtin: true,
        source: "bundled",
        filePath: "src/agents/research-assistant.md",
        effectiveTools: ["read", "subagent"],
        effectiveSkills: ["workflow"],
      },
      {
        name: "search",
        description: "Searches",
        enabled: true,
        builtin: true,
        source: "bundled",
        filePath: "src/agents/search.md",
        effectiveTools: ["read", "web-search"],
        effectiveSkills: ["paper-search", "arxiv"],
      },
    ] as never);
    renderSettings();

    expect(await screen.findByRole("button", { name: "View details for Search" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Tools" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Skills" })).toBeTruthy();
    expect(screen.getAllByText("read")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "View details for Search" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(within(screen.getByRole("dialog")).getByText("web-search")).toBeTruthy();
    expect(within(screen.getByRole("dialog")).getByText("paper-search")).toBeTruthy();
  });

  it("opens the agent config modal with the enable switch, model, thinking, and edit controls", async () => {
    const user = userEvent.setup();
    renderSettings();
    const dialog = await openAgentConfig(user, "Search");
    expect(within(dialog).getByRole("switch", { name: "Enable Search" })).toBeTruthy();
    expect(within(dialog).getByRole("combobox", { name: "Select model for Search" })).toBeTruthy();
    expect(within(dialog).getByRole("combobox", { name: "Select thinking for Search" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Edit Search" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "View tools & skills details" })).toBeTruthy();
  });

  it("toggles an agent enable switch inside the modal", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listAgents).mockResolvedValue([
      { name: "search", description: "Searches", enabled: true },
      { name: "writing", description: "Writes", enabled: true },
    ] as never);
    vi.mocked(api.readAgentResource).mockResolvedValue({
      name: "search",
      description: "Searches",
      enabled: true,
      builtin: true,
      source: "bundled",
      filePath: "src/agents/search.md",
      effectiveTools: ["read", "web-search"],
      effectiveSkills: ["paper-search", "arxiv"],
      missingSkills: [],
      content: "---\nname: search\ndescription: Searches\nenable: true\n---\nPrompt\n",
    });
    vi.mocked(api.writeAgentResource).mockResolvedValue({
      name: "search",
      description: "Searches",
      enabled: false,
      builtin: true,
      source: "bundled",
      filePath: "src/agents/search.md",
      effectiveTools: ["read", "web-search"],
      effectiveSkills: ["paper-search", "arxiv"],
      missingSkills: [],
      content: "---\nname: search\ndescription: Searches\nenable: false\n---\nPrompt\n",
    });
    renderSettings();
    const dialog = await openAgentConfig(user, "Search");
    const toggle = within(dialog).getByRole("switch", { name: "Enable Search" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await user.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
    expect(api.writeAgentResource).toHaveBeenCalledWith(
      "search",
      "---\nname: search\ndescription: Searches\nenable: false\n---\nPrompt\n",
    );
  });

  it("stacks the details dialog above the agent config modal and Esc unwinds top-down", async () => {
    const user = userEvent.setup();
    renderSettings();
    const config = await openAgentConfig(user, "Search");
    const configZ = Number((config.parentElement as HTMLElement).style.zIndex);

    await user.click(within(config).getByRole("button", { name: "View tools & skills details" }));
    const details = screen.getByRole("dialog", { name: "Search resources" });
    const detailsZ = Number((details.parentElement as HTMLElement).style.zIndex);
    expect(detailsZ).toBeGreaterThan(configZ);

    // Escape closes the details dialog first, leaving the config modal open.
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Search resources" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Agents" })).toBeTruthy();

    // A second Escape closes the config modal.
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Agents" })).toBeNull();
  });
});
