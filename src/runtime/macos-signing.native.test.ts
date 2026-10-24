import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { finalizeBuildArtifact, TARGETS } from "../../scripts/build";

it.skipIf(process.platform !== "darwin")("repairs a rejected Mach-O signature before accepting its hash and executing it", () => {
  const root = mkdtempSync(join(tmpdir(), "easyresearch-native-signature-"));
  try {
    const source = join(root, "fixture.c");
    const binary = join(root, "fixture");
    const original = "good-signature-fixture";
    const modified = "bad!-signature-fixture";
    writeFileSync(source, `#include <stdio.h>\nint main(void) { puts("${original}"); return 0; }\n`);
    const compile = spawnSync("/usr/bin/clang", [source, "-o", binary], { encoding: "utf8", timeout: 30_000 });
    expect(compile.status, compile.error?.message ?? compile.stderr).toBe(0);
    const sign = spawnSync("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", binary], { timeout: 30_000 });
    expect(sign.status, sign.stderr?.toString()).toBe(0);
    const bytes = readFileSync(binary);
    const offset = bytes.indexOf(original);
    expect(offset).toBeGreaterThan(0);
    bytes.write(modified, offset);
    writeFileSync(binary, bytes);
    const rejected = spawnSync("/usr/bin/codesign", ["--verify", "--strict", binary], { timeout: 30_000 });
    expect(rejected.error).toBeUndefined();
    expect(rejected.signal).toBeNull();
    expect(rejected.status).toBeGreaterThan(0);

    const artifact = finalizeBuildArtifact(TARGETS.find((target) => target.name === "darwin-arm64")!, binary, "1.2.3");
    const verified = spawnSync("/usr/bin/codesign", ["--verify", "--strict", binary], { timeout: 30_000 });
    expect(verified.status, verified.stderr?.toString()).toBe(0);
    expect(artifact.sha256).toBe(createHash("sha256").update(readFileSync(binary)).digest("hex"));
    expect(artifact.sha256).not.toBe(createHash("sha256").update(bytes).digest("hex"));
    const executed = spawnSync(binary, [], { encoding: "utf8", timeout: 10_000 });
    expect(executed.status, executed.error?.message ?? executed.stderr).toBe(0);
    expect(executed.stdout.trim()).toBe(modified);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
