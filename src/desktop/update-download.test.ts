import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverDesktopRelease, downloadDesktopAsset, desktopPackageKind } from "./update-download";

const bytes = Buffer.from("verified installer bytes");
const digest = createHash("sha256").update(bytes).digest("hex");
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function release(kind = "windows-x64.exe") {
  const name = `EasyResearch-2.0.0-${kind}`;
  const sums = `${digest}  ${name}\n`;
  const asset = (name: string, size: number, sha256: string) => ({
    name, size, digest: `sha256:${sha256}`, state: "uploaded",
    browser_download_url: `https://github.com/hdu-ailab/EasyResearch/releases/download/v2.0.0/${name}`,
  });
  return { metadata: { tag_name: "v2.0.0", draft: false, prerelease: false,
    html_url: "https://github.com/hdu-ailab/EasyResearch/releases/tag/v2.0.0",
    assets: [asset(name, bytes.length, digest), asset("SHA256SUMS", Buffer.byteLength(sums), createHash("sha256").update(sums).digest("hex"))],
  }, sums };
}

describe("official Desktop release assets", () => {
  it.each(["windows-x64.exe", "macos-arm64.dmg", "linux-arm64.AppImage", "linux-arm64.deb"] as const)("discovers the exact %s asset", async (kind) => {
    const data = release(kind);
    const fetch = vi.fn(async (url: string) => new Response(url.endsWith("/latest") ? JSON.stringify(data.metadata) : data.sums));
    const result = await discoverDesktopRelease("1.0.0", kind, { fetch });
    expect(result?.asset).toMatchObject({ name: `EasyResearch-2.0.0-${kind}`, size: bytes.length, sha256: digest });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects duplicate assets, draft releases, wrong targets and checksum disagreement", async () => {
    for (const mutate of [
      (data: ReturnType<typeof release>) => { data.metadata.assets.push(data.metadata.assets[0]!); },
      (data: ReturnType<typeof release>) => { data.metadata.draft = true; },
      (data: ReturnType<typeof release>) => { data.metadata.assets[0]!.name = "EasyResearch-2.0.0-linux-arm64.deb"; },
      (data: ReturnType<typeof release>) => { data.metadata.assets[0]!.digest = `sha256:${"0".repeat(64)}`; },
    ]) {
      const data = release(); mutate(data);
      await expect(discoverDesktopRelease("1.0.0", "windows-x64.exe", {
        fetch: async (url) => new Response(String(url).endsWith("/latest") ? JSON.stringify(data.metadata) : data.sums),
      })).rejects.toThrow();
    }
  });

  it("has a full-body deadline even when headers arrive immediately", async () => {
    await expect(discoverDesktopRelease("1.0.0", "windows-x64.exe", {
      timeoutMs: 10,
      fetch: async () => new Response(new ReadableStream({ start() {} })),
    })).rejects.toThrow(/timed out/i);
  });

  it("does not follow an unapproved asset redirect", async () => {
    const data = release();
    await expect(discoverDesktopRelease("1.0.0", "windows-x64.exe", {
      fetch: async (url) => String(url).endsWith("/latest") ? Response.json(data.metadata)
        : new Response(null, { status: 302, headers: { location: "https://example.org/installer" } }),
    })).rejects.toThrow(/redirect/i);
  });

  it("recognizes only released platform/package combinations", () => {
    expect(desktopPackageKind("linux", "x64", undefined)).toBeNull();
    expect(desktopPackageKind("linux", "arm64", "/home/user/EasyResearch.AppImage")).toBe("linux-arm64.AppImage");
    expect(desktopPackageKind("linux", "arm64", undefined)).toBe("linux-arm64.deb");
    expect(desktopPackageKind("darwin", "arm64", undefined)).toBe("macos-arm64.dmg");
  });
});

describe("streaming verified installer download", () => {
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "desktop-update-")); roots.push(root);
    const asset = { name: "EasyResearch-2.0.0-windows-x64.exe", size: bytes.length, sha256: digest,
      url: "https://github.com/hdu-ailab/EasyResearch/releases/download/v2.0.0/EasyResearch-2.0.0-windows-x64.exe" };
    return { root, asset };
  }

  it("publishes only complete digest-verified bytes and known-size progress", async () => {
    const { root, asset } = await fixture(); const progress = vi.fn();
    const downloaded = await downloadDesktopAsset(asset, root, {
      fetch: async () => new Response(bytes), onProgress: progress,
    });
    expect(await readFile(downloaded.path)).toEqual(bytes);
    expect(progress).toHaveBeenLastCalledWith(bytes.length, bytes.length);
    expect(await readdir(root)).toEqual([asset.name]);
  });

  it.each([bytes.subarray(1), Buffer.alloc(bytes.length), Buffer.concat([bytes, bytes])])("removes incomplete or invalid downloads", async (body) => {
    const { root, asset } = await fixture();
    await expect(downloadDesktopAsset(asset, root, { fetch: async () => new Response(body) })).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });

  it("cancels a stalled body, deletes the partial file, and never reports download success", async () => {
    const { root, asset } = await fixture(); const abort = new AbortController();
    const operation = downloadDesktopAsset(asset, root, {
      signal: abort.signal,
      fetch: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.subarray(0, 2)); } })),
      onProgress: () => abort.abort(),
    });
    await expect(operation).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });
});
