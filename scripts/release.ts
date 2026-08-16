#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TARGETS,
  type BuildArtifact,
  type BuildManifest,
  buildManifestPath,
  buildTargets,
  platformBinaryName,
  platformPackageDir,
  releaseDir,
  repoPackageVersion,
} from "./build";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAIN_PACKAGE = "easyresearch";
export const NPM_REGISTRY = "https://registry.npmjs.org/";

export interface CliFlags {
  dryRun: boolean;
  only?: string;
  skipBuild?: boolean;
}

export function parseFlags(args = process.argv.slice(2)): CliFlags {
  const flags: CliFlags = { dryRun: false, skipBuild: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--skip-build") flags.skipBuild = true;
    else if (arg === "--only") {
      const target = args[index + 1];
      if (!target || target.startsWith("--")) throw new Error("--only requires a target");
      if (!TARGETS.some((candidate) => candidate.name === target)) throw new Error(`unknown target: ${target}`);
      flags.only = target;
      index += 1;
    } else {
      throw new Error(`unknown release flag: ${arg}`);
    }
  }
  return flags;
}

function requireNpmAuth(): void {
  const result = spawnSync("npm", ["whoami", `--registry=${NPM_REGISTRY}`], { encoding: "utf8" });
  if (result.status !== 0) {
    console.error("[release] Not logged in to npm. Run `npm login` first.");
    process.exit(1);
  }
  console.log(`[release] Publishing as ${(result.stdout ?? "").trim()}`);
}

async function publishPackage(dir: string, name: string, version: string, dryRun: boolean): Promise<void> {
  if (dryRun) {
    console.log(`[release] DRY RUN: validated ${name}@${version}`);
    return;
  }
  if (!dryRun && isAlreadyPublished(name, version)) {
    console.log(`[release] ${name}@${version} already published, skipping`);
    return;
  }
  const args = ["publish", `--registry=${NPM_REGISTRY}`];
  if (process.env.GITHUB_ACTIONS === "true") args.push("--provenance");
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    console.log(`[release] publishing ${name} (attempt ${attempt})…`);
    const result = spawnSync("npm", args, { cwd: dir, stdio: ["inherit", "inherit", "pipe"], encoding: "utf8" });
    if (result.status === 0) return;
    const stderr = (result.stderr ?? "").toLowerCase();
    const rateLimited = stderr.includes("e429") || stderr.includes("rate limit");
    if (!rateLimited || attempt === 6) process.exit(result.status ?? 1);
    const waitSec = 60 * attempt;
    console.log(`[release] npm rate limited; retrying ${name} in ${waitSec}s…`);
    await new Promise((resolve) => setTimeout(resolve, waitSec * 1000));
  }
}

