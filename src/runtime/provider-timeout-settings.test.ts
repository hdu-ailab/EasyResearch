import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { fingerprintConfiguration } from "./live-configuration";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("tracks native provider timeout changes while preserving explicit zero and fallback identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "easyresearch-timeout-policy-"));
  roots.push(root);
  const path = join(root, "settings.json");
  const initial = await fingerprintConfiguration(root, root);
  expect(initial.providerTimeoutSettings).toEqual({ timeoutMs: 3_600_000, source: "default" });
  writeFileSync(path, JSON.stringify({ retry: { provider: { timeoutMs: 0 } } }));
  const disabled = await fingerprintConfiguration(root, root);
  expect(disabled.providerTimeoutSettings).toEqual({ timeoutMs: 0, source: "provider" });
  expect(disabled.value).not.toBe(initial.value);
  writeFileSync(path, JSON.stringify({ httpIdleTimeoutMs: 0 }));
  const fallback = await fingerprintConfiguration(root, root);
  expect(fallback.providerTimeoutSettings).toEqual({ timeoutMs: 0, source: "httpIdle" });
  expect(fallback.value).not.toBe(disabled.value);
  writeFileSync(path, JSON.stringify({ retry: { provider: { timeoutMs: "private-invalid-value" } } }));
  const invalid = await fingerprintConfiguration(root, root);
  expect(invalid.invalidSettingsLayers?.providerTimeout).toBe(true);
  expect(invalid.diagnostic).toContain(path);
  expect(invalid.diagnostic).not.toContain("private-invalid-value");
});
