import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigFileService } from "./config-files";
import {
  parseGlobalApiUsageSettings,
  patchGlobalApiUsageSettings,
} from "./api-usage-settings";

describe("API usage settings", () => {
  let agentDir: string;
  let config: ConfigFileService;

  beforeEach(() => {
    agentDir = mkdtempSync(join("/dev/shm", "easyresearch-api-usage-settings-"));
    config = new ConfigFileService(agentDir);
  });

  afterEach(() => rmSync(agentDir, { recursive: true, force: true }));

  it("defaults missing global state to visible and preserves explicit false", () => {
    expect(parseGlobalApiUsageSettings({})).toEqual({ showApiUsageDetails: true });
    expect(parseGlobalApiUsageSettings({ easyresearch: { web: {} } })).toEqual({ showApiUsageDetails: true });
    expect(parseGlobalApiUsageSettings({
      easyresearch: { web: { showApiUsageDetails: false } },
    })).toEqual({ showApiUsageDetails: false });
  });

  it("preserves unrelated global settings while enabling details", async () => {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
      theme: "dark",
      easyresearch: {
        web: { sessionIdleTimeoutMs: 1234 },
        future: { keep: true },
      },
    }));

    await patchGlobalApiUsageSettings(config, { showApiUsageDetails: true });

    expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))).toEqual({
      theme: "dark",
      easyresearch: {
        web: { sessionIdleTimeoutMs: 1234, showApiUsageDetails: true },
        future: { keep: true },
      },
    });
  });

  it.each([
    {},
    { showApiUsageDetails: "true" },
    { showApiUsageDetails: true, extra: false },
  ])("rejects invalid patch %# without writing", async (patch) => {
    const settingsPath = join(agentDir, "settings.json");
    writeFileSync(settingsPath, '{"theme":"dark"}', "utf8");

    await expect(patchGlobalApiUsageSettings(config, patch)).rejects.toMatchObject({ status: 400 });
    expect(readFileSync(settingsPath, "utf8")).toBe('{"theme":"dark"}');
  });

  it.each([
    "{malformed",
    "[]",
    '{"easyresearch":"invalid"}',
    '{"easyresearch":{"web":[]}}',
  ])("rejects malformed or non-object current settings without replacing bytes: %s", async (content) => {
    const settingsPath = join(agentDir, "settings.json");
    writeFileSync(settingsPath, content, "utf8");

    await expect(patchGlobalApiUsageSettings(config, { showApiUsageDetails: true }))
      .rejects.toMatchObject({ status: 409 });
    expect(readFileSync(settingsPath, "utf8")).toBe(content);
  });

  it("rejects an invalid external boolean instead of accepting a new generation", () => {
    expect(() => parseGlobalApiUsageSettings({
      easyresearch: { web: { showApiUsageDetails: 1 } },
    })).toThrow(/boolean/i);
  });
});
