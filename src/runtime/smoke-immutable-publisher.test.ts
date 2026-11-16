import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { smokeImmutablePublisher } from "../../scripts/smoke-immutable-publisher";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "easyresearch-publisher-smoke-"));
  roots.push(root);
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, EASYRESEARCH_CODING_AGENT_DIR: join(root, "agent") };
  const discovery = spawnSync(
    process.env.EASYRESEARCH_SMOKE_PYTHON ?? (process.platform === "win32" ? "python" : "python3"),
    ["-I", "-c", "import sys; print(sys.executable)"],
    { env, encoding: "utf8", timeout: 10_000 },
  );
  expect(discovery.error).toBeUndefined();
  expect(discovery.status, discovery.stderr).toBe(0);
  // An absolute interpreter remains usable with a PATH containing no Node/Bun.
  for (const key of Object.keys(env)) if (key.toUpperCase() === "PATH") delete env[key];
  const childEnv: NodeJS.ProcessEnv = { ...env, PATH: bin };
  const bundledDir = join(root, "bundle with spaces");
  const publisher = join(bundledDir, "skills", "specialist-handoff", "scripts", "publish_immutable.py");
  return {
    bin,
    publisher,
    options: { bundledDir, python: discovery.stdout.trim(), workspace: join(root, "project"), env: childEnv },
  };
}

describe("materialized immutable publisher acceptance", () => {
  it("executes the supplied resource with real publication, collisions and cleanup rollback", () => {
    const { publisher, options } = fixture();
    mkdirSync(dirname(publisher), { recursive: true });
    // Source-level fixture only. Native smoke supplies the compiled extraction.
    copyFileSync(resolve(import.meta.dirname, "../skills/specialist-handoff/scripts/publish_immutable.py"), publisher);
    expect(() => smokeImmutablePublisher(options)).not.toThrow();
  });

  it("fails when the supplied bundle is missing instead of falling back to repository resources", () => {
    const { options } = fixture();
    expect(() => smokeImmutablePublisher(options)).toThrow(/FileNotFoundError/);
  });

  it("rejects a child environment that resolves Node before executing the publisher", () => {
    const { bin, options } = fixture();
    writeFileSync(join(bin, process.platform === "win32" ? "node.exe" : "node"), "fixture", { mode: 0o700 });
    expect(() => smokeImmutablePublisher(options)).toThrow(/publisher environment resolves Node/);
  });
});
