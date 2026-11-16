import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
const publishOrder = [...packageNames.slice(1), "easyresearch"];
const githubEnv = {
  GITHUB_ACTIONS: "true",
  RUNNER_ENVIRONMENT: "github-hosted",
  GITHUB_REPOSITORY: "hdu-ailab/EasyResearch",
  GITHUB_REF: `refs/tags/v${version}`,
  GITHUB_WORKFLOW_REF: `hdu-ailab/EasyResearch/.github/workflows/release.yml@refs/tags/v${version}`,
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://fixture.actions.githubusercontent.com/idtoken?request=private-request-url&audience=old",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "private-request-token",
};
const tokenEnvKeys = ["NPM_TOKEN", "NODE_AUTH_TOKEN", "NPM_ID_TOKEN"];
const identityToken = "private-github-identity-token";
const exchangeToken = "private-npm-exchange-token";
const privateBody = "private-response-body";
const privateError = "private-transport-error";
const fetchMock = vi.fn<typeof fetch>();
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
let loginResult: { status: number | null; stdout: string; stderr: string; error?: Error; signal?: string | null };
let loginThrows: boolean;
let npmCalls: Array<{ args: string[]; options?: { cwd?: string; timeout?: number; killSignal?: string; env?: NodeJS.ProcessEnv } }>;
const argv = process.argv;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "release-publication-"));
  const home = join(root, "home");
  mkdirSync(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("EASYRESEARCH_CODING_AGENT_DIR", join(home, ".easyresearch", "agent"));
  for (const key of ["NPM_CONFIG_USERCONFIG", "npm_config_userconfig"]) vi.stubEnv(key, join(home, "user.npmrc"));
  for (const key of ["NPM_CONFIG_GLOBALCONFIG", "npm_config_globalconfig"]) vi.stubEnv(key, join(home, "global.npmrc"));
  for (const key of [...Object.keys(githubEnv), ...tokenEnvKeys]) vi.stubEnv(key, undefined);
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
  loginResult = { status: 0, stdout: "fixture-user", stderr: "" };
  loginThrows = false;
  npmCalls = [];
  fetchMock.mockReset().mockRejectedValue(new Error("Network access is forbidden in release tests"));
  vi.stubGlobal("fetch", fetchMock);
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
       npmCalls.push({ args: [...args], options });
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
       if (args[0] === "whoami") {
         if (loginThrows) throw new Error(privateError);
         return loginResult;
       }
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
  vi.unstubAllEnvs();
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

describe("release authentication admission", () => {
  let releaseMain: () => Promise<void>;
  let diagnostics: unknown[][];

  beforeEach(async () => {
    process.argv = ["bun", "release.ts", "--skip-build"];
    diagnostics = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { diagnostics.push(args); });
    }
    releaseMain = (await import("../../scripts/release")).main;
  });

  function setGitHubContext(): void {
    for (const [key, value] of Object.entries(githubEnv)) vi.stubEnv(key, value);
  }

  function exchangeBody(): Record<string, unknown> {
    return {
      token_type: "oidc", token: exchangeToken,
      created: new Date(Date.now()).toISOString(), expires: new Date(Date.now() + 60_000).toISOString(),
    };
  }

  function mockOidc(override?: (name: string | undefined, init: RequestInit) => Response | Promise<Response> | undefined): void {
    fetchMock.mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const isIdentity = url.origin === new URL(githubEnv.ACTIONS_ID_TOKEN_REQUEST_URL).origin;
      const name = isIdentity ? undefined : decodeURIComponent(url.pathname.split("/").at(-1)!);
      operations.push(isIdentity ? "identity" : `exchange:${name}`);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.redirect).toBe("error");
      expect(init?.cache).toBe("no-store");
      expect(init?.body).toBeUndefined();
      expect(new Headers(init?.headers).get("accept")).toBe("application/json");
      expect(new Headers(init?.headers).get("authorization"))
        .toBe(`Bearer ${isIdentity ? githubEnv.ACTIONS_ID_TOKEN_REQUEST_TOKEN : identityToken}`);
      if (isIdentity) {
        expect(init?.method).toBe("GET");
        expect(url.searchParams.getAll("audience")).toEqual(["npm:registry.npmjs.org"]);
        expect(url.searchParams.get("request")).toBe("private-request-url");
      } else {
        expect(init?.method).toBe("POST");
        expect(packageNames).toContain(name);
        expect(url.href).toBe(`https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/${name}`);
      }
      return override?.(name, init!) ?? Response.json(
        isIdentity ? { value: identityToken } : exchangeBody(), { status: isIdentity ? 200 : 201 },
      );
    });
  }

  function expectSanitized(error?: Error): void {
    expect(error?.cause).toBeUndefined();
    const output = [String(error ?? ""), error?.stack, JSON.stringify(error), JSON.stringify(diagnostics)].join("\n");
    for (const secret of [
      "private-request-url", githubEnv.ACTIONS_ID_TOKEN_REQUEST_TOKEN, identityToken, exchangeToken,
      privateBody, privateError, "private-env-value",
    ]) expect(output).not.toContain(secret);
    expect(readdirSync(join(root, "home"), { recursive: true })).toEqual([]);
  }

  async function expectAuthFailure(message: RegExp, github = true): Promise<void> {
    const result = await releaseMain().then(() => undefined, (error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(message);
    expectSanitized(result as Error);
    expect(uploads).toEqual([]);
    expect(operations).not.toContain("publish");
    if (github) expect(operations).not.toContain("whoami");
  }

  it("preflights every platform and meta identity before any upload, then lets npm publish with provenance", async () => {
    setGitHubContext();
    mockOidc();
    const envKeys = Object.keys(process.env).sort();
    await releaseMain();

    expect(fetchMock).toHaveBeenCalledTimes(packageNames.length + 1);
    expect(operations.filter((operation) => operation.startsWith("exchange:")))
      .toEqual(publishOrder.map((name) => `exchange:${name}`));
    for (const name of packageNames) {
      expect(operations.indexOf(`exchange:${name}`)).toBeLessThan(operations.indexOf("publish"));
    }
    expect(operations).not.toContain("whoami");
    expect(uploads).toEqual(publishOrder);
    for (const call of npmCalls.filter((call) => call.args[0] === "publish")) {
      expect(call.args).toContain("--provenance");
      expect(call.options?.env).toBeUndefined();
    }
    expect(JSON.stringify(npmCalls)).not.toContain(identityToken);
    expect(JSON.stringify(npmCalls)).not.toContain(exchangeToken);
    expect(Object.keys(process.env).sort()).toEqual(envKeys);
    for (const [key, value] of Object.entries(githubEnv)) expect(process.env[key]).toBe(value);
    for (const key of tokenEnvKeys) expect(process.env[key]).toBeUndefined();
    expectSanitized();
  });

  it("waits for the meta exchange response body before allowing the first platform upload", async () => {
    setGitHubContext();
    let finishMeta: ((body: unknown) => void) | undefined;
    mockOidc((name) => {
      if (name !== "easyresearch") return undefined;
      return {
        status: 201,
        json: () => new Promise((resolve) => { finishMeta = resolve; }),
      } as Response;
    });
    const outcome = releaseMain();
    await vi.waitFor(() => { expect(finishMeta).toBeTypeOf("function"); });
    expect(uploads).toEqual([]);
    expect(operations).not.toContain("whoami");
    finishMeta!(exchangeBody());
    await outcome;
    expect(uploads).toEqual(publishOrder);
    expectSanitized();
  });

  it.each(Object.keys(githubEnv))("rejects missing %s instead of falling back to login", async (key) => {
    setGitHubContext();
    vi.stubEnv(key, undefined);
    await expectAuthFailure(/GitHub OIDC.*complete.*context/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(Object.keys(githubEnv))("rejects a partial context containing only %s", async (key) => {
    vi.stubEnv(key, githubEnv[key as keyof typeof githubEnv]);
    await expectAuthFailure(/GitHub OIDC.*complete.*context/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["GITHUB_ACTIONS", "false"],
    ["RUNNER_ENVIRONMENT", "self-hosted"],
    ["GITHUB_REPOSITORY", "private-env-value"],
    ["GITHUB_REF", "refs/heads/private-env-value"],
    ["GITHUB_WORKFLOW_REF", "private-env-value"],
    ["ACTIONS_ID_TOKEN_REQUEST_TOKEN", " \t"],
    ["ACTIONS_ID_TOKEN_REQUEST_URL", ""],
  ])("rejects invalid %s context without exposing its value", async (key, value) => {
    setGitHubContext();
    vi.stubEnv(key, value);
    await expectAuthFailure(/GitHub OIDC.*complete.*context/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    "private-env-value", "http://fixture.invalid/private-env-value",
    "https://private-env-value@fixture.invalid/", "https://fixture.invalid/#private-env-value",
  ])("rejects an invalid identity request URL without disclosing it (%#)", async (url) => {
    setGitHubContext();
    vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_URL", url);
    await expectAuthFailure(/Invalid GitHub OIDC request URL/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe.each(tokenEnvKeys)("ambient %s", (key) => {
    it.each(["private-env-value", ""])("blocks GitHub publication when the variable is present (%#)", async (value) => {
      setGitHubContext();
      vi.stubEnv(key, value);
      await expectAuthFailure(/requires.*to be unset/);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it.each(publishOrder)("leaves zero uploads when identity exchange fails for %s", async (failedName) => {
    setGitHubContext();
    const rejected = Response.json({ token: exchangeToken, message: privateBody }, { status: 401 });
    const readBody = vi.spyOn(rejected, "json");
    mockOidc((name) => name === failedName ? rejected : undefined);
    await expectAuthFailure(new RegExp(`npm OIDC exchange for ${failedName} failed \\(HTTP 401\\)`));
    expect(readBody).not.toHaveBeenCalled();
    expect(operations.filter((operation) => operation.startsWith("exchange:")))
      .toEqual(publishOrder.slice(0, publishOrder.indexOf(failedName) + 1).map((name) => `exchange:${name}`));
  });

  it.each([200, 202, 302, 403, 404, 429, 500])("rejects meta exchange HTTP %s before uploading platforms", async (status) => {
    setGitHubContext();
    mockOidc((name) => name === "easyresearch" ? Response.json({ ...exchangeBody(), message: privateBody }, { status }) : undefined);
    await expectAuthFailure(new RegExp(`npm OIDC exchange for easyresearch failed \\(HTTP ${status}\\)`));
  });

  it.each([
    { label: "missing token type", change: { token_type: undefined } },
    { label: "wrong token type", change: { token_type: "bearer" } },
    { label: "missing token", change: { token: undefined } },
    { label: "blank token", change: { token: " \t" } },
    { label: "non-string token", change: { token: 123 } },
    { label: "missing expiry", change: { expires: undefined } },
    { label: "invalid expiry", change: { expires: privateBody } },
    { label: "non-string expiry", change: { expires: Number.MAX_SAFE_INTEGER } },
    { label: "expired token", change: { expires: "2000-01-01T00:00:00.000Z" } },
  ])("rejects $label in the meta exchange, with no credential diagnostics or uploads", async ({ change }) => {
    setGitHubContext();
    mockOidc((name) => name === "easyresearch" ? Response.json({ ...exchangeBody(), ...change }, { status: 201 }) : undefined);
    await expectAuthFailure(/Invalid npm OIDC exchange response for easyresearch/);
  });

  it("requires expiry to be strictly later than validation time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-16T08:00:00Z"));
    setGitHubContext();
    mockOidc((name) => name === "easyresearch" ? Response.json({ ...exchangeBody(), expires: new Date().toISOString() }, { status: 201 }) : undefined);
    await expectAuthFailure(/Invalid npm OIDC exchange response for easyresearch/);
  });

  describe.each(["identity", "exchange"] as const)("%s response failures", (stage) => {
    function isStage(name: string | undefined): boolean {
      return stage === "identity" ? name === undefined : name === "easyresearch";
    }

    it.each(["null", "array", "malformed JSON", "body failure", "transport failure"])("rejects %s without leaking response or cause", async (kind) => {
      setGitHubContext();
      mockOidc((name) => {
        if (!isStage(name)) return undefined;
        const status = stage === "identity" ? 200 : 201;
        if (kind === "null") return Response.json(null, { status });
        if (kind === "array") return Response.json([privateBody], { status });
        if (kind === "malformed JSON") return new Response(`{"token":"${exchangeToken}",${privateBody}`, { status });
        const error = new Error(privateError, { cause: { token: exchangeToken, body: privateBody } });
        if (kind === "transport failure") throw error;
        return { status, json: async () => { throw error; } } as unknown as Response;
      });
      await expectAuthFailure(/OIDC.*failed/);
    });

    it.each(["headers", "body"])("bounds stalled %s, aborts the request and ignores late completion", async (part) => {
      vi.useFakeTimers();
      setGitHubContext();
      let signal: AbortSignal | null | undefined;
      let completeLate: (() => void) | undefined;
      mockOidc((name, init) => {
        if (!isStage(name)) return undefined;
        signal = init.signal;
        const status = stage === "identity" ? 200 : 201;
        const data = stage === "identity" ? { value: identityToken } : exchangeBody();
        if (part === "headers") {
          return new Promise<Response>((resolve) => { completeLate = () => resolve(Response.json(data, { status })); });
        }
        return {
          status,
          json: () => new Promise((resolve) => { completeLate = () => resolve(data); }),
        } as Response;
      });
      const started = Date.now();
      const outcome = expectAuthFailure(/OIDC.*timed out/);
      await vi.runAllTimersAsync();
      await outcome;
      expect(Date.now() - started).toBeGreaterThan(0);
      expect(Date.now() - started).toBeLessThanOrEqual(30_000);
      expect(signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      completeLate!();
      await vi.runAllTimersAsync();
      expect(uploads).toEqual([]);
      expectSanitized();
    });
  });

  it.each([undefined, "", " \n", 123])("rejects an invalid GitHub identity value before exchanges (%#)", async (value) => {
    setGitHubContext();
    mockOidc((name) => name === undefined ? Response.json({ value, message: privateBody }) : undefined);
    await expectAuthFailure(/Invalid GitHub OIDC identity response/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a failed GitHub identity request even if the response contains a token", async () => {
    setGitHubContext();
    mockOidc((name) => name === undefined ? Response.json({ value: identityToken, message: privateBody }, { status: 403 }) : undefined);
    await expectAuthFailure(/GitHub OIDC identity request failed \(HTTP 403\)/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses a bounded official-registry whoami for local manual publication", async () => {
    await releaseMain();
    expect(fetchMock).not.toHaveBeenCalled();
    const login = npmCalls.filter((call) => call.args[0] === "whoami");
    expect(login).toHaveLength(1);
    expect(login[0]!.args).toContain("--fetch-retries=0");
    const fetchTimeout = Number(login[0]!.args.find((arg) => arg.startsWith("--fetch-timeout="))?.split("=")[1]);
    expect(fetchTimeout).toBeGreaterThan(0);
    expect(fetchTimeout).toBeLessThanOrEqual(login[0]!.options!.timeout!);
    expect(login[0]!.options!.timeout).toBeLessThanOrEqual(30_000);
    expect(login[0]!.options!.killSignal).toBe("SIGKILL");
    expect(operations.indexOf("whoami")).toBeLessThan(operations.indexOf("publish"));
    expect(uploads).toEqual(publishOrder);
    for (const call of npmCalls.filter((call) => call.args[0] === "publish")) expect(call.args).not.toContain("--provenance");
    expectSanitized();
  });

  it.each([
    { label: "not logged in", status: 1, stdout: privateBody, stderr: privateError },
    { label: "empty identity", status: 0, stdout: " \n", stderr: privateError },
    { label: "spawn failure", status: null, stdout: privateBody, stderr: privateError, error: new Error(privateError) },
    { label: "timeout with output", status: 0, stdout: privateBody, stderr: privateError, error: new Error(privateError) },
    { label: "signal termination", status: 0, stdout: privateBody, stderr: privateError, signal: "SIGTERM" },
  ])("blocks local publication on $label without exposing subprocess diagnostics", async (result) => {
    loginResult = result;
    await expectAuthFailure(/npm login check failed.*npm login/, false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(operations).toContain("whoami");
  });

  it("sanitizes a thrown local login subprocess error", async () => {
    loginThrows = true;
    await expectAuthFailure(/npm login check failed/, false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["local", "GitHub", "partial GitHub", "legacy token"])("skips all authentication for a %s dry run", async (context) => {
    if (context !== "local") setGitHubContext();
    if (context === "partial GitHub") vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", undefined);
    if (context === "legacy token") vi.stubEnv("NPM_TOKEN", "private-env-value");
    process.argv = ["bun", "release.ts", "--skip-build", "--dry-run"];
    await releaseMain();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(operations).not.toContain("whoami");
    expect(operations).not.toContain("publish");
    expect(uploads).toEqual([]);
    expect(operations.filter((operation) => operation === "pack")).toHaveLength(packageNames.length);
    expectSanitized();
  });
});
