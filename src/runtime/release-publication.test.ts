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
let visibleAfter: Map<string, number>;
let uploads: string[];
let visibilityQueries: Array<{ args: string[]; timeout?: number; killSignal?: string }>;
let postUploadFailure: string | undefined;
let postUploadResult: ReturnType<typeof spawnSync> | undefined;
let lookupCostMs: number;
const argv = process.argv;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "release-publication-"));
  published = new Set();
  operations = [];
  buildCount = 0;
  collideDuringBuild = false;
  lookupFailure = false;
  rejectPublish = false;
  visibleAfter = new Map();
  uploads = [];
  visibilityQueries = [];
  postUploadFailure = undefined;
  postUploadResult = undefined;
  lookupCostMs = 0;
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
   vi.mocked(spawnSync).mockImplementation(((command: string, args: string[], options?: { cwd?: string; timeout?: number; killSignal?: string }) => {
      if (command !== "npm") {
        expect(command.startsWith(root)).toBe(true);
        expect(args).toEqual(["--version"]);
        return { status: 0, stdout: `easyresearch ${version}\n`, stderr: "" };
      }
      expect(args).toContain("--registry=https://registry.npmjs.org/");
      operations.push(args[0]!);
      if (args[0] === "view") {
        if (uploads.length === TARGETS.length) {
          visibilityQueries.push({ args: [...args], timeout: options?.timeout, killSignal: options?.killSignal });
          if (postUploadResult) {
            const result = postUploadResult;
            postUploadResult = undefined;
            return result;
          }
          if (lookupCostMs) vi.advanceTimersByTime(Math.min(lookupCostMs, options?.timeout ?? lookupCostMs));
          if (postUploadFailure) return { status: 1, stdout: "", stderr: `npm error code ${postUploadFailure}` };
        }
        if (lookupFailure) {
          lookupFailure = false;
          return { status: 1, stdout: "", stderr: "npm error code ECONNRESET" };
        }
        const name = args[1]!.split("@")[0]!;
        const exists = published.has(name) && Date.now() >= (visibleAfter.get(name) ?? 0);
        return { status: exists ? 0 : 1, stdout: exists ? version : "", stderr: exists ? "" : "npm error code E404" };
      }
      if (args[0] === "whoami") return { status: 0, stdout: "fixture-user", stderr: "" };
      if (args[0] === "pack") return {
        status: 0, stdout: JSON.stringify([{ files: ["package.json", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.txt"].map((path) => ({ path })) }]), stderr: "",
      };
      if (args[0] === "publish") {
        if (rejectPublish) throw new Error("Unexpected partial publication attempt");
        uploads.push(basename(options!.cwd!));
        published.add(basename(options!.cwd!));
        return { status: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected npm operation: ${args[0]}`);
    }) as typeof spawnSync);
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  process.argv = argv;
  vi.mocked(spawnSync).mockReset();
  vi.unstubAllGlobals();
  vi.doUnmock("../../scripts/build");
  vi.doUnmock("../../scripts/third-party-notices");
  vi.resetModules();
  rmSync(root, { recursive: true, force: true });
});

describe("immutable publication admission", () => {
  describe.each([
    { label: "signal-terminated E404 without a spawn error", status: null, signal: "SIGTERM" },
    { label: "unknown status without a signal", status: null, signal: null },
    { label: "negative status", status: -1, signal: null },
    { label: "fractional status", status: 1.5, signal: null },
    { label: "NaN status", status: NaN, signal: null },
    { label: "infinite status", status: Infinity, signal: null },
    { label: "nonzero status with a signal", status: 1, signal: "SIGTERM" },
    { label: "success output with a signal", status: 0, signal: "SIGTERM" },
  ])("incomplete lookup: $label", ({ status, signal }) => {
    const result = { status, signal, stdout: version, stderr: "npm error code E404\n" };

    it("rejects preflight before building or uploading", async () => {
      vi.mocked(spawnSync).mockReturnValueOnce(result as ReturnType<typeof spawnSync>);
      process.argv = ["bun", "release.ts"];
      const { main } = await import("../../scripts/release");
      await expect(main()).rejects.toThrow(/verify.*publication/i);
      expect(buildCount).toBe(0);
      expect(operations).toEqual([]);
      expect(uploads).toEqual([]);
    });

    it("blocks meta after platform uploads without retrying uploads or accepting a later lookup", async () => {
      vi.useFakeTimers();
      postUploadResult = result as ReturnType<typeof spawnSync>;
      process.argv = ["bun", "release.ts", "--skip-build"];
      const { main } = await import("../../scripts/release");
      const outcome = main().then(() => "unexpected success", (error: Error) => error.message);
      await vi.runAllTimersAsync();
      expect(await outcome).toMatch(/meta publication blocked.*verify.*publication/i);
      expect(visibilityQueries).toHaveLength(1);
      expect(uploads).toEqual(packageNames.slice(1));
    });
  });

  it("waits beyond 150 seconds for every exact platform version without repeating uploads", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    visibleAfter.set("easyresearch-linux-x64", 160_000);
    visibleAfter.set("easyresearch-darwin-arm64", 240_000);
    visibleAfter.set("easyresearch-windows-x64", 310_000);
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    process.argv = ["bun", "release.ts", "--skip-build"];
    const { main } = await import("../../scripts/release");
    const outcome = main().then(() => "complete", (error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(uploads).toEqual(packageNames.slice(1));
    await vi.runAllTimersAsync();
    expect(await outcome).toBe("complete");
    expect(uploads).toEqual([...packageNames.slice(1), "easyresearch"]);
    expect(logs.mock.calls.some(([line]) => /missing.*easyresearch-windows-x64@1\.2\.3/.test(String(line)))).toBe(true);
    logs.mockRestore();
  });

  it("blocks meta at the total deadline and bounds fresh registry subprocesses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    visibleAfter.set("easyresearch-darwin-arm64", Infinity);
    process.argv = ["bun", "release.ts", "--skip-build"];
    const { main } = await import("../../scripts/release");
    const outcome = main().then(() => "unexpected success", (error: Error) => error.message);
    await vi.runAllTimersAsync();
    expect(await outcome).toMatch(/meta publication blocked.*deadline.*easyresearch-darwin-arm64@1\.2\.3/is);
    expect(Date.now()).toBe(900_000);
    expect(uploads).toEqual(packageNames.slice(1));
    expect(visibilityQueries.length).toBeGreaterThan(0);
    for (const query of visibilityQueries) {
      expect(query.args).toContain("--prefer-online");
      expect(query.args).toContain("--fetch-retries=0");
      const fetchTimeout = Number(query.args.find((arg) => arg.startsWith("--fetch-timeout="))?.split("=")[1]);
      expect(fetchTimeout).toBeGreaterThan(0);
      expect(fetchTimeout).toBeLessThanOrEqual(query.timeout!);
      expect(query.timeout).toBeLessThanOrEqual(30_000);
      expect(query.killSignal).toBe("SIGKILL");
    }
  });

  it.each(["ECONNRESET", "E401"])("fails closed on post-upload %s without publishing meta or repeating uploads", async (code) => {
    postUploadFailure = code;
    process.argv = ["bun", "release.ts", "--skip-build"];
    const { main } = await import("../../scripts/release");
    await expect(main()).rejects.toThrow(/verify.*publication/i);
    expect(uploads).toEqual(packageNames.slice(1));
  });

  it("charges slow subprocesses to the total deadline and shrinks their last request budget", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    lookupCostMs = 7_000;
    visibleAfter.set("easyresearch-darwin-arm64", Infinity);
    process.argv = ["bun", "release.ts", "--skip-build"];
    const { main } = await import("../../scripts/release");
    const outcome = main().then(() => "unexpected success", (error: Error) => error.message);
    await vi.runAllTimersAsync();
    expect(await outcome).toMatch(/deadline/i);
    expect(Date.now()).toBe(900_000);
    const last = visibilityQueries.at(-1)!;
    expect(last.timeout).toBeGreaterThan(0);
    expect(last.timeout).toBeLessThan(lookupCostMs);
    expect(last.args).toContain(`--fetch-timeout=${last.timeout}`);
    expect(uploads).toEqual(packageNames.slice(1));
  });

  it.each([
    { status: 1, stdout: "", stderr: "npm error code E401" },
    { status: 0, stdout: "wrong-version", stderr: "" },
    { status: null, stdout: "", stderr: "npm error code E404", error: new Error("ETIMEDOUT") },
    { status: 0, stdout: version, stderr: "", error: new Error("ETIMEDOUT") },
  ])("does not admit an unverifiable pre-publication result: %j", async (result) => {
    vi.mocked(spawnSync).mockReturnValueOnce(result as ReturnType<typeof spawnSync>);
    process.argv = ["bun", "release.ts", "--skip-build"];
    const { main } = await import("../../scripts/release");
    await expect(main()).rejects.toThrow(/verify.*publication/i);
    expect(uploads).toEqual([]);
    expect(buildCount).toBe(0);
  });

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
