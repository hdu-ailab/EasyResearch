/** Diagnose the actual private Desktop TLS prerequisite without installing the app. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { createDesktopFixtureCertificate, powershell, windowsFixtureTrust, withFixtureTrust } from "./smoke-desktop-update-fixture";
import { withWindowsFixtureRoamingAppData } from "./smoke-desktop-update-windows";

if (process.platform !== "win32") throw new Error("Desktop trust diagnosis requires native Windows.");
const root = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "easyresearch-desktop-trust-"));
const phases: Array<Record<string, unknown>> = [];
const started = performance.now();
let passed = false;
let profileRestored = true;
try {
  const certificate = await createDesktopFixtureCertificate(join(root, "tls"));
  const store = windowsFixtureTrust(certificate.caPath);
  const step = async <T>(phase: string, operation: () => Promise<T>): Promise<T> => {
    const record: Record<string, unknown> = { phase, startedMs: performance.now() - started }; phases.push(record);
    console.log(`[desktop-trust] ${phase}`);
    try { const result = await operation(); record.result = result; return result; }
    catch (error) { record.error = String(error); throw error; }
    finally { record.finishedMs = performance.now() - started; }
  };
  await withFixtureTrust(certificate.thumbprint, {
    contains: id => step("contains", () => store.contains(id)),
    add: id => step("add", () => store.add(id)),
    remove: id => step("remove", () => store.remove(id)),
  }, async () => { await step("trusted-operation", async () => true); });
  const profile = join(root, "profile"); mkdirSync(profile);
  profileRestored = false;
  await step("native-profile-binding", () => withWindowsFixtureRoamingAppData(profile, async () => {
    const observed = (await powershell("[Console]::Write([Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData))")).trim();
    assert.equal(win32.resolve(observed).toLowerCase(), win32.resolve(realpathSync(join(profile, "appdata"))).toLowerCase());
    return true;
  }));
  profileRestored = true;
  passed = true;
} finally {
  rmSync(join(root, "tls"), { recursive: true, force: true });
  if (profileRestored) rmSync(root, { recursive: true, force: true });
  const report = { passed, phases };
  writeFileSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "windows-desktop-trust-diagnostic.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
