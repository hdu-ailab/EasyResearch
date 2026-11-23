#!/usr/bin/env bun
/**
 * Build an older, updater-enabled copy of the CURRENT checked-out source privately.
 * bun scripts/build-update-fixture.ts --target windows-x64 --version 0.1.23 --desktop --all-windows-locales
 * bun scripts/build-update-fixture.ts --target linux-arm64 --version 0.1.23 --receipt <path>
 * Prints one JSON result; build output lives in private logs. Caller owns result.root
 * until removeUpdateFixture(result). No publication and no accepted artifact writes.
 */
import assert from "node:assert/strict";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { TARGETS } from "./build";
import { assertNativeDesktopHost, desktopBuilderInvocation, desktopPackageFileName, desktopTarget, validateDesktopBuildManifest } from "./build-desktop";
import { assertOlderVersion, assertStableVersion, digestFile, runFixtureCommand } from "./smoke-desktop-update-fixture";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MARKER = ".private-update-fixture.json";
export interface UpdateFixtureOptions { target: string; version: string; desktop: boolean; allWindowsLocales: boolean; temporaryDirectory?: string; receipt?: string }
export interface UpdateFixtureSource { root: string; source: string; originalSource: string; version: string }
export interface UpdateFixtureBuild extends UpdateFixtureSource { target: string; nativeBinary: string; nativeManifest: string; desktopManifest?: string; installer?: string; allWindowsLocales: boolean }

export function assertExternalFixtureReceipt(source: string, path: string): void {
  const checkout = realpathSync(source); const parent = realpathSync(dirname(resolve(path)));
  const rel = relative(checkout, parent);
  assert(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel), "Fixture receipt must be outside the source checkout");
  if (existsSync(path)) assert(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), "Fixture receipt cannot replace a redirected path");
}

export function parseUpdateFixtureOptions(args: string[]): UpdateFixtureOptions {
  const values = new Map<string, string>(); const flags = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const name = args[index]!;
    if (["--desktop", "--all-windows-locales"].includes(name)) { assert(!flags.has(name), `Repeated ${name}`); flags.add(name); continue; }
    assert(["--target", "--version", "--temporary-directory", "--receipt"].includes(name), `Unknown fixture flag ${name}`);
    const value = args[++index]; assert(value && !value.startsWith("--") && !values.has(name), `Missing or repeated ${name}`); values.set(name, value);
  }
  const target = values.get("--target"); const version = values.get("--version");
  assert(target && TARGETS.some(item => item.name === target) && version, "Usage: bun scripts/build-update-fixture.ts --target <native-target> --version <older-stable-version> [--desktop] [--all-windows-locales] [--temporary-directory <outside-checkout>] [--receipt <json>]");
  assertStableVersion(version);
  assert(!flags.has("--desktop") || target !== "linux-x64", "Linux x64 has no release Desktop package");
  assert(!flags.has("--all-windows-locales") || (flags.has("--desktop") && target === "windows-x64"), "All locales requires Windows Desktop packaging");
  return { target, version, desktop: flags.has("--desktop"), allWindowsLocales: flags.has("--all-windows-locales"), temporaryDirectory: values.get("--temporary-directory"), receipt: values.get("--receipt") };
}

