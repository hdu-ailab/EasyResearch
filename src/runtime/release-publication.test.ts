import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TARGETS, platformBinaryName } from "../../scripts/build";

vi.mock("node:child_process", () => {
  const blocked = () => { throw new Error("Unmocked subprocess is forbidden in release tests"); };
  const methods = {
    spawnSync: vi.fn(blocked), spawn: blocked, exec: blocked, execSync: blocked,
    execFile: blocked, execFileSync: blocked, fork: blocked,
  };
  return { ...methods, default: methods };
});

const version = "1.2.3";
const packageNames = ["easyresearch", ...TARGETS.map((target) => `easyresearch-${target.name}`)];
let root: string;
let published: Set<string>;
let operations: string[];
let buildCount: number;
let collideDuringBuild: boolean;
let lookupFailure: boolean;
let rejectPublish: boolean;
const argv = process.argv;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "release-publication-"));
  published = new Set();
  operations = [];
  buildCount = 0;
  collideDuringBuild = false;
  lookupFailure = false;
  rejectPublish = false;
  vi.stubGlobal("fetch", () => { throw new Error("Network access is forbidden in release tests"); });
  const bytes = Buffer.from("accepted fixture binary");
  writeFileSync(join(root, "manifest.json"), JSON.stringify({
    version,
    artifacts: TARGETS.map((target) => ({
      version, target: target.name, binaryName: platformBinaryName(target), size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"), builtAt: "2026-09-08T00:00:00Z",
    })),
  }));
  for (const target of TARGETS) {
    const bin = join(root, `easyresearch-${target.name}`, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, platformBinaryName(target)), bytes);
  }
  const build = await vi.importActual<typeof import("../../scripts/build")>("../../scripts/build");
  vi.doMock("../../scripts/build", () => ({
    ...build,
    repoPackageVersion: () => version,
    releaseDir: () => root,
    platformPackageDir: (target: string) => join(root, `easyresearch-${target}`),
    buildManifestPath: () => join(root, "manifest.json"),
    buildTargets: async () => {
      buildCount += 1;
      if (collideDuringBuild) published.add("easyresearch-linux-x64");
    },
  }));
  vi.doMock("../../scripts/third-party-notices", () => ({
    THIRD_PARTY_NOTICES_FILE: "THIRD_PARTY_NOTICES.txt",
    generateThirdPartyNotices: () => "fixture notices",
    assertThirdPartyNoticesFile: () => {},
  }));
  vi.mocked(spawnSync).mockImplementation(((command: string, args: string[], options?: { cwd?: string }) => {
      if (command !== "npm") {
        expect(command.startsWith(root)).toBe(true);
        expect(args).toEqual(["--version"]);
        return { status: 0, stdout: `easyresearch ${version}\n`, stderr: "" };
      }
      expect(args).toContain("--registry=https://registry.npmjs.org/");
      operations.push(args[0]!);
      if (args[0] === "view") {
        if (lookupFailure) {
          lookupFailure = false;
          return { status: 1, stdout: "", stderr: "npm error code ECONNRESET" };
        }
        const exists = published.has(args[1]!.split("@")[0]!);
        return { status: exists ? 0 : 1, stdout: exists ? version : "", stderr: exists ? "" : "npm error code E404" };
      }
      if (args[0] === "whoami") return { status: 0, stdout: "fixture-user", stderr: "" };
      if (args[0] === "pack") return {
        status: 0, stdout: JSON.stringify([{ files: ["package.json", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.txt"].map((path) => ({ path })) }]), stderr: "",
      };
      if (args[0] === "publish") {
        if (rejectPublish) throw new Error("Unexpected partial publication attempt");
        published.add(basename(options!.cwd!));
        return { status: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected npm operation: ${args[0]}`);
    }) as typeof spawnSync);
  vi.resetModules();
});

afterEach(() => {
  process.argv = argv;
  vi.mocked(spawnSync).mockReset();
  vi.unstubAllGlobals();
  vi.doUnmock("../../scripts/build");
  vi.doUnmock("../../scripts/third-party-notices");
  vi.resetModules();
  rmSync(root, { recursive: true, force: true });
});

describe("immutable publication admission", () => {
  it.each([false, true])("rejects non-dry-run --only before build or any npm operation (skipBuild=%s)", async (skipBuild) => {
    rejectPublish = true;
    process.argv = ["bun", "release.ts", "--only", "darwin-arm64", ...(skipBuild ? ["--skip-build"] : [])];
    const { main } = await import("../../scripts/release");
    await expect(main()).rejects.toThrow(/--only.*--dry-run/i);
    expect(buildCount).toBe(0);
    expect(operations).toEqual([]);
    expect(published.size).toBe(0);
  });

  it("allows --only for dry-run assembly without publishing any package", async () => {
    rejectPublish = true;
    process.argv = ["bun", "release.ts", "--only", "darwin-arm64", "--dry-run"];
    const { main } = await import("../../scripts/release");
    await main();
    expect(buildCount).toBe(1);
    expect(operations.filter((operation) => operation === "pack")).toHaveLength(2);
    expect(operations).not.toContain("whoami");
    expect(operations).not.toContain("publish");
    expect(published.size).toBe(0);
  });

  it.each([
    [[], ["easyresearch-linux-x64"]],
    [["--skip-build"], ["easyresearch-linux-x64"]],
    [["--dry-run", "--only", "darwin-arm64"], ["easyresearch-linux-x64", "easyresearch-windows-x64"]],
    [["--dry-run"], ["easyresearch-linux-x64"]],
    [[], ["easyresearch"]],
    [[], packageNames],
  ])("rejects published packages before build or package operations: flags=%j packages=%j", async (flags, names) => {
    published = new Set(names);
    process.argv = ["bun", "release.ts", ...flags];
    const { main } = await import("../../scripts/release");

    await expect(main()).rejects.toThrow(/immutable.*advance.*version/i);
    expect(buildCount).toBe(0);
    expect(operations.every((operation) => operation === "view")).toBe(true);
  });

  it("publishes a fresh accepted version platform-first and meta-last", async () => {
    process.argv = ["bun", "release.ts", "--skip-build"];
    const { main } = await import("../../scripts/release");
    await main();
    expect([...published]).toEqual([...packageNames.slice(1), "easyresearch"]);
  });

  it("does not treat a registry lookup failure as proof the version is unpublished", async () => {
    lookupFailure = true;
    process.argv = ["bun", "release.ts"];
    const { main } = await import("../../scripts/release");
    await expect(main()).rejects.toThrow(/verify.*publication/i);
    expect(buildCount).toBe(0);
    expect(operations).toEqual(["view"]);
  });

  it("fails instead of skipping a package published concurrently after admission", async () => {
    collideDuringBuild = true;
    process.argv = ["bun", "release.ts"];
    const { main } = await import("../../scripts/release");
    await expect(main()).rejects.toThrow(/immutable.*advance.*version/i);
    expect(operations).not.toContain("publish");
    expect([...published]).toEqual(["easyresearch-linux-x64"]);
  });
});
