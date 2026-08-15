#!/usr/bin/env bun
import { chmodSync, cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import {
  TARGETS,
  buildTargets,
  platformBinaryName,
  platformPackageDir,
  releaseDir,
  repoPackageVersion,
} from "./build";

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const MAIN_PACKAGE = "easyresearch";

interface CliFlags {
  dryRun: boolean;
  only?: string;
  skipBuild?: boolean;
}

function parseFlags(): CliFlags {
  const args = process.argv.slice(2);
  const flags: CliFlags = { dryRun: args.includes("--dry-run"), skipBuild: args.includes("--skip-build") };
  const onlyIndex = args.indexOf("--only");
  if (onlyIndex >= 0) flags.only = args[onlyIndex + 1];
  return flags;
}

function requireNpmAuth(): void {
  const result = spawnSync("npm", ["whoami"], { encoding: "utf8" });
  if (result.status !== 0) {
    console.error("[release] Not logged in to npm. Run `npm login` first.");
    process.exit(1);
  }
  console.log(`[release] Publishing as ${(result.stdout ?? "").trim()}`);
}

async function publishPackage(dir: string, name: string, version: string, dryRun: boolean): Promise<void> {
  if (!dryRun && isAlreadyPublished(name, version)) {
    console.log(`[release] ${name}@${version} already published, skipping`);
    return;
  }
  const args = ["publish"];
  if (dryRun) args.push("--dry-run");
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    console.log(`[release] ${dryRun ? "DRY RUN: " : ""}publishing ${name} (attempt ${attempt})…`);
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

function isAlreadyPublished(name: string, version: string): boolean {
  const result = spawnSync("npm", ["view", `${name}@${version}`, "version"], { encoding: "utf8" });
  return result.status === 0 && (result.stdout ?? "").trim() === version;
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function assemblePlatformPackage(targetName: string, version: string): void {
  const target = TARGETS.find((t) => t.name === targetName);
  if (!target) throw new Error(`unknown target: ${targetName}`);
  const pkgDir = platformPackageDir(targetName);
  const binPath = join(pkgDir, "bin", platformBinaryName(target));
  if (!existsSync(binPath)) throw new Error(`missing binary for ${targetName}: ${binPath}`);
  writeJson(join(pkgDir, "package.json"), {
    name: `easyresearch-${targetName}`,
    version,
    description: `EasyResearch CLI binary for ${targetName} (installed automatically by the easyresearch meta package)`,
    license: "MIT",
    preferUnplugged: true,
    os: target.os,
    cpu: target.cpu,
    bin: { easyresearch: `./bin/${platformBinaryName(target)}` },
  });
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
`;

const BIN_STUB = `#!/bin/sh
# Placeholder replaced by postinstall.mjs with the platform binary.
echo "easyresearch: platform binary not installed. Run: npm rebuild easyresearch" >&2
exit 1
`;

function assembleMainPackage(version: string, targets: string[]): void {
  const pkgDir = join(releaseDir(), MAIN_PACKAGE);
  const binDir = join(pkgDir, "bin");
  mkdirSync(binDir, { recursive: true });
  writeJson(join(pkgDir, "package.json"), {
    name: MAIN_PACKAGE,
    version,
    description: "Automated academic paper writing CLI built on the Pi agent harness",
    license: "MIT",
    repository: { type: "git", url: "https://github.com/hdu-ailab/EasyResearch.git" },
    keywords: ["research", "paper-writing", "cli", "ai", "latex"],
    bin: { easyresearch: "./bin/easyresearch.exe" },
    scripts: { postinstall: "node ./postinstall.mjs" },
    optionalDependencies: Object.fromEntries(targets.map((name) => [`easyresearch-${name}`, version])),
  });
  cpSync(join(ROOT, "postinstall.mjs"), join(pkgDir, "postinstall.mjs"));
  cpSync(join(ROOT, "LICENSE"), join(pkgDir, "LICENSE"));
  const stubPath = join(binDir, "easyresearch.exe");
  writeFileSync(stubPath, BIN_STUB);
  chmodSync(stubPath, 0o755);
  writeFileSync(join(pkgDir, "README.md"), NPM_README);
}

async function main(): Promise<void> {
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
  } else {
    for (const t of targets) {
      if (!existsSync(join(platformPackageDir(t.name), "bin", platformBinaryName(t)))) {
        console.error(`[release] missing binary for ${t.name}; drop --skip-build`);
        process.exit(1);
      }
    }
  }

  if (!flags.dryRun) requireNpmAuth();

  for (const t of missing) {
    assemblePlatformPackage(t.name, version);
    await publishPackage(platformPackageDir(t.name), `easyresearch-${t.name}`, version, flags.dryRun);
  }

  if (!mainPublished) {
    assembleMainPackage(version, targets.map((t) => t.name));
    await publishPackage(join(releaseDir(), MAIN_PACKAGE), MAIN_PACKAGE, version, flags.dryRun);
  } else {
    console.log(`[release] ${MAIN_PACKAGE}@${version} already published, skipping`);
  }
  console.log(`[release] done${flags.dryRun ? " (dry run)" : ""}`);
}

await main();
