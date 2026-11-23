import { createHash } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { compareSemanticVersions, parseSemanticVersion } from "./update";

export const LATEST_RELEASE_API = "https://api.github.com/repos/hdu-ailab/EasyResearch/releases/latest";
const RELEASE_DOWNLOAD = "https://github.com/hdu-ailab/EasyResearch/releases/download/";
const METADATA_LIMIT = 1024 * 1024;
const CHECKSUM_LIMIT = 64 * 1024;
const INSTALLER_LIMIT = 2 * 1024 * 1024 * 1024;
export type DesktopPackageKind = "windows-x64.exe" | "macos-arm64.dmg" | "linux-arm64.AppImage" | "linux-arm64.deb";
export type UpdateFetch = (input: string, init?: RequestInit) => Promise<Response>;
export interface DesktopAsset { name: string; url: string; size: number; sha256: string }
export interface DesktopRelease { version: string; asset: DesktopAsset }
export interface UpdateDownloadOptions {
  fetch?: UpdateFetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress?(received: number, total: number): void;
}

export function desktopPackageKind(platform: NodeJS.Platform, arch: string, appImage?: string): DesktopPackageKind | null {
  if (platform === "win32" && arch === "x64") return "windows-x64.exe";
  if (platform === "darwin" && arch === "arm64") return "macos-arm64.dmg";
  if (platform === "linux" && arch === "arm64") return appImage ? "linux-arm64.AppImage" : "linux-arm64.deb";
  return null;
}

/** One deadline covers headers, redirects and the complete body, including stalled readers. */
export async function withUpdateDeadline<T>(options: UpdateDownloadOptions, defaultMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error("Update request timed out.")), options.timeoutMs ?? defaultMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  try { return await run(signal); } finally { clearTimeout(timer); }
}

export function updateAbortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Update cancelled."));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

async function request(url: string, signal: AbortSignal, fetchImpl: UpdateFetch): Promise<Response> {
  let target = url;
  for (let redirects = 0; redirects <= 4; redirects++) {
    signal.throwIfAborted();
    const pending = fetchImpl(target, {
      signal, redirect: "manual", credentials: "omit",
      headers: { Accept: target === LATEST_RELEASE_API ? "application/vnd.github+json" : "application/octet-stream",
        "User-Agent": "EasyResearch/Desktop", "X-GitHub-Api-Version": "2022-11-28", "Accept-Encoding": "identity" },
    });
    void pending.then((response) => { if (signal.aborted) void response.body?.cancel().catch(() => {}); }, () => {});
    const response = await updateAbortable(pending, signal);
    if (response.status >= 300 && response.status < 400) {
      void response.body?.cancel().catch(() => {});
      const location = response.headers.get("location");
      const next = location ? new URL(location, target) : undefined;
      if (url === LATEST_RELEASE_API || !next || !allowedAssetRedirect(next)) throw new Error("Invalid update download redirect.");
      target = next.href;
      continue;
    }
    if (!response.ok || response.status !== 200) {
      void response.body?.cancel().catch(() => {});
      throw new Error(`Update request returned HTTP ${response.status}.`);
    }
    return response;
  }
  throw new Error("Too many update download redirects.");
}

function allowedAssetRedirect(url: URL): boolean {
  return url.protocol === "https:" && url.port === "" && !url.username && !url.password && !url.hash
    && (url.hostname === "release-assets.githubusercontent.com" || url.hostname === "objects.githubusercontent.com"
      || (url.hostname === "github.com" && url.href.startsWith(RELEASE_DOWNLOAD)));
}

async function consume(response: Response, signal: AbortSignal, limit: number, write: (chunk: Uint8Array) => Promise<void>): Promise<number> {
  if (!response.body) throw new Error("Empty update response.");
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > limit)) {
    void response.body.cancel().catch(() => {});
    throw new Error("Update response exceeds its size limit.");
  }
  const reader = response.body.getReader();
  let received = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await updateAbortable(reader.read(), signal);
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > limit) throw new Error("Update response exceeds its size limit.");
      await write(chunk.value);
    }
    signal.throwIfAborted();
    if (length !== null && Number(length) !== received) throw new Error("Truncated update response.");
    return received;
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function readUpdateMetadata(options: UpdateDownloadOptions = {}): Promise<unknown> {
  return withUpdateDeadline(options, 15_000, async (signal) => {
    const response = await request(LATEST_RELEASE_API, signal, options.fetch ?? fetch);
    const chunks: Uint8Array[] = [];
    await consume(response, signal, METADATA_LIMIT, async (chunk) => { chunks.push(chunk); });
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  });
}

