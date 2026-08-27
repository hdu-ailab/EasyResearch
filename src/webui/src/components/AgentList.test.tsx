import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDto } from "../../../web/contracts";
import * as api from "../api";
import { AgentList } from "./AgentList";

vi.mock("../api", () => ({
  listAgents: vi.fn(),
  listModels: vi.fn(),
  patchAgent: vi.fn(),
  refreshConfigurationResources: vi.fn(),
}));

const baseAgents: AgentDto[] = [
  {
    name: "research-assistant",
    description: "Coordinates work",
    enabled: true,
    builtin: true,
    source: "bundled",
    filePath: "research-assistant.md",
    effectiveModel: "openai/gpt-4o",
    effectiveTools: [],
    effectiveSkills: [],
    missingSkills: [],
  },
  {
    name: "search",
    description: "Finds papers",
    enabled: true,
    builtin: true,
    source: "global",
    filePath: "/agent/agents/search.md",
    model: "custom/model",
    effectiveModel: "custom/model",
    thinking: "low",
    effectiveTools: ["web-search"],
    effectiveSkills: ["paper-search"],
    missingSkills: [],
  },
];

const props = {
  cwd: "/p",
  statusByAgent: { "research-assistant": "idle", search: "idle" } as const,
  configurationGeneration: 1,
  configurationError: null,
};

beforeEach(() => {
  vi.mocked(api.listAgents).mockReset().mockResolvedValue(baseAgents);
  vi.mocked(api.listModels)
    .mockReset()
    .mockResolvedValue([
      { provider: "openai", id: "gpt-4o", reasoning: true, thinkingLevelMap: { xhigh: null, max: null } },
    ]);
  vi.mocked(api.patchAgent)
    .mockReset()
    .mockImplementation(async (name, patch) => {
      const current = baseAgents.find((agent) => agent.name === name)!;
      const next = { ...current };
      if (patch.model === null) delete next.model;
      else if (patch.model !== undefined) next.model = patch.model;
      if (patch.thinking === null) delete next.thinking;
      else if (patch.thinking !== undefined) next.thinking = patch.thinking;
      return next;
    });
  vi.mocked(api.refreshConfigurationResources).mockReset().mockResolvedValue({ generation: 1, error: null });
});