export async function copyUpdateFixtureSource(options: { source: string; temporaryDirectory: string; version: string }): Promise<UpdateFixtureSource> {
  const originalSource = realpathSync(options.source); const parent = realpathSync(options.temporaryDirectory);
  const rel = relative(originalSource, parent);
  assert(rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel), "Private fixture must be outside the source checkout");
  const pkg = JSON.parse(readFileSync(join(originalSource, "package.json"), "utf8"));
  assertOlderVersion(options.version, pkg.version);
  const root = realpathSync(mkdtempSync(join(parent, "easyresearch-update-fixture-"))); const source = join(root, "source");
  const fixture = { root, source, originalSource, version: options.version };
  writeFileSync(join(root, MARKER), JSON.stringify(fixture), { mode: 0o600 });
  const omitted = new Set([".git", ".docs", "AGENTS.md", "node_modules", "release", ".opencode", ".worktrees", ".venv", "__pycache__", "dist", ".vite", ".vite-temp", "coverage", "test-results", "playwright-report"]);
  const privateRootEntries = new Set([".easyresearch", ".pi", ".lazypaper", ".npmrc"]);
  const copy = (from: string, to: string) => {
    assert(!lstatSync(from).isSymbolicLink(), `Source fixture refuses symbolic links: ${from}`);
    if (lstatSync(from).isDirectory()) {
      mkdirSync(to, { recursive: true });
      for (const entry of readdirSync(from)) {
        // Exclude local credentials/config before stat or traversal. Nested Skill
        // examples with these names are ordinary shipped resources, not config.
        const normalized = entry.toLowerCase();
        if (from === originalSource && (privateRootEntries.has(normalized) || normalized.startsWith(".env") || normalized.startsWith(".npmrc."))) continue;
        if (!omitted.has(entry) && !entry.endsWith(".log") && !entry.endsWith(".pyc")) copy(join(from, entry), join(to, entry));
      }
    } else { assert(lstatSync(from).isFile(), "Source fixture requires regular files"); copyFileSync(from, to); }
  };
  try {
    copy(originalSource, source);
    writeFileSync(join(source, "package.json"), `${JSON.stringify({ ...pkg, version: options.version }, null, 2)}\n`);
    // Dependencies are read-only inputs. Keep Vite's generated config/cache siblings
    // private, rather than letting a whole-node_modules junction mutate the checkout.
    const dependencies = join(source, "node_modules"); mkdirSync(dependencies);
    for (const entry of readdirSync(join(originalSource, "node_modules"))) {
      if ([".vite", ".vite-temp", ".cache"].includes(entry)) continue;
      const input = realpathSync(join(originalSource, "node_modules", entry));
      if (lstatSync(input).isDirectory()) symlinkSync(input, join(dependencies, entry), process.platform === "win32" ? "junction" : "dir");
      else copyFileSync(input, join(dependencies, entry));
    }
    if (existsSync(join(originalSource, ".docs"))) symlinkSync(realpathSync(join(originalSource, ".docs")), join(source, ".docs"), process.platform === "win32" ? "junction" : "dir");
    return fixture;
  } catch (error) { await removeUpdateFixture(fixture); throw error; }
}

