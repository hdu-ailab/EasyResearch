#!/usr/bin/env bun
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  THIRD_PARTY_NOTICES_FILE,
  generateThirdPartyNotices,
} from "./third-party-notices";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GENERATED_MODULE = join(ROOT, "src", "generated", "embedded-assets.ts");

export interface PlatformTarget {
  /** Package suffix after `easyresearch-`, e.g. `linux-x64`. */
  name: string;
  /** Bun compile target, e.g. `bun-linux-x64`. */
  target: string;
  os: string[];
  cpu: string[];
}

export interface BuildArtifact {
  version: string;
  target: string;
  binaryName: string;
  size: number;
  sha256: string;
  builtAt: string;
}

export interface BuildManifest {
  version: string;
  artifacts: BuildArtifact[];
}

/**
 * Shipped platform targets (ADR-070 amended): the common desktop/server
 * platforms only — linux x64, windows x64, darwin arm64. Other targets can
 * be re-added to this list and rebuilt at any time.
 */
export const TARGETS: PlatformTarget[] = [
  { name: "linux-x64", target: "bun-linux-x64", os: ["linux"], cpu: ["x64"] },
  { name: "darwin-arm64", target: "bun-darwin-arm64", os: ["darwin"], cpu: ["arm64"] },
  { name: "windows-x64", target: "bun-windows-x64", os: ["win32"], cpu: ["x64"] },
];

export function releaseDir(): string {
  return join(ROOT, "release");
}

export function buildManifestPath(targetName?: string): string {
  return join(releaseDir(), targetName ? `build-manifest-${targetName}.json` : "build-manifest.json");
}

export function platformPackageDir(targetName: string): string {
  return join(releaseDir(), `easyresearch-${targetName}`);
}

export function platformBinaryName(target: PlatformTarget): string {
  return target.os[0] === "win32" ? "easyresearch.exe" : "easyresearch";
}

export function repoPackageVersion(): string {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };
  return pkg.version;
}

function collectFiles(root: string, prefix: string): string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__pycache__" || entry.name === ".venv" || entry.name === "node_modules") continue;
        visit(abs);
      } else if (entry.isFile()) {
        const rel = (prefix + abs.slice(root.length + 1)).replaceAll("\\", "/");
        if (rel.endsWith(".pyc") || rel.includes(".test.") || rel.endsWith(".DS_Store")) continue;
        files.push(rel);
      }
    }
  };
  if (existsSync(root)) visit(root);
  return files.sort();
}

/**
 * Enumerate every file shipped inside the standalone binary: web UI bundle,
 * bundled agents/skills, and pi's runtime assets (package.json, README, themes).
 * The materialized `pi/package.json` is EasyResearch's own: pi reads
 * `piConfig.configDir` (`.easyresearch`) from it to keep the native identity.
 *
 * `includeWebUi` is true only during compilation: the committed module must
 * not reference `webui/dist` (gitignored; missing on fresh checkouts would
 * break direct `bun` imports in tests). Dev mode falls back to the disk tree.
 */
export function collectEmbeddedAssets(includeWebUi = false): string[] {
  const piPkg = join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent");
  const photonPkg = join(ROOT, "node_modules", "@silvia-odwyer", "photon-node");
  return [
    ...(includeWebUi ? collectFiles(join(ROOT, "src", "webui", "dist"), "webui/dist/") : []),
    ...collectFiles(join(ROOT, "src", "agents"), "agents/").filter((rel) => rel.endsWith(".md")),
    ...collectFiles(join(ROOT, "src", "skills"), "skills/"),
    ...["pi/package.json", "pi/README.md", "pi/CHANGELOG.md"],
    ...collectFiles(join(piPkg, "dist", "modes", "interactive", "theme"), "pi/theme/").filter((rel) =>
      rel.endsWith(".json"),
    ),
    ...collectFiles(join(piPkg, "dist", "modes", "interactive", "assets"), "pi/assets/").filter((rel) =>
      rel.endsWith(".png"),
    ),
    ...collectFiles(join(piPkg, "dist", "core", "export-html"), "pi/export-html/").filter((rel) =>
      rel === "pi/export-html/template.html"
      || rel === "pi/export-html/template.css"
      || rel === "pi/export-html/template.js"
      || (rel.startsWith("pi/export-html/vendor/") && rel.endsWith(".js")),
    ),
    ...collectFiles(join(piPkg, "docs"), "pi/docs/"),
    ...collectFiles(join(piPkg, "examples"), "pi/examples/"),
    ...(existsSync(join(photonPkg, "photon_rs_bg.wasm")) ? ["pi/photon_rs_bg.wasm"] : []),
  ];
}

/**
 * Regenerate src/generated/embedded-assets.ts. The module uses `with { type:
 * "file" }` imports so the bundler embeds each asset into compiled binaries;
 * running from source the same imports resolve to real disk paths. A
 * `@ts-nocheck` header keeps tsc happy about non-TS module imports.
 *
 * `includeWebUi` toggles `webui/dist` entries: true only while compiling (the
 * binary must embed the UI); the committed/restored state excludes them so
 * fresh checkouts (no gitignored dist) stay importable.
 */
export async function generateEmbeddedAssetsModule(includeWebUi = true): Promise<string[]> {
  const rels = collectEmbeddedAssets(includeWebUi);
  const content = renderEmbeddedAssetsModule(rels, repoPackageVersion());
  if (readFileSync(GENERATED_MODULE, "utf8") !== content) writeFileSync(GENERATED_MODULE, content);
  return rels;
}

