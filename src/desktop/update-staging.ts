import { link, lstat, mkdir, readFile, readdir, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { regularUpdateFile, updateFileHash, writeUpdateJson } from "./update-files";
import type { DesktopAsset } from "./update-download";

export async function verifyDesktopDownload(path: string, asset: DesktopAsset): Promise<void> {
  if (await regularUpdateFile(path) !== asset.size || await updateFileHash(path) !== asset.sha256) throw new Error("Downloaded update verification failed.");
}

export async function retainManualDesktopDownload(path: string, root: string, asset: DesktopAsset): Promise<string> {
  if (!manualAssetName(asset.name)) throw new Error("Invalid manual update artifact.");
  await verifyDesktopDownload(path, asset);
  const directory = join(root, "manual"); await mkdir(directory, { recursive: true, mode: 0o700 });
  const rootStat = await lstat(directory);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Invalid manual download directory.");
  const manifestPath = join(directory, ".owned-downloads.json");
  const records = await readManualOwnership(manifestPath);
  const valid: ManualDownloadOwnership[] = [];
  for (const record of records) if (await matchesManualOwnership(directory, record)) valid.push(record);
  const destination = join(directory, asset.name);
  let exists = false;
  try { await lstat(destination); exists = true; await verifyDesktopDownload(destination, asset); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const current = valid.find((record) => record.name === asset.name);
  const previous = valid.filter((record) => record.name !== asset.name);
  // Reserve capacity before publishing another artifact. A failed deletion stops
  // admission, rather than letting repeated versions grow an installer cache.
  for (const superseded of previous.slice(1)) {
    if (await matchesManualOwnership(directory, superseded)) await unlink(join(directory, superseded.name));
  }
  let created: ManualDownloadOwnership | undefined;
  try {
    if (!exists) {
      await link(path, destination); // Exclusive; never replace a foreign file.
      created = await captureManualOwnership(destination, asset);
      await verifyDesktopDownload(destination, asset);
    }
    const ownedCurrent = created ?? current;
    await writeUpdateJson(manifestPath, { schema: 1, files: [...(ownedCurrent ? [ownedCurrent] : []), ...previous.slice(0, 1)] });
    await unlink(path);
    return destination;
  } catch (error) {
    if (created && await matchesManualOwnership(directory, created)) await unlink(destination);
    throw error;
  }
}

interface ManualDownloadOwnership {
  name: string; size: number; sha256: string; dev: string; ino: string; mtimeNs: string;
}

function manualAssetName(name: string): boolean {
  return /^EasyResearch-\d+\.\d+\.\d+-(windows-x64\.exe|macos-arm64\.dmg|linux-arm64\.(AppImage|deb))$/u.test(name);
}

async function readManualOwnership(path: string): Promise<ManualDownloadOwnership[]> {
  try { await regularUpdateFile(path, 32 * 1024); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const value = JSON.parse(await readFile(path, "utf8")) as { schema?: unknown; files?: unknown };
  if (!value || typeof value !== "object" || Object.keys(value).sort().join(",") !== "files,schema"
    || value.schema !== 1 || !Array.isArray(value.files) || value.files.length > 16) throw new Error("Invalid manual download ownership.");
  const seen = new Set<string>();
  for (const entry of value.files) {
    const record = entry as ManualDownloadOwnership;
    if (!record || typeof record !== "object" || Object.keys(record).sort().join(",") !== "dev,ino,mtimeNs,name,sha256,size"
      || typeof record.name !== "string" || !manualAssetName(record.name) || seen.has(record.name)
      || !Number.isSafeInteger(record.size) || record.size <= 0 || record.size > 2 * 1024 ** 3
      || typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(record.sha256)
      || ![record.dev, record.ino, record.mtimeNs].every((part) => typeof part === "string" && /^\d{1,32}$/u.test(part))) throw new Error("Invalid manual download ownership.");
    seen.add(record.name);
  }
  return value.files as ManualDownloadOwnership[];
}

async function captureManualOwnership(path: string, asset: DesktopAsset): Promise<ManualDownloadOwnership> {
  const stat = await lstat(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== BigInt(asset.size)) throw new Error("Manual artifact changed during publication.");
  return { name: asset.name, size: asset.size, sha256: asset.sha256, dev: String(stat.dev), ino: String(stat.ino), mtimeNs: String(stat.mtimeNs) };
}

async function matchesManualOwnership(directory: string, record: ManualDownloadOwnership): Promise<boolean> {
  try {
    const path = join(directory, record.name);
    const stat = await lstat(path, { bigint: true });
    return stat.isFile() && !stat.isSymbolicLink() && stat.size === BigInt(record.size) && String(stat.dev) === record.dev
      && String(stat.ino) === record.ino && String(stat.mtimeNs) === record.mtimeNs && await updateFileHash(path) === record.sha256;
  } catch { return false; } // Unverifiable/user-modified files never become deletion targets.
}

/** Only known updater files are removed. Foreign files/links and their directory remain. */
export async function cleanupDesktopUpdateStaging(directory: string, installerName: string, keepInstaller = false, io: {
  unlink?: typeof unlink; wait?: (milliseconds: number) => Promise<void>; platform?: NodeJS.Platform;
} = {}): Promise<void> {
  const stat = await lstat(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid update staging directory.");
  const owned = new Set(["custodian.exe", "handoff.json", "recovery-handoff.json", "receipt.json", "receipt.json.acknowledged", "registry-0.reg", "registry-1.reg", "registry-probe.reg", "handoff.json.tmp", "recovery-handoff.json.tmp", "receipt.json.tmp"]);
  if (!keepInstaller) { owned.add(installerName); owned.add(`${installerName}.partial`); }
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length > 32) throw new Error("Unexpected update staging contents.");
  const authority = new Set(["handoff.json", "recovery-handoff.json", "receipt.json", "receipt.json.acknowledged"]);
  entries.sort((a, b) => Number(authority.has(a.name)) - Number(authority.has(b.name)));
  const candidates = await Promise.all(entries.filter(entry => entry.isFile() && owned.has(entry.name)).map(async entry => {
    const path = join(directory, entry.name);
    const original = await lstat(path, { bigint: true });
    if (!original.isFile() || original.isSymbolicLink()) throw new Error("Update staging file changed before cleanup.");
    return { path, original };
  }));
  for (const { path, original } of candidates) {
    for (let attempt = 0; ; attempt++) {
      const [currentDirectory, current] = await Promise.all([lstat(directory, { bigint: true }), lstat(path, { bigint: true })]);
      if (!currentDirectory.isDirectory() || currentDirectory.isSymbolicLink() || currentDirectory.dev !== stat.dev || currentDirectory.ino !== stat.ino
        || !current.isFile() || current.isSymbolicLink() || current.dev !== original.dev || current.ino !== original.ino
        || current.size !== original.size || current.mtimeNs !== original.mtimeNs) throw new Error("Update staging identity changed during cleanup.");
      try { await (io.unlink ?? unlink)(path); break; }
      catch (error) {
        if ((io.platform ?? process.platform) !== "win32" || attempt >= 20 || !["EPERM", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        await (io.wait ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))))(100);
      }
    }
  }
  if (!keepInstaller) {
    try { await rmdir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY" && (error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
}