export async function discoverDesktopRelease(currentVersion: string, kind: DesktopPackageKind, options: UpdateDownloadOptions = {}): Promise<DesktopRelease | null> {
  return withUpdateDeadline(options, 30_000, async (signal) => {
    const raw = await readUpdateMetadata({ ...options, signal });
    if (!raw || typeof raw !== "object") throw new Error("Invalid release metadata.");
    const body = raw as Record<string, unknown>;
    if (body.draft !== false || body.prerelease !== false || typeof body.tag_name !== "string") throw new Error("A stable published release is required.");
    const version = body.tag_name.replace(/^v/u, "");
    if (!/^\d+\.\d+\.\d+$/u.test(version) || parseSemanticVersion(version).prerelease.length > 0
      || body.tag_name !== `v${version}` || body.html_url !== `https://github.com/hdu-ailab/EasyResearch/releases/tag/v${version}`) throw new Error("Invalid release identity.");
    if (compareSemanticVersions(version, currentVersion) <= 0) return null;
    if (!Array.isArray(body.assets) || body.assets.length > 64) throw new Error("Invalid release assets.");
    const find = (name: string, limit: number): DesktopAsset => {
      const matches = (body.assets as Array<Record<string, unknown>>).filter((asset) => asset?.name === name);
      const asset = matches[0];
      if (matches.length !== 1 || !asset || asset.state !== "uploaded" || !Number.isSafeInteger(asset.size)
        || (asset.size as number) <= 0 || (asset.size as number) > limit
        || asset.browser_download_url !== `${RELEASE_DOWNLOAD}v${version}/${name}`
        || (asset.digest !== null && asset.digest !== undefined && (typeof asset.digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(asset.digest)))) throw new Error("Missing or invalid exact release asset.");
      return { name, size: asset.size as number, url: asset.browser_download_url as string,
        sha256: typeof asset.digest === "string" ? asset.digest.slice(7) : "" };
    };
    const installer = find(`EasyResearch-${version}-${kind}`, INSTALLER_LIMIT);
    const checksum = find("SHA256SUMS", CHECKSUM_LIMIT);
    const response = await request(checksum.url, signal, options.fetch ?? fetch);
    const chunks: Uint8Array[] = [];
    const received = await consume(response, signal, checksum.size, async (chunk) => { chunks.push(chunk); });
    const bytes = Buffer.concat(chunks);
    if (received !== checksum.size || (checksum.sha256 && createHash("sha256").update(bytes).digest("hex") !== checksum.sha256)) throw new Error("Checksum file verification failed.");
    const entries = bytes.toString("utf8").trim().split(/\r?\n/u).map((line) => line.match(/^([a-f0-9]{64}) {2}(EasyResearch-[A-Za-z0-9.\-]+)$/u));
    if (entries.some((entry) => !entry)) throw new Error("Invalid release checksum file.");
    const matches = entries.filter((entry) => entry![2] === installer.name);
    if (matches.length !== 1 || (installer.sha256 && matches[0]![1] !== installer.sha256)) throw new Error("Installer checksum mismatch.");
    return { version, asset: { ...installer, sha256: matches[0]![1]! } };
  });
}

/** The caller creates an owner-private staging directory; no executable is run here. */
export async function downloadDesktopAsset(asset: DesktopAsset, directory: string, options: UpdateDownloadOptions = {}): Promise<{ path: string }> {
  if (!/^EasyResearch-\d+\.\d+\.\d+-(windows-x64\.exe|macos-arm64\.dmg|linux-arm64\.(AppImage|deb))$/u.test(asset.name)
    || !/^[a-f0-9]{64}$/u.test(asset.sha256) || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > INSTALLER_LIMIT) throw new Error("Invalid installer identity.");
  const path = join(directory, asset.name);
  const partial = `${path}.partial`;
  return withUpdateDeadline(options, 15 * 60_000, async (signal) => {
    const file = await open(partial, "wx", 0o600);
    try {
      const hash = createHash("sha256");
      let progress = 0;
      const response = await request(asset.url, signal, options.fetch ?? fetch);
      const received = await consume(response, signal, asset.size, async (chunk) => {
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.byteLength) {
          signal.throwIfAborted();
          const result = await file.write(chunk, offset, chunk.byteLength - offset);
          if (result.bytesWritten === 0) throw new Error("Installer staging write failed.");
          offset += result.bytesWritten;
        }
        progress += chunk.byteLength;
        options.onProgress?.(progress, asset.size);
      });
      if (received !== asset.size || hash.digest("hex") !== asset.sha256) throw new Error("Installer size or SHA-256 verification failed.");
      await file.sync(); await file.close(); signal.throwIfAborted();
      await rename(partial, path);
      return { path };
    } catch (error) {
      await file.close().catch(() => {});
      await rm(partial, { force: true });
      throw error;
    }
  });
}
