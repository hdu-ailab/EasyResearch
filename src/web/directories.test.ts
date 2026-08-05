import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { DirectoryService, DirectoryServiceError } from "./directories";

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
});
