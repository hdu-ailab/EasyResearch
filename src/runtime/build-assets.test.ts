import { describe, expect, it } from "vitest";
import * as build from "../../scripts/build";

describe("release asset collection", () => {
  it("includes the complete Pi runtime asset families without extension sources", () => {
    const assets = build.collectEmbeddedAssets(false);
    expect(assets).toContain("pi/package.json");
    expect(assets).toContain("pi/README.md");
    expect(assets).toContain("pi/CHANGELOG.md");
    expect(assets.some((rel) => rel.startsWith("pi/theme/") && rel.endsWith(".json"))).toBe(true);
    expect(assets.some((rel) => rel.startsWith("pi/assets/") && rel.endsWith(".png"))).toBe(true);
    expect(assets).toContain("pi/export-html/template.html");
    expect(assets).toContain("pi/export-html/template.css");
    expect(assets).toContain("pi/export-html/template.js");
    expect(assets.some((rel) => rel.startsWith("pi/export-html/vendor/") && rel.endsWith(".js"))).toBe(true);
    expect(assets.some((rel) => rel.startsWith("pi/docs/"))).toBe(true);
    expect(assets.some((rel) => rel.startsWith("pi/examples/"))).toBe(true);
    expect(assets).toContain("pi/photon_rs_bg.wasm");
    expect(assets.some((rel) => rel.startsWith("extensions/"))).toBe(false);
    expect(assets.some((rel) => rel.includes(".test."))).toBe(false);
  });

  it("rejects an unknown target before building", () => {
    const selectBuildTargets = (build as typeof build & {
      selectBuildTargets(only?: string, prefer?: string[]): typeof build.TARGETS;
    }).selectBuildTargets;
    expect(() => selectBuildTargets("not-a-target")).toThrow("unknown target");
  });

  it("renders only the embedded file map and version", () => {
    const renderEmbeddedAssetsModule = (build as typeof build & {
      renderEmbeddedAssetsModule(assets: string[], version: string): string;
    }).renderEmbeddedAssetsModule;
    const rendered = renderEmbeddedAssetsModule(["agents/paper-assistant.md"], "1.2.3");
    expect(rendered).toContain("embeddedFiles");
    expect(rendered).toContain('embeddedVersion = "1.2.3"');
    expect(rendered).not.toContain("extensionSourceFiles");
  });
});
