#!/usr/bin/env bun
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { platformPackageDir, repoPackageVersion } from "./build";
import { buildUpdateFixture, removeUpdateFixture } from "./build-update-fixture";
import { runNpmUpdateSmoke } from "./smoke-npm-update";

/** Release wiring: keep the accepted candidate intact while building a private predecessor. */
async function main(args: string[]): Promise<void> {
  const [target, oldVersion] = args;
  assert(args.length === 2 && target === `linux-${process.arch}` && process.platform === "linux" && oldVersion,
    "Usage: bun scripts/smoke-npm-update-release.ts <native-linux-target> <older-stable-version>");
  const fixture = await buildUpdateFixture({ target, version: oldVersion, desktop: false, allWindowsLocales: false,
    temporaryDirectory: process.env.RUNNER_TEMP ?? (existsSync("/tmp/opencode") ? "/tmp/opencode" : tmpdir()) });
  try {
    await runNpmUpdateSmoke({ oldBin: fixture.nativeBinary, oldVersion, newVersion: repoPackageVersion(),
      newBin: join(platformPackageDir(target), "bin", "easyresearch"), timeoutMs: 10 * 60_000 });
  } finally {
    await removeUpdateFixture(fixture);
  }
}

if (import.meta.main) await main(process.argv.slice(2));
