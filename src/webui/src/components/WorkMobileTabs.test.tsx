// @vitest-environment jsdom
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { I18nContext } from "../i18n/I18nProvider";
import { zhCN } from "../i18n/messages";
import { WorkMobileTabs } from "./WorkMobileTabs";
import type { WorkView } from "./WorkMobileTabs";

it("exposes one selected tab with stable tab and panel ids", () => {
  render(<WorkMobileTabs active="chat" onChange={() => {}} />);

  const tabs = screen.getAllByRole("tab");
  expect(tabs).toHaveLength(3);
  expect(tabs[0]).toHaveAttribute("id", "work-tab-chat");
  expect(tabs[0]).toHaveAttribute("aria-selected", "true");
  expect(tabs[0]).toHaveAttribute("aria-controls", "work-panel-chat");
  expect(tabs[0]).toHaveAttribute("tabindex", "0");
  expect(tabs[1]).toHaveAttribute("id", "work-tab-files");
  expect(tabs[1]).toHaveAttribute("aria-selected", "false");
  expect(tabs[1]).toHaveAttribute("aria-controls", "work-panel-files");
  expect(tabs[1]).toHaveAttribute("tabindex", "-1");
  expect(tabs[2]).toHaveAttribute("id", "work-tab-agents");
  expect(tabs[2]).toHaveAttribute("aria-selected", "false");
  expect(tabs[2]).toHaveAttribute("aria-controls", "work-panel-agents");
  expect(tabs[2]).toHaveAttribute("tabindex", "-1");
});

it("selects and focuses tabs with click, arrows, Home, and End", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();

  function ControlledTabs() {
    const [active, setActive] = useState<WorkView>("chat");
    return (
      <WorkMobileTabs
        active={active}
        onChange={(view) => {
          onChange(view);
          setActive(view);
        }}
      />
    );
  }

  render(<ControlledTabs />);
  const chat = screen.getByRole("tab", { name: "Chat" });
  const files = screen.getByRole("tab", { name: "Files" });
  const agents = screen.getByRole("tab", { name: "Agents" });

  await user.click(files);
  expect(onChange).toHaveBeenLastCalledWith("files");
  expect(files).toHaveFocus();
  expect(files).toHaveAttribute("aria-selected", "true");
  expect(files).toHaveAttribute("tabindex", "0");
  expect(chat).toHaveAttribute("aria-selected", "false");
  expect(chat).toHaveAttribute("tabindex", "-1");

  await user.keyboard("{ArrowRight}");
  expect(onChange).toHaveBeenLastCalledWith("agents");
  expect(agents).toHaveFocus();
  expect(agents).toHaveAttribute("aria-selected", "true");
  expect(agents).toHaveAttribute("tabindex", "0");
  expect(files).toHaveAttribute("aria-selected", "false");
  expect(files).toHaveAttribute("tabindex", "-1");

  await user.keyboard("{ArrowDown}");
  expect(onChange).toHaveBeenLastCalledWith("chat");
  expect(chat).toHaveFocus();

  await user.keyboard("{ArrowLeft}");
  expect(onChange).toHaveBeenLastCalledWith("agents");
  expect(agents).toHaveFocus();

  await user.keyboard("{ArrowUp}");
  expect(onChange).toHaveBeenLastCalledWith("files");
  expect(files).toHaveFocus();

  await user.keyboard("{Home}");
  expect(onChange).toHaveBeenLastCalledWith("chat");
  expect(chat).toHaveFocus();

  await user.keyboard("{End}");
  expect(onChange).toHaveBeenLastCalledWith("agents");
  expect(agents).toHaveFocus();
});

it("prevents default only for handled navigation keys", () => {
  const onChange = vi.fn();
  render(<WorkMobileTabs active="chat" onChange={onChange} />);
  const chat = screen.getByRole("tab", { name: "Chat" });

  for (const key of ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"]) {
    expect(fireEvent.keyDown(chat, { key })).toBe(false);
  }
  expect(onChange).toHaveBeenCalledTimes(6);

  onChange.mockClear();
  expect(fireEvent.keyDown(chat, { key: "PageDown" })).toBe(true);
  expect(onChange).not.toHaveBeenCalled();
});

it("uses localized tablist and tab labels", () => {
  render(
    <I18nContext.Provider
      value={{ language: "zh-CN", setLanguage: () => {}, t: (key) => zhCN[key] }}
    >
      <WorkMobileTabs active="chat" onChange={() => {}} />
    </I18nContext.Provider>,
  );

  expect(screen.getByRole("tablist", { name: "工作视图" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "对话" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "文件" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "智能体" })).toBeInTheDocument();
});
