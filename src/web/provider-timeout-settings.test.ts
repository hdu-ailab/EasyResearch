import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ConfigFileService } from "./config-files";
import { patchGlobalProviderTimeout } from "./provider-timeout-settings";

let root: string;
let config: ConfigFileService;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "easyresearch-timeout-api-")); config = new ConfigFileService(root); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

it("sets and clears the native timeout without losing retry siblings or explicit zero", async () => {
  const path = join(root, "settings.json");
  writeFileSync(path, JSON.stringify({ theme: "custom", httpIdleTimeoutMs: 5000, retry: { enabled: false, provider: { maxRetries: 2 } } }));
  await patchGlobalProviderTimeout(config, { timeoutMs: 0 });
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ theme: "custom", httpIdleTimeoutMs: 5000,
    retry: { enabled: false, provider: { maxRetries: 2, timeoutMs: 0 } } });
  await patchGlobalProviderTimeout(config, { timeoutMs: null });
  expect(JSON.parse(readFileSync(path, "utf8")).retry).toEqual({ enabled: false, provider: { maxRetries: 2 } });
});

it.each([{}, { timeoutMs: -1 }, { timeoutMs: 0.5 }, { timeoutMs: "5" }, { timeoutMs: 2_147_483_648 }, { timeoutMs: 1, extra: true }])(
  "rejects invalid timeout patches without writing %#", async (patch) => {
    const path = join(root, "settings.json");
    writeFileSync(path, "{}");
    await expect(patchGlobalProviderTimeout(config, patch)).rejects.toMatchObject({ status: 400 });
    expect(readFileSync(path, "utf8")).toBe("{}");
  });

it.each(['{"retry":[]}', '{"retry":{"provider":false}}', '{"private":"not-closed'])(
  "does not overwrite malformed current settings %#", async (bytes) => {
    const path = join(root, "settings.json");
    writeFileSync(path, bytes);
    await expect(patchGlobalProviderTimeout(config, { timeoutMs: 5000 })).rejects.toMatchObject({ status: 409 });
    expect(readFileSync(path, "utf8")).toBe(bytes);
  });
