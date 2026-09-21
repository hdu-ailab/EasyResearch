import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readDesktopPreferenceBlob, writeDesktopPreferenceBlob } from "../../../desktop/preferences-store";
import { STORAGE_KEY } from "../preferences";
import { CLASSIC_FAVICON } from "../ui-version";
import { CHAT_FONT_VAR, FILES_FONT_VAR } from "../webui-fonts";
import { PreferencesProvider, usePreferences } from "./PreferencesProvider";

function Probe() {
  const { preferences, updatePreferences } = usePreferences();
  return (
    <>
      <span data-testid="tools-expanded">{String(preferences.autoExpandTools)}</span>
      <span data-testid="thinking-expanded">{String(preferences.autoExpandThinking)}</span>
      <span data-testid="ui-version">{preferences.uiVersion}</span>
      <button type="button" onClick={() => updatePreferences({ autoExpandTools: true })}>
        enable tools
      </button>
      <button type="button" onClick={() => updatePreferences({ uiVersion: "classic" })}>
        use classic
      </button>
      <button type="button" onClick={() => updatePreferences({ uiVersion: "current" })}>
        use current
      </button>
      <button
        type="button"
        onClick={() => {
          updatePreferences({ autoExpandTools: true });
          updatePreferences({ autoExpandThinking: true });
        }}
      >
        enable both
      </button>
    </>
  );
}

