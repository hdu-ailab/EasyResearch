import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackgroundTask } from "../../../background/contracts";
import { I18nProvider } from "../i18n/I18nProvider";
import { STORAGE_KEY } from "../preferences";
import { PreferencesProvider } from "../preferences/PreferencesProvider";
import { BackgroundTaskControls } from "./BackgroundTaskControls";

afterEach(() => window.localStorage.clear());
describe("BackgroundTaskControls", () => {
  const tasks: BackgroundTask[] = [
    { id: "shell", kind: "shell", sessionID: "root", description: "Train", status: "running", blocking: true },
    {
      id: "child",
      kind: "subagent",
      sessionID: "child",
      agent: "search",
      description: "Sources",
      status: "running",
      blocking: false,
    },
    { id: "done", kind: "shell", sessionID: "root", description: "Finished", status: "completed", blocking: false },
  ];
  it("supports native keyboard controls with Chinese names and omits finished work", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ language: "zh-CN" }));
    const onCancel = vi.fn().mockResolvedValue(true);
    const onPromote = vi.fn().mockResolvedValue(true);
    render(
      <PreferencesProvider>
        <I18nProvider>
          <BackgroundTaskControls
            rootId="root"
            tasks={tasks}
            pending={[]}
            error={null}
            disabled={false}
            onCancel={onCancel}
            onPromote={onPromote}
          />
        </I18nProvider>
      </PreferencesProvider>,
    );
    const user = userEvent.setup();
    await user.tab();
    expect(screen.getByRole("button", { name: "运行中的任务 · 2" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "将命令转入后台" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onPromote).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "运行中的任务 · 2" }));
    await user.tab();
    expect(screen.getByRole("button", { name: "取消命令：Train" })).toHaveFocus();
    await user.keyboard(" ");
    expect(onCancel).toHaveBeenCalledWith("shell");
    expect(screen.getByRole("button", { name: "取消智能体及其子任务：Sources" })).toBeVisible();
    expect(screen.queryByText("Finished", { exact: false })).toBeNull();
  });
  it("disables only pending actions and keeps independently cancellable peers", async () => {
    render(
      <BackgroundTaskControls
        rootId="root"
        tasks={tasks}
        pending={["shell", "promote"]}
        error={null}
        disabled={false}
        onCancel={vi.fn()}
        onPromote={vi.fn()}
      />,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Running tasks · 2" }));
    expect(screen.getByRole("button", { name: "Cancel command: Train" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move command to background" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel agent tree: Sources" })).toBeEnabled();
  });
});
