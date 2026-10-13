import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DesktopInstallerAsset } from "./update";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export async function downloadWindowsInstaller(
  asset: DesktopInstallerAsset,
  stagingRoot: string,
  options: { fetch?: FetchLike; onProgress?: (percent: number) => void } = {},
): Promise<string> {
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(stagingRoot, "release-"));
  const destination = join(directory, asset.fileName);
  try {
    const response = await (options.fetch ?? fetch)(asset.url, {
      signal: AbortSignal.timeout(10 * 60_000),
      redirect: "follow",
    });
    if (!response.ok || !response.body) throw new Error(`Installer download failed (HTTP ${response.status}).`);
    const length = response.headers.get("content-length");
    if (length !== null && Number(length) !== asset.size) {
      throw new Error("Installer download size differs from the release metadata.");
    }
    const file = await open(destination, "wx", 0o600);
    const digest = createHash("sha256");
    let received = 0;
    let lastPercent = -1;
    try {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > asset.size) throw new Error("Installer download exceeds the release metadata size.");
        digest.update(value);
        let written = 0;
        while (written < value.byteLength) {
          const result = await file.write(value, written, value.byteLength - written);
          if (result.bytesWritten === 0) throw new Error("Installer download could not be written.");
          written += result.bytesWritten;
        }
        const percent = Math.floor(100 * received / asset.size);
        if (percent !== lastPercent) {
          lastPercent = percent;
          options.onProgress?.(percent);
        }
      }
    } finally {
      await file.close();
    }
    if (received !== asset.size || digest.digest("hex") !== asset.sha256) {
      throw new Error("Installer download failed SHA-256 or size verification.");
    }
    return destination;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function psLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** The helper is outside the Electron installation, so NSIS can replace its files. */
export function windowsInstallerScript(
  installer: string,
  appPath: string,
  logPath: string,
  oldPid: number,
  readyMarker = "Helper ready",
): string {
  if (!Number.isSafeInteger(oldPid) || oldPid <= 0) throw new Error("Invalid desktop process identity.");
  return `
$ErrorActionPreference = 'Stop'
$installer = ${psLiteral(installer)}
$app = ${psLiteral(appPath)}
$log = ${psLiteral(logPath)}
$installDir = ${psLiteral(dirname(appPath))}
Add-Content -LiteralPath $log -Value ${psLiteral(readyMarker)}
$deadline = (Get-Date).AddSeconds(45)
while (Get-Process -Id ${oldPid} -ErrorAction SilentlyContinue) {
  if ((Get-Date) -ge $deadline) { Add-Content -LiteralPath $log -Value 'Previous desktop did not exit; installation cancelled.'; exit 2 }
  Start-Sleep -Milliseconds 250
}
try {
  Add-Content -LiteralPath $log -Value 'Previous desktop exited; launching installer.'
  $result = Start-Process -FilePath $installer -ArgumentList ('/S /D=' + $installDir) -Wait -PassThru -WindowStyle Hidden
  Add-Content -LiteralPath $log -Value ('Installer exited with code ' + $result.ExitCode)
} catch {
  Add-Content -LiteralPath $log -Value ('Installer failed: ' + $_.Exception.Message)
} finally {
  try {
    Start-Process -FilePath $app -WindowStyle Normal
    Add-Content -LiteralPath $log -Value 'Desktop relaunch requested.'
  } catch {
    Add-Content -LiteralPath $log -Value ('Desktop relaunch failed: ' + $_.Exception.Message)
  }
}
`;
}

export async function scheduleWindowsInstaller(installer: string, appPath: string, logPath: string): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const readyMarker = `Helper ready ${randomUUID()}`;
  const script = windowsInstallerScript(installer, appPath, logPath, process.pid, readyMarker);
  const command = Buffer.from(script, "utf16le").toString("base64");
  // Node's detached Windows spawn makes PowerShell exit before it runs an encoded
  // command. Start-Process creates the lasting helper from a normal short-lived
  // PowerShell process instead.
  const launcher = `Start-Process -FilePath ${psLiteral(powershell)} -ArgumentList @('-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand','${command}') -WindowStyle Hidden`;
  const launcherCommand = Buffer.from(launcher, "utf16le").toString("base64");
  const log = await open(logPath, "a", 0o600);
  try {
    const child = spawn(powershell, ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", launcherCommand], {
      windowsHide: true,
      stdio: ["ignore", log.fd, log.fd],
    });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", resolve);
    });
    child.unref();
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if ((await readFile(logPath, "utf8")).includes(readyMarker)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    child.kill();
    throw new Error(`Desktop update helper did not start. Review ${logPath}`);
  } finally {
    await log.close();
  }
}