export function renderEmbeddedAssetsModule(rels: string[], version: string): string {
  const lines: string[] = [
    "// @ts-nocheck",
    "// Generated by scripts/build.ts — do not edit.",
    "// Embedded file map keyed by repo-relative path; empty in fresh checkouts (dev falls back to disk).",
  ];
  rels.forEach((rel, index) => {
    lines.push(`import _e${index} from ${JSON.stringify(moduleRelative(rel))} with { type: "file" };`);
  });
  lines.push("");
  lines.push("export const embeddedFiles: Record<string, string> = {");
  rels.forEach((rel, index) => {
    lines.push(`  ${JSON.stringify(rel)}: _e${index},`);
  });
  lines.push("};");
  lines.push("");
  lines.push(`export const embeddedVersion = ${JSON.stringify(version)};`);
  lines.push("");
  return lines.join("\n");
}

function moduleRelative(rel: string): string {
  if (rel === "pi/package.json") {
    return "../../package.json";
  }
  if (rel === "pi/README.md") {
    return `../../node_modules/@earendil-works/pi-coding-agent/README.md`;
  }
  if (rel === "pi/CHANGELOG.md") {
    return `../../node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md`;
  }
  if (rel.startsWith("pi/theme/")) {
    return `../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/${rel.slice(
      "pi/theme/".length,
    )}`;
  }
  if (rel.startsWith("pi/assets/")) {
    return `../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/assets/${rel.slice("pi/assets/".length)}`;
  }
  if (rel.startsWith("pi/export-html/")) {
    return `../../node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/${rel.slice("pi/export-html/".length)}`;
  }
  if (rel.startsWith("pi/docs/")) {
    return `../../node_modules/@earendil-works/pi-coding-agent/docs/${rel.slice("pi/docs/".length)}`;
  }
  if (rel.startsWith("pi/examples/")) {
    return `../../node_modules/@earendil-works/pi-coding-agent/examples/${rel.slice("pi/examples/".length)}`;
  }
  if (rel === "pi/photon_rs_bg.wasm") {
    return "../../node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm";
  }
  return `../${rel}`;
}

export async function buildWebUi(): Promise<void> {
  const { build } = await import("vite");
  await build({ configFile: join(ROOT, "src", "webui", "vite.config.ts"), logLevel: "info" });
}

export function compileCommand(
  target: PlatformTarget,
  outfile: string,
  bunExecutable = process.execPath,
): string[] {
  return [
    bunExecutable,
    "build",
    join(ROOT, "src", "cli", "index.ts"),
    "--compile",
    "--target",
    target.target,
    "--outfile",
    outfile,
    "--external",
    "cpu-features",
    "--minify",
  ];
}

export async function compileTarget(target: PlatformTarget): Promise<string> {
  const pkgDir = platformPackageDir(target.name);
  const binDir = join(pkgDir, "bin");
  mkdirSync(binDir, { recursive: true });
  const outfile = join(binDir, platformBinaryName(target));
  // Native testing under the former Bun 1.3.14 pin found that
  // `Bun.build({ compile })` emitted inert Windows executables. Keep the proven
  // `bun build --compile` CLI path until every target validates an API change.
  const result = Bun.spawnSync({
    cmd: compileCommand(target, outfile),
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    throw new Error(`compile failed for ${target.name} (exit ${result.exitCode})`);
  }
  return outfile;
}

export async function buildTargets(only?: string, prefer?: string[]): Promise<PlatformTarget[]> {
  const targets = selectBuildTargets(only, prefer);
  const developmentStub = readFileSync(GENERATED_MODULE, "utf8");
  rmSync(buildManifestPath(), { force: true });
  if (only) rmSync(buildManifestPath(only), { force: true });
  const thirdPartyNotices = generateThirdPartyNotices(ROOT);
  for (const target of targets) {
    const packageDir = platformPackageDir(target.name);
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, THIRD_PARTY_NOTICES_FILE), thirdPartyNotices, "utf8");
  }
  await buildWebUi();
  try {
    await generateEmbeddedAssetsModule(true);
    const artifacts: BuildArtifact[] = [];
    for (const target of targets) {
      console.log(`[build] compiling ${target.name} (${target.target})…`);
      const outfile = await compileTarget(target);
      const size = statSync(outfile).size;
      artifacts.push({
        version: repoPackageVersion(),
        target: target.name,
        binaryName: platformBinaryName(target),
        size,
        sha256: createHash("sha256").update(readFileSync(outfile)).digest("hex"),
        builtAt: new Date().toISOString(),
      });
      console.log(`[build] ${target.name} -> ${outfile} (${(size / 1024 / 1024).toFixed(1)} MiB)`);
    }
    mkdirSync(releaseDir(), { recursive: true });
    writeFileSync(
      buildManifestPath(only),
      `${JSON.stringify({ version: repoPackageVersion(), artifacts }, null, 2)}\n`,
    );
    return targets;
  } finally {
    writeFileSync(GENERATED_MODULE, developmentStub);
  }
}

export function selectBuildTargets(only?: string, prefer?: string[]): PlatformTarget[] {
  if (only !== undefined && !TARGETS.some((target) => target.name === only)) {
    throw new Error(`unknown target: ${only}`);
  }
  const targets = TARGETS.filter(
    (t) => (only === undefined || t.name === only) && (prefer === undefined || prefer.includes(t.name)),
  );
  if (targets.length === 0) throw new Error("no build targets selected");
  return targets;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const onlyIndex = args.indexOf("--only");
  const only = onlyIndex >= 0 ? args[onlyIndex + 1] : undefined;
  await buildTargets(only);
}