export function isAlreadyPublished(name: string, version: string): boolean {
  const result = spawnSync("npm", ["view", `${name}@${version}`, "version", `--registry=${NPM_REGISTRY}`], { encoding: "utf8" });
  return result.status === 0 && (result.stdout ?? "").trim() === version;
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function platformPackageManifest(target: (typeof TARGETS)[number], version: string): Record<string, unknown> {
  const binaryName = platformBinaryName(target);
  return {
    name: `easyresearch-${target.name}`,
    version,
    description: `EasyResearch CLI binary for ${target.name} (installed automatically by the easyresearch meta package)`,
    license: "MIT",
    preferUnplugged: true,
    os: target.os,
    cpu: target.cpu,
    ...(target.os.includes("linux") ? { libc: ["glibc"] } : {}),
    files: [`bin/${binaryName}`, "README.md", "LICENSE"],
    publishConfig: { registry: NPM_REGISTRY },
  };
}

export function assemblePlatformPackage(targetName: string, version: string): void {
  const target = TARGETS.find((t) => t.name === targetName);
  if (!target) throw new Error(`unknown target: ${targetName}`);
  const pkgDir = platformPackageDir(targetName);
  const binPath = join(pkgDir, "bin", platformBinaryName(target));
  if (!existsSync(binPath)) throw new Error(`missing binary for ${targetName}: ${binPath}`);
  writeJson(join(pkgDir, "package.json"), platformPackageManifest(target, version));
  cpSync(join(ROOT, "LICENSE"), join(pkgDir, "LICENSE"));
  writeFileSync(join(pkgDir, "README.md"), NPM_README);
  chmodSync(binPath, 0o755);
}

const NPM_README = `# easyresearch

Automated academic paper writing CLI with a local web panel.

\`\`\`sh
npm install -g easyresearch
easyresearch
\`\`\`

Self-contained binary per platform (no Bun/Node required). On first run it
creates a local Python venv (\`markitdown\`, \`arxiv\`) and extracts bundled
agents/skills — watch the terminal for progress. Requires Python 3 on PATH
for PDF conversion and arXiv SDK features; everything else works without it.

\`\`\`sh
easyresearch          # start the web panel at http://127.0.0.1:3000
easyresearch exit     # stop the background service
easyresearch --version
\`\`\`

Skip first-run setup with \`EASYRESEARCH_SKIP_SETUP=1\`.

## Supported platforms

linux-x64, darwin-arm64, windows-x64. On other platforms the install fails
with a clear message — build from source instead:

\`\`\`sh
git clone https://github.com/hdu-ailab/EasyResearch.git
cd EasyResearch
bun install
bun run build:release -- --only <target>   # e.g. linux-arm64
# binary at release/easyresearch-<target>/bin/easyresearch
\`\`\`

See \`scripts/build.ts\` \`TARGETS\` for valid <target> names.
`;

export function mainPackageManifest(version: string): Record<string, unknown> {
  return {
    name: MAIN_PACKAGE,
    version,
    description: "Automated academic paper writing CLI built on the Pi agent harness",
    license: "MIT",
    repository: { type: "git", url: "https://github.com/hdu-ailab/EasyResearch.git" },
    keywords: ["research", "paper-writing", "cli", "ai", "latex"],
    files: ["launcher.mjs", "README.md", "LICENSE"],
    bin: { easyresearch: "./launcher.mjs" },
    optionalDependencies: Object.fromEntries(TARGETS.map((target) => [`easyresearch-${target.name}`, version])),
    publishConfig: { registry: NPM_REGISTRY },
  };
}

export function assembleMainPackage(version: string): void {
  const pkgDir = join(releaseDir(), MAIN_PACKAGE);
  rmSync(pkgDir, { recursive: true, force: true });
  mkdirSync(pkgDir, { recursive: true });
  writeJson(join(pkgDir, "package.json"), mainPackageManifest(version));
  cpSync(join(ROOT, "launcher.mjs"), join(pkgDir, "launcher.mjs"));
  cpSync(join(ROOT, "LICENSE"), join(pkgDir, "LICENSE"));
  writeFileSync(join(pkgDir, "README.md"), NPM_README);
}

export function validateBuildArtifact(
  record: BuildArtifact | Record<string, unknown>,
  target: (typeof TARGETS)[number],
  version: string,
  binary: string,
): void {
  if (record.version !== version) throw new Error(`build manifest version mismatch for ${target.name}`);
  if (record.target !== target.name) throw new Error(`build manifest target mismatch for ${target.name}`);
  if (record.binaryName !== platformBinaryName(target)) throw new Error(`build manifest binary mismatch for ${target.name}`);
  if (!existsSync(binary)) throw new Error(`missing binary for ${target.name}: ${binary}`);
  if (record.size !== statSync(binary).size) throw new Error(`build manifest size mismatch for ${target.name}`);
  const actualHash = createHash("sha256").update(readFileSync(binary)).digest("hex");
  if (record.sha256 !== actualHash) throw new Error(`build manifest SHA-256 mismatch for ${target.name}`);
}

export function validateBuildArtifacts(targets: readonly (typeof TARGETS)[number][], version: string): void {
  let manifest: BuildManifest;
  try {
    manifest = JSON.parse(readFileSync(buildManifestPath(), "utf8")) as BuildManifest;
  } catch {
    throw new Error("missing or invalid build manifest; drop --skip-build and rebuild");
  }
  if (manifest.version !== version || !Array.isArray(manifest.artifacts)) {
    throw new Error("build manifest does not match the current package version");
  }
  for (const target of targets) {
    const record = manifest.artifacts.find((artifact) => artifact.target === target.name);
    if (!record) throw new Error(`build manifest has no artifact for ${target.name}`);
    validateBuildArtifact(
      record,
      target,
      version,
      join(platformPackageDir(target.name), "bin", platformBinaryName(target)),
    );
    if (target.name === currentNativeTarget()) {
      const binary = join(platformPackageDir(target.name), "bin", platformBinaryName(target));
      const smoke = spawnSync(binary, ["--version"], { encoding: "utf8" });
      validateNativeVersionOutput(smoke.status, smoke.stdout ?? "", version, target.name);
    }
  }
}

export function validateNativeVersionOutput(
  status: number | null,
  stdout: string,
  version: string,
  target: string,
  stderr = "",
): void {
  const expected = `easyresearch ${version}`;
  const lines = `${stdout}\n${stderr}`.split(/\r?\n/).map((line) => line.trim());
  if (status !== 0 || !lines.includes(expected)) {
    throw new Error(
      `native version smoke failed for ${target}: expected ${expected}; stdout=${JSON.stringify(stdout)}; stderr=${JSON.stringify(stderr)}`,
    );
  }
}

function currentNativeTarget(): string | undefined {
  if (process.arch !== "x64" && process.arch !== "arm64") return undefined;
  const platform = process.platform === "win32" ? "windows" : process.platform;
  return TARGETS.some((target) => target.name === `${platform}-${process.arch}`)
    ? `${platform}-${process.arch}`
    : undefined;
}

function validatePackedPackage(dir: string): void {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json", `--registry=${NPM_REGISTRY}`], {
    cwd: dir,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`npm pack validation failed for ${dir}: ${(result.stderr ?? "").trim()}`);
  const paths = packedPaths(result.stdout || "[]");
  for (const required of ["package.json", "README.md", "LICENSE"]) {
    if (!paths.has(required)) throw new Error(`npm pack omitted ${required} for ${dir}`);
  }
}