describe("AgentList", () => {
  it("renders global Agent fields for the exact cwd and has no session override action", async () => {
    render(<AgentList {...props} />);

    expect(await screen.findByText("Research Assistant")).toBeVisible();
    expect(api.listAgents).toHaveBeenCalledWith("/p");
    expect(screen.queryByRole("button", { name: /follow global/i })).toBeNull();
    const search = screen.getByText("Search").closest<HTMLElement>("div.mt-3")!;
    expect(within(search).getByRole("combobox", { name: "Select model" })).toHaveTextContent("custom/model");
    expect(within(search).getByRole("combobox", { name: /select thinking/i })).toHaveValue("low");
  });

  it("patches the same global Agent model without a session id", async () => {
    const user = userEvent.setup();
    render(<AgentList {...props} />);
    const search = (await screen.findByText("Search")).closest<HTMLElement>("div.mt-3")!;
    const model = within(search).getByRole("combobox", { name: "Select model" });

    await user.click(model);
    await user.click(screen.getByRole("option", { name: "inherit (Research Assistant's model)" }));

    await waitFor(() => expect(api.patchAgent).toHaveBeenCalledWith("search", { model: null }));
  });

  it("selects Pi's resolved Research Assistant model once without an Automatic option", async () => {
    const user = userEvent.setup();
    render(<AgentList {...props} />);

    const assistant = (await screen.findByText("Research Assistant")).closest<HTMLElement>("div.mt-3")!;
    const model = within(assistant).getByRole("combobox", { name: "Select model" });
    expect(model).toHaveTextContent("openai/gpt-4o");
    await user.click(model);
    expect(screen.getAllByRole("option", { name: "openai/gpt-4o" })).toHaveLength(1);
    expect(screen.queryByRole("option", { name: "Automatic (Pi default)" })).toBeNull();
    expect(api.patchAgent).not.toHaveBeenCalled();
  });

  it("keeps the Research Assistant model empty and reports when Pi resolves no default", async () => {
    vi.mocked(api.listAgents).mockResolvedValueOnce([{ ...baseAgents[0]!, effectiveModel: undefined }]);
    render(<AgentList {...props} />);

    const assistant = (await screen.findByText("Research Assistant")).closest<HTMLElement>("div.mt-3")!;
    const model = within(assistant).getByRole("combobox", { name: "Select model" });
    expect(model).not.toHaveTextContent("openai/gpt-4o");
    expect(within(assistant).queryByText("Automatic (Pi default)")).toBeNull();
    expect(within(assistant).getByRole("alert")).toHaveTextContent(
      "Could not resolve a default model. Configure a model or credentials.",
    );
    expect(assistant).not.toHaveTextContent(/\bPi\b/);
  });

  it("distinguishes automatic Research Assistant thinking from inherited stage thinking", async () => {
    vi.mocked(api.listAgents).mockResolvedValueOnce([
      baseAgents[0]!,
      { ...baseAgents[1]!, model: undefined, effectiveModel: "openai/gpt-4o", thinking: undefined },
    ]);
    render(<AgentList {...props} />);

    const assistant = (await screen.findByText("Research Assistant")).closest<HTMLElement>("div.mt-3")!;
    const search = screen.getByText("Search").closest<HTMLElement>("div.mt-3")!;
    expect(within(assistant).getByRole("combobox", { name: /select thinking/i })).toHaveTextContent(
      "Automatic (highest supported)",
    );
    expect(within(assistant).getByRole("option", { name: "high" })).toBeTruthy();
    expect(within(assistant).queryByRole("option", { name: "max" })).toBeNull();
    expect(within(search).getByRole("combobox", { name: /select thinking/i })).toHaveTextContent(
      "inherit (Research Assistant's thinking)",
    );
    expect(within(search).getByRole("option", { name: "high" })).toBeTruthy();
    expect(within(search).queryByRole("option", { name: "max" })).toBeNull();
  });

  it("patches global thinking and clears it to the off default", async () => {
    const user = userEvent.setup();
    render(<AgentList {...props} />);
    const search = (await screen.findByText("Search")).closest<HTMLElement>("div.mt-3")!;
    const thinking = within(search).getByRole("combobox", { name: /select thinking/i });

    await user.selectOptions(thinking, "off");
    await waitFor(() => expect(api.patchAgent).toHaveBeenCalledWith("search", { thinking: "off" }));
    await user.selectOptions(thinking, "");
    await waitFor(() => expect(api.patchAgent).toHaveBeenCalledWith("search", { thinking: null }));
  });

  it("refetches on a newer configuration generation and reflects added and removed Agents", async () => {
    const reviewer: AgentDto = {
      name: "reviewer",
      description: "Reviews evidence",
      enabled: true,
      builtin: false,
      source: "global",
      filePath: "/agent/agents/reviewer.md",
      effectiveTools: [],
      effectiveSkills: [],
      missingSkills: [],
    };
    const view = render(<AgentList {...props} />);
    expect(await screen.findByText("Search")).toBeVisible();
    vi.mocked(api.listAgents).mockResolvedValueOnce([baseAgents[0]!, reviewer]);

    view.rerender(<AgentList {...props} configurationGeneration={2} />);

    expect(await screen.findByText("reviewer")).toBeVisible();
    expect(screen.queryByText("Search")).toBeNull();
  });

  it("updates rendered effective Skill counts after missing project Skills resolve", async () => {
    vi.mocked(api.listAgents).mockResolvedValueOnce([
      baseAgents[0]!,
      { ...baseAgents[1]!, missingSkills: ["project-search"] },
    ]);
    const view = render(<AgentList {...props} />);
    const initial = (await screen.findByText("Search")).closest<HTMLElement>("div.mt-3")!;
    expect(within(initial).getByText("1 tools, 1 skills")).toBeVisible();
    vi.mocked(api.listAgents).mockResolvedValueOnce([
      baseAgents[0]!,
      {
        ...baseAgents[1]!,
        effectiveSkills: ["paper-search", "project-search"],
        missingSkills: [],
      },
    ]);

    view.rerender(<AgentList {...props} configurationGeneration={2} />);

    const refreshed = (await screen.findByText("Search")).closest<HTMLElement>("div.mt-3")!;
    expect(within(refreshed).getByText("1 tools, 2 skills")).toBeVisible();
    expect(within(refreshed).queryByText("1 tools, 1 skills")).toBeNull();
  });

  it("does not let a generation-two response replace generation three", async () => {
    const stale = deferred<AgentDto[]>();
    const initial: AgentDto = { ...baseAgents[1]!, name: "reviewer", builtin: false, description: "Initial revision" };
    const current: AgentDto[] = [{ ...initial, description: "Generation three" }];
    vi.mocked(api.listAgents).mockResolvedValueOnce([initial]);
    const view = render(<AgentList {...props} />);
    expect(await screen.findByText("Initial revision")).toBeVisible();
    vi.mocked(api.listAgents).mockReturnValueOnce(stale.promise).mockResolvedValueOnce(current);

    view.rerender(<AgentList {...props} configurationGeneration={2} />);
    view.rerender(<AgentList {...props} configurationGeneration={3} />);
    expect(await screen.findByText("Generation three")).toBeVisible();

    await act(async () => {
      stale.resolve([{ ...initial, description: "Generation two" }]);
      await stale.promise;
    });
    expect(screen.getByText("Generation three")).toBeVisible();
    expect(screen.queryByText("Generation two")).toBeNull();
  });

  it("keeps last-good controls under config.error and supports manual Refresh recovery", async () => {
    const user = userEvent.setup();
    const view = render(<AgentList {...props} />);
    expect(await screen.findByText("Search")).toBeVisible();

    view.rerender(<AgentList {...props} configurationError="Invalid Agent configuration" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Invalid Agent configuration");
    expect(screen.getByText("Search")).toBeVisible();
    expect(screen.getAllByRole("combobox").length).toBeGreaterThan(0);

    vi.mocked(api.listAgents).mockResolvedValueOnce([
      { ...baseAgents[1]!, name: "reviewer", builtin: false, description: "Recovered" },
    ]);
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Recovered")).toBeVisible();
  });

  it("awaits exact-project synchronization before manual Refresh and surfaces its safe error", async () => {
    const user = userEvent.setup();
    const synchronization = deferred<Awaited<ReturnType<typeof api.refreshConfigurationResources>>>();
    vi.mocked(api.refreshConfigurationResources).mockReturnValue(synchronization.promise);
    vi.mocked(api.listAgents)
      .mockResolvedValueOnce(baseAgents)
      .mockResolvedValueOnce([{ ...baseAgents[1]!, name: "reviewer", builtin: false, description: "Recovered" }]);
    render(<AgentList {...props} />);
    expect(await screen.findByText("Search")).toBeVisible();
    const agentCalls = vi.mocked(api.listAgents).mock.calls.length;

    await user.click(screen.getByRole("button", { name: "Refresh" }));

    expect(api.refreshConfigurationResources).toHaveBeenCalledWith({ projectCwds: ["/p"] });
    expect(api.listAgents).toHaveBeenCalledTimes(agentCalls);

    await act(async () => {
      synchronization.resolve({ generation: 2, error: "Configuration refresh failed. Retry refresh." });
      await synchronization.promise;
    });
    expect(await screen.findByText("Recovered")).toBeVisible();
    expect(screen.getByText("Configuration refresh failed. Retry refresh.")).toBeVisible();
  });

  it("keeps disabled stage Agents read-only", async () => {
    vi.mocked(api.listAgents).mockResolvedValueOnce([baseAgents[0]!, { ...baseAgents[1]!, enabled: false }]);
    render(<AgentList {...props} />);

    const search = (await screen.findByText("Search")).closest<HTMLElement>("div.mt-3")!;
    expect(within(search).getByText("Disabled")).toBeVisible();
    expect(
      within(search)
        .getAllByRole("combobox")
        .every((control) => control.hasAttribute("disabled")),
    ).toBe(true);
  });

  it("keeps the header and Research Assistant fallback when the first load fails", async () => {
    vi.mocked(api.listAgents).mockRejectedValueOnce(new Error("unavailable"));
    render(<AgentList {...props} />);

    expect(screen.getByText("Agents")).toBeVisible();
    expect(await screen.findByText("Research Assistant")).toBeVisible();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
