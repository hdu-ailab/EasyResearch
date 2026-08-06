import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { DirectoryService, DirectoryServiceError, FILE_PREVIEW_LIMIT } from "./directories";

let fakeHome: string;

beforeEach(() => {
  fakeHome = join(tmpdir(), `lazyresearch-dirs-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(fakeHome, "project", "a-dir"), { recursive: true });
  mkdirSync(join(fakeHome, "project", "z-dir"), { recursive: true });
  mkdirSync(join(fakeHome, "empty"), { recursive: true });
  writeFileSync(join(fakeHome, "project", "file.txt"), "x");
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

  it("rejects reading a directory or a missing path", () => {
    const service = new DirectoryService(fakeHome);
    expect(() => service.readFile(join(fakeHome, "project"))).toThrow(/not a file/);
    expect(() => service.readFile(join(fakeHome, "missing"))).toThrow(/does not exist/);
  });
});
