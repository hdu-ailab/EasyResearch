import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STORAGE_KEY } from "../preferences";
import { CHAT_FONT_VAR, FILES_FONT_VAR } from "../webui-fonts";
import { PreferencesProvider, usePreferences } from "./PreferencesProvider";

function Probe() {
  const { preferences, updatePreferences } = usePreferences();
  return (
    <>
      <span data-testid="tools-expanded">{String(preferences.autoExpandTools)}</span>
      <span data-testid="thinking-expanded">{String(preferences.autoExpandThinking)}</span>
      <button type="button" onClick={() => updatePreferences({ autoExpandTools: true })}>
        enable tools
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
      autoExpandThinking: false,
      autoExpandTools: true,
      expandSubagentOutput: false,
    });
  });

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
