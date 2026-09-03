import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { importPi } from "./pi-import";
import { parsePiSettingsJson } from "./pi-settings-json";

/** Pi's documented switch for the automatic version update check. */
export const VERSION_CHECK_ENV = "PI_SKIP_VERSION_CHECK";

/**
 * ADR-023: EasyResearch is a rebranded host distribution; Pi's "new version
 * available" notification would point at the upstream package and is noise.
 * `PI_SKIP_VERSION_CHECK` is Pi's documented env switch (.docs/pi/settings.md);
 * `PI_OFFLINE` is deliberately not used — it would also disable the model
 * catalog refresh needed for first runs.
 */
export function disableVersionUpdateCheck(): void {
  process.env[VERSION_CHECK_ENV] = "1";
}

export interface VersionParts {
  major: number;
  minor: number;
  patch: number;
}

/** Parse a leading "X.Y.Z" version; null when the string is not a version. */
export function parseVersion(version: string): VersionParts | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/**
 * ADR-024: Pi renders its "What's New" changelog notice whenever the stored
 * `lastChangelogVersion` watermark is lower than any changelog entry, and it
 * rewrites the watermark to its own `VERSION` constant — which the identity
 * bootstrap (ADR-016) binds to EasyResearch's package version, so upstream
 * release notes would otherwise look new on every launch forever. The host
 * primes the watermark to the pinned upstream version instead. A missing or
 * unparseable watermark is treated as behind; a value at or above upstream is
 * never touched.
 */
export function shouldPrimeChangelogVersion(
  stored: string | undefined,
  upstream: string,
): boolean {
  const upstreamParts = parseVersion(upstream);
  if (!upstreamParts) return false;
  const storedParts = stored ? parseVersion(stored) : null;
  if (!storedParts) return true;
  return (
    storedParts.major < upstreamParts.major ||
    (storedParts.major === upstreamParts.major && storedParts.minor < upstreamParts.minor) ||
    (storedParts.major === upstreamParts.major &&
      storedParts.minor === upstreamParts.minor &&
      storedParts.patch < upstreamParts.patch)
  );
}

export interface PrimeChangelogOptions {
  agentDir?: string;
  upstreamVersion?: string;
}

/**
 * Prime the global settings `lastChangelogVersion` to the pinned upstream Pi
 * version when it is missing or behind, preserving every other field. Returns
 * whether a write happened. The upstream version is read at runtime from the
 * pinned package via Pi's own `getPackageDir()` — never `pi.VERSION`, which is
 * the EasyResearch identity version. Unreadable settings are left untouched.
 */
export async function primeChangelogSeenVersion(
  options: PrimeChangelogOptions = {},
): Promise<boolean> {
  const pi = await importPi();
  const agentDir = options.agentDir ?? pi.getAgentDir();
  const upstreamVersion =
    options.upstreamVersion ?? readUpstreamVersion(pi.getPackageDir());
  if (!upstreamVersion) return false;

  const settingsPath = join(agentDir, "settings.json");
  let settings: Record<string, unknown> = {};
  let stored: string | undefined;
  try {
    if (existsSync(settingsPath)) {
      settings = parsePiSettingsJson(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
      const value = settings.lastChangelogVersion;
      stored = typeof value === "string" ? value : undefined;
    }
  } catch {
    return false;
  }
  if (!shouldPrimeChangelogVersion(stored, upstreamVersion)) return false;

  const next = { ...settings, lastChangelogVersion: upstreamVersion };
  const tmpPath = `${settingsPath}.tmp`;
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(tmpPath, JSON.stringify(next, null, 2), "utf8");
  renameSync(tmpPath, settingsPath);
  return true;
}

function readUpstreamVersion(packageDir: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}
