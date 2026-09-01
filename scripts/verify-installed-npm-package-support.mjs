import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { createRequire } from "node:module";

export const NPM_REGISTRY = "https://registry.npmjs.org/";

const META_PACKAGE = "easyresearch";
const PLATFORM_PACKAGE = "easyresearch-linux-x64";

export async function waitForPublishedPackages(options) {
  if (!Array.isArray(options.specs) || options.specs.length === 0) {
    throw new Error("npm registry visibility requires at least one package");
  }
  if (!Number.isSafeInteger(options.attempts) || options.attempts <= 0) {
    throw new Error("npm registry visibility attempts must be a positive integer");
  }
  if (!Number.isSafeInteger(options.delayMs) || options.delayMs < 0) {
    throw new Error("npm registry visibility delay must be a non-negative integer");
  }

  let missing = [...options.specs];
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    missing = [];
    for (const spec of options.specs) {
      if (!await options.check(spec)) missing.push(spec);
    }
    if (missing.length === 0) return;
    if (attempt < options.attempts) {
      options.onRetry?.({ attempt, missing: [...missing] });
      await options.wait(options.delayMs);
    }
  }
  throw new Error(
    `npm packages were not visible on the official registry: ${missing.join(", ")} after ${options.attempts} attempts`,
  );
}

export function assertInstalledPackageManifest(manifest, expectedName, version) {
  if (
    !manifest
    || typeof manifest !== "object"
    || Array.isArray(manifest)
    || manifest.name !== expectedName
    || manifest.version !== version
  ) {
    throw new Error(
      `installed package ${expectedName}@${version} did not have the exact expected identity`,
    );
  }
}

export function assertInstalledVersionInvocation(result, version) {
  const expected = `easyresearch ${version}\n`;
  if (
    result.error
    || result.status !== 0
    || result.stdout !== expected
    || (result.stderr ?? "") !== ""
  ) {
    throw new Error(
      `installed npm bin version check expected easyresearch ${version} with exit 0; status=${String(result.status)}; stdout=${JSON.stringify(result.stdout ?? "")}; stderr=${JSON.stringify(result.stderr ?? "")}; error=${result.error?.message ?? "none"}`,
    );
  }
}

export async function verifyInstalledNpmPackage(options) {
  const version = options.version;
  if (typeof version !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.+-]*$/u.test(version)) {
    throw new Error(`installed npm package gate received an invalid version: ${String(version)}`);
  }
  if ((options.platform ?? process.platform) !== "linux") {
    throw new Error("installed npm package gate must run on Linux");
  }
  if ((options.arch ?? process.arch) !== "x64") {
    throw new Error("installed npm package gate must run on Linux x64");
  }

  const run = options.run ?? ((command, args, runOptions) => spawnSync(command, args, runOptions));
  const wait = options.wait
    ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const temporaryRoot = (options.makeTemporaryRoot
    ?? (() => mkdtempSync(join(tmpdir(), "easyresearch-installed-npm-"))))();
  const prefix = join(temporaryRoot, "prefix");
  const home = join(temporaryRoot, "home");
  const npmCache = join(temporaryRoot, "npm-cache");
  mkdirSync(prefix, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(npmCache, { recursive: true });
  const childEnv = {
    ...(options.baseEnv ?? process.env),
    HOME: home,
    USERPROFILE: home,
    NPM_CONFIG_CACHE: npmCache,
    NPM_CONFIG_REGISTRY: NPM_REGISTRY,
  };
  delete childEnv.NODE_PATH;
  delete childEnv.NODE_OPTIONS;
  const runOptions = { encoding: "utf8", env: childEnv };
  const specs = [`${META_PACKAGE}@${version}`, `${PLATFORM_PACKAGE}@${version}`];

  try {
    await waitForPublishedPackages({
      specs,
      attempts: options.attempts ?? 12,
      delayMs: options.retryDelayMs ?? 10_000,
      wait,
      check: (spec) => {
        const result = run(
          "npm",
          ["view", spec, "version", `--registry=${NPM_REGISTRY}`],
          runOptions,
        );
        return !result.error
          && result.status === 0
          && (result.stdout ?? "").trim() === version;
      },
      onRetry: ({ attempt, missing }) => options.log?.(
        `[installed-npm] registry visibility attempt ${attempt} missing ${missing.join(", ")}`,
      ),
    });

    const installResult = run(
      "npm",
      [
        "install",
        "--global",
        "--prefix",
        prefix,
        `${META_PACKAGE}@${version}`,
        `--registry=${NPM_REGISTRY}`,
        "--no-audit",
        "--no-fund",
      ],
      runOptions,
    );
    if (installResult.error || installResult.status !== 0) {
      throw new Error(
        `isolated npm install failed with status ${String(installResult.status)}: ${installResult.error?.message ?? installResult.stderr ?? "unknown error"}`,
      );
    }

    const metaDir = join(prefix, "lib", "node_modules", META_PACKAGE);
    const metaManifestPath = join(metaDir, "package.json");
    const metaManifest = readJson(metaManifestPath);
    assertInstalledPackageManifest(metaManifest, META_PACKAGE, version);

    let platformManifestPath;
    try {
      platformManifestPath = (options.resolvePlatformManifest
        ?? ((fromPath, specifier) => createRequire(fromPath).resolve(specifier)))(
        join(metaDir, "launcher.mjs"),
        `${PLATFORM_PACKAGE}/package.json`,
      );
    } catch (error) {
      throw new Error(`installed ${META_PACKAGE}@${version} did not resolve ${PLATFORM_PACKAGE}`, {
        cause: error,
      });
    }
    const nodeModulesRoot = realpathSync(join(prefix, "lib", "node_modules"));
    const canonicalPlatformManifest = realpathSync(platformManifestPath);
    const manifestRelativePath = relative(nodeModulesRoot, canonicalPlatformManifest);
    if (
      isAbsolute(manifestRelativePath)
      || manifestRelativePath === ".."
      || manifestRelativePath.startsWith(`..${sep}`)
    ) {
      throw new Error(
        `installed platform manifest resolved outside the temporary prefix node_modules: ${canonicalPlatformManifest}`,
      );
    }
    assertInstalledPackageManifest(
      readJson(canonicalPlatformManifest),
      PLATFORM_PACKAGE,
      version,
    );

    const binPath = join(prefix, "bin", "easyresearch");
    if (!lstatSync(binPath).isSymbolicLink()) {
      throw new Error(`npm did not generate the expected Linux bin link: ${binPath}`);
    }
    const versionResult = run(binPath, ["--version"], runOptions);
    assertInstalledVersionInvocation(versionResult, version);
    if (existsSync(join(home, ".easyresearch"))) {
      throw new Error("installed npm --version unexpectedly mutated EasyResearch user state");
    }
    return { version, binPath };
  } finally {
    (options.removeTemporaryRoot
      ?? ((path) => rmSync(path, { recursive: true, force: true })))(temporaryRoot);
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`installed package manifest was unreadable: ${path}`, { cause: error });
  }
}
