/** Diagnose the actual private Desktop TLS prerequisite without installing the app. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesktopFixtureCertificate, windowsFixtureTrust, withFixtureTrust } from "./smoke-desktop-update-fixture";

if (process.platform !== "win32") throw new Error("Desktop trust diagnosis requires native Windows.");
const root = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "easyresearch-desktop-trust-"));
const phases: Array<Record<string, unknown>> = [];
const started = performance.now();
let passed = false;
try {
  const certificate = await createDesktopFixtureCertificate(root);
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
  passed = true;
} finally {
  rmSync(root, { recursive: true, force: true });
  const report = { passed, phases };
  writeFileSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "windows-desktop-trust-diagnostic.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
