import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ConfigFileService } from "./config-files";
import {
  pickEffectiveAssistantModel,
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
    expect(settings.agentModels).toEqual({});
    expect(settings.assistantModel).toBeNull();
    expect(settings.effectiveAssistantModel).toBeNull();
  });

  it("reads stored values and the registry agent models", async () => {
    writeSettings({
      easyresearch: {
        webui: { chatFontSize: 15, filesFontSize: 11 },
        agents: { search: { model: "openai/gpt-4o" } },
      },
    });
    const settings = await readWebuiSettings(config);
    expect(settings.agentModels).toEqual({ search: "openai/gpt-4o" });
  });

  it("keeps string agent models and drops malformed ones", async () => {
    writeSettings({
      easyresearch: {
        webui: { chatFontSize: "big", filesFontSize: 3 },
        agents: { search: { model: 42 }, writing: { model: "anthropic/claude-sonnet-4" } },
      },
    });
    const settings = await readWebuiSettings(config);
    expect(settings.agentModels).toEqual({ writing: "anthropic/claude-sonnet-4" });
  });

  it("ignores legacy font-size fields in settings.json", async () => {
    writeSettings({ easyresearch: { webui: { chatFontSize: 15, filesFontSize: 11 } } });
    const settings = await readWebuiSettings(config);
    expect(settings).toEqual({ agentModels: {}, assistantModel: null, effectiveAssistantModel: null });
  });

  it("reads the assistant model from the registry entry", async () => {
    writeSettings({ easyresearch: { agents: { assistant: { model: "openai/gpt-4o" } } } });
    const settings = await readWebuiSettings(config);
    expect(settings.assistantModel).toBe("openai/gpt-4o");
  });

  it("derives assistantModel from the registry assistant", async () => {
    writeSettings({ easyresearch: { agents: { assistant: { model: "openai/gpt-4o" } } } });
    const settings = await readEffectiveWebuiSettings(config, []);
    expect(settings.assistantModel).toBe("openai/gpt-4o");
  });

  it("no longer reads the legacy agentModels key", async () => {
    writeSettings({ easyresearch: { agentModels: { search: "a/b" } } });
    const settings = await readEffectiveWebuiSettings(config, []);
    expect(settings.agentModels).toEqual({});
  });

  it("reads null assistantModel when the registry entry is absent or modelless", async () => {
    writeSettings({});
    expect((await readWebuiSettings(config)).assistantModel).toBeNull();
    writeSettings({ easyresearch: { agents: { assistant: { model: "" } } } });
    expect((await readWebuiSettings(config)).assistantModel).toBeNull();
    writeSettings({ easyresearch: { agents: { assistant: { definition: "agents/assistant.md" } } } });
    expect((await readWebuiSettings(config)).assistantModel).toBeNull();
  });

  it("errors on an invalid JSON settings file", async () => {
    writeFileSync(join(agentDir, "settings.json"), "{ not json");
    await expect(readWebuiSettings(config)).rejects.toMatchObject({ status: 400 });
  });
});

describe("updateWebuiSettings", () => {
  it("writes a partial patch and preserves unrelated settings fields and registry entry fields", async () => {
    writeSettings({
      theme: "light",
      easyresearch: { agents: { search: { model: "openai/gpt-4o", definition: "agents/search.md" } } },
    });
    await updateWebuiSettings(config, { agentModels: { writing: "anthropic/claude-sonnet-4" } });
    const raw = JSON.parse(await config.read({ scope: "global", path: "settings.json" })) as Record<string, unknown>;
    expect(raw.theme).toBe("light");
    const agents = raw.easyresearch as { agents?: Record<string, { model?: string; definition?: string }> };
    expect(agents.agents?.writing?.model).toBe("anthropic/claude-sonnet-4");
    expect(agents.agents?.search?.model).toBeUndefined();
    expect(agents.agents?.search?.definition).toBe("agents/search.md");
  });

  it("updates the assistant model via assistantModel patch", async () => {
    await updateWebuiSettings(config, { assistantModel: "openai/gpt-4o" });
    const raw = JSON.parse(await config.read({ scope: "global", path: "settings.json" })) as Record<string, unknown>;
    const agents = (raw.easyresearch as { agents?: Record<string, { model?: string }> }).agents;
    expect(agents?.assistant?.model).toBe("openai/gpt-4o");
  });

  it("updates agentModels and returns the new full state", async () => {
    writeSettings({ easyresearch: { agents: { search: { model: "openai/gpt-4o" } } } });
    const updated = await updateWebuiSettings(config, { agentModels: { writing: "anthropic/claude-sonnet-4" } });
    expect(updated.agentModels).toEqual({ writing: "anthropic/claude-sonnet-4" });
  });

  it("writes the assistant registry model from a provider/id string", async () => {
    const updated = await updateWebuiSettings(config, { assistantModel: "openai/gpt-4o" });
    expect(updated.assistantModel).toBe("openai/gpt-4o");
    const raw = JSON.parse(await config.read({ scope: "global", path: "settings.json" })) as Record<string, unknown>;
    const agents = (raw.easyresearch as { agents?: Record<string, { model?: string }> }).agents;
    expect(agents?.assistant?.model).toBe("openai/gpt-4o");
  });

  it("removes the assistant registry model when null is sent", async () => {
    writeSettings({
      theme: "dark",
      easyresearch: { agents: { assistant: { model: "openai/gpt-4o", definition: "agents/assistant.md" } } },
    });
    const updated = await updateWebuiSettings(config, { assistantModel: null });
    expect(updated.assistantModel).toBeNull();
    const raw = JSON.parse(await config.read({ scope: "global", path: "settings.json" })) as Record<string, unknown>;
    const agents = raw.easyresearch as { agents?: Record<string, { model?: string; definition?: string }> };
    expect(agents.agents?.assistant?.model).toBeUndefined();
    expect(agents.agents?.assistant?.definition).toBe("agents/assistant.md");
    expect(raw.theme).toBe("dark");
  });

  it("keeps stage agent models unchanged when setting the assistant model", async () => {
    writeSettings({ easyresearch: { agents: { search: { model: "openai/gpt-4o" } } } });
    const updated = await updateWebuiSettings(config, { assistantModel: "anthropic/claude-sonnet-4" });
    expect(updated.agentModels).toEqual({ search: "openai/gpt-4o", assistant: "anthropic/claude-sonnet-4" });
  });

  it.each([
    ["non-object agentModels", { agentModels: ["search"] }],
    ["non-string agentModels value", { agentModels: { search: 42 } }],
  ])("rejects %s", async (_label, patch) => {
    await expect(updateWebuiSettings(config, patch as never)).rejects.toMatchObject({ status: 400 });
  });

  it.each([
    ["assistant without slash", { assistantModel: "openai" }],
    ["assistant empty provider", { assistantModel: "/gpt-4o" }],
    ["assistant empty id", { assistantModel: "openai/" }],
    ["assistant non-string", { assistantModel: 42 }],
  ])("rejects %s", async (_label, patch) => {
    await expect(updateWebuiSettings(config, patch as never)).rejects.toMatchObject({ status: 400 });
  });

  it("rejects unknown top-level keys", async () => {
    await expect(updateWebuiSettings(config, { chatFontSize: 13 } as never)).rejects.toMatchObject({ status: 400 });
  });
});