export function packedPaths(output: string): Set<string> {
  const parsed = JSON.parse(output) as
    | Array<{ files?: Array<{ path: string }> }>
    | Record<string, { files?: Array<{ path: string }> }>;
  const report = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  return new Set(report?.files?.map((file) => file.path));
}

async function waitForAllPlatformPackages(version: string): Promise<void> {
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const missing = TARGETS.filter((target) => !isAlreadyPublished(`easyresearch-${target.name}`, version));
    if (missing.length === 0) return;
    if (attempt === 6) throw new Error(`meta publication blocked; registry is missing ${missing.map((target) => `easyresearch-${target.name}@${version}`).join(", ")}`);
    await new Promise((resolve) => setTimeout(resolve, attempt * 10_000));
  }
}

export async function main(): Promise<void> {
  const flags = parseFlags();
  const version = repoPackageVersion();
  const targets = TARGETS.filter((t) => flags.only === undefined || t.name === flags.only);
  const mainPublished = !flags.dryRun && isAlreadyPublished(MAIN_PACKAGE, version);
  const missing = flags.dryRun ? targets : targets.filter((t) => !isAlreadyPublished(`easyresearch-${t.name}`, version));
  const skipCount = targets.length - missing.length;
  if (skipCount > 0) console.log(`[release] skipping ${skipCount} already-published platform package(s)`);

  if (missing.length === 0 && mainPublished) {
    console.log(`[release] ${MAIN_PACKAGE}@${version} and all platform packages already published`);
    return;
  }

  if (!flags.skipBuild) {
    if (missing.length > 0) {
      console.log(`[release] building ${missing.length} target(s) for easyresearch@${version}`);
      await buildTargets(flags.only, missing.map((t) => t.name));
    } else {
      console.log("[release] no platform packages to build");
    }
  }
  if (missing.length > 0) validateBuildArtifacts(missing, version);

  if (!flags.dryRun) requireNpmAuth();

  for (const t of missing) {
    assemblePlatformPackage(t.name, version);
    validatePackedPackage(platformPackageDir(t.name));
    await publishPackage(platformPackageDir(t.name), `easyresearch-${t.name}`, version, flags.dryRun);
  }

  if (!mainPublished) {
    if (!flags.dryRun) await waitForAllPlatformPackages(version);
    assembleMainPackage(version);
    validatePackedPackage(join(releaseDir(), MAIN_PACKAGE));
    await publishPackage(join(releaseDir(), MAIN_PACKAGE), MAIN_PACKAGE, version, flags.dryRun);
  } else {
    console.log(`[release] ${MAIN_PACKAGE}@${version} already published, skipping`);
  }
  console.log(`[release] done${flags.dryRun ? " (dry run)" : ""}`);
}

if (import.meta.main) await main();
