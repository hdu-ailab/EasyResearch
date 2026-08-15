import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bundledFilePath,
  bundledVersionMarker,
  isEmbeddedBuild,
  listBundledAssets,
  writeBundledFiles,
} from "./bundled-assets";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("dev-mode source fallback", () => {
  it("reports non-embedded build", () => {
    expect(isEmbeddedBuild()).toBe(false);
  });

  it("resolves existing repo assets from disk and undefined for missing ones", () => {
    expect(bundledFilePath("agents/paper-assistant.md")).toBeDefined();
    expect(bundledFilePath("agents/does-not-exist.md")).toBeUndefined();
  });

  it("lists bundled assets by repo-relative prefix", () => {
    const agents = listBundledAssets("agents/");
    expect(agents).toContain("agents/paper-assistant.md");
    expect(agents.length).toBeGreaterThan(1);
    expect(listBundledAssets("skills/").length).toBeGreaterThan(1);
  });
});

describe("writeBundledFiles", () => {
  it("writes files, nested dirs, and the version marker", () => {
    const root = mkdtempSync(join(tmpdir(), "bundled-"));
    tempDirs.push(root);
    writeBundledFiles(root, { "agents/a.md": "# a", "skills/s/SKILL.md": "# skill" }, "1.0.0", () => {});
    expect(readFileSync(join(root, "agents", "a.md"), "utf8")).toBe("# a");
    expect(readFileSync(join(root, "skills", "s", "SKILL.md"), "utf8")).toBe("# skill");
    expect(readFileSync(bundledVersionMarker(root), "utf8")).toBe("1.0.0");
  });

  it("is idempotent: same version skips rewrite but files remain", () => {
    const root = mkdtempSync(join(tmpdir(), "bundled-"));
    tempDirs.push(root);
    writeBundledFiles(root, { "agents/a.md": "# a" }, "1.0.0", () => {});
    writeBundledFiles(root, { "agents/a.md": "# a" }, "1.0.0", () => {});
    expect(existsSync(join(root, "agents", "a.md"))).toBe(true);
    expect(readFileSync(bundledVersionMarker(root), "utf8")).toBe("1.0.0");
  });

  it("rewrites when the version marker changes", () => {
    const root = mkdtempSync(join(tmpdir(), "bundled-"));
    tempDirs.push(root);
    writeBundledFiles(root, { "agents/a.md": "# v1" }, "1.0.0", () => {});
    writeBundledFiles(root, { "agents/a.md": "# v2" }, "2.0.0", () => {});
    expect(readFileSync(join(root, "agents", "a.md"), "utf8")).toBe("# v2");
    expect(readFileSync(bundledVersionMarker(root), "utf8")).toBe("2.0.0");
  });
});
