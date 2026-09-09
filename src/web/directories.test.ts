import fs, {
  accessSync,
  chmodSync,
  closeSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DirectoryService, DirectoryServiceError, FILE_PREVIEW_LIMIT } from "./directories";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, readSync: vi.fn(fs.readSync), readFileSync: vi.fn(fs.readFileSync),
    realpathSync: vi.fn(fs.realpathSync), statSync: vi.fn(fs.statSync),
    accessSync: vi.fn(fs.accessSync), openSync: vi.fn(fs.openSync) };
});

let fakeHome: string;

beforeEach(() => {
  fakeHome = join(tmpdir(), `easyresearch-dirs-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(fakeHome, "project", "a-dir"), { recursive: true });
  mkdirSync(join(fakeHome, "project", "z-dir"), { recursive: true });
  mkdirSync(join(fakeHome, "empty"), { recursive: true });
  writeFileSync(join(fakeHome, "project", "file.txt"), "x");
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(fakeHome, { recursive: true, force: true });
});

describe("DirectoryService", () => {
  it("lists the injected home root by default with canonical path", () => {
    const service = new DirectoryService(fakeHome);
    const listing = service.list();
    expect(listing.path).toBe(realpathSync(fakeHome));
    expect(listing.entries.map((e) => e.name).sort()).toEqual(["empty", "project"]);
  });

  it("lists only directories sorted by name for a given path", () => {
    const service = new DirectoryService(fakeHome);
    const listing = service.list(join(fakeHome, "project"));
    expect(listing.entries.map((e) => e.name)).toEqual(["a-dir", "z-dir"]);
  });

  it("enumerates every readable Windows drive root", () => {
    type RootAwareService = DirectoryService & { listRoots(): Array<{ name: string; path: string }> };
    const RootAwareDirectoryService = DirectoryService as unknown as new (
      homeDir: string,
      options: { platform: NodeJS.Platform; resolveRoot: (candidate: string) => string | null },
    ) => RootAwareService;
    const readable = new Set(["C:\\", "D:\\"]);
    const service = new RootAwareDirectoryService(String.raw`C:\Users\researcher`, {
      platform: "win32",
      resolveRoot: (candidate) => (readable.has(candidate) ? candidate : null),
    });
    const roots = typeof service.listRoots === "function" ? service.listRoots() : [];

    expect(roots).toEqual([
      { name: "C:\\", path: "C:\\" },
      { name: "D:\\", path: "D:\\" },
    ]);
  });

  it("returns canonical path from requireCwd", () => {
    const service = new DirectoryService(fakeHome);
    const project = join(fakeHome, "project");
    expect(service.requireCwd(project)).toBe(realpathSync(project));
  });

  it("rejects a file path as not a directory", () => {
    const service = new DirectoryService(fakeHome);
    const file = join(fakeHome, "project", "file.txt");
    expect(() => service.requireCwd(file)).toThrow(/not a directory/);
    expect(() => service.requireCwd(file)).toThrow(DirectoryServiceError);
  });

  it("rejects a missing path as not existing", () => {
    const service = new DirectoryService(fakeHome);
    const missing = join(fakeHome, "nope");
    expect(() => service.requireCwd(missing)).toThrow(/does not exist/);
    expect(() => service.requireCwd(missing)).toThrow(DirectoryServiceError);
  });

  it("rejects a readable directory that cannot be searched", () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const service = new DirectoryService(fakeHome);
    const blocked = join(fakeHome, "no-search");
    mkdirSync(blocked);
    chmodSync(blocked, 0o400);
    try {
      expect(() => service.requireCwd(blocked)).toThrow(/not readable/i);
    } finally {
      chmodSync(blocked, 0o700);
    }
  });

  it("rejects listing a missing path with a typed error", () => {
    const service = new DirectoryService(fakeHome);
    expect(() => service.list(join(fakeHome, "missing"))).toThrow(DirectoryServiceError);
  });

  it("lists files and directories together, directories first", () => {
    const service = new DirectoryService(fakeHome);
    const { entries } = service.listEntries(join(fakeHome, "project"));
    expect(entries.map((e) => [e.kind, e.name])).toEqual([
      ["directory", "a-dir"],
      ["directory", "z-dir"],
      ["file", "file.txt"],
    ]);
  });

  it("lists entries under the injected home root by default", () => {
    const service = new DirectoryService(fakeHome);
    const { path, entries } = service.listEntries();
    expect(path).toBe(realpathSync(fakeHome));
    expect(entries.every((e) => e.path.startsWith(path))).toBe(true);
  });

  it("preserves a requested directory alias in file entry paths", () => {
    const service = new DirectoryService(fakeHome);
    const alias = join(fakeHome, "project-alias");
    symlinkSync(join(fakeHome, "project"), alias, process.platform === "win32" ? "junction" : "dir");

    const listing = service.listEntries(alias);

    expect(listing.path).toBe(resolve(alias));
    expect(listing.entries.map((entry) => entry.path)).toContain(join(resolve(alias), "file.txt"));
  });

  it("reads a file's text content with its canonical path", () => {
    const service = new DirectoryService(fakeHome);
    writeFileSync(join(fakeHome, "project", "read.txt"), "hello");
    const file = service.readFile(join(fakeHome, "project", "read.txt"));
    expect(file.content).toBe("hello");
    expect(file.binary).toBe(false);
    expect(file.truncated).toBe(false);
    expect(file.path).toBe(join(realpathSync(fakeHome), "project", "read.txt"));
  });

  it("marks non-UTF-8 bytes binary with empty content", () => {
    const service = new DirectoryService(fakeHome);
    const bin = join(fakeHome, "data.bin");
    writeFileSync(bin, Buffer.from([0xff, 0xfe, 0x00, 0x01]));
    const file = service.readFile(bin);
    expect(file.binary).toBe(true);
    expect(file.content).toBe("");
    expect(file.byteCount).toBe(4);
  });

  it("marks NUL-containing valid UTF-8 as binary", () => {
    const service = new DirectoryService(fakeHome);
    const nul = join(fakeHome, "nul.bin");
    writeFileSync(nul, Buffer.from([0x68, 0x69, 0x00, 0x21]));
    const file = service.readFile(nul);
    expect(file.binary).toBe(true);
    expect(file.content).toBe("");
  });

  it("describes a file with size and MIME type", () => {
    const service = new DirectoryService(fakeHome);
    writeFileSync(join(fakeHome, "paper.pdf"), Buffer.from([0, 1, 2, 3, 4]));
    const descriptor = service.describeFile(join(fakeHome, "paper.pdf"));
    expect(descriptor.path).toBe(join(realpathSync(fakeHome), "paper.pdf"));
    expect(descriptor.size).toBe(5);
    expect(descriptor.mimeType).toBe("application/pdf");
  });

  it("reads a bounded inclusive byte range from a file", () => {
    const service = new DirectoryService(fakeHome);
    writeFileSync(join(fakeHome, "raw.bin"), Buffer.from([0, 1, 2, 3, 4]));
    const bytes = service.readFileBytes(join(fakeHome, "raw.bin"), { start: 1, end: 3 });
    expect([...bytes]).toEqual([1, 2, 3]);
  });

  it("rejects reading bytes of a directory or a missing path", () => {
    const service = new DirectoryService(fakeHome);
    expect(() => service.readFileBytes(join(fakeHome, "project"), { start: 0, end: 0 })).toThrow(/not a file/);
    expect(() => service.readFileBytes(join(fakeHome, "missing"), { start: 0, end: 0 })).toThrow(/does not exist/);
  });

  it("reads a near-end range of a large file without materializing the whole file", () => {
    const service = new DirectoryService(fakeHome);
    const big = join(fakeHome, "big.bin");
    const size = 16 * 1024 * 1024 + 1234;
    const fd = openSync(big, "w");
    try {
      writeSync(fd, Buffer.alloc(size));
      writeSync(fd, Buffer.from([0xde, 0xad, 0xbe, 0xef]), 0, 4, size - 4);
    } finally {
      closeSync(fd);
    }
    expect([...service.readFileBytes(big, { start: size - 4, end: size - 1 })]).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it("streams the full file bytes as a readable body", async () => {
    const service = new DirectoryService(fakeHome);
    writeFileSync(join(fakeHome, "stream.bin"), Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
    const stream = (await service.readFileBody(join(fakeHome, "stream.bin"), null)).stream();
    expect(stream).toBeInstanceOf(ReadableStream);
    const reader = stream.getReader();
    const chunks: number[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(...value);
    }
    expect(chunks).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("streams only an inclusive byte range", async () => {
    const service = new DirectoryService(fakeHome);
    writeFileSync(join(fakeHome, "stream.bin"), Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
    const reader = (await service.readFileBody(join(fakeHome, "stream.bin"), { start: 2, end: 6 })).stream().getReader();
    const chunks: number[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(...value);
    }
    expect(chunks).toEqual([2, 3, 4, 5, 6]);
  });

  it("streams a near-end range of a large file bounded to the window", async () => {
    const service = new DirectoryService(fakeHome);
    const big = join(fakeHome, "big.bin");
    const size = 8 * 1024 * 1024 + 99;
    const fd = openSync(big, "w");
    try {
      writeSync(fd, Buffer.alloc(size));
      writeSync(fd, Buffer.from([1, 2, 3, 4]), 0, 4, size - 4);
    } finally {
      closeSync(fd);
    }
    const reader = (await service.readFileBody(big, { start: size - 4, end: size - 1 })).stream().getReader();
    const chunks: number[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(...value);
    }
    expect(chunks).toEqual([1, 2, 3, 4]);
  });

  it("streams an empty file as an empty body", async () => {
    const service = new DirectoryService(fakeHome);
    writeFileSync(join(fakeHome, "empty.bin"), Buffer.alloc(0));
    const reader = (await service.readFileBody(join(fakeHome, "empty.bin"), null)).stream().getReader();
    const first = await reader.read();
    expect(first.done).toBe(true);
    expect(first.value).toBeUndefined();
  });

  it("truncates oversized reads and flags them", () => {
    const service = new DirectoryService(fakeHome);
    const big = join(fakeHome, "big.bin");
    writeFileSync(big, Buffer.alloc(FILE_PREVIEW_LIMIT + 10, 0x61));
    const file = service.readFile(big);
    expect(file.truncated).toBe(true);
    expect(file.byteCount).toBe(FILE_PREVIEW_LIMIT + 10);
    expect(file.binary).toBe(false);
    expect(file.content.length).toBe(FILE_PREVIEW_LIMIT);
  });

  it("bounds filesystem reads to the preview prefix, independently of the full file size", () => {
    const path = join(fakeHome, "large-log.txt");
    const size = FILE_PREVIEW_LIMIT * 16;
    writeFileSync(path, Buffer.alloc(FILE_PREVIEW_LIMIT, 0x61));
    const fd = openSync(path, "r+");
    try {
      ftruncateSync(fd, size);
    } finally {
      closeSync(fd);
    }
    vi.mocked(readSync).mockClear();
    vi.mocked(readFileSync).mockClear();

    const file = new DirectoryService(fakeHome).readFile(path);
    const wholeReadBytes = vi.mocked(readFileSync).mock.results.reduce((sum, result) =>
      sum + (result.type === "return" && Buffer.isBuffer(result.value) ? result.value.byteLength : 0), 0);
    const chunkReadBytes = vi.mocked(readSync).mock.results.reduce((sum, result) =>
      sum + (result.type === "return" ? result.value : 0), 0);

    expect(wholeReadBytes + chunkReadBytes).toBeLessThanOrEqual(FILE_PREVIEW_LIMIT);
    expect(file).toMatchObject({ byteCount: size, truncated: true, binary: false });
    expect(file.content).toBe("a".repeat(FILE_PREVIEW_LIMIT));
  });

  it.each([
    ["\u00a2", 1], ["\u4e2d", 1], ["\u4e2d", 2],
    ["\u{1f600}", 1], ["\u{1f600}", 2], ["\u{1f600}", 3],
  ] as const)("omits only an incomplete %s suffix at byte %i of the preview boundary", (character, prefixBytes) => {
    const path = join(fakeHome, "multilingual.txt");
    const prefix = "a".repeat(FILE_PREVIEW_LIMIT - prefixBytes);
    const bytes = Buffer.from(`${prefix}${character}tail`);
    writeFileSync(path, bytes);

    const file = new DirectoryService(fakeHome).readFile(path);

    expect(file).toMatchObject({ binary: false, truncated: true, byteCount: bytes.byteLength });
    expect(file.content).toBe(prefix);
  });

  it("does not hide malformed UTF-8 at EOF or inside a truncated prefix", () => {
    const path = join(fakeHome, "malformed.txt");
    writeFileSync(path, Buffer.from([0x61, 0xe4, 0xb8]));
    expect(new DirectoryService(fakeHome).readFile(path)).toMatchObject({ binary: true, truncated: false, content: "" });
    writeFileSync(path, Buffer.concat([Buffer.from([0xc0, 0xaf]), Buffer.alloc(FILE_PREVIEW_LIMIT, 0x61)]));
    expect(new DirectoryService(fakeHome).readFile(path)).toMatchObject({ binary: true, truncated: true, content: "" });
  });

  it("rejects reading a directory or a missing path", () => {
    const service = new DirectoryService(fakeHome);
    expect(() => service.readFile(join(fakeHome, "project"))).toThrow(/not a file/);
    expect(() => service.readFile(join(fakeHome, "missing"))).toThrow(/does not exist/);
  });

  it.each([
    ["ENOENT", 404], ["ENOTDIR", 404], ["EISDIR", 400], ["EACCES", 403], ["EPERM", 403],
    ["EIO", undefined], ["EBADF", undefined],
  ] as const)("classifies %s from the actual file open, not just preflight checks", async (code, status) => {
    const service = new DirectoryService(fakeHome);
    const path = join(fakeHome, "project", "file.txt");
    const failure = Object.assign(new Error("filesystem operation failed"), { code });
    const blobFs = fs as typeof fs & { openAsBlob(path: string): Promise<Blob> };
    const blobOpen = vi.spyOn(blobFs, "openAsBlob");
    for (const read of [
      () => service.readFile(path),
      () => service.readFileBytes(path, { start: 0, end: 0 }),
      () => service.readFileBody(path, null),
    ]) {
      vi.mocked(openSync).mockImplementationOnce(() => { throw failure; });
      blobOpen.mockRejectedValueOnce(failure);
      const result = Promise.resolve().then<unknown>(() => read());
      if (status === undefined) await expect(result).rejects.toBe(failure);
      else await expect(result).rejects.toMatchObject({ status });
      vi.mocked(openSync).mockReset();
      blobOpen.mockReset();
    }
  });

  it.each([
    ["realpath", realpathSync], ["stat", statSync], ["access", accessSync],
  ] as const)("preserves the filesystem error class at the %s boundary", (_name, operation) => {
    const service = new DirectoryService(fakeHome);
    const path = join(fakeHome, "project", "file.txt");
    for (const [code, status] of [["ENOENT", 404], ["ENOTDIR", 404], ["EACCES", 403], ["EPERM", 403], ["EIO", undefined]] as const) {
      const failure = Object.assign(new Error("filesystem operation failed"), { code });
      vi.mocked(operation).mockImplementationOnce(() => { throw failure; });
      let caught: unknown;
      try { service.describeFile(path); } catch (error) { caught = error; }
      if (status === undefined) expect(caught).toBe(failure);
      else expect(caught).toMatchObject({ status });
    }
  });
});
