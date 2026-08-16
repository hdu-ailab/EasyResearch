#!/usr/bin/env node
// postinstall for the `easyresearch` meta package.
// Resolves the platform-specific binary package (easyresearch-<os>-<arch>),
// copies the executable into ./bin/easyresearch.exe, and verifies it with
// `--version`.
//
// Adapted from opencode-ai (https://github.com/sst/opencode, MIT licensed)
// which ships a platform meta package in the same way.

import childProcess from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));

const platformMap = {
  darwin: "darwin",
  linux: "linux",
  win32: "windows",
};
const archMap = {
  x64: "x64",
  arm64: "arm64",
};

const platform = platformMap[os.platform()] ?? os.platform();
const arch = archMap[os.arch()] ?? os.arch();
const base = `easyresearch-${platform}-${arch}`;
const sourceBinary = platform === "windows" ? "easyresearch.exe" : "easyresearch";
const targetBinary = path.join(__dirname, "bin", "easyresearch.exe");

function packageName() {
  // Shipped platforms (see scripts/build.ts TARGETS):
  //   linux-x64, darwin-arm64, windows-x64
  return base;
}

function resolveBinary(name) {
  const packageJsonPath = require.resolve(`${name}/package.json`);
  const binaryPath = path.join(path.dirname(packageJsonPath), "bin", sourceBinary);
  if (!fs.existsSync(binaryPath)) throw new Error(`Binary not found at ${binaryPath}`);
  return binaryPath;
}

function installPackage(name) {
  const version = packageJson.optionalDependencies?.[name];
  if (!version) return;

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "easyresearch-install-"));
  try {
    const result = childProcess.spawnSync(
      "npm",
      ["install", "--ignore-scripts", "--no-save", "--loglevel=error", "--prefix", temp, `${name}@${version}`],
      { stdio: "inherit", windowsHide: true },
    );
    if (result.status !== 0) return;
    const packageDir = path.join(temp, "node_modules", name);
    copyBinary(path.join(packageDir, "bin", sourceBinary), targetBinary);
    return true;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function copyBinary(source, target) {
  if (!fs.existsSync(source)) throw new Error(`Binary not found at ${source}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) fs.unlinkSync(target);
  try {
    fs.linkSync(source, target);
  } catch {
    fs.copyFileSync(source, target);
  }
  fs.chmodSync(target, 0o755);
}

function verifyBinary() {
  const result = childProcess.spawnSync(targetBinary, ["--version"], {
    encoding: "utf8",
    stdio: "ignore",
    windowsHide: true,
  });
  return result.status === 0;
}

function main() {
  const name = packageName();
  if (!packageJson.optionalDependencies?.[name]) {
    throw new Error(
      `easyresearch does not ship a binary for ${platform}-${arch}. Supported platforms: linux-x64, darwin-arm64, windows-x64.`,
    );
  }
  try {
    copyBinary(resolveBinary(name), targetBinary);
    if (verifyBinary()) return;
  } catch {
    if (installPackage(name) && verifyBinary()) return;
  }

  throw new Error(
    `It seems your package manager failed to install the right easyresearch binary package. Try manually installing ${JSON.stringify(
      name,
    )}.`,
  );
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