describe("pickEffectiveAssistantModel", () => {
  const available = [
    { provider: "oc", id: "deepseek-v4-flash-free" },
    { provider: "anthropic", id: "claude-opus-4-8" },
    { provider: "openai", id: "gpt-5.5" },
  ];

  it("returns the configured model when present", () => {
    expect(pickEffectiveAssistantModel("anthropic/claude-sonnet-4", available)).toBe("anthropic/claude-sonnet-4");
  });

  it("prefers Pi's per-provider default over the first available model", () => {
    expect(pickEffectiveAssistantModel(null, available)).toBe("anthropic/claude-opus-4-8");
  });

  it("falls back to the first available model when no per-provider default matches", () => {
    const only = [{ provider: "oc", id: "deepseek-v4-flash-free" }];
    expect(pickEffectiveAssistantModel(null, only)).toBe("oc/deepseek-v4-flash-free");
  });

  it("returns null when nothing is available", () => {
    expect(pickEffectiveAssistantModel(null, [])).toBeNull();
  });

  it("mirrors every 0.84.1 upstream default provider in key order", () => {
    const upstream = [
      ["amazon-bedrock", "us.anthropic.claude-opus-4-6-v1"],
      ["baseten", "zai-org/GLM-5.2"],
      ["qwen-token-plan-individual", "qwen3.8-max"],
      ["xiaomi-token-plan-sgp", "mimo-v2.5-pro"],
    ] as const;
    // provider defaults are reachable through pickEffectiveAssistantModel
    // and win over the first available entry, so the target entry sits behind
    // a decoy ("oc" is not a Pi provider):
    for (const [provider, id] of upstream) {
      const available = [
        { provider: "oc", id: "deepseek-v4-flash-free" },
        { provider, id },
      ] as Array<{ provider: string; id: string }>;
      expect(pickEffectiveAssistantModel(null, available)).toBe(`${provider}/${id}`);
    }
  });
});

describe("readEffectiveWebuiSettings", () => {
  it("uses the configured assistant model as the effective model", async () => {
    writeSettings({ easyresearch: { agents: { assistant: { model: "openai/gpt-4o" } } } });
    const settings = await readEffectiveWebuiSettings(config, [{ provider: "oc", id: "deepseek-v4-flash-free" }]);
    expect(settings.assistantModel).toBe("openai/gpt-4o");
    expect(settings.effectiveAssistantModel).toBe("openai/gpt-4o");
  });

  it("resolves the fallback model from the injected available list when unconfigured", async () => {
    const settings = await readEffectiveWebuiSettings(config, [
      { provider: "oc", id: "deepseek-v4-flash-free" },
      { provider: "anthropic", id: "claude-opus-4-8" },
    ]);
    expect(settings.assistantModel).toBeNull();
    expect(settings.effectiveAssistantModel).toBe("anthropic/claude-opus-4-8");
  });

  it("resolves null when unconfigured and nothing is available", async () => {
    const settings = await readEffectiveWebuiSettings(config, []);
    expect(settings.effectiveAssistantModel).toBeNull();
  });
});