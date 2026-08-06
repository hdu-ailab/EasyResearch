import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ConfigFileService } from "./config-files";
import {
  CHAT_FONT_MAX,
  CHAT_FONT_MIN,
  DEFAULT_CHAT_FONT_SIZE,
  DEFAULT_FILES_FONT_SIZE,
  FILES_FONT_MAX,
  FILES_FONT_MIN,
  WebuiSettingsError,
  pickEffectiveOrchestratorModel,
  readEffectiveWebuiSettings,
  readWebuiSettings,
  updateWebuiSettings,
} from "./webui-settings";

let agentDir: string;
let config: ConfigFileService;

const writeSettings = (content: unknown) => {
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify(content));
};

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "lr-webui-"));
  config = new ConfigFileService(agentDir);
});

describe("readWebuiSettings", () => {
  it("returns defaults when settings.json is absent", async () => {
    const settings = await readWebuiSettings(config);
    expect(settings.chatFontSize).toBe(DEFAULT_CHAT_FONT_SIZE);
    expect(settings.filesFontSize).toBe(DEFAULT_FILES_FONT_SIZE);
    expect(settings.agentModels).toEqual({});
    expect(settings.orchestratorModel).toBeNull();
  });

  it("reads stored values and the agentModels map", async () => {
    writeSettings({
      lazyresearch: { webui: { chatFontSize: 15, filesFontSize: 11 }, agentModels: { search: "openai/gpt-4o" } },
    });
    const settings = await readWebuiSettings(config);
    expect(settings.chatFontSize).toBe(15);
    expect(settings.filesFontSize).toBe(11);
    expect(settings.agentModels).toEqual({ search: "openai/gpt-4o" });
  });

  it("reads the top-level orchestrator default model pair", async () => {
    writeSettings({ defaultProvider: "openai", defaultModel: "gpt-4o" });
    const settings = await readWebuiSettings(config);
    expect(settings.orchestratorModel).toBe("openai/gpt-4o");
  });

  it("reads null orchestratorModel when either default key is absent or empty", async () => {
    writeSettings({ defaultProvider: "openai" });
    expect((await readWebuiSettings(config)).orchestratorModel).toBeNull();
    writeSettings({ defaultProvider: "", defaultModel: "gpt-4o" });
    expect((await readWebuiSettings(config)).orchestratorModel).toBeNull();
    writeSettings({ defaultModel: "gpt-4o" });
    expect((await readWebuiSettings(config)).orchestratorModel).toBeNull();
  });

  it("falls back to defaults for missing or malformed webui values", async () => {
    writeSettings({ lazyresearch: { webui: { chatFontSize: "big", filesFontSize: 3 }, agentModels: { search: 42 } } });
    const settings = await readWebuiSettings(config);
    expect(settings.chatFontSize).toBe(DEFAULT_CHAT_FONT_SIZE);
    expect(settings.filesFontSize).toBe(DEFAULT_FILES_FONT_SIZE);
    expect(settings.agentModels).toEqual({});
  });

  it("errors on an invalid JSON settings file", async () => {
    writeFileSync(join(agentDir, "settings.json"), "{ not json");
    await expect(readWebuiSettings(config)).rejects.toSatisfy((e) => e instanceof WebuiSettingsError && e.status === 400);
  });
});

describe("pickEffectiveOrchestratorModel", () => {
  const available = [
    { provider: "oc", id: "deepseek-v4-flash-free" },
    { provider: "anthropic", id: "claude-opus-4-8" },
    { provider: "openai", id: "gpt-5.5" },
  ];

  it("returns the configured model when present", () => {
    expect(pickEffectiveOrchestratorModel("anthropic/claude-sonnet-4", available)).toBe("anthropic/claude-sonnet-4");
  });

  it("prefers Pi's per-provider default over the first available model", () => {
    expect(pickEffectiveOrchestratorModel(null, available)).toBe("anthropic/claude-opus-4-8");
  });

  it("falls back to the first available model when no per-provider default matches", () => {
    const only = [{ provider: "oc", id: "deepseek-v4-flash-free" }];
    expect(pickEffectiveOrchestratorModel(null, only)).toBe("oc/deepseek-v4-flash-free");
  });

  it("returns null when nothing is available", () => {
    expect(pickEffectiveOrchestratorModel(null, [])).toBeNull();
  });
});

describe("readEffectiveWebuiSettings", () => {
  it("uses the configured orchestrator model as the effective model", async () => {
    writeSettings({ defaultProvider: "openai", defaultModel: "gpt-4o" });
    const settings = await readEffectiveWebuiSettings(config, [{ provider: "oc", id: "deepseek-v4-flash-free" }]);
    expect(settings.orchestratorModel).toBe("openai/gpt-4o");
    expect(settings.effectiveOrchestratorModel).toBe("openai/gpt-4o");
  });

  it("resolves the fallback model from the injected available list when unconfigured", async () => {
    const settings = await readEffectiveWebuiSettings(config, [
      { provider: "oc", id: "deepseek-v4-flash-free" },
      { provider: "anthropic", id: "claude-opus-4-8" },
    ]);
    expect(settings.orchestratorModel).toBeNull();
    expect(settings.effectiveOrchestratorModel).toBe("anthropic/claude-opus-4-8");
  });

  it("resolves null when unconfigured and nothing is available", async () => {
    const settings = await readEffectiveWebuiSettings(config, []);
    expect(settings.effectiveOrchestratorModel).toBeNull();
  });
});

