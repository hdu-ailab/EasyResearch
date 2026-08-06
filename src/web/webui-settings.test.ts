import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ConfigFileService } from "./config-files";
import {
  WebuiSettingsError,
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
  });

  it("reads stored values and the agentModels map", async () => {
    writeSettings({
      lazyresearch: { webui: { chatFontSize: 15, filesFontSize: 11 }, agentModels: { search: "openai/gpt-4o" } },
    });
    const settings = await readWebuiSettings(config);
    expect(settings.agentModels).toEqual({ search: "openai/gpt-4o" });
  });

  it("keeps string agentModels entries and drops malformed ones", async () => {
    writeSettings({
      lazyresearch: { webui: { chatFontSize: "big", filesFontSize: 3 }, agentModels: { search: 42, writing: "anthropic/claude-sonnet-4" } },
    });
    const settings = await readWebuiSettings(config);
    expect(settings.agentModels).toEqual({ writing: "anthropic/claude-sonnet-4" });
  });

  it("ignores legacy font-size fields in settings.json", async () => {
    writeSettings({ lazyresearch: { webui: { chatFontSize: 15, filesFontSize: 11 }, agentModels: {} } });
    const settings = await readWebuiSettings(config);
    expect(settings).toEqual({ agentModels: {} });
  });

  it("errors on an invalid JSON settings file", async () => {
    writeFileSync(join(agentDir, "settings.json"), "{ not json");
    await expect(readWebuiSettings(config)).rejects.toSatisfy((e) => e instanceof WebuiSettingsError && e.status === 400);
  });
});

describe("updateWebuiSettings", () => {
  it("writes a partial patch and preserves unrelated settings fields", async () => {
    writeSettings({ theme: "light", lazyresearch: { agentModels: { search: "openai/gpt-4o" } } });
    await updateWebuiSettings(config, { agentModels: { writing: "anthropic/claude-sonnet-4" } });
    const raw = JSON.parse(await config.read({ scope: "global", path: "settings.json" })) as Record<string, unknown>;
    expect(raw.theme).toBe("light");
    expect((raw.lazyresearch as { agentModels: Record<string, string> }).agentModels.writing).toBe("anthropic/claude-sonnet-4");
  });

  it("updates agentModels and returns the new full state", async () => {
    writeSettings({ lazyresearch: { agentModels: { search: "openai/gpt-4o" } } });
    const updated = await updateWebuiSettings(config, { agentModels: { writing: "anthropic/claude-sonnet-4" } });
    expect(updated.agentModels).toEqual({ writing: "anthropic/claude-sonnet-4" });
  });

  it.each([
    ["non-object agentModels", { agentModels: ["search"] }],
    ["non-string agentModels value", { agentModels: { search: 42 } }],
  ])("rejects %s", async (_label, patch) => {
    await expect(updateWebuiSettings(config, patch as never)).rejects.toSatisfy(
      (e) => e instanceof WebuiSettingsError && e.status === 400,
    );
  });

  it("rejects unknown top-level keys", async () => {
    await expect(updateWebuiSettings(config, { chatFontSize: 13 } as never)).rejects.toSatisfy(
      (e) => e instanceof WebuiSettingsError && e.status === 400,
    );
  });
});
