import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ConfigFileService } from "./config-files";
import {
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
    expect(settings.agentModels).toEqual({});
    expect(settings.orchestratorModel).toBeNull();
    expect(settings.effectiveOrchestratorModel).toBeNull();
  });

  it("reads stored values and the registry agent models", async () => {
    writeSettings({
      lazyresearch: {
        webui: { chatFontSize: 15, filesFontSize: 11 },
        agents: { search: { model: "openai/gpt-4o" } },
      },
    });
    const settings = await readWebuiSettings(config);
    expect(settings.agentModels).toEqual({ search: "openai/gpt-4o" });
  });

  it("keeps string agent models and drops malformed ones", async () => {
    writeSettings({
      lazyresearch: {
        webui: { chatFontSize: "big", filesFontSize: 3 },
        agents: { search: { model: 42 }, writing: { model: "anthropic/claude-sonnet-4" } },
      },
    });
    const settings = await readWebuiSettings(config);
    expect(settings.agentModels).toEqual({ writing: "anthropic/claude-sonnet-4" });
  });

  it("ignores legacy font-size fields in settings.json", async () => {
    writeSettings({ lazyresearch: { webui: { chatFontSize: 15, filesFontSize: 11 } } });
    const settings = await readWebuiSettings(config);
    expect(settings).toEqual({ agentModels: {}, orchestratorModel: null, effectiveOrchestratorModel: null });
  });

  it("reads the orchestrator model from the registry entry", async () => {
    writeSettings({ lazyresearch: { agents: { orchestrator: { model: "openai/gpt-4o" } } } });
    const settings = await readWebuiSettings(config);
    expect(settings.orchestratorModel).toBe("openai/gpt-4o");
  });

  it("derives orchestratorModel from the registry orchestrator", async () => {
    writeSettings({ lazyresearch: { agents: { orchestrator: { model: "openai/gpt-4o" } } } });
    const settings = await readEffectiveWebuiSettings(config, []);
    expect(settings.orchestratorModel).toBe("openai/gpt-4o");
  });

  it("no longer reads the legacy agentModels key", async () => {
    writeSettings({ lazyresearch: { agentModels: { search: "a/b" } } });
    const settings = await readEffectiveWebuiSettings(config, []);
    expect(settings.agentModels).toEqual({});
  });

  it("reads null orchestratorModel when the registry entry is absent or modelless", async () => {
    writeSettings({});
    expect((await readWebuiSettings(config)).orchestratorModel).toBeNull();
    writeSettings({ lazyresearch: { agents: { orchestrator: { model: "" } } } });
    expect((await readWebuiSettings(config)).orchestratorModel).toBeNull();
    writeSettings({ lazyresearch: { agents: { orchestrator: { definition: "agents/orchestrator.md" } } } });
    expect((await readWebuiSettings(config)).orchestratorModel).toBeNull();
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
      lazyresearch: { agents: { search: { model: "openai/gpt-4o", definition: "agents/search.md" } } },
    });
    await updateWebuiSettings(config, { agentModels: { writing: "anthropic/claude-sonnet-4" } });
    const raw = JSON.parse(await config.read({ scope: "global", path: "settings.json" })) as Record<string, unknown>;
    expect(raw.theme).toBe("light");
    const agents = raw.lazyresearch as { agents?: Record<string, { model?: string; definition?: string }> };
    expect(agents.agents?.writing?.model).toBe("anthropic/claude-sonnet-4");
    expect(agents.agents?.search?.model).toBeUndefined();
    expect(agents.agents?.search?.definition).toBe("agents/search.md");
  });

  it("updates the orchestrator model via orchestratorModel patch", async () => {
    await updateWebuiSettings(config, { orchestratorModel: "openai/gpt-4o" });
    const raw = JSON.parse(await config.read({ scope: "global", path: "settings.json" })) as Record<string, unknown>;
    const agents = (raw.lazyresearch as { agents?: Record<string, { model?: string }> }).agents;
    expect(agents?.orchestrator?.model).toBe("openai/gpt-4o");
  });

  it("updates agentModels and returns the new full state", async () => {
    writeSettings({ lazyresearch: { agents: { search: { model: "openai/gpt-4o" } } } });
    const updated = await updateWebuiSettings(config, { agentModels: { writing: "anthropic/claude-sonnet-4" } });
    expect(updated.agentModels).toEqual({ writing: "anthropic/claude-sonnet-4" });
  });

  it("writes the orchestrator registry model from a provider/id string", async () => {
    const updated = await updateWebuiSettings(config, { orchestratorModel: "openai/gpt-4o" });
    expect(updated.orchestratorModel).toBe("openai/gpt-4o");
    const raw = JSON.parse(await config.read({ scope: "global", path: "settings.json" })) as Record<string, unknown>;
    const agents = (raw.lazyresearch as { agents?: Record<string, { model?: string }> }).agents;
    expect(agents?.orchestrator?.model).toBe("openai/gpt-4o");
  });

  it("removes the orchestrator registry model when null is sent", async () => {
    writeSettings({
      theme: "dark",
      lazyresearch: { agents: { orchestrator: { model: "openai/gpt-4o", definition: "agents/orchestrator.md" } } },
    });
    const updated = await updateWebuiSettings(config, { orchestratorModel: null });
    expect(updated.orchestratorModel).toBeNull();
    const raw = JSON.parse(await config.read({ scope: "global", path: "settings.json" })) as Record<string, unknown>;
    const agents = raw.lazyresearch as { agents?: Record<string, { model?: string; definition?: string }> };
    expect(agents.agents?.orchestrator?.model).toBeUndefined();
    expect(agents.agents?.orchestrator?.definition).toBe("agents/orchestrator.md");
    expect(raw.theme).toBe("dark");
  });

  it("keeps stage agent models unchanged when setting the orchestrator model", async () => {
    writeSettings({ lazyresearch: { agents: { search: { model: "openai/gpt-4o" } } } });
    const updated = await updateWebuiSettings(config, { orchestratorModel: "anthropic/claude-sonnet-4" });
    expect(updated.agentModels).toEqual({ search: "openai/gpt-4o", orchestrator: "anthropic/claude-sonnet-4" });
  });

  it.each([
    ["non-object agentModels", { agentModels: ["search"] }],
    ["non-string agentModels value", { agentModels: { search: 42 } }],
  ])("rejects %s", async (_label, patch) => {
    await expect(updateWebuiSettings(config, patch as never)).rejects.toMatchObject({ status: 400 });
  });

  it.each([
    ["orchestrator without slash", { orchestratorModel: "openai" }],
    ["orchestrator empty provider", { orchestratorModel: "/gpt-4o" }],
    ["orchestrator empty id", { orchestratorModel: "openai/" }],
    ["orchestrator non-string", { orchestratorModel: 42 }],
  ])("rejects %s", async (_label, patch) => {
    await expect(updateWebuiSettings(config, patch as never)).rejects.toMatchObject({ status: 400 });
  });

  it("rejects unknown top-level keys", async () => {
    await expect(updateWebuiSettings(config, { chatFontSize: 13 } as never)).rejects.toMatchObject({ status: 400 });
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
    writeSettings({ lazyresearch: { agents: { orchestrator: { model: "openai/gpt-4o" } } } });
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