export async function removeUpdateFixture(fixture: UpdateFixtureSource): Promise<void> {
  assert(realpathSync(fixture.root) === resolve(fixture.root) && !lstatSync(fixture.root).isSymbolicLink(), "Fixture cleanup root is redirected");
  const owned = JSON.parse(readFileSync(join(fixture.root, MARKER), "utf8"));
  assert(owned.root === fixture.root && owned.source === join(fixture.root, "source") && owned.originalSource === fixture.originalSource, "Unowned fixture cleanup refused");
  // rm does not traverse directory symlinks/junctions. Remove them explicitly first.
  for (const path of [join(fixture.source, ".docs"), join(fixture.source, "node_modules")]) if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  rmSync(fixture.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

export async function buildUpdateFixture(options: UpdateFixtureOptions, source = REPO): Promise<UpdateFixtureBuild> {
  const target = TARGETS.find(item => item.name === options.target);
  assert(target && target.os[0] === process.platform && target.cpu[0] === process.arch, "Older fixture must be built on its actual native target");
  if (options.desktop) assertNativeDesktopHost(options.target as "windows-x64" | "darwin-arm64" | "linux-arm64");
  if (options.receipt) assertExternalFixtureReceipt(source, options.receipt);
  const originalPackage = readFileSync(join(source, "package.json"));
  const candidateVersion = JSON.parse(originalPackage.toString()).version as string;
  const preserved = [join(source, "release", "build-manifest.json"), join(source, "release", `build-manifest-${options.target}.json`), join(source, "release", `desktop-manifest-${options.target}.json`),
    join(source, "release", `easyresearch-${options.target}`, "bin", process.platform === "win32" ? "easyresearch.exe" : "easyresearch"),
    ...(options.desktop ? desktopTarget(options.target).packages.map(({ format }) => join(source, "release", "desktop", desktopPackageFileName(options.target as "windows-x64" | "darwin-arm64" | "linux-arm64", format, candidateVersion))) : [])];
  const identities = await Promise.all(preserved.filter(existsSync).map(async path => ({ path, hash: await digestFile(path) })));
  const fixture = await copyUpdateFixtureSource({ source, version: options.version, temporaryDirectory: options.temporaryDirectory ?? process.env.RUNNER_TEMP ?? tmpdir() });
  try {
    await runFixtureCommand(process.execPath, [join(fixture.source, "scripts/build.ts"), "--only", options.target], { cwd: fixture.source, timeoutMs: 30 * 60_000, logFile: join(fixture.root, "native-build.log") });
    if (options.desktop) {
      await runFixtureCommand(process.execPath, [join(fixture.source, "scripts/build-desktop.ts"), options.target], { cwd: fixture.source, timeoutMs: 30 * 60_000, logFile: join(fixture.root, "desktop-build.log") });
      if (options.allWindowsLocales) await runFixtureCommand(process.execPath, [join(fixture.source, "scripts/build-update-fixture.ts"), "--private-repack-all-locales"], { cwd: fixture.source, timeoutMs: 20 * 60_000, logFile: join(fixture.root, "all-locales-build.log") });
    }
    const result: UpdateFixtureBuild = { ...fixture, target: options.target, nativeBinary: join(fixture.source, "release", `easyresearch-${options.target}`, "bin", process.platform === "win32" ? "easyresearch.exe" : "easyresearch"),
      nativeManifest: join(fixture.source, "release", `build-manifest-${options.target}.json`), allWindowsLocales: options.allWindowsLocales,
      ...(options.desktop ? { desktopManifest: join(fixture.source, "release", `desktop-manifest-${options.target}.json`),
        installer: join(fixture.source, "release", "desktop", desktopPackageFileName(options.target as "windows-x64" | "darwin-arm64" | "linux-arm64", process.platform === "win32" ? "nsis" : process.platform === "darwin" ? "dmg" : "AppImage", options.version)) } : {}) };
    writeFileSync(join(fixture.root, "fixture.json"), JSON.stringify(result, null, 2));
    return result;
  } catch (error) { throw new Error(`Private fixture build failed; logs retained at ${fixture.root}`, { cause: error }); }
  finally {
    assert(readFileSync(join(source, "package.json")).equals(originalPackage), "Candidate package.json changed during fixture build");
    for (const item of identities) assert.equal(await digestFile(item.path), item.hash, `Accepted candidate changed: ${item.path}`);
  }
}

async function repackPrivateAllLocales(): Promise<void> {
  assertNativeDesktopHost("windows-x64");
  const marker = JSON.parse(readFileSync(join(REPO, "..", MARKER), "utf8"));
  assert(marker.source === REPO && marker.originalSource !== REPO, "All-locale packaging is private-fixture-only");
  const version = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version;
  const stage = join(REPO, "release", "desktop-stage", "windows-x64"); const output = join(REPO, "release", "desktop");
  const invocation = desktopBuilderInvocation("windows-x64", version, stage, output);
  const config = { ...invocation.config, win: { ...invocation.config.win, electronLanguages: [] }, afterPack: undefined };
  const { build, Platform, Arch } = await import("electron-builder");
  await build({ ...invocation, config, targets: Platform.WINDOWS.createTarget(["nsis"], Arch.x64), publish: "never" });
  const manifestPath = join(REPO, "release", "desktop-manifest-windows-x64.json");
  const manifest = validateDesktopBuildManifest(JSON.parse(readFileSync(manifestPath, "utf8")), "windows-x64", version);
  const installer = join(output, manifest.packages[0]!.fileName);
  manifest.packages[0]!.size = lstatSync(installer).size; manifest.packages[0]!.sha256 = await digestFile(installer);
  assert(readdirSync(join(output, "win-unpacked", "locales")).filter(name => name.endsWith(".pak")).length > 4, "Private older package lost its extra locale packs");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

if (import.meta.main) {
  if (process.argv.slice(2).join(" ") === "--private-repack-all-locales") await repackPrivateAllLocales();
  else {
    const options = parseUpdateFixtureOptions(process.argv.slice(2)); const result = await buildUpdateFixture(options);
    if (options.receipt) writeFileSync(options.receipt, `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result));
  }
}
