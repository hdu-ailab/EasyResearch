import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readDesktopPreferenceBlob, writeDesktopPreferenceBlob } from "../../../../desktop/preferences-store";
import { I18nProvider } from "../../i18n/I18nProvider";
import { messages } from "../../i18n/messages";
import { readPreferences, STORAGE_KEY } from "../../preferences";
import { PreferencesProvider } from "../../preferences/PreferencesProvider";
import { getTimelineDetail, TIMELINE_CATEGORIES, TIMELINE_PRESETS } from "../../timeline-detail";
import { TimelineDetailSettings } from "./TimelineDetailSettings";

function renderSettings() {
  return render(
    <PreferencesProvider>
      <I18nProvider>
        <TimelineDetailSettings />
      </I18nProvider>
    </PreferencesProvider>,
  );
}

function storedDetail() {
  return getTimelineDetail(readPreferences(localStorage, () => "en"));
}

beforeEach(() => {
  localStorage.clear();
  delete window.easyresearchDesktop;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete window.easyresearchDesktop;
});

describe("TimelineDetailSettings", () => {
  it("starts compact with advanced controls closed and exposes all presets through the scale", async () => {
    const user = userEvent.setup();
    renderSettings();
    const slider = screen.getByRole("slider", { name: "Conversation detail" });
    const advanced = screen.getByRole("button", { name: "Advanced" });
    expect(slider).toHaveAttribute("aria-valuetext", "Compact");
    expect(advanced).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("group", { name: "Commands" })).not.toBeInTheDocument();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

    for (const [position, preset] of [...TIMELINE_PRESETS].reverse().entries()) {
      fireEvent.change(slider, { target: { value: position } });
      expect(slider).toHaveAttribute("aria-valuetext", messages.en[`settings.timeline.preset.${preset.id}`]);
      expect(storedDetail()).toEqual(preset.value);
    }
    advanced.focus();
    await user.keyboard("{Enter}");
    expect(advanced).toHaveAttribute("aria-expanded", "true");
    for (const category of TIMELINE_CATEGORIES) {
      expect(screen.getByRole("group", { name: messages.en[`settings.timeline.category.${category}`] })).toBeVisible();
    }
  });

  it.each(TIMELINE_CATEGORIES)(
    "changes only %s and restores grouping/disclosure after hide and show",
    async (category) => {
      const user = userEvent.setup();
      renderSettings();
      await user.click(screen.getByRole("button", { name: "Advanced" }));
      const activity = messages.en[`settings.timeline.category.${category}`];
      const row = within(screen.getByRole("group", { name: activity }));
      const original = storedDetail();

      await user.click(row.getByRole("switch", { name: `Group ${activity}` }));
      const collapse = row.getByRole("switch", { name: `Collapse ${activity} by default` });
      collapse.focus();
      await user.keyboard(" ");
      expect(storedDetail()).toEqual({ ...original, [category]: { placement: "separate", details: "expanded" } });
      expect(screen.getByRole("slider")).toHaveAttribute("aria-valuetext", "Custom");

      await user.click(row.getByRole("button", { name: `Hide ${activity}` }));
      expect(storedDetail()[category]).toEqual({ placement: "hidden", details: "expanded" });
      expect(row.queryByRole("switch")).not.toBeInTheDocument();
      const show = row.getByRole("button", { name: `Show ${activity}` });
      expect(show).toHaveAttribute("aria-pressed", "false");
      await user.click(show);
      expect(storedDetail()).toEqual({ ...original, [category]: { placement: "separate", details: "expanded" } });
      expect(row.getByRole("button", { name: `Hide ${activity}` })).toHaveAttribute("aria-pressed", "true");
    },
  );

  it("opens advanced controls for migrated custom preferences and preserves subagent output", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ expandSubagentOutput: true, autoExpandThinking: false }));
    renderSettings();
    expect(screen.getByRole("button", { name: "Advanced" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("switch", { name: "Collapse Subagents by default" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.getByRole("switch", { name: "Group Subagents" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("switch", { name: "Collapse Thinking by default" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("restores the latest visible placement after preset changes instead of an earlier Hide", async () => {
    const user = userEvent.setup();
    renderSettings();
    await user.click(screen.getByRole("button", { name: "Advanced" }));
    await user.click(screen.getByRole("button", { name: "Hide Commands" }));
    const slider = screen.getByRole("slider", { name: "Conversation detail" });
    fireEvent.change(slider, { target: { value: 4 } });
    fireEvent.change(slider, { target: { value: 0 } });
    await user.click(screen.getByRole("button", { name: "Show Commands" }));
    expect(storedDetail()).toEqual({
      ...TIMELINE_PRESETS[4].value,
      shell: { placement: "separate", details: "collapsed" },
    });
  });

  it("remembers each category's latest cross-tab placement through subsequent hidden updates", async () => {
    const user = userEvent.setup();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ timelineDetail: TIMELINE_PRESETS[0].value }));
    renderSettings();
    await user.click(screen.getByRole("button", { name: "Advanced" }));
    await user.click(screen.getByRole("button", { name: "Hide Commands" }));

    function receive(timelineDetail: ReturnType<typeof getTimelineDetail>) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ timelineDetail }));
      act(() => window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY })));
    }

    receive(TIMELINE_PRESETS[2].value);
    receive({ ...TIMELINE_PRESETS[2].value, edit: { placement: "separate", details: "collapsed" } });
    receive(TIMELINE_PRESETS[4].value);
    const hidden = {
      ...TIMELINE_PRESETS[4].value,
      shell: { placement: "hidden", details: "expanded" },
    } as const;
    receive(hidden);
    await user.click(screen.getByRole("button", { name: "Show Commands" }));
    await user.click(screen.getByRole("button", { name: "Show File changes" }));
    expect(storedDetail()).toEqual({
      ...hidden,
      shell: { placement: "grouped", details: "expanded" },
      edit: { placement: "separate", details: "collapsed" },
    });
  });

  it("activates Compact directly from Custom even when the range is already at the Compact stop", async () => {
    const user = userEvent.setup();
    renderSettings();
    await user.click(screen.getByRole("button", { name: "Advanced" }));
    await user.click(screen.getByRole("switch", { name: "Collapse Thinking by default" }));
    const slider = screen.getByRole("slider", { name: "Conversation detail" });
    expect(slider).toHaveValue("2");
    expect(slider).toHaveAttribute("aria-valuetext", "Custom");
    const presets = screen.getByRole("combobox", { name: "Conversation detail" });
    expect(presets).toHaveValue("custom");
    await user.selectOptions(presets, "compact");
    expect(storedDetail()).toEqual(TIMELINE_PRESETS[2].value);
    expect(presets).toHaveValue("compact");
    expect(slider).toHaveValue("2");
    expect(slider).toHaveAttribute("aria-valuetext", "Compact");
  });

  it("applies cross-tab policy changes without echo persistence or replacing the control", async () => {
    const user = userEvent.setup();
    const persistWebUiPreferences = vi.fn();
    window.easyresearchDesktop = { platform: "linux", version: "1.2.3", persistWebUiPreferences };
    renderSettings();
    await user.click(screen.getByRole("button", { name: "Advanced" }));
    const slider = screen.getByRole("slider");
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ timelineDetail: TIMELINE_PRESETS[4].value }));
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY })));
    expect(screen.getByRole("slider")).toBe(slider);
    expect(slider).toHaveAttribute("aria-valuetext", "Text only");
    expect(screen.getByRole("button", { name: "Show Thinking" })).toBeVisible();
    expect(setItem).not.toHaveBeenCalled();
    expect(persistWebUiPreferences).not.toHaveBeenCalled();
  });

  it("round-trips a custom category policy through the existing Desktop bridge and a fresh renderer", async () => {
    const user = userEvent.setup();
    const root = mkdtempSync(join(tmpdir(), "easyresearch-timeline-prefs-"));
    const legacy = {
      chatFontSize: 18,
      filesFontSize: 15,
      language: "en",
      studioTheme: "dark",
      autoExpandThinking: true,
      autoExpandTools: false,
      expandSubagentOutput: true,
    };
    try {
      writeDesktopPreferenceBlob(root, JSON.stringify(legacy));
      localStorage.setItem(STORAGE_KEY, readDesktopPreferenceBlob(root)!);
      window.easyresearchDesktop = {
        platform: "linux",
        version: "1.2.3",
        persistWebUiPreferences: (raw) => writeDesktopPreferenceBlob(root, raw),
      };
      const first = renderSettings();
      await user.click(screen.getByRole("button", { name: "Hide Notices" }));
      const accepted = readDesktopPreferenceBlob(root)!;
      expect(JSON.parse(accepted)).toMatchObject({
        ...legacy,
        timelineDetail: { notices: { placement: "hidden", details: "collapsed" } },
      });
      const expected = storedDetail();
      first.unmount();
      localStorage.clear();
      localStorage.setItem(STORAGE_KEY, accepted);
      renderSettings();
      expect(storedDetail()).toEqual(expected);
      expect(screen.getByRole("button", { name: "Show Notices" })).toBeVisible();
      expect(screen.getByRole("switch", { name: "Collapse Subagents by default" })).toHaveAttribute(
        "aria-checked",
        "false",
      );
      expect(document.documentElement.dataset.uiTheme).toBe("dark");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("localizes the control, categories and accessible actions in Chinese", async () => {
    const user = userEvent.setup();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ language: "zh-CN" }));
    renderSettings();
    expect(screen.getByRole("slider", { name: "对话详细程度" })).toHaveAttribute("aria-valuetext", "紧凑");
    await user.click(screen.getByRole("button", { name: "高级设置" }));
    await user.click(screen.getByRole("button", { name: "隐藏命令执行" }));
    expect(screen.getByRole("button", { name: "显示命令执行" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("switch", { name: "默认折叠子智能体" })).toHaveAttribute("aria-checked", "true");
  });
});
