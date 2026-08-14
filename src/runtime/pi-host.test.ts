import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  disableVersionUpdateCheck,
  parseVersion,
  primeChangelogSeenVersion,
  shouldPrimeChangelogVersion,
  VERSION_CHECK_ENV,
} from "./pi-host";

const hoisted = vi.hoisted(() => ({
  originalEnv: "" as string | undefined,
  agentDir: "" as string,
  packageDir: "" as string,
  settings: {} as Record<string, unknown>,
}));

vi.mock("./pi-import", () => ({
  importPi: async () => ({
    getAgentDir: () => hoisted.agentDir,
    getPackageDir: () => hoisted.packageDir,
    SettingsManager: { create: () => ({ getGlobalSettings: () => hoisted.settings }) },
  }),
}));

function tempAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lr-pi-host-"));
  return dir;
}

afterEach(() => {
  if (hoisted.originalEnv === undefined) delete process.env[VERSION_CHECK_ENV];
  else process.env[VERSION_CHECK_ENV] = hoisted.originalEnv;
  hoisted.originalEnv = undefined;
  vi.clearAllMocks();
});

describe("disableVersionUpdateCheck (ADR-023)", () => {
  it("sets PI_SKIP_VERSION_CHECK=1", () => {
    hoisted.originalEnv = process.env[VERSION_CHECK_ENV];
    delete process.env[VERSION_CHECK_ENV];
    disableVersionUpdateCheck();
    expect(process.env[VERSION_CHECK_ENV]).toBe("1");
  });
});

describe("parseVersion", () => {
  it("parses leading X.Y.Z parts", () => {
    expect(parseVersion("0.83.0")).toEqual({ major: 0, minor: 83, patch: 0 });
    expect(parseVersion("1.2.3-alpha.1")).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it("returns null for non-versions", () => {
    expect(parseVersion("")).toBeNull();
    expect(parseVersion("latest")).toBeNull();
    expect(parseVersion("0.1")).toBeNull();
  });
});

describe("shouldPrimeChangelogVersion (ADR-024)", () => {
  it("primes when the watermark is missing", () => {
    expect(shouldPrimeChangelogVersion(undefined, "0.83.0")).toBe(true);
  });

  it("primes when the watermark is behind upstream", () => {
    expect(shouldPrimeChangelogVersion("0.1.0", "0.83.0")).toBe(true);
    expect(shouldPrimeChangelogVersion("0.82.9", "0.83.0")).toBe(true);
  });

  it("treats a pre-release of the same version as caught up (naive compare, like Pi)", () => {
    expect(shouldPrimeChangelogVersion("0.83.0-alpha.1", "0.83.0")).toBe(false);
  });

  it("does not prime when the watermark is at or above upstream", () => {
    expect(shouldPrimeChangelogVersion("0.83.0", "0.83.0")).toBe(false);
    expect(shouldPrimeChangelogVersion("9.0.0", "0.83.0")).toBe(false);
  });

  it("does not prime when the upstream version itself is unparseable", () => {
    expect(shouldPrimeChangelogVersion("0.1.0", "not-a-version")).toBe(false);
  });

  it("primes when the stored watermark is unparseable", () => {
    expect(shouldPrimeChangelogVersion("garbage", "0.83.0")).toBe(true);
  });
});

describe("primeChangelogSeenVersion (ADR-024)", () => {
  it("writes the upstream version, preserving every other settings field", async () => {
    const agentDir = tempAgentDir();
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ lastChangelogVersion: "0.1.0", theme: "dark" }, null, 2));
    const wrote = await primeChangelogSeenVersion({ agentDir, upstreamVersion: "0.83.0" });
    expect(wrote).toBe(true);
    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as Record<string, string>;
    expect(settings.lastChangelogVersion).toBe("0.83.0");
    expect(settings.theme).toBe("dark");
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("creates the settings file when it does not exist", async () => {
    const agentDir = tempAgentDir();
    const wrote = await primeChangelogSeenVersion({ agentDir, upstreamVersion: "0.83.0" });
    expect(wrote).toBe(true);
    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as Record<string, string>;
    expect(settings.lastChangelogVersion).toBe("0.83.0");
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("leaves the file untouched when the watermark is already current", async () => {
    const agentDir = tempAgentDir();
    const path = join(agentDir, "settings.json");
    writeFileSync(path, JSON.stringify({ lastChangelogVersion: "0.83.0", theme: "dark" }, null, 2));
    const before = readFileSync(path, "utf8");
    const wrote = await primeChangelogSeenVersion({ agentDir, upstreamVersion: "0.83.0" });
    expect(wrote).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(before);
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("never downgrades a newer stored watermark", async () => {
    const agentDir = tempAgentDir();
    const path = join(agentDir, "settings.json");
    writeFileSync(path, JSON.stringify({ lastChangelogVersion: "9.9.9" }, null, 2));
    const wrote = await primeChangelogSeenVersion({ agentDir, upstreamVersion: "0.83.0" });
    expect(wrote).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ lastChangelogVersion: "9.9.9" });
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("does nothing when the upstream version cannot be resolved", async () => {
    const agentDir = tempAgentDir();
    const wrote = await primeChangelogSeenVersion({ agentDir, upstreamVersion: "nope" });
    expect(wrote).toBe(false);
    expect(existsSync(join(agentDir, "settings.json"))).toBe(false);
    rmSync(agentDir, { recursive: true, force: true });
  });
});
