import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { EnvironmentMap } from "./network-policy";

/** Private launcher-to-owner carrier. Never forwarded to a Web/Agent environment. */
export const NPM_PROVENANCE_ENV = "EASYRESEARCH_NPM_PROVENANCE";
export interface NpmProvenance {
  schema: 1;
  metaRoot: string;
  launcher: string;
  platformManifest: string;
  binary: string;
  nodeExecutable: string;
  version: string;
  platform: NodeJS.Platform;
  arch: string;
}
export interface NpmInstallation {
  provenance: NpmProvenance;
  prefix: string;
  packageName: string;
}

export function stableNpmVersion(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
    && value.split(".").every((part) => Number.isSafeInteger(Number(part)));
}

export function consumeNpmProvenance(environment: EnvironmentMap): NpmProvenance | undefined {
  const raw = environment[NPM_PROVENANCE_ENV];
  delete environment[NPM_PROVENANCE_ENV];
  if (!raw || raw.length > 32_768) return undefined;
  try {
    const value = JSON.parse(raw) as NpmProvenance;
    if (!value || value.schema !== 1 || !stableNpmVersion(value.version)
      || !["linux", "darwin", "win32"].includes(value.platform) || !["x64", "arm64"].includes(value.arch)) return undefined;
    for (const key of ["metaRoot", "launcher", "platformManifest", "binary", "nodeExecutable"] as const) {
      if (typeof value[key] !== "string" || !isAbsolute(value[key]) || /[\x00-\x1f]/.test(value[key])) return undefined;
    }
    return Object.freeze(value);
  } catch { return undefined; }
}

function manifest(path: string): Record<string, unknown> {
  const size = lstatSync(path);
  if (!size.isFile() || size.size > 1_048_576) throw new Error("Package manifest is unavailable.");
  return JSON.parse(readFileSync(path, "utf8"));
}
function physical(path: string): string {
  const actual = realpathSync(path);
  if (actual !== resolve(path)) throw new Error("Linked installation is not supported.");
  return actual;
}

/** A global-looking directory alone is insufficient: the bin link and dependency must agree. */
export function inspectNpmInstallation(provenance: NpmProvenance, expectedVersion: string): NpmInstallation {
  const root = physical(provenance.metaRoot);
  const modules = dirname(root);
  const prefix = provenance.platform === "win32" ? dirname(modules) : dirname(dirname(modules));
  if (basename(root) !== "easyresearch" || basename(modules) !== "node_modules"
    || (provenance.platform !== "win32" && basename(dirname(modules)) !== "lib")
    || /(?:^|[\\/])(?:node_modules|_npx|\.nvm|\.volta|\.asdf|\.fnm|fnm|\.bun|\.pnpm|pnpm|yarn|Cellar|mise)(?:[\\/]|$)/i.test(prefix)) {
    throw new Error("Installation scope is not a conventional global npm prefix.");
  }
  physical(prefix);
  if (provenance.launcher !== join(root, "launcher.mjs")) throw new Error("Launcher relationship changed.");
  physical(provenance.launcher);
  const meta = manifest(join(root, "package.json"));
  const os = provenance.platform === "win32" ? "windows" : provenance.platform;
  const packageName = `easyresearch-${os}-${provenance.arch}`;
  const launcherBin = (meta.bin as Record<string, unknown> | undefined)?.easyresearch ?? meta.bin;
  if (meta.name !== "easyresearch" || meta.version !== expectedVersion
    || (meta.optionalDependencies as Record<string, unknown> | undefined)?.[packageName] !== expectedVersion
    || (launcherBin !== "launcher.mjs" && launcherBin !== "./launcher.mjs")) {
    throw new Error("Installed meta package does not match the selected version.");
  }
  const require = createRequire(provenance.launcher);
  const resolved = require.resolve(`${packageName}/package.json`);
  const platformManifest = physical(provenance.platformManifest);
  const nested = join(root, "node_modules", packageName, "package.json");
  const expectedManifest = existsSync(nested) ? nested : join(modules, packageName, "package.json");
  if (resolved !== platformManifest || physical(expectedManifest) !== platformManifest || !platformManifest.startsWith(`${modules}${sep}`)) {
    throw new Error("Platform package escaped the original installation.");
  }
  const platform = manifest(platformManifest);
  const binary = join(dirname(platformManifest), "bin", provenance.platform === "win32" ? "easyresearch.exe" : "easyresearch");
  if (platform.name !== packageName || platform.version !== expectedVersion || binary !== provenance.binary
    || physical(binary) !== binary || !lstatSync(binary).isFile()) throw new Error("Installed platform package does not match the selected version.");
  if (provenance.platform === "win32") {
    const shim = join(prefix, "easyresearch.cmd");
    physical(shim);
    if (!readFileSync(shim, "utf8").includes('%dp0%\\node_modules\\easyresearch\\launcher.mjs')) throw new Error("Global npm launcher shim is unavailable.");
  } else if (realpathSync(join(prefix, "bin", "easyresearch")) !== provenance.launcher) {
    throw new Error("Global npm launcher link does not match.");
  }
  return { provenance, prefix, packageName };
}

/** Resolve npm only beside the actual Node that ran the launcher, never from daemon PATH. */
export function resolveAssociatedNpm(provenance: NpmProvenance): { node: string; npm: string } {
  const node = physical(provenance.nodeExecutable);
  if (!/^node(?:\.exe)?$/i.test(basename(node))) throw new Error("The launcher Node runtime is unavailable.");
  const bin = dirname(node);
  const candidates = provenance.platform === "win32"
    ? [join(bin, "node_modules/npm/bin/npm-cli.js")]
    : [join(bin, "../lib/node_modules/npm/bin/npm-cli.js"), join(bin, "../share/nodejs/npm/bin/npm-cli.js")];
  for (const candidate of candidates) {
    try {
      const npm = physical(resolve(candidate));
      const npmRoot = dirname(dirname(npm));
      const pkg = manifest(join(npmRoot, "package.json"));
      if (pkg.name !== "npm" || (pkg.bin as Record<string, unknown> | undefined)?.npm !== "bin/npm-cli.js") continue;
      if (provenance.platform !== "win32" && realpathSync(join(bin, "npm")) !== npm) continue;
      return { node, npm };
    } catch { /* An absent associated npm is a capability limit, not startup failure. */ }
  }
  throw new Error("npm associated with the launcher Node runtime is unavailable.");
}

export function npmInstallArguments(prefix: string, version: string): string[] {
  if (!stableNpmVersion(version)) throw new Error("An exact stable npm version is required.");
  return installArguments(prefix, version);
}

function installArguments(prefix: string, version: string): string[] {
  return ["install", "--global", "--prefix", prefix, `easyresearch@${version}`, "--registry=https://registry.npmjs.org/", "--ignore-scripts", "--include=optional", "--no-audit", "--no-fund"];
}

export function npmManualCommand(prefix: string | undefined, version: string, platform: NodeJS.Platform): string | undefined {
  if (!prefix || (version !== "latest" && !stableNpmVersion(version))) return undefined;
  const quote = (value: string) => /^[\w@=./:-]+$/.test(value) ? value
    : platform === "win32" ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", `'"'"'`)}'`;
  return ["npm", ...installArguments(prefix, version)].map(quote).join(" ");
}
