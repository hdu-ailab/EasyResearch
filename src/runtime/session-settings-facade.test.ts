import { describe, expect, it, vi } from "vitest";
import { createSessionSettingsFacade } from "./session-settings-facade";

describe("createSessionSettingsFacade", () => {
  it("delegates unrelated reads, reloads, and writes with the original receiver", async () => {
    const globalSettings = { theme: "dark" };
    const receivers: unknown[] = [];
    const settings = {
      value: "before",
      getGlobalSettings() {
        receivers.push(this);
        return globalSettings;
      },
      async reload() {
        receivers.push(this);
        return "reloaded";
      },
      setTheme(value: string) {
        receivers.push(this);
        this.value = value;
      },
      setDefaultProvider: vi.fn(),
      setDefaultModel: vi.fn(),
      setDefaultModelAndProvider: vi.fn(),
      setDefaultThinkingLevel: vi.fn(),
    };

    const facade = createSessionSettingsFacade(settings);

    expect(facade.getGlobalSettings()).toBe(globalSettings);
    await expect(facade.reload()).resolves.toBe("reloaded");
    facade.setTheme("light");
    expect(settings.value).toBe("light");
    expect(receivers).toEqual([settings, settings, settings]);
  });

  it("suppresses every Pi default provider, model, and thinking persistence setter", () => {
    const settings = {
      setDefaultProvider: vi.fn(),
      setDefaultModel: vi.fn(),
      setDefaultModelAndProvider: vi.fn(),
      setDefaultThinkingLevel: vi.fn(),
    };
    const facade = createSessionSettingsFacade(settings);

    facade.setDefaultProvider("anthropic");
    facade.setDefaultModel("claude-sonnet");
    facade.setDefaultModelAndProvider("openai", "gpt-test");
    facade.setDefaultThinkingLevel("high");

    expect(settings.setDefaultProvider).not.toHaveBeenCalled();
    expect(settings.setDefaultModel).not.toHaveBeenCalled();
    expect(settings.setDefaultModelAndProvider).not.toHaveBeenCalled();
    expect(settings.setDefaultThinkingLevel).not.toHaveBeenCalled();
  });
});