describe("updateWebuiSettings", () => {
  it("writes a partial patch and preserves unrelated settings fields", async () => {
    writeSettings({ theme: "light", lazyresearch: { agentModels: { search: "openai/gpt-4o" } } });
    await updateWebuiSettings(config, { chatFontSize: 14 });
    const raw = JSON.parse(await config.read({ scope: "global", path: "settings.json" })) as Record<string, unknown>;
    expect(raw.theme).toBe("light");
    const webui = (raw.lazyresearch as { webui: unknown }).webui as { chatFontSize: number };
    expect(webui.chatFontSize).toBe(14);
    expect((raw.lazyresearch as { agentModels: Record<string, string> }).agentModels.search).toBe("openai/gpt-4o");
  });

  it("updates agentModels and returns the new full state", async () => {
    writeSettings({ lazyresearch: { agentModels: { search: "openai/gpt-4o" } } });
    const updated = await updateWebuiSettings(config, { agentModels: { writing: "anthropic/claude-sonnet-4" } });
    expect(updated.agentModels).toEqual({ writing: "anthropic/claude-sonnet-4" });
    expect(updated.chatFontSize).toBe(DEFAULT_CHAT_FONT_SIZE);
  });

  it("creates the file from defaults when it is absent", async () => {
    const updated = await updateWebuiSettings(config, { filesFontSize: 14 });
    expect(updated.filesFontSize).toBe(14);
    expect(updated.chatFontSize).toBe(DEFAULT_CHAT_FONT_SIZE);
  });

  it("writes the orchestrator default model pair from a provider/id string", async () => {
    const updated = await updateWebuiSettings(config, { orchestratorModel: "openai/gpt-4o" });
    expect(updated.orchestratorModel).toBe("openai/gpt-4o");
    const raw = JSON.parse(await config.read({ scope: "global", path: "settings.json" })) as Record<string, unknown>;
    expect(raw.defaultProvider).toBe("openai");
    expect(raw.defaultModel).toBe("gpt-4o");
  });

  it("removes the orchestrator default pair when null is sent", async () => {
    writeSettings({ theme: "dark", defaultProvider: "openai", defaultModel: "gpt-4o" });
    const updated = await updateWebuiSettings(config, { orchestratorModel: null });
    expect(updated.orchestratorModel).toBeNull();
    const raw = JSON.parse(await config.read({ scope: "global", path: "settings.json" })) as Record<string, unknown>;
    expect(raw.defaultProvider).toBeUndefined();
    expect(raw.defaultModel).toBeUndefined();
    expect(raw.theme).toBe("dark");
  });

  it("does not touch agentModels when setting the orchestrator model", async () => {
    writeSettings({ lazyresearch: { agentModels: { search: "openai/gpt-4o" } } });
    const updated = await updateWebuiSettings(config, { orchestratorModel: "anthropic/claude-sonnet-4" });
    expect(updated.agentModels).toEqual({ search: "openai/gpt-4o" });
  });

  it.each([
    ["orchestrator without slash", { orchestratorModel: "openai" }],
    ["orchestrator empty provider", { orchestratorModel: "/gpt-4o" }],
    ["orchestrator empty id", { orchestratorModel: "openai/" }],
    ["orchestrator non-string", { orchestratorModel: 42 }],
  ])("rejects %s", async (_label, patch) => {
    await expect(updateWebuiSettings(config, patch as never)).rejects.toSatisfy(
      (e) => e instanceof WebuiSettingsError && e.status === 400,
    );
  });

  it.each([
    ["chat below min", { chatFontSize: CHAT_FONT_MIN - 1 }],
    ["chat above max", { chatFontSize: CHAT_FONT_MAX + 1 }],
    ["files below min", { filesFontSize: FILES_FONT_MIN - 1 }],
    ["files above max", { filesFontSize: FILES_FONT_MAX + 1 }],
    ["non-integer chat", { chatFontSize: 13.5 }],
    ["non-object agentModels", { agentModels: ["search"] }],
    ["non-string agentModels value", { agentModels: { search: 42 } }],
  ])("rejects %s", async (_label, patch) => {
    await expect(updateWebuiSettings(config, patch as never)).rejects.toSatisfy(
      (e) => e instanceof WebuiSettingsError && e.status === 400,
    );
  });

  it("rejects unknown top-level keys", async () => {
    await expect(updateWebuiSettings(config, { bogus: 1 } as never)).rejects.toSatisfy(
      (e) => e instanceof WebuiSettingsError && e.status === 400,
    );
  });
});
