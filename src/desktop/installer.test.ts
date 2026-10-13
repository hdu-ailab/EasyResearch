import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { downloadWindowsInstaller, windowsInstallerScript } from "./installer";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("Windows desktop installer", () => {
  it("writes an exact verified download and reports progress", async () => {
    const root = mkdtempSync(join(tmpdir(), "desktop-updater-")); roots.push(root);
    const bytes = Buffer.from("verified installer fixture");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const progress: number[] = [];
    const path = await downloadWindowsInstaller({
      fileName: "EasyResearch-1.3.0-windows-x64.exe", url: "https://github.com/test", size: bytes.length, sha256: digest,
    }, root, {
      fetch: async () => new Response(bytes),
      onProgress: (percent) => progress.push(percent),
    });
    expect(readFileSync(path)).toEqual(bytes);
    expect(progress.at(-1)).toBe(100);
  });

  it("rejects a mismatched digest and removes the incomplete download", async () => {
    const root = mkdtempSync(join(tmpdir(), "desktop-updater-")); roots.push(root);
    const bytes = Buffer.from("unverified fixture");
    await expect(downloadWindowsInstaller({
      fileName: "EasyResearch-1.3.0-windows-x64.exe", url: "https://github.com/test", size: bytes.length,
      sha256: "0".repeat(64),
    }, root, { fetch: async () => new Response(bytes) })).rejects.toThrow(/SHA-256/);
    expect(readdirSync(root)).toEqual([]);
  });

  it("waits for the exact old process and relaunches only after installer settlement", () => {
    const script = windowsInstallerScript("C:\\Updates\\it's.exe", "C:\\App\\EasyResearch.exe", "C:\\Logs\\update.log", 4567);
    expect(script).toContain("Get-Process -Id 4567");
    expect(script.indexOf("Get-Process -Id 4567")).toBeLessThan(script.indexOf("Start-Process -FilePath $installer"));
    expect(script.indexOf("Start-Process -FilePath $installer")).toBeLessThan(script.indexOf("Start-Process -FilePath $app"));
    expect(script).toContain("'C:\\Updates\\it''s.exe'");
    expect(script).not.toContain("Stop-Process");
  });
});
