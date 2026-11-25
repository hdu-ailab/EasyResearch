import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDto, ToolDiagnosticDto } from "../../../../web/contracts";
import * as api from "../../api";
import { I18nProvider } from "../../i18n/I18nProvider";
import { STORAGE_KEY } from "../../preferences";
import { PreferencesProvider } from "../../preferences/PreferencesProvider";
import { ToolsSettingsPanel } from "./ToolsSettingsPanel";

vi.mock("../../api", () => ({
  listAgents: vi.fn(),
  refreshConfigurationResources: vi.fn(),
}));

function agent(tools: string[], diagnostics: ToolDiagnosticDto[] = [], truncated = false): AgentDto {
  return {
    name: "research-assistant",
    description: "Coordinates",
    source: "bundled",
    builtin: true,
    enabled: true,
    filePath: "/bundled/research-assistant.md",
    effectiveTools: tools,
    effectiveSkills: [],
    missingSkills: [],
    toolDiagnostics: diagnostics,
    toolDiagnosticsTruncated: truncated,
  };
}
const load: ToolDiagnosticDto = { kind: "load", scope: "global", path: "/agent/extensions/missing-dependency.ts" };
const registration: ToolDiagnosticDto = {
  kind: "registration",
  scope: "project",
  path: "/papers/a/.easyresearch/extensions/conflicting.ts",
};
const defaults = {
  active: true,
  scope: "global",
  projects: [{ cwd: "/papers/a" }, { cwd: "/papers/b" }],
  configurationGeneration: 1,
  mutationRevision: 0,
  onScopeChange: vi.fn(),
};
function ScopedTools() {
  const [scope, setScope] = useState("global");
  return <ToolsSettingsPanel {...defaults} scope={scope} onScopeChange={setScope} />;
}
beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(api.listAgents)
    .mockReset()
    .mockResolvedValue([agent(["read", "healthy_tool"])]);
  vi.mocked(api.refreshConfigurationResources).mockReset().mockResolvedValue({ generation: 1, error: null });
});
afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
});

