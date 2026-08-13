import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigFileService } from "./config-files";
import { pickEffectivePaperAssistantModel, readEffectiveWebuiSettings, readWebuiSettings, updateWebuiSettings } from "./webui-settings";

let agentDir: string;
let config: ConfigFileService;

function writeAgent(name: string, model?: string, thinking?: string): void {
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  writeFileSync(
    join(agentDir, "agents", `${name}.md`),
    `---\nname: ${name}\ndescription: ${name}\n${model ? `model: ${model}\n` : ""}${thinking ? `thinking: ${thinking}\n` : ""}---\nPrompt\n`,
  );
}

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "easyresearch-webui-"));
  config = new ConfigFileService(agentDir);
});

afterEach(() => rmSync(agentDir, { recursive: true, force: true }));

describe("Markdown-backed web settings", () => {
  it("returns defaults when no global Markdown overrides exist", async () => {
    const settings = await readWebuiSettings(config);
    expect(settings.agentModels).toEqual({});
    expect(settings.paperAssistantModel).toBeNull();
    expect(settings.agentThinking).toEqual({});
    expect(settings.paperAssistantThinking).toBeNull();
  });

  it("reads global agent models from Markdown frontmatter", async () => {
    writeAgent("search", "openai/gpt-4o");
    writeAgent("paper-assistant", "anthropic/claude");
    const settings = await readWebuiSettings(config);
    expect(settings.agentModels).toMatchObject({ search: "openai/gpt-4o", "paper-assistant": "anthropic/claude" });
    expect(settings.paperAssistantModel).toBe("anthropic/claude");
  });

  it("reads global agent thinking defaults from Markdown frontmatter", async () => {
    writeAgent("search", undefined, "high");
    writeAgent("paper-assistant", undefined, "medium");
    const settings = await readWebuiSettings(config);
    expect(settings.agentThinking).toMatchObject({ search: "high", "paper-assistant": "medium" });
    expect(settings.paperAssistantThinking).toBe("medium");
  });

  it("writes model changes to Markdown instead of settings JSON", async () => {
    writeAgent("search");
    await updateWebuiSettings(config, { agentModels: { search: "openai/gpt-4o" } });
    const content = await config.read({ scope: "global", path: "agents/search.md" });
    expect(content).toContain("model: openai/gpt-4o");
    expect(() => JSON.parse(content)).toThrow();
  });

  it("writes thinking defaults to Markdown frontmatter", async () => {
    writeAgent("search");
    await updateWebuiSettings(config, { agentThinking: { search: "high" } });
    const content = await config.read({ scope: "global", path: "agents/search.md" });
    expect(content).toContain("thinking: high");

    await updateWebuiSettings(config, { agentThinking: { search: "off" } });
    const offContent = await config.read({ scope: "global", path: "agents/search.md" });
    expect(offContent).toContain("thinking: off");
  });

  it("copies the bundled Paper Assistant before editing its model", async () => {
    await updateWebuiSettings(config, { paperAssistantModel: "openai/gpt-4o" });
    const content = await config.read({ scope: "global", path: "agents/paper-assistant.md" });
    expect(content).toContain("model: openai/gpt-4o");
  });

  it("copies the bundled Paper Assistant before editing its thinking default", async () => {
    await updateWebuiSettings(config, { paperAssistantThinking: "medium" });
    const content = await config.read({ scope: "global", path: "agents/paper-assistant.md" });
    expect(content).toContain("thinking: medium");
  });

  it("rejects unknown thinking levels in thinking updates", async () => {
    writeAgent("search");
    await expect(updateWebuiSettings(config, { agentThinking: { search: "ultra" } })).rejects.toThrow();
    await expect(updateWebuiSettings(config, { paperAssistantThinking: "ultra" })).rejects.toThrow();
  });

  it("uses the configured Paper Assistant model as effective", async () => {
    writeAgent("paper-assistant", "openai/gpt-4o");
    const settings = await readEffectiveWebuiSettings(config, [{ provider: "openai", id: "gpt-4o" }]);
    expect(settings.paperAssistantModel).toBe("openai/gpt-4o");
    expect(settings.effectivePaperAssistantModel).toBe("openai/gpt-4o");
  });
});

describe("pickEffectivePaperAssistantModel", () => {
  it("returns configured, provider-default, first, or null", () => {
    const models = [{ provider: "openai", id: "gpt-5.5" }, { provider: "custom", id: "model" }];
    expect(pickEffectivePaperAssistantModel("custom/model", models)).toBe("custom/model");
    expect(pickEffectivePaperAssistantModel(null, models)).toBe("openai/gpt-5.5");
    expect(pickEffectivePaperAssistantModel(null, [{ provider: "custom", id: "model" }])).toBe("custom/model");
    expect(pickEffectivePaperAssistantModel(null, [])).toBeNull();
  });
});
