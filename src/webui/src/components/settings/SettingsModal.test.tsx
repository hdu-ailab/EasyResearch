import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../api";
import { I18nProvider } from "../../i18n/I18nProvider";
import { readPreferences, STORAGE_KEY } from "../../preferences";
import { PreferencesProvider } from "../../preferences/PreferencesProvider";
import { SettingsModal, type SettingsModalProps } from "./SettingsModal";

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
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
    refreshConfigurationResources: vi.fn(),
  };
});

beforeEach(() => {
  vi.stubGlobal("innerWidth", 1200);
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
  vi.mocked(api.refreshConfigurationResources).mockReset().mockResolvedValue({ generation: 1, error: null });
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const defaultModalProps: SettingsModalProps = {
  configurationGeneration: 1,
  configurationError: null,
  onClose: vi.fn(),
  onOpenConfig: vi.fn(),
  onProjectInterestChange: vi.fn(),
  registerRouteCloseGuard: () => () => {},
};

function settingsElement(
  onOpenConfig: () => void = () => {},
  onClose: () => void = () => {},
  configurationGeneration = 1,
  configurationError: string | null = null,
  onProjectInterestChange: (cwd?: string) => void = () => {},
) {
  return (
    <PreferencesProvider>
      <I18nProvider>
        <SettingsModal
          onClose={onClose}
          onOpenConfig={onOpenConfig}
          onProjectInterestChange={onProjectInterestChange}
          registerRouteCloseGuard={defaultModalProps.registerRouteCloseGuard}
          configurationGeneration={configurationGeneration}
          configurationError={configurationError}
        />
      </I18nProvider>
    </PreferencesProvider>
  );
}

function renderSettings(onOpenConfig: () => void = () => {}, onClose: () => void = () => {}) {
  return render(settingsElement(onOpenConfig, onClose));
}

async function selectCategory(user: ReturnType<typeof userEvent.setup>, name: string) {
  const tab = screen.getByRole("tab", { name });
  if (tab.getAttribute("aria-selected") !== "true") await user.click(tab);
}

async function openAgentConfig(user: ReturnType<typeof userEvent.setup>, name: string) {
  await selectCategory(user, "Agents");
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

describe("SettingsModal", () => {
  it("uses an automatically activating vertical tablist on desktop", async () => {
    const user = userEvent.setup();
    renderSettings();
    const tabs = screen.getByRole("tablist", { name: "Settings" });
    expect(tabs).toHaveAttribute("aria-orientation", "vertical");
    const general = screen.getByRole("tab", { name: "General" });
    const conversation = screen.getByRole("tab", { name: "Conversation" });
    general.focus();
    await user.keyboard("{ArrowDown}");
    expect(conversation).toHaveFocus();
    expect(conversation).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Conversation" })).toBeVisible();
  });

  it("opens a category index first on mobile and restores row focus on Back", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("innerWidth", 390);
    renderSettings();
    const agents = screen.getByRole("button", { name: "Agents" });
    await user.click(agents);
    expect(screen.getByRole("heading", { name: "Agents" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Back to settings" }));
    expect(agents).toHaveFocus();
  });

  it("opens Agent configuration as a full mobile viewport layer with desktop bounds at 820px", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("innerWidth", 390);
    renderSettings();
    await user.click(screen.getByRole("button", { name: "Agents" }));
    await user.click(await screen.findByRole("button", { name: "Configure Search" }));

    const dialog = screen.getByRole("dialog", { name: "Agents" });
    expect(dialog.parentElement).toHaveClass("p-0", "min-[820px]:p-6");
    expect(dialog).toHaveClass(
      "h-full",
      "w-full",
      "min-[820px]:h-auto",
      "min-[820px]:max-h-[min(720px,calc(100vh-24px))]",
      "min-[820px]:max-w-[520px]",
      "min-[820px]:rounded-[10px]",
    );
    expect(dialog).not.toHaveClass("max-h-[min(720px,calc(100vh-24px))]", "max-w-[520px]", "rounded-[10px]");
  });

  it("renders a named modal shell without a page Topbar and closes from its control", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderSettings(() => {}, onClose);

    expect(screen.getByRole("dialog", { name: "Settings" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /back to home/i })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("dismisses only a direct desktop backdrop press", () => {
    const onClose = vi.fn();
    renderSettings(() => {}, onClose);
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    const backdrop = dialog.parentElement;
    expect(backdrop).not.toBeNull();

    fireEvent.mouseDown(dialog);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(backdrop!);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("uses an inset-free full-screen shell without mobile backdrop dismissal", () => {
    const onClose = vi.fn();
    vi.stubGlobal("innerWidth", 390);
    renderSettings(() => {}, onClose);
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    const backdrop = dialog.parentElement;

    expect(dialog).toHaveClass("h-full", "w-full");
    expect(backdrop).toHaveClass("p-0");
    fireEvent.mouseDown(backdrop!);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("focuses the selected desktop category on first mount", () => {
    renderSettings();
    expect(screen.getByRole("tab", { name: "General" })).toHaveFocus();
  });

  it("returns to the mobile category index when crossing below 820px and restores the active desktop tab", async () => {
    const user = userEvent.setup();
    renderSettings();
    await selectCategory(user, "Agents");

    vi.stubGlobal("innerWidth", 819);
    fireEvent(window, new Event("resize"));
    expect(screen.getByRole("button", { name: "Agents" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Agents" })).toBeNull();

    vi.stubGlobal("innerWidth", 820);
    fireEvent(window, new Event("resize"));
    expect(screen.getByRole("tab", { name: "Agents" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Agents" })).toBeVisible();
  });

  it("does not dismiss the outer layer while a nested dialog is above it", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderSettings(() => {}, onClose);
    await selectCategory(user, "Model providers");
    await user.click(screen.getByRole("button", { name: /^Connect providers/ }));
    expect(screen.getByRole("dialog", { name: "Connect providers" })).toBeVisible();

    const outer = document.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="settings-dialog-title"]');
    expect(outer).not.toBeNull();
    fireEvent.mouseDown(outer!.parentElement!);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("registers a route guard that closes only the nested top layer", async () => {
    const user = userEvent.setup();
    let guard: Parameters<SettingsModalProps["registerRouteCloseGuard"]>[0] | null = null;
    const registerRouteCloseGuard: SettingsModalProps["registerRouteCloseGuard"] = (next) => {
      guard = next;
      return () => {
        guard = null;
      };
    };
    render(
      <PreferencesProvider>
        <I18nProvider>
          <SettingsModal {...defaultModalProps} registerRouteCloseGuard={registerRouteCloseGuard} />
        </I18nProvider>
      </PreferencesProvider>,
    );
    await openAgentConfig(user, "Search");
    expect(guard).not.toBeNull();
    expect(guard!.shouldBlock()).toBe(true);

    act(() => guard!.requestClose());

    expect(screen.queryByRole("dialog", { name: "Agents" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeVisible();
    expect(guard!.shouldBlock()).toBe(false);
  });

  it("routes close-above through the dirty Markdown discard guard", async () => {
    const user = userEvent.setup();
    const confirmDiscard = vi.spyOn(window, "confirm").mockReturnValue(false);
    let guard: Parameters<SettingsModalProps["registerRouteCloseGuard"]>[0] | null = null;
    const registerRouteCloseGuard: SettingsModalProps["registerRouteCloseGuard"] = (next) => {
      guard = next;
      return () => {
        guard = null;
      };
    };
    render(
      <PreferencesProvider>
        <I18nProvider>
          <SettingsModal {...defaultModalProps} registerRouteCloseGuard={registerRouteCloseGuard} />
        </I18nProvider>
      </PreferencesProvider>,
    );
    const config = await openAgentConfig(user, "Search");
    await user.click(within(config).getByRole("button", { name: "Edit Search" }));
    const editor = await screen.findByRole("textbox", { name: /agent markdown/i });
    fireEvent.change(editor, { target: { value: "---\nname: search\n---\nChanged prompt\n" } });

    act(() => guard!.requestClose());

    expect(confirmDiscard).toHaveBeenCalledOnce();
    expect(editor).toBeVisible();
    expect(guard!.shouldBlock()).toBe(true);

    confirmDiscard.mockReturnValue(true);
    act(() => guard!.requestClose());

    await waitFor(() => expect(screen.queryByRole("textbox", { name: /agent markdown/i })).toBeNull());
    expect(screen.getByRole("dialog", { name: "Agents" })).toBeVisible();
    expect(document.querySelector('[role="dialog"][aria-labelledby="settings-dialog-title"]')).toBeInTheDocument();
    expect(guard!.shouldBlock()).toBe(true);
  });

  it("opens provider management from its category with the connected count", async () => {
    const user = userEvent.setup();
    renderSettings();
    await selectCategory(user, "Model providers");

    const providerAction = (await screen.findByText("1 providers connected")).closest("button");
    expect(providerAction).not.toBeNull();
    expect(providerAction).toHaveAccessibleName("Connect providers 1 providers connected");
    await user.click(providerAction!);
    expect(screen.getByRole("dialog", { name: "Connect providers" })).toBeVisible();
  });

  it("renders localized category and route-control copy", async () => {
    const user = userEvent.setup();
    renderSettings();
    await user.click(screen.getByRole("button", { name: "简体中文" }));

    expect(screen.getByRole("tab", { name: "常规" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "模型提供商" })).toBeVisible();
    expect(screen.getByRole("button", { name: "打开配置浏览器…" })).toBeVisible();
    expect(screen.getByRole("button", { name: "关闭" })).toBeVisible();
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
    await selectCategory(user, "Conversation");

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
    const user = userEvent.setup();
    renderSettings();
    await selectCategory(user, "Conversation");

    const input = await screen.findByRole("spinbutton", { name: /automatic compaction/i });
    expect(input).toHaveValue(70);
    expect(api.getCompactionSettings).toHaveBeenCalledOnce();
  });

  it("retains an in-flight compaction failure and its Retry target across category switches", async () => {
    const user = userEvent.setup();
    const failedSave = deferred<Awaited<ReturnType<typeof api.patchCompactionSettings>>>();
    vi.mocked(api.patchCompactionSettings)
      .mockReturnValueOnce(failedSave.promise)
      .mockResolvedValueOnce({ triggerPercent: 80, globalEnabled: true });
    renderSettings();
    await selectCategory(user, "Conversation");
    const input = await screen.findByRole("spinbutton", { name: /automatic compaction/i });

    await user.clear(input);
    await user.type(input, "80");
    await user.tab();
    await waitFor(() => expect(api.patchCompactionSettings).toHaveBeenCalledOnce());
    await selectCategory(user, "General");
    await act(async () => {
      failedSave.reject(new Error("offline"));
      await failedSave.promise.catch(() => {});
    });
    await selectCategory(user, "Conversation");

    expect(screen.getByRole("spinbutton", { name: /automatic compaction/i })).toBe(input);
    expect(input).toHaveValue(70);
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
    expect(api.getCompactionSettings).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(api.patchCompactionSettings).toHaveBeenCalledTimes(2));
    expect(api.patchCompactionSettings).toHaveBeenLastCalledWith({ triggerPercent: 80 });
    expect(input).toHaveValue(80);
  });

  it("retains the accepted API usage value and failed Retry target across category switches", async () => {
    const user = userEvent.setup();
    const failedSave = deferred<Awaited<ReturnType<typeof api.patchApiUsageSettings>>>();
    vi.mocked(api.patchApiUsageSettings)
      .mockResolvedValueOnce({ showApiUsageDetails: true })
      .mockReturnValueOnce(failedSave.promise)
      .mockResolvedValueOnce({ showApiUsageDetails: false });
    renderSettings();
    await selectCategory(user, "Conversation");
    const toggle = await screen.findByRole("switch", { name: /show api usage details/i });

    await user.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    await selectCategory(user, "General");
    await selectCategory(user, "Conversation");
    expect(screen.getByRole("switch", { name: /show api usage details/i })).toBe(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");

    await user.click(toggle);
    await waitFor(() => expect(api.patchApiUsageSettings).toHaveBeenCalledTimes(2));
    await selectCategory(user, "Agents");
    await act(async () => {
      failedSave.reject(new Error("offline"));
      await failedSave.promise.catch(() => {});
    });
    await selectCategory(user, "Conversation");

    expect(screen.getByRole("switch", { name: /show api usage details/i })).toBe(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
    expect(api.getApiUsageSettings).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(api.patchApiUsageSettings).toHaveBeenCalledTimes(3));
    expect(api.patchApiUsageSettings).toHaveBeenLastCalledWith({ showApiUsageDetails: false });
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("contains all switch thumbs with fixed pixel geometry in both states", async () => {
    const user = userEvent.setup();
    renderSettings();
    await selectCategory(user, "Conversation");
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
    await waitFor(() => expect(api.listAgents).toHaveBeenCalled());
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
    await user.click(screen.getByRole("tab", { name: "智能体" }));

    await user.click(await screen.findByRole("button", { name: "配置 研究助手" }));
    expect(screen.getByRole("combobox", { name: "选择模型： 研究助手" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "关闭编辑器" }));
    await user.click(await screen.findByRole("button", { name: "配置 检索" }));
    expect(screen.getByRole("combobox", { name: "选择模型： 检索" })).toBeTruthy();
  });

  it("pins the Research Assistant card to the first position regardless of API order", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listAgents).mockResolvedValue([
      { name: "writing", description: "Writes" },
      { name: "research-assistant", description: "Coordinates" },
      { name: "search", description: "Searches" },
    ] as never);
    renderSettings();
    await selectCategory(user, "Agents");
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
    const user = userEvent.setup();
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
    await selectCategory(user, "Agents");
    expect(await screen.findByRole("button", { name: "Configure Search" })).toBeVisible();
    vi.mocked(api.listAgentResources).mockResolvedValueOnce([reviewer]);
    vi.mocked(api.listAgents).mockResolvedValueOnce([reviewer]);

    view.rerender(settingsElement(undefined, undefined, 2));

    expect(await screen.findByRole("button", { name: "Configure reviewer" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Configure Search" })).toBeNull();
  });

  it("refreshes the connected provider count on a newer configuration generation", async () => {
    const user = userEvent.setup();
    const view = renderSettings();
    await selectCategory(user, "Model providers");
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

  it("refreshes Skill rows and the selected project diagnostics independently of slow metadata", async () => {
    const user = userEvent.setup();
    const slowMetadata = deferred<Awaited<ReturnType<typeof api.listAgents>>>();
    const staleResources = deferred<Awaited<ReturnType<typeof api.listSkillResources>>>();
    const staleDiagnostics = deferred<Awaited<ReturnType<typeof api.listAgents>>>();
    let generation = 1;
    const metadata = (revision: number) =>
      [
        {
          name: `reviewer-${revision}`,
          description: `Metadata ${revision}`,
          enabled: true,
          builtin: false,
          source: "global" as const,
          filePath: `/agent/agents/reviewer-${revision}.md`,
          effectiveTools: [],
          effectiveSkills: [],
          missingSkills: [],
        },
      ] as never;
    const diagnostics = (revision: number) =>
      [{ name: "writing", description: "Writes", missingSkills: [`missing-${revision}`] }] as never;
    const resources = (revision: number) =>
      [
        {
          name: `skill-${revision}`,
          source: "global" as const,
          path: `/agent/skills/skill-${revision}`,
          skillPath: `/agent/skills/skill-${revision}/SKILL.md`,
        },
      ] as never;
    vi.mocked(api.listAgents).mockImplementation((cwd) => {
      const requestedGeneration = generation;
      if (requestedGeneration === 2 && cwd === undefined) return slowMetadata.promise;
      if (requestedGeneration === 4 && cwd === "/papers/project-a") return staleDiagnostics.promise;
      return Promise.resolve(
        cwd === "/papers/project-a" ? diagnostics(requestedGeneration) : metadata(requestedGeneration),
      );
    });
    vi.mocked(api.listSkillResources).mockImplementation(() => {
      const requestedGeneration = generation;
      return requestedGeneration === 4 ? staleResources.promise : Promise.resolve(resources(requestedGeneration));
    });

    const view = renderSettings();
    await selectCategory(user, "Skills and tools");
    const scope = await screen.findByRole("combobox", { name: "Skill diagnostic scope" });
    await user.selectOptions(scope, "/papers/project-a");
    expect(await screen.findByText("missing-1")).toBeVisible();
    expect(screen.getByRole("button", { name: "Edit skill skill-1" })).toBeVisible();

    generation = 2;
    view.rerender(settingsElement(undefined, undefined, 2));

    expect(await screen.findByText("missing-2")).toBeVisible();
    expect(screen.getByRole("button", { name: "Edit skill skill-2" })).toBeVisible();
    expect(scope).toHaveValue("/papers/project-a");

    generation = 3;
    view.rerender(settingsElement(undefined, undefined, 3));
    await selectCategory(user, "Agents");
    expect(await screen.findByRole("button", { name: "Configure reviewer-3" })).toBeVisible();
    await act(async () => {
      slowMetadata.resolve(metadata(2));
      await slowMetadata.promise;
    });
    expect(screen.getByRole("button", { name: "Configure reviewer-3" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Configure reviewer-2" })).toBeNull();

    await selectCategory(user, "Skills and tools");
    generation = 4;
    view.rerender(settingsElement(undefined, undefined, 4));
    generation = 5;
    view.rerender(settingsElement(undefined, undefined, 5));
    expect(await screen.findByText("missing-5")).toBeVisible();
    expect(screen.getByRole("button", { name: "Edit skill skill-5" })).toBeVisible();

    await act(async () => {
      staleResources.resolve(resources(4));
      staleDiagnostics.resolve(diagnostics(4));
      await Promise.all([staleResources.promise, staleDiagnostics.promise]);
    });
    expect(scope).toHaveValue("/papers/project-a");
    expect(screen.getByText("missing-5")).toBeVisible();
    expect(screen.queryByText("missing-4")).toBeNull();
    expect(screen.getByRole("button", { name: "Edit skill skill-5" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Edit skill skill-4" })).toBeNull();
  });

  it("reports only the selected diagnostic project and clears the interest on reset and unmount", async () => {
    const user = userEvent.setup();
    const onProjectInterestChange = vi.fn();
    const view = render(settingsElement(undefined, undefined, 1, null, onProjectInterestChange));
    await selectCategory(user, "Skills and tools");
    const scope = await screen.findByRole("combobox", { name: "Skill diagnostic scope" });

    await user.selectOptions(scope, "/papers/project-a");
    expect(onProjectInterestChange).toHaveBeenLastCalledWith("/papers/project-a");

    await user.selectOptions(scope, "global");
    expect(onProjectInterestChange).toHaveBeenLastCalledWith(undefined);

    await user.selectOptions(scope, "/papers/project-b");
    expect(onProjectInterestChange).toHaveBeenLastCalledWith("/papers/project-b");
    view.unmount();
    expect(onProjectInterestChange).toHaveBeenLastCalledWith(undefined);
  });

  it("awaits selected-project synchronization before Settings Refresh and keeps a safe refresh error visible", async () => {
    const user = userEvent.setup();
    const synchronization = deferred<Awaited<ReturnType<typeof api.refreshConfigurationResources>>>();
    vi.mocked(api.refreshConfigurationResources).mockReturnValue(synchronization.promise);
    renderSettings();
    await selectCategory(user, "Skills and tools");
    const scope = await screen.findByRole("combobox", { name: "Skill diagnostic scope" });
    await user.selectOptions(scope, "/papers/project-a");
    await selectCategory(user, "Agents");
    await screen.findByRole("button", { name: "Configure Search" });
    const metadataCalls = vi.mocked(api.listModels).mock.calls.length;

    await user.click(screen.getByRole("button", { name: "Refresh" }));

    expect(api.refreshConfigurationResources).toHaveBeenCalledWith({ projectCwds: ["/papers/project-a"] });
    expect(api.listModels).toHaveBeenCalledTimes(metadataCalls);

    await act(async () => {
      synchronization.resolve({ generation: 2, error: "Configuration refresh failed. Retry refresh." });
      await synchronization.promise;
    });
    await waitFor(() => expect(api.listModels).toHaveBeenCalledTimes(metadataCalls + 1));
    expect(screen.getByRole("alert")).toHaveTextContent("Configuration refresh failed. Retry refresh.");
    expect(screen.getByRole("button", { name: "Configure Search" })).toBeVisible();
  });

  it("invalidates pending manual Refresh on diagnostic scope change and unmount while the new scope stays current", async () => {
    const user = userEvent.setup();
    const projectARefresh = deferred<Awaited<ReturnType<typeof api.refreshConfigurationResources>>>();
    const projectBRefresh = deferred<Awaited<ReturnType<typeof api.refreshConfigurationResources>>>();
    vi.mocked(api.refreshConfigurationResources)
      .mockReturnValueOnce(projectARefresh.promise)
      .mockReturnValueOnce(projectBRefresh.promise);
    const view = renderSettings();
    await selectCategory(user, "Agents");
    await screen.findByRole("button", { name: "Configure Search" });
    const metadataCalls = vi.mocked(api.listModels).mock.calls.length;
    vi.mocked(api.listAgents).mockImplementation(async (cwd) =>
      cwd === "/papers/project-b"
        ? ([{ name: "writing", description: "Writes", missingSkills: ["project-b-current"] }] as never)
        : ([] as never),
    );

    await selectCategory(user, "Skills and tools");
    const scope = screen.getByRole("combobox", { name: "Skill diagnostic scope" });
    await user.selectOptions(scope, "/papers/project-a");
    await selectCategory(user, "Agents");
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(api.refreshConfigurationResources).toHaveBeenLastCalledWith({ projectCwds: ["/papers/project-a"] });

    await selectCategory(user, "Skills and tools");
    await user.selectOptions(scope, "/papers/project-b");
    expect(await screen.findByText("project-b-current")).toBeVisible();
    await act(async () => {
      projectARefresh.resolve({ generation: 2, error: "stale project A refresh" });
      await projectARefresh.promise;
    });

    expect(scope).toHaveValue("/papers/project-b");
    expect(screen.getByText("project-b-current")).toBeVisible();
    await selectCategory(user, "Agents");
    expect(screen.queryByText("stale project A refresh")).toBeNull();
    expect(api.listModels).toHaveBeenCalledTimes(metadataCalls);
    const refresh = screen.getByRole("button", { name: "Refresh" });
    expect(refresh).not.toBeDisabled();

    await user.click(refresh);
    expect(api.refreshConfigurationResources).toHaveBeenLastCalledWith({ projectCwds: ["/papers/project-b"] });
    view.unmount();
    await act(async () => {
      projectBRefresh.resolve({ generation: 3, error: "stale unmounted refresh" });
      await projectBRefresh.promise;
    });
    expect(api.listModels).toHaveBeenCalledTimes(metadataCalls);
  });

  it("clears the prior Agents error after a successful Refresh", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listModels).mockRejectedValueOnce(new Error("agent refresh failed"));
    renderSettings();
    await selectCategory(user, "Agents");
    expect(await screen.findByRole("alert")).toHaveTextContent("agent refresh failed");

    await user.click(screen.getByRole("button", { name: "Refresh" }));

    expect(await screen.findByRole("button", { name: "Configure Search" })).toBeVisible();
    await waitFor(() => expect(screen.queryByText("agent refresh failed")).toBeNull());
  });

  it("retains last-good Settings controls while configuration is malformed", async () => {
    const user = userEvent.setup();
    const view = renderSettings();
    await selectCategory(user, "Agents");
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
    const user = userEvent.setup();
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
    await selectCategory(user, "Agents");
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
    await selectCategory(user, "Agents");
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
    await selectCategory(user, "Skills and tools");
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
    const metadata = vi.mocked(api.listAgents).getMockImplementation()!;
    vi.mocked(api.listAgents)
      .mockImplementationOnce(metadata)
      .mockResolvedValueOnce([{ name: "search", description: "Searches", missingSkills: ["before-save"] }] as never)
      .mockResolvedValueOnce([{ name: "search", description: "Searches", missingSkills: ["after-save"] }] as never);
    renderSettings();
    await selectCategory(user, "Skills and tools");
    expect(await screen.findByText("before-save")).toBeVisible();

    await openAgentConfig(user, "Search");
    await user.click(screen.getByRole("button", { name: "Edit Search" }));
    await user.click(screen.getByRole("button", { name: /save agent/i }));

    await selectCategory(user, "Skills and tools");
    expect(await screen.findByText("after-save")).toBeVisible();
    expect(screen.queryByText("before-save")).toBeNull();
    expect(api.listAgents).toHaveBeenLastCalledWith(undefined);
  });

  it("refreshes the selected project diagnostics after a successful global Skill save", async () => {
    const user = userEvent.setup();
    const metadata = vi.mocked(api.listAgents).getMockImplementation()!;
    vi.mocked(api.listAgents)
      .mockImplementationOnce(metadata)
      .mockResolvedValueOnce([{ name: "search", description: "Searches", missingSkills: ["global-missing"] }] as never)
      .mockResolvedValueOnce([
        { name: "writing", description: "Writes", missingSkills: ["before-skill-save"] },
      ] as never)
      .mockResolvedValueOnce([
        { name: "writing", description: "Writes", missingSkills: ["after-skill-save"] },
      ] as never);
    renderSettings();
    await selectCategory(user, "Skills and tools");
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
    const metadata = vi.mocked(api.listAgents).getMockImplementation()!;
    vi.mocked(api.listAgents)
      .mockImplementationOnce(metadata)
      .mockResolvedValueOnce([{ name: "search", description: "Searches", missingSkills: ["global-missing"] }] as never)
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce([
        { name: "writing", description: "Writes", missingSkills: ["fresh-after-save"] },
      ] as never);
    renderSettings();
    await selectCategory(user, "Skills and tools");
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
    const user = userEvent.setup();
    vi.mocked(api.listAgents).mockResolvedValue([
      { name: "search", description: "Searches", missingSkills: ["missing-skill"] },
      { name: "writing", description: "Writes", missingSkills: ["missing-skill"] },
    ] as never);

    renderSettings();
    await selectCategory(user, "Skills and tools");

    const scope = await screen.findByRole("combobox", { name: "Skill diagnostic scope" });
    expect(scope).toHaveValue("global");
    expect(scope).toHaveClass("focus:outline-2", "focus:outline-offset-2", "focus:outline-v2-blue-600");
    const warning = (await screen.findByText("missing-skill")).parentElement!;
    expect(within(warning).getByText(/Search/)).toBeVisible();
    expect(within(warning).getByText(/Writing/)).toBeVisible();
  });

  it("refetches only diagnostic Agents when a project scope is selected", async () => {
    const user = userEvent.setup();
    const metadata = vi.mocked(api.listAgents).getMockImplementation()!;
    vi.mocked(api.listAgents)
      .mockImplementationOnce(metadata)
      .mockResolvedValueOnce([{ name: "search", description: "Searches", missingSkills: ["global-missing"] }] as never)
      .mockResolvedValueOnce([{ name: "writing", description: "Writes", missingSkills: ["project-missing"] }] as never);

    renderSettings();
    await selectCategory(user, "Skills and tools");
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
    const metadata = vi.mocked(api.listAgents).getMockImplementation()!;
    vi.mocked(api.listAgents)
      .mockImplementationOnce(metadata)
      .mockResolvedValueOnce([{ name: "search", description: "Searches", missingSkills: ["global-missing"] }] as never)
      .mockReturnValueOnce(projectA.promise)
      .mockReturnValueOnce(projectB.promise);

    renderSettings();
    await selectCategory(user, "Skills and tools");
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
    const metadata = vi.mocked(api.listAgents).getMockImplementation()!;
    vi.mocked(api.listAgents)
      .mockImplementationOnce(metadata)
      .mockResolvedValueOnce([{ name: "search", description: "Searches", missingSkills: ["global-missing"] }] as never)
      .mockRejectedValueOnce(new Error("diagnostic failed"))
      .mockResolvedValueOnce([
        { name: "writing", description: "Writes", missingSkills: ["recovered-missing"] },
      ] as never);

    renderSettings();
    await selectCategory(user, "Skills and tools");
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
    const user = userEvent.setup();
    vi.mocked(api.listConfigProjects).mockRejectedValueOnce(new Error("project discovery failed"));

    renderSettings();
    await waitFor(() => expect(api.listConfigProjects).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).toBeNull();
    await selectCategory(user, "Skills and tools");

    expect(await screen.findByRole("button", { name: "Edit skill paper-search" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("project discovery failed");

    await selectCategory(user, "General");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("retries the owning Skill and project loads and clears their initial error", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listSkillResources)
      .mockRejectedValueOnce(new Error("resource discovery failed"))
      .mockResolvedValueOnce([
        {
          name: "paper-search",
          source: "bundled",
          path: "src/skills/paper-search",
          skillPath: "src/skills/paper-search/SKILL.md",
        },
      ] as never);
    renderSettings();
    await selectCategory(user, "Skills and tools");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("resource discovery failed");

    await user.click(within(alert).getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("button", { name: "Edit skill paper-search" })).toBeVisible();
    await waitFor(() => expect(screen.queryByText("resource discovery failed")).toBeNull());
    expect(api.listSkillResources).toHaveBeenCalledTimes(2);
    expect(api.listConfigProjects).toHaveBeenCalledTimes(2);
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

    await selectCategory(user, "Skills and tools");
    expect(screen.getByRole("heading", { name: "Tools" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Skills" })).toBeTruthy();
    expect(screen.getAllByText("read")).toHaveLength(1);

    await selectCategory(user, "Agents");
    await user.click(screen.getByRole("button", { name: "View details for Search" }));
    const details = screen.getByRole("dialog", { name: "Search resources" });
    expect(details).toBeTruthy();
    expect(within(details).getByText("web-search")).toBeTruthy();
    expect(within(details).getByText("paper-search")).toBeTruthy();
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
