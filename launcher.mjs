#!/usr/bin/env node
// Runtime launcher for the `easyresearch` meta package.
// Resolves the platform-specific binary package (easyresearch-<os>-<arch>)
// from optionalDependencies and executes it with the given arguments.
// No install scripts, no postinstall: works on any npm version regardless
// of allowScripts/--ignore-scripts settings.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const platformMap = {
  darwin: "darwin",
  linux: "linux",
  win32: "windows",
};
const supportedArchs = ["x64", "arm64"];

export function missingOptionalPackageMessage(name) {
  return `Required optional package ${name} is not installed. Run npm reinstall easyresearch and ensure optional dependencies are enabled.`;
}

export function describeSpawnFailure(result, target) {
  if (result.error) {
    const code = result.error.code ? ` (${result.error.code})` : "";
    return `Failed to execute ${target}${code}: ${result.error.message}`;
  }
  if (result.signal) return `${target} was terminated by signal ${result.signal}.`;
  return `${target} exited with code ${result.status ?? 1}.`;
}

function binaryPath(name, platform) {
  const packageJsonPath = require.resolve(`${name}/package.json`);
  const binary = join(dirname(packageJsonPath), "bin", platform === "windows" ? "easyresearch.exe" : "easyresearch");
  if (!existsSync(binary)) throw new Error(`The ${name} package is installed but its executable is missing at ${binary}. Reinstall easyresearch.`);
  return binary;
}

export function runLauncher(argv = process.argv.slice(2)) {
  const packageJson = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8"));
  const platform = platformMap[process.platform];
  const arch = supportedArchs.includes(process.arch) ? process.arch : undefined;
  const name = platform && arch ? `easyresearch-${platform}-${arch}` : undefined;
  if (!name || !packageJson.optionalDependencies?.[name]) {
    console.error(
      `easyresearch does not ship a binary for ${process.platform}-${process.arch}. Supported platforms: linux-x64, darwin-arm64, windows-x64.`,
    );
    return 1;
  }

  let target;
  try {
    target = binaryPath(name, platform);
  } catch (error) {
    const candidate = error;
    if (candidate && typeof candidate === "object" && candidate.code === "MODULE_NOT_FOUND") {
      console.error(missingOptionalPackageMessage(name));
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    return 1;
  }

  const result = spawnSync(target, argv, { stdio: "inherit" });
  if (result.error || result.signal || result.status !== 0) console.error(describeSpawnFailure(result, target));
  return result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(runLauncher());
}
