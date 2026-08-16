#!/usr/bin/env node
// Runtime launcher for the `easyresearch` meta package.
// Resolves the platform-specific binary package (easyresearch-<os>-<arch>)
// from optionalDependencies and executes it with the given arguments.
// No install scripts, no postinstall: works on any npm version regardless
// of allowScripts/--ignore-scripts settings.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const packageJson = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8"));

const platformMap = {
  darwin: "darwin",
  linux: "linux",
  win32: "windows",
};
const supportedArchs = ["x64", "arm64"];

const platform = platformMap[process.platform];
const arch = supportedArchs.includes(process.arch) ? process.arch : undefined;
const name = platform && arch ? `easyresearch-${platform}-${arch}` : undefined;

if (!name || !packageJson.optionalDependencies?.[name]) {
  console.error(
    `easyresearch does not ship a binary for ${process.platform}-${process.arch}. Supported platforms: linux-x64, darwin-arm64, windows-x64.`,
  );
  process.exit(1);
}

function binaryPath() {
  const packageJsonPath = require.resolve(`${name}/package.json`);
  const binary = join(dirname(packageJsonPath), "bin", platform === "windows" ? "easyresearch.exe" : "easyresearch");
  if (!existsSync(binary)) throw new Error(`Binary not found at ${binary}`);
  return binary;
}

let target;
try {
  target = binaryPath();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const result = spawnSync(target, process.argv.slice(2), { stdio: "inherit" });
process.exit(result.status ?? 1);
