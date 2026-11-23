import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { consumeNpmProvenance, inspectNpmInstallation, npmInstallArguments, npmManualCommand, NPM_PROVENANCE_ENV, type NpmProvenance } from "./npm-update-provenance";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function installationFixture(prefixPart = "user prefix's dir") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "npm-update-")));
  roots.push(root);
  const prefix = join(root, prefixPart);
  const metaRoot = join(prefix, "lib/node_modules/easyresearch");
  const platformRoot = join(metaRoot, "node_modules/easyresearch-linux-x64");
  const launcher = join(metaRoot, "launcher.mjs");
  const binary = join(platformRoot, "bin/easyresearch");
  for (const directory of [join(prefix, "bin"), dirname(binary)]) mkdirSync(directory, { recursive: true });
  writeFileSync(launcher, "// fixture");
  writeFileSync(join(metaRoot, "package.json"), JSON.stringify({ name: "easyresearch", version: "1.0.0", bin: { easyresearch: "launcher.mjs" }, optionalDependencies: { "easyresearch-linux-x64": "1.0.0" } }));
  writeFileSync(join(platformRoot, "package.json"), JSON.stringify({ name: "easyresearch-linux-x64", version: "1.0.0" }));
  writeFileSync(binary, "fixture");
  symlinkSync(launcher, join(prefix, "bin/easyresearch"));
  const provenance: NpmProvenance = { schema: 1, metaRoot, launcher, platformManifest: join(platformRoot, "package.json"), binary, nodeExecutable: realpathSync(process.execPath), version: "1.0.0", platform: "linux", arch: "x64" };
  return { root, prefix, provenance };
}

describe("npm installation authority", () => {
  it("preserves a verified non-default prefix and removes the private carrier even on invalid input", () => {
    const f = installationFixture();
    const env = { [NPM_PROVENANCE_ENV]: JSON.stringify(f.provenance) };
    expect(consumeNpmProvenance(env)).toEqual(f.provenance);
    expect(env).not.toHaveProperty(NPM_PROVENANCE_ENV);
    expect(inspectNpmInstallation(f.provenance, "1.0.0")).toMatchObject({ prefix: f.prefix });
    const malformed = { [NPM_PROVENANCE_ENV]: "not-json" };
    expect(consumeNpmProvenance(malformed)).toBeUndefined();
    expect(malformed).not.toHaveProperty(NPM_PROVENANCE_ENV);
  });

  it.each(["project/node_modules/nested", ".npm/_npx/cache", ".volta/tools/image", ".nvm/versions/node/v22"])("refuses ambiguous or manager-owned scope %s", (part) => {
    const f = installationFixture(part);
    expect(() => inspectNpmInstallation(f.provenance, "1.0.0")).toThrow();
  });

  it("refuses escaped platform packages and a changed meta dependency", () => {
    const f = installationFixture();
    const outside = join(f.root, "foreign.json");
    writeFileSync(outside, JSON.stringify({ name: "easyresearch-linux-x64", version: "1.0.0" }));
    expect(() => inspectNpmInstallation({ ...f.provenance, platformManifest: outside }, "1.0.0")).toThrow();
    writeFileSync(join(f.provenance.metaRoot, "package.json"), JSON.stringify({ name: "easyresearch", version: "1.0.0", optionalDependencies: { "easyresearch-linux-x64": "2.0.0" } }));
    expect(() => inspectNpmInstallation(f.provenance, "1.0.0")).toThrow();
  });

  it("refuses a linked platform dependency even when its target stays inside the prefix", () => {
    const f = installationFixture();
    const platform = dirname(f.provenance.platformManifest);
    const linked = join(f.prefix, "lib/node_modules/easyresearch-linux-x64");
    mkdirSync(join(linked, "bin"), { recursive: true });
    writeFileSync(join(linked, "package.json"), JSON.stringify({ name: "easyresearch-linux-x64", version: "1.0.0" }));
    writeFileSync(join(linked, "bin/easyresearch"), "fixture");
    rmSync(platform, { recursive: true }); symlinkSync(linked, platform, "junction");
    expect(() => inspectNpmInstallation({ ...f.provenance, platformManifest: join(linked, "package.json"), binary: join(linked, "bin/easyresearch") }, "1.0.0")).toThrow();
  });

  it.skipIf(process.platform === "win32")("quotes literal prefixes and pins the official exact-version argv", () => {
    const f = installationFixture();
    const command = npmManualCommand(f.prefix, "2.3.4", "linux");
    const parsed = spawnSync("/bin/sh", ["-c", `npm() { printf '%s\\n' "$@"; }; ${command}`], { encoding: "utf8" });
    expect(parsed.status).toBe(0);
    expect(parsed.stdout.trimEnd().split("\n")).toEqual([
      "install", "--global", "--prefix", f.prefix, "easyresearch@2.3.4", "--registry=https://registry.npmjs.org/", "--ignore-scripts", "--include=optional", "--no-audit", "--no-fund",
    ]);
    expect(npmManualCommand(undefined, "2.3.4", "linux")).toBeUndefined();
    expect(() => npmInstallArguments(f.prefix, "latest; touch /tmp/unsafe")).toThrow();
  });
  it("quotes Windows prefixes for PowerShell without expanding special characters", () => {
    expect(npmManualCommand("C:\\Users\\O'Brien\\$npm", "2.3.4", "win32")).toContain("'C:\\Users\\O''Brien\\$npm'");
    expect(npmManualCommand(undefined, "2.3.4", "win32")).toBeUndefined();
  });
  it("offers a manual latest-tag command when registry discovery failed without admitting an automatic tag install", () => {
    expect(npmManualCommand("/home/user/npm", "latest", "linux")).toContain("easyresearch@latest --registry=https://registry.npmjs.org/");
    expect(() => npmInstallArguments("/home/user/npm", "latest")).toThrow();
  });
});