describe("Tools Settings inventory", () => {
  it("counts distinct extension paths per kind and retains healthy tools from partially registered extensions", async () => {
    const secondLoad: ToolDiagnosticDto = {
      kind: "load",
      path: "/agent/extensions/invalid-typescript.ts",
      scope: "global",
    };
    const diagnostics = [load, secondLoad, registration];
    vi.mocked(api.listAgents).mockResolvedValue([
      agent(["read", "healthy_tool", "conflicting_survivor"], diagnostics),
      {
        ...agent(
          ["read"],
          diagnostics.map((value) => ({ ...value })),
        ),
        name: "search",
      },
    ]);
    render(<ToolsSettingsPanel {...defaults} />);
    expect(await screen.findByText("2 tool extensions failed to load. Loaded tools remain available.")).toBeVisible();
    expect(
      screen.getByText("1 tool extensions have registration issues. Loaded tools remain available."),
    ).toBeVisible();
    const failures = screen.getByRole("list", { name: "Failed tool extensions" });
    expect(within(failures).getAllByRole("listitem")).toHaveLength(2);
    expect(within(failures).getByText(load.path)).toBeVisible();
    const conflicts = screen.getByRole("list", { name: "Tool registration issues" });
    expect(within(conflicts).getAllByRole("listitem")).toHaveLength(1);
    expect(within(conflicts).getByText(registration.path)).toBeVisible();
    const tools = screen.getByRole("list", { name: "Loaded tools" });
    expect(within(tools).getAllByRole("listitem")).toHaveLength(3);
    expect(within(tools).getByText("conflicting_survivor")).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps scope identities distinct without counting a repeated path twice within a kind", async () => {
    vi.mocked(api.listAgents).mockResolvedValue([
      agent(["healthy_tool"], [load, { ...load, scope: "project" }, { ...load }]),
    ]);
    render(<ToolsSettingsPanel {...defaults} />);
    expect(await screen.findByText("1 tool extensions failed to load. Loaded tools remain available.")).toBeVisible();
    const failures = screen.getByRole("list", { name: "Failed tool extensions" });
    expect(within(failures).getAllByRole("listitem")).toHaveLength(2);
    expect(within(failures).getByText("Global")).toBeVisible();
    expect(within(failures).getByText("Workspace")).toBeVisible();
  });

  it("uses lower-bound bilingual summaries for truncated projections", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ language: "zh-CN" }));
    vi.mocked(api.listAgents).mockResolvedValue([agent(["healthy_tool"], [load, registration], true)]);
    render(
      <PreferencesProvider>
        <I18nProvider>
          <ToolsSettingsPanel {...defaults} />
        </I18nProvider>
      </PreferencesProvider>,
    );
    expect(await screen.findByText("至少 1 个工具扩展加载失败。已加载的工具仍可使用。")).toBeVisible();
    expect(screen.getByText("至少 1 个工具扩展存在注册问题。已加载的工具仍可使用。")).toBeVisible();
    expect(screen.getByText("部分扩展诊断已省略。")).toBeVisible();
    expect(screen.getByRole("button", { name: "刷新工具" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "工具范围" })).toBeVisible();
    expect(screen.getByText("healthy_tool")).toBeVisible();
  });

  it("uses only registered effective tools, including explicit empty inventories", async () => {
    vi.mocked(api.listAgents).mockResolvedValue([
      { ...agent([]), tools: ["configured_but_missing"] },
      { ...agent([]), name: "search", tools: ["also_missing"] },
    ]);
    render(<ToolsSettingsPanel {...defaults} />);
    expect(await screen.findByText("No tools loaded.")).toBeVisible();
    expect(screen.queryByText("configured_but_missing")).toBeNull();
    expect(screen.queryByText("also_missing")).toBeNull();
  });

  it("clears scope-mismatched values immediately and ignores a stale project failure", async () => {
    const user = userEvent.setup();
    const projectA = Promise.withResolvers<AgentDto[]>();
    const projectB = Promise.withResolvers<AgentDto[]>();
    vi.mocked(api.listAgents)
      .mockResolvedValueOnce([agent(["global_only"], [load])])
      .mockReturnValueOnce(projectA.promise)
      .mockReturnValueOnce(projectB.promise);
    render(<ScopedTools />);
    await screen.findByText("global_only");
    const scope = screen.getByRole("combobox", { name: "Tool scope" });
    await user.selectOptions(scope, "/papers/a");
    const signalA = vi.mocked(api.listAgents).mock.calls[1]![1];
    expect(screen.queryByText("global_only")).toBeNull();
    expect(screen.queryByText(load.path)).toBeNull();
    expect(screen.getByText("Loading tools…")).toBeVisible();
    await user.selectOptions(scope, "/papers/b");
    expect(signalA?.aborted).toBe(true);
    await act(async () => projectB.resolve([agent(["project_b"])]));
    await act(async () => projectA.reject(new Error("secret stale project A payload")));
    expect(screen.getByText("project_b")).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(scope).toHaveValue("/papers/b");
    expect(screen.queryByText("Loading tools…")).toBeNull();
  });

  it("does not display a former scope's HTTP error while the new scope is loading", async () => {
    const user = userEvent.setup();
    const pending = Promise.withResolvers<AgentDto[]>();
    vi.mocked(api.listAgents)
      .mockRejectedValueOnce(new Error("private exception"))
      .mockReturnValueOnce(pending.promise);
    render(<ScopedTools />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the tool inventory.");
    expect(screen.queryByText("No tools loaded.")).toBeNull();
    expect(screen.queryByText("private exception")).toBeNull();
    await user.selectOptions(screen.getByRole("combobox", { name: "Tool scope" }), "/papers/a");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("No tools loaded.")).toBeNull();
    await act(async () => pending.resolve([agent(["project_tool"])]));
    expect(screen.getByText("project_tool")).toBeVisible();
  });

  it("reconciles accepted inventory events and retains same-scope cached tools on an HTTP failure", async () => {
    const old = Promise.withResolvers<AgentDto[]>();
    vi.mocked(api.listAgents)
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce([agent(["current_tool"], [registration])])
      .mockRejectedValueOnce(new Error("arbitrary server exception"))
      .mockResolvedValueOnce([agent(["recovered_tool"])]);
    const view = render(<ToolsSettingsPanel {...defaults} />);
    const oldSignal = vi.mocked(api.listAgents).mock.calls[0]![1];
    view.rerender(<ToolsSettingsPanel {...defaults} configurationGeneration={2} />);
    await screen.findByText("current_tool");
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => old.resolve([agent(["obsolete_tool"], [load])]));
    expect(screen.queryByText("obsolete_tool")).toBeNull();
    view.rerender(<ToolsSettingsPanel {...defaults} configurationGeneration={3} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Showing the last loaded inventory.");
    expect(screen.getByText("current_tool")).toBeVisible();
    expect(screen.queryByText("arbitrary server exception")).toBeNull();
    view.rerender(<ToolsSettingsPanel {...defaults} configurationGeneration={4} />);
    expect(await screen.findByText("recovered_tool")).toBeVisible();
    expect(screen.queryByText(registration.path)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("synchronizes the selected project before manual refetch and coalesces events during synchronization", async () => {
    const user = userEvent.setup();
    const synchronization = Promise.withResolvers<{ generation: number; error: string | null }>();
    vi.mocked(api.listAgents)
      .mockResolvedValueOnce([agent(["healthy_tool"], [load])])
      .mockResolvedValueOnce([agent(["fresh_tool"])]);
    vi.mocked(api.refreshConfigurationResources).mockReturnValue(synchronization.promise);
    const view = render(<ToolsSettingsPanel {...defaults} scope="/papers/a" />);
    await screen.findByText(load.path);
    const refresh = screen.getByRole("button", { name: "Refresh tools" });
    await user.dblClick(refresh);
    expect(api.refreshConfigurationResources).toHaveBeenCalledExactlyOnceWith({ projectCwds: ["/papers/a"] });
    expect(refresh).toBeDisabled();
    expect(api.listAgents).toHaveBeenCalledOnce();
    view.rerender(<ToolsSettingsPanel {...defaults} scope="/papers/a" configurationGeneration={2} />);
    expect(api.listAgents).toHaveBeenCalledOnce();
    await act(async () => synchronization.resolve({ generation: 2, error: null }));
    expect(await screen.findByText("fresh_tool")).toBeVisible();
    expect(api.listAgents).toHaveBeenLastCalledWith("/papers/a", expect.any(AbortSignal));
    expect(screen.queryByText(load.path)).toBeNull();
    expect(refresh).toBeEnabled();
  });

  it("drops obsolete synchronization replies without refetching or clearing the next scope's pending state", async () => {
    const user = userEvent.setup();
    const synchronization = Promise.withResolvers<{ generation: number; error: string | null }>();
    const project = Promise.withResolvers<AgentDto[]>();
    vi.mocked(api.listAgents)
      .mockResolvedValueOnce([agent(["global_tool"])])
      .mockReturnValueOnce(project.promise);
    vi.mocked(api.refreshConfigurationResources).mockReturnValue(synchronization.promise);
    render(<ScopedTools />);
    await screen.findByText("global_tool");
    await user.click(screen.getByRole("button", { name: "Refresh tools" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Tool scope" }), "/papers/a");
    await act(async () => synchronization.resolve({ generation: 2, error: "Old scope failure" }));
    expect(api.listAgents).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Loading tools…")).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("global_tool")).toBeNull();
    await act(async () => project.resolve([agent(["project_tool"])]));
    expect(screen.getByText("project_tool")).toBeVisible();
  });

  it("shows genuine synchronization failure with healthy inventory and retries the same scope", async () => {
    const user = userEvent.setup();
    vi.mocked(api.refreshConfigurationResources)
      .mockRejectedValueOnce(new Error("raw unsafe failure"))
      .mockResolvedValueOnce({ generation: 2, error: null });
    render(<ToolsSettingsPanel {...defaults} scope="/papers/a" />);
    await screen.findByText("healthy_tool");
    await user.click(screen.getByRole("button", { name: "Refresh tools" }));
    const error = screen.getByRole("alert");
    expect(error).toHaveTextContent("Could not synchronize the tool inventory.");
    expect(screen.getByText("healthy_tool")).toBeVisible();
    expect(screen.queryByText("raw unsafe failure")).toBeNull();
    expect(api.listAgents).toHaveBeenCalledOnce();
    await user.click(within(error).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(api.refreshConfigurationResources).toHaveBeenNthCalledWith(2, { projectCwds: ["/papers/a"] });
    expect(api.listAgents).toHaveBeenCalledTimes(2);
  });

  it("reads only on demand, mutation or configuration invalidation and cancels obsolete view requests", async () => {
    const pending = Promise.withResolvers<AgentDto[]>();
    const view = render(<ToolsSettingsPanel {...defaults} active={false} />);
    expect(api.listAgents).not.toHaveBeenCalled();
    view.rerender(<ToolsSettingsPanel {...defaults} />);
    await screen.findByText("healthy_tool");
    vi.useFakeTimers();
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(api.listAgents).toHaveBeenCalledOnce();
    vi.useRealTimers();
    vi.mocked(api.listAgents).mockReturnValueOnce(pending.promise);
    view.rerender(<ToolsSettingsPanel {...defaults} mutationRevision={1} />);
    const signal = vi.mocked(api.listAgents).mock.calls[1]![1];
    view.rerender(<ToolsSettingsPanel {...defaults} active={false} mutationRevision={1} />);
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.reject(new Error("inactive read")));
    expect(screen.queryByRole("alert")).toBeNull();
    view.rerender(<ToolsSettingsPanel {...defaults} mutationRevision={1} />);
    await waitFor(() => expect(api.listAgents).toHaveBeenCalledTimes(3));
    const synchronization = Promise.withResolvers<{ generation: number; error: string | null }>();
    vi.mocked(api.refreshConfigurationResources).mockReturnValue(synchronization.promise);
    fireEvent.click(screen.getByRole("button", { name: "Refresh tools" }));
    view.unmount();
    await act(async () => synchronization.resolve({ generation: 3, error: null }));
    expect(api.listAgents).toHaveBeenCalledTimes(3);
  });
});
