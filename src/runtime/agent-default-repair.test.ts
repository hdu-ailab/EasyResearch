import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigFileService } from "../web/config-files";
import {
  planDanglingAgentDefaultRepairs,
  repairDanglingAgentDefaults,
} from "./agent-default-repair";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function configWith(settings: unknown): { config: ConfigFileService; settingsPath: string } {
  const root = mkdtempSync(join(tmpdir(), "easyresearch-agent-default-repair-"));
  roots.push(root);
  const settingsPath = join(root, "settings.json");
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return { config: new ConfigFileService(root), settingsPath };
}

describe("repairDanglingAgentDefaults", () => {
  it("plans repairs only for discovered Agents whose explicit model is absent", () => {
    const dangling = "deepseek/deepseek-v4-flash";
    expect(planDanglingAgentDefaultRepairs({
      definitions: [
        {
          name: "research-assistant",
          description: "Research Assistant",
          enabled: true,
          builtin: true,
          systemPrompt: "prompt",
          source: "bundled",
          filePath: "/bundle/research-assistant.md",
        },
        {
          name: "search",
          description: "Search",
          enabled: true,
          builtin: true,
          systemPrompt: "prompt",
          source: "bundled",
          filePath: "/bundle/search.md",
        },
      ],
      diagnostics: [],
      defaults: {
        "research-assistant": { model: dangling },
        search: { model: dangling },
        dormant: { model: dangling },
      },
    }, [{ provider: "openai", id: "registered" }], { provider: "openai", id: "fallback" })).toEqual([
      {
        agentName: "research-assistant",
        danglingModel: dangling,
        replacementModel: "openai/fallback",
      },
      { agentName: "search", danglingModel: dangling },
    ]);
  });

  it("replaces Research Assistant, clears specialists, and preserves every unrelated field", async () => {
    const dangling = "deepseek/deepseek-v4-flash";
    const { config, settingsPath } = configWith({
      theme: "light",
      easyresearch: {
        keep: { nested: true },
        agentDefaults: {
          "research-assistant": { model: dangling, thinking: "max", future: { keep: true } },
          search: { model: dangling, thinking: "high" },
          writing: { model: "openai/registered", thinking: "medium" },
          dormant: { model: dangling, future: "untouched" },
        },
      },
      unknownRoot: [1, 2, 3],
    });

    const result = await repairDanglingAgentDefaults(config, [
      {
        agentName: "research-assistant",
        danglingModel: dangling,
        replacementModel: "openai/fallback",
      },
      { agentName: "search", danglingModel: dangling },
    ]);

    expect(result).toEqual({ status: "repaired", repairedAgents: ["research-assistant", "search"] });
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
      theme: "light",
      easyresearch: {
        keep: { nested: true },
        agentDefaults: {
          "research-assistant": {
            model: "openai/fallback",
            thinking: "max",
            future: { keep: true },
          },
          search: { thinking: "high" },
          writing: { model: "openai/registered", thinking: "medium" },
          dormant: { model: dangling, future: "untouched" },
        },
      },
      unknownRoot: [1, 2, 3],
    });
  });

  it("does not overwrite a concurrent model change that no longer equals the dangling reference", async () => {
    const { config, settingsPath } = configWith({
      easyresearch: {
        agentDefaults: {
          "research-assistant": { model: "openai/user-choice", thinking: "high" },
        },
      },
    });
    const before = readFileSync(settingsPath);

    const result = await repairDanglingAgentDefaults(config, [{
      agentName: "research-assistant",
      danglingModel: "deepseek/deepseek-v4-flash",
      replacementModel: "openai/fallback",
    }]);

    expect(result).toEqual({ status: "unchanged", repairedAgents: [] });
    expect(readFileSync(settingsPath)).toEqual(before);
  });

  it("rejects malformed settings without replacing the original bytes", async () => {
    const root = mkdtempSync(join(tmpdir(), "easyresearch-agent-default-repair-"));
    roots.push(root);
    const settingsPath = join(root, "settings.json");
    writeFileSync(settingsPath, "{ malformed settings\n");
    const before = readFileSync(settingsPath);

    await expect(repairDanglingAgentDefaults(new ConfigFileService(root), [{
      agentName: "research-assistant",
      danglingModel: "deepseek/deepseek-v4-flash",
      replacementModel: "openai/fallback",
    }])).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(readFileSync(settingsPath)).toEqual(before);
  });
});
