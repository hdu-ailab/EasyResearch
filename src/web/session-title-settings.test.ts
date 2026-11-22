import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ConfigFileService } from "./config-files";
import { parseGlobalSessionTitleSettings, patchGlobalSessionTitleSettings } from "./session-title-settings";

let dir: string;
let config: ConfigFileService;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "easyresearch-title-settings-")); config = new ConfigFileService(dir); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it("defaults to enabled and preserves explicit false without seeding settings", async () => {
  expect(parseGlobalSessionTitleSettings({})).toEqual({ autoSessionTitle: true });
  writeFileSync(join(dir, "settings.json"), '\ufeff{"easyresearch":{"web":{"showApiUsageDetails":false}},"unknown":42}');
  await patchGlobalSessionTitleSettings(config, { autoSessionTitle: false });
  const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8").replace(/^\ufeff/, ""));
  expect(settings).toEqual({ easyresearch: { web: { showApiUsageDetails: false, autoSessionTitle: false } }, unknown: 42 });
  expect(parseGlobalSessionTitleSettings(settings)).toEqual({ autoSessionTitle: false });
});

it.each([{}, { autoSessionTitle: 1 }, { autoSessionTitle: false, other: 1 }])("rejects invalid patches without a write (%j)", async (value) => {
  const before = '{"unknown":42}';
  writeFileSync(join(dir, "settings.json"), before);
  await expect(patchGlobalSessionTitleSettings(config, value)).rejects.toMatchObject({ status: 400 });
  expect(readFileSync(join(dir, "settings.json"), "utf8")).toBe(before);
});

it.each(['{broken', '[]', '{"easyresearch":false}', '{"easyresearch":{"web":[]}}'])("preserves malformed bytes (%s)", async (before) => {
  writeFileSync(join(dir, "settings.json"), before);
  await expect(patchGlobalSessionTitleSettings(config, { autoSessionTitle: true })).rejects.toMatchObject({ status: 409 });
  expect(readFileSync(join(dir, "settings.json"), "utf8")).toBe(before);
});

it("repairs an invalid boolean while preserving sibling settings", async () => {
  writeFileSync(join(dir, "settings.json"), '{"easyresearch":{"web":{"autoSessionTitle":"invalid","sessionIdleTimeoutMs":123}}}');
  expect(() => parseGlobalSessionTitleSettings(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")))).toThrow(/boolean/);
  await patchGlobalSessionTitleSettings(config, { autoSessionTitle: false });
  expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).easyresearch.web).toEqual({ autoSessionTitle: false, sessionIdleTimeoutMs: 123 });
});
