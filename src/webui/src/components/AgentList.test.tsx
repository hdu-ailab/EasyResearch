import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { AgentList } from "./AgentList";

vi.mock("../api", () => ({
  getEffectiveModels: vi.fn(),
  getEffectiveThinking: vi.fn(),
  listAgents: vi.fn(),
  listModels: vi.fn(),
  setAgentModel: vi.fn(),
  setAgentThinking: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(api.listAgents).mockReset();
  vi.mocked(api.listModels).mockReset();
  vi.mocked(api.getEffectiveModels).mockReset();
  vi.mocked(api.getEffectiveThinking).mockReset();
  vi.mocked(api.setAgentModel).mockReset();
  vi.mocked(api.setAgentThinking).mockReset();
  vi.mocked(api.listAgents).mockResolvedValue([
    {
      name: "paper-assistant",
      description: "Coordinates work",
      enabled: true,
      builtin: true,
      source: "bundled",
      filePath: "paper-assistant.md",
      effectiveTools: [],
      effectiveSkills: [],
      missingSkills: [],
    },
    {
      name: "search",
      description: "Finds papers",
      enabled: true,
      builtin: true,
      source: "bundled",
      filePath: "search.md",
      effectiveTools: [],
      effectiveSkills: [],
      missingSkills: [],
    },
  ]);
  vi.mocked(api.listModels).mockResolvedValue([
    { provider: "openai", id: "gpt-4o", reasoning: true, thinkingLevelMap: { xhigh: null, max: null } },
  ]);
  vi.mocked(api.getEffectiveModels).mockResolvedValue([
    { name: "paper-assistant", model: "openai/gpt-4o", source: "inherit" },
    { name: "search", model: "custom/model", source: "override" },
  ]);
  vi.mocked(api.getEffectiveThinking).mockResolvedValue([
    { name: "paper-assistant", thinking: "high", source: "override" },
    { name: "search", thinking: "low", source: "default" },
  ]);
  vi.mocked(api.setAgentModel).mockResolvedValue(undefined);
  vi.mocked(api.setAgentThinking).mockResolvedValue(undefined);
});

describe("AgentList", () => {
  it("loads the effective roster for the exact session cwd", async () => {
    vi.mocked(api.listAgents).mockImplementation(async (cwd) =>
      cwd === "/papers/project"
        ? [
            {
              name: "project-reviewer",
              description: "Project-only reviewer",
              enabled: true,
              builtin: false,
              source: "project",
              filePath: "/papers/project/.easyresearch/agents/project-reviewer.md",
              effectiveTools: [],
              effectiveSkills: [],
              missingSkills: [],
            },
          ]
        : [],
    );

    render(<AgentList cwd="/papers/project" statusByAgent={{ "project-reviewer": "idle" }} sessionId="s1" />);

    expect(await screen.findByText("project-reviewer")).toBeVisible();
    expect(screen.getByText("Project-only reviewer")).toBeVisible();
  });

  it("renders the Paper Assistant card and preserves an effective model absent from the catalog", async () => {
    render(<AgentList cwd="/p" statusByAgent={{ "paper-assistant": "idle", search: "working" }} sessionId="s1" />);

    expect(await screen.findByText("Paper Assistant")).toBeVisible();
    expect(api.listAgents).toHaveBeenCalledWith("/p");
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getAllByRole("combobox")[2]).toHaveTextContent("custom/model");
  });

  it("reloads the effective roster when the project cwd changes", async () => {
    const { rerender } = render(
      <AgentList cwd="/p" statusByAgent={{ "paper-assistant": "idle", search: "idle" }} sessionId="s1" />,
    );
    await screen.findByText("Paper Assistant");

    rerender(<AgentList cwd="/other" statusByAgent={{ "paper-assistant": "idle", search: "idle" }} sessionId="s1" />);

    await waitFor(() => expect(api.listAgents).toHaveBeenCalledWith("/other"));
  });

  it("sends null when a stage agent is reset to the default model", async () => {
    const user = userEvent.setup();
    render(<AgentList cwd="/p" statusByAgent={{ "paper-assistant": "idle", search: "idle" }} sessionId="s1" />);

    const searchCard = (await screen.findByText("Search")).closest<HTMLElement>("div.mt-3")!;
    const searchModel = within(searchCard).getByRole("combobox", { name: "Select model" });
    await user.click(searchModel);
    await user.click(screen.getByRole("option", { name: "Default model" }));

    await waitFor(() => expect(api.setAgentModel).toHaveBeenCalledWith("s1", "search", null));
  });

  it("shows the effective thinking level per card from the effective-thinking endpoint", async () => {
    render(<AgentList cwd="/p" statusByAgent={{ "paper-assistant": "idle", search: "idle" }} sessionId="s1" />);

    expect(await screen.findByDisplayValue("high")).toBeVisible();
    expect(screen.getByDisplayValue("low")).toBeVisible();
    expect(api.getEffectiveThinking).toHaveBeenCalledWith("s1");
  });

  it("shades the default value on the empty thinking option when the value is the default", async () => {
    render(<AgentList cwd="/p" statusByAgent={{ "paper-assistant": "idle", search: "idle" }} sessionId="s1" />);

    const thinking = await screen.findByDisplayValue("low");
    const options = Array.from(thinking.querySelectorAll("option"));
    expect(options.some((option) => option.value === "" && option.textContent === "Default (low)")).toBe(true);
  });

  it("applies a stage-agent thinking selection as a session override", async () => {
    const user = userEvent.setup();
    render(<AgentList cwd="/p" statusByAgent={{ "paper-assistant": "idle", search: "idle" }} sessionId="s1" />);

    const thinking = await screen.findByDisplayValue("low");
    await user.selectOptions(thinking, "off");

    await waitFor(() => expect(api.setAgentThinking).toHaveBeenCalledWith("s1", "search", "off"));
  });

  it("clears the thinking override when the empty option is selected", async () => {
    const user = userEvent.setup();
    render(<AgentList cwd="/p" statusByAgent={{ "paper-assistant": "idle", search: "idle" }} sessionId="s1" />);

    const thinking = await screen.findByDisplayValue("high");
    await user.selectOptions(thinking, "");

    await waitFor(() => expect(api.setAgentThinking).toHaveBeenCalledWith("s1", "paper-assistant", null));
  });

  it("keeps its header mounted when agent data fails", async () => {
    vi.mocked(api.listAgents).mockRejectedValue(new Error("unavailable"));
    render(<AgentList cwd="/p" statusByAgent={{ "paper-assistant": "idle" }} sessionId="s1" />);

    expect(screen.getByText("Agents")).toBeVisible();
  });

  it("does not let an old session model response replace the current session", async () => {
    const oldModels = deferred<Awaited<ReturnType<typeof api.getEffectiveModels>>>();
    vi.mocked(api.getEffectiveModels)
      .mockReturnValueOnce(oldModels.promise)
      .mockResolvedValueOnce([
        { name: "paper-assistant", model: "openai/current", source: "override" },
        { name: "search", model: "openai/current", source: "override" },
      ]);
    const { rerender } = render(
      <AgentList cwd="/p" statusByAgent={{ "paper-assistant": "idle", search: "idle" }} sessionId="s1" />,
    );
    rerender(<AgentList cwd="/p" statusByAgent={{ "paper-assistant": "idle", search: "idle" }} sessionId="s2" />);
    await waitFor(() => {
      const current = screen.getAllByRole("combobox").filter((el) => el.textContent?.includes("openai/current"));
      expect(current).toHaveLength(2);
    });

    oldModels.resolve([
      { name: "paper-assistant", model: "openai/old", source: "override" },
      { name: "search", model: "openai/old", source: "override" },
    ]);

    await waitFor(() => {
      const stale = screen.getAllByRole("combobox").filter((el) => el.textContent?.includes("openai/old"));
      expect(stale).toHaveLength(0);
    });
  });

  it("does not leave the previous session roster interactive when the current load fails", async () => {
    const { rerender } = render(
      <AgentList cwd="/p" statusByAgent={{ "paper-assistant": "idle", search: "idle" }} sessionId="s1" />,
    );
    expect(await screen.findByText("Search")).toBeVisible();
    expect(screen.getAllByRole("combobox")).toHaveLength(4);
    vi.mocked(api.listAgents).mockRejectedValueOnce(new Error("current project unavailable"));

    rerender(<AgentList cwd="/other" statusByAgent={{ "paper-assistant": "idle" }} sessionId="s2" />);

    await waitFor(() => expect(screen.queryByText("Search")).toBeNull());
    expect(screen.getAllByRole("combobox")).toHaveLength(2);
    expect(screen.getAllByRole("combobox")[0]).toBeDisabled();
    expect(screen.getAllByRole("combobox")[1]).toBeDisabled();
    expect(screen.queryByDisplayValue("openai/gpt-4o")).toBeNull();
  });

  it("shows disabled stage agents read-only and disables their model selector", async () => {
    vi.mocked(api.listAgents).mockResolvedValueOnce([
      {
        name: "paper-assistant",
        description: "Coordinates work",
        enabled: true,
        builtin: true,
        source: "bundled",
        filePath: "paper-assistant.md",
        effectiveTools: [],
        effectiveSkills: [],
        missingSkills: [],
      },
      {
        name: "search",
        description: "Finds papers",
        enabled: false,
        builtin: true,
        source: "bundled",
        filePath: "search.md",
        effectiveTools: [],
        effectiveSkills: [],
        missingSkills: [],
      },
    ]);
    render(<AgentList cwd="/p" statusByAgent={{ "paper-assistant": "idle", search: "idle" }} sessionId="s1" />);

    const search = (await screen.findByText("Search")).closest<HTMLElement>("div.mt-3")!;
    expect(within(search).getByText("Disabled")).toBeVisible();
    expect(
      within(search)
        .getAllByRole("combobox")
        .every((box) => (box as HTMLSelectElement).disabled),
    ).toBe(true);
    expect(screen.queryByRole("switch")).toBeNull();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
