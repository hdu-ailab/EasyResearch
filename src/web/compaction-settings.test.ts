import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigFileService } from "./config-files";
import { patchGlobalCompactionTrigger } from "./compaction-settings";

describe("patchGlobalCompactionTrigger", () => {
  let agentDir: string;
  let config: ConfigFileService;

  beforeEach(() => {
    agentDir = mkdtempSync(join("/dev/shm", "easyresearch-compaction-settings-"));
    config = new ConfigFileService(agentDir);
  });

  afterEach(() => rmSync(agentDir, { recursive: true, force: true }));

  it("preserves native and unknown settings while setting the global trigger", async () => {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
      theme: "dark",
      compaction: { enabled: false, keepRecentTokens: 7_000 },
      easyresearch: { secretFutureField: { keep: true } },
    }));

    await patchGlobalCompactionTrigger(config, { triggerPercent: 80 });

    expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))).toEqual({
      theme: "dark",
      compaction: { enabled: false, keepRecentTokens: 7_000 },
      easyresearch: {
        secretFutureField: { keep: true },
        compaction: { triggerPercent: 80 },
      },
    });
  });

  it.each([
    {},
    { triggerPercent: 9 },
    { triggerPercent: 91 },
    { triggerPercent: 70.5 },
    { triggerPercent: "70" },
    { triggerPercent: 70, extra: true },
  ])("rejects invalid patch %# without writing", async (patch) => {
    const settingsPath = join(agentDir, "settings.json");
    writeFileSync(settingsPath, '{"theme":"dark"}', "utf8");

    await expect(patchGlobalCompactionTrigger(config, patch)).rejects.toMatchObject({ status: 400 });
    expect(readFileSync(settingsPath, "utf8")).toBe('{"theme":"dark"}');
  });

  it.each([
    "{malformed",
    "[]",
    '{"easyresearch":"invalid"}',
    '{"easyresearch":{"compaction":[]}}',
  ])("rejects malformed or non-object current settings without replacing bytes: %s", async (content) => {
    const settingsPath = join(agentDir, "settings.json");
    writeFileSync(settingsPath, content, "utf8");

    await expect(patchGlobalCompactionTrigger(config, { triggerPercent: 75 }))
      .rejects.toMatchObject({ status: 409 });
    expect(readFileSync(settingsPath, "utf8")).toBe(content);
  });

  it("repairs only an invalid old percentage inside an otherwise valid object tree", async () => {
    const settingsPath = join(agentDir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({
      easyresearch: { compaction: { triggerPercent: "bad", future: 1 } },
    }));

    await patchGlobalCompactionTrigger(config, { triggerPercent: 65 });

    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
      easyresearch: { compaction: { triggerPercent: 65, future: 1 } },
    });
  });
});
