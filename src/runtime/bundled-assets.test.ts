import { existsSync, readFileSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
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
    expect(bundledFilePath("agents/research-assistant.md")).toBeDefined();
    expect(bundledFilePath("agents/review.md")).toBeDefined();
    expect(bundledFilePath("skills/specialist-handoff/SKILL.md")).toBeDefined();
    expect(bundledFilePath("skills/peer-review/SKILL.md")).toBeDefined();
    expect(bundledFilePath("agents/paper-assistant.md")).toBeUndefined();
    expect(bundledFilePath("agents/does-not-exist.md")).toBeUndefined();
  });

  it("lists bundled assets by repo-relative prefix", () => {
    const agents = listBundledAssets("agents/");
    expect(agents).toContain("agents/research-assistant.md");
    expect(agents).not.toContain("agents/paper-assistant.md");
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

  it("repairs an incomplete tree even when its version marker matches", () => {
    const root = mkdtempSync(join(tmpdir(), "bundled-"));
    tempDirs.push(root);
    const files = { "agents/a.md": "# a", "skills/s/SKILL.md": "# skill" };
    writeBundledFiles(root, files, "1.0.0", () => {});
    unlinkSync(join(root, "skills", "s", "SKILL.md"));

    writeBundledFiles(root, files, "1.0.0", () => {});

    expect(readFileSync(join(root, "skills", "s", "SKILL.md"), "utf8")).toBe("# skill");
  });

  it("rewrites when the version marker changes", () => {
    const root = mkdtempSync(join(tmpdir(), "bundled-"));
    tempDirs.push(root);
    writeBundledFiles(root, { "agents/a.md": "# v1" }, "1.0.0", () => {});
    writeBundledFiles(root, { "agents/a.md": "# v2" }, "2.0.0", () => {});
    expect(readFileSync(join(root, "agents", "a.md"), "utf8")).toBe("# v2");
    expect(readFileSync(bundledVersionMarker(root), "utf8")).toBe("2.0.0");
  });

  it("preserves the previous valid tree when staging the replacement fails", () => {
    const root = mkdtempSync(join(tmpdir(), "bundled-"));
    tempDirs.push(root);
    writeBundledFiles(root, { "agents/a.md": "# stable" }, "1.0.0", () => {});

    expect(() => writeBundledFiles(root, {
      "agents/a.md": "# replacement",
      "agents/a.md/child": "cannot be nested below a file",
    }, "2.0.0", () => {})).toThrow();

    expect(readFileSync(join(root, "agents", "a.md"), "utf8")).toBe("# stable");
    expect(readFileSync(bundledVersionMarker(root), "utf8")).toBe("1.0.0");
  });

  it("preserves arbitrary bytes", () => {
    const root = mkdtempSync(join(tmpdir(), "bundled-"));
    tempDirs.push(root);
    const bytes = Buffer.from([0x00, 0xff, 0x89, 0x50, 0x4e, 0x47]);
    writeBundledFiles(root, { "assets/image.bin": bytes }, "1.0.0", () => {});
    expect(readFileSync(join(root, "assets", "image.bin"))).toEqual(bytes);
  });
});
