import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { AgentList } from "./AgentList";

vi.mock("../api", () => ({
  getEffectiveModels: vi.fn(),
  listAgents: vi.fn(),
  listModels: vi.fn(),
  setAgentModel: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(api.listAgents).mockReset();
  vi.mocked(api.listModels).mockReset();
  vi.mocked(api.getEffectiveModels).mockReset();
  vi.mocked(api.setAgentModel).mockReset();
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
  vi.mocked(api.listModels).mockResolvedValue([{ provider: "openai", id: "gpt-4o" }]);
  vi.mocked(api.getEffectiveModels).mockResolvedValue([
    { name: "paper-assistant", model: "openai/gpt-4o", source: "inherit" },
    { name: "search", model: "custom/model", source: "override" },
  ]);
  vi.mocked(api.setAgentModel).mockResolvedValue(undefined);
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
    expect(screen.getAllByRole("combobox")[1]).toHaveDisplayValue("custom/model");
    expect(screen.getAllByRole("combobox")[1]).toHaveTextContent("custom/model");
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

    const searchSelect = await screen.findByDisplayValue("custom/model");
    await user.selectOptions(searchSelect, "");

    await waitFor(() => expect(api.setAgentModel).toHaveBeenCalledWith("s1", "search", null));
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
    expect(await screen.findAllByDisplayValue("openai/current")).toHaveLength(2);

    oldModels.resolve([
      { name: "paper-assistant", model: "openai/old", source: "override" },
      { name: "search", model: "openai/old", source: "override" },
    ]);

    await waitFor(() => expect(screen.queryByDisplayValue("openai/old")).toBeNull());
  });

  it("does not leave the previous session roster interactive when the current load fails", async () => {
    const { rerender } = render(
      <AgentList cwd="/p" statusByAgent={{ "paper-assistant": "idle", search: "idle" }} sessionId="s1" />,
    );
    expect(await screen.findByText("Search")).toBeVisible();
    expect(screen.getAllByRole("combobox")).toHaveLength(2);
    vi.mocked(api.listAgents).mockRejectedValueOnce(new Error("current project unavailable"));

    rerender(<AgentList cwd="/other" statusByAgent={{ "paper-assistant": "idle" }} sessionId="s2" />);

    await waitFor(() => expect(screen.queryByText("Search")).toBeNull());
    expect(screen.getByRole("combobox")).toBeDisabled();
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
    expect(within(search).getByRole("combobox")).toBeDisabled();
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