describe("PreferencesProvider", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.lang = "";
    document.documentElement.style.removeProperty(CHAT_FONT_VAR);
    document.documentElement.style.removeProperty(FILES_FONT_VAR);
    delete window.easyresearchDesktop;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("applies the selected interface version to the document icon", async () => {
    const user = userEvent.setup();
    const link = document.createElement("link");
    link.rel = "icon";
    document.head.append(link);
    try {
      render(
        <PreferencesProvider>
          <Probe />
        </PreferencesProvider>,
      );

      await user.click(screen.getByRole("button", { name: "use classic" }));
      expect(screen.getByTestId("ui-version").textContent).toBe("classic");
      expect(link.getAttribute("href")).toBe(CLASSIC_FAVICON);

      await user.click(screen.getByRole("button", { name: "use current" }));
      expect(screen.getByTestId("ui-version").textContent).toBe("current");
      expect(new URL(link.href).pathname).toBe("/favicon.svg");
    } finally {
      link.remove();
    }
  });

  it("updates consumers and persists a complete preference blob in the same tab", async () => {
    const user = userEvent.setup();
    render(
      <PreferencesProvider>
        <Probe />
      </PreferencesProvider>,
    );

    await user.click(screen.getByRole("button", { name: "enable tools" }));

    expect(screen.getByTestId("tools-expanded").textContent).toBe("true");
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}")).toEqual({
      chatFontSize: 13,
      filesFontSize: 12,
      language: "en",
      uiVersion: "current",
      autoExpandThinking: false,
      autoExpandTools: true,
      expandSubagentOutput: false,
    });
  });

  it("mirrors a same-tab preference write through the optional desktop bridge", async () => {
    const user = userEvent.setup();
    const persistWebUiPreferences = vi.fn();
    window.easyresearchDesktop = {
      platform: "darwin",
      version: "1.2.3",
      persistWebUiPreferences,
    };
    render(
      <PreferencesProvider>
        <Probe />
      </PreferencesProvider>,
    );

    await user.click(screen.getByRole("button", { name: "enable tools" }));

    expect(persistWebUiPreferences).toHaveBeenCalledOnce();
    expect(JSON.parse(persistWebUiPreferences.mock.calls[0]![0] as string)).toMatchObject({
      autoExpandTools: true,
      autoExpandThinking: false,
    });
  });

  it.each(["current", "classic"] as const)(
    "restores the renderer's complete %s blob through host persistence",
    async (uiVersion) => {
      const root = mkdtempSync(join(tmpdir(), "easyresearch-renderer-prefs-"));
      const user = userEvent.setup();
      // The preload supplies a previously accepted six-field blob before React starts.
      const oldBlob = JSON.stringify({
        chatFontSize: 18,
        filesFontSize: 15,
        language: "zh-CN",
        autoExpandThinking: true,
        autoExpandTools: false,
        expandSubagentOutput: true,
      });
      try {
        writeDesktopPreferenceBlob(root, oldBlob);
        window.localStorage.setItem(STORAGE_KEY, readDesktopPreferenceBlob(root)!);
        window.easyresearchDesktop = {
          platform: "darwin",
          version: "1.2.3",
          persistWebUiPreferences: (raw) => writeDesktopPreferenceBlob(root, raw),
        };
        const first = render(
          <PreferencesProvider>
            <Probe />
          </PreferencesProvider>,
        );
        await user.click(screen.getByRole("button", { name: `use ${uiVersion}` }));
        await user.click(screen.getByRole("button", { name: "enable tools" }));
        const saved = readDesktopPreferenceBlob(root)!;
        expect(JSON.parse(saved)).toEqual({ ...JSON.parse(oldBlob), uiVersion, autoExpandTools: true });
        first.unmount();

        // A fresh ephemeral origin starts with empty localStorage and the host mirror.
        window.localStorage.clear();
        window.localStorage.setItem(STORAGE_KEY, saved);
        render(
          <PreferencesProvider>
            <Probe />
          </PreferencesProvider>,
        );
        expect(screen.getByTestId("ui-version")).toHaveTextContent(uiVersion);
        expect(screen.getByTestId("tools-expanded")).toHaveTextContent("true");
        expect(screen.getByTestId("thinking-expanded")).toHaveTextContent("true");
        expect(document.documentElement.lang).toBe("zh-CN");
        expect(document.documentElement.style.getPropertyValue(CHAT_FONT_VAR)).toBe("18px");
        expect(document.documentElement.style.getPropertyValue(FILES_FONT_VAR)).toBe("15px");
      } finally {
        delete window.easyresearchDesktop;
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("follows cross-tab preference changes and reapplies document preferences", () => {
    render(
      <PreferencesProvider>
        <Probe />
      </PreferencesProvider>,
    );
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        chatFontSize: 16,
        filesFontSize: 11,
        language: "zh-CN",
        autoExpandThinking: true,
        autoExpandTools: true,
        expandSubagentOutput: true,
      }),
    );

    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
    });

    expect(screen.getByTestId("tools-expanded").textContent).toBe("true");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(document.documentElement.style.getPropertyValue(CHAT_FONT_VAR)).toBe("16px");
    expect(document.documentElement.style.getPropertyValue(FILES_FONT_VAR)).toBe("11px");
  });

  it("coalesces multiple same-tick patches into one complete persisted value", async () => {
    const user = userEvent.setup();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    render(
      <PreferencesProvider>
        <Probe />
      </PreferencesProvider>,
    );
    setItem.mockClear();

    await user.click(screen.getByRole("button", { name: "enable both" }));

    expect(screen.getByTestId("tools-expanded").textContent).toBe("true");
    expect(screen.getByTestId("thinking-expanded").textContent).toBe("true");
    expect(setItem).toHaveBeenCalledOnce();
    expect(JSON.parse(setItem.mock.calls[0]![1] as string)).toMatchObject({
      autoExpandThinking: true,
      autoExpandTools: true,
      expandSubagentOutput: false,
    });
  });

  it("does not persist a value received through the storage event", () => {
    render(
      <PreferencesProvider>
        <Probe />
      </PreferencesProvider>,
    );
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        chatFontSize: 13,
        filesFontSize: 12,
        language: "en",
        autoExpandThinking: false,
        autoExpandTools: true,
        expandSubagentOutput: false,
      }),
    );
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
    });

    expect(screen.getByTestId("tools-expanded").textContent).toBe("true");
    expect(setItem).not.toHaveBeenCalled();
  });

  it("keeps same-tab state when persistence throws", async () => {
    const user = userEvent.setup();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    render(
      <PreferencesProvider>
        <Probe />
      </PreferencesProvider>,
    );

    await user.click(screen.getByRole("button", { name: "enable tools" }));

    expect(screen.getByTestId("tools-expanded").textContent).toBe("true");
  });
});
