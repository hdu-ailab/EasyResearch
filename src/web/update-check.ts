import type { UpdateCheckDto } from "./contracts";

export const NPM_LATEST_URL = "https://registry.npmjs.org/easyresearch/latest";
const UPDATE_CHECK_TIMEOUT_MS = 5000;

interface SemanticVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function parseSemanticVersion(version: string): SemanticVersion | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
    version,
  );
  if (!match) return null;

  const core = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (core.some((part) => !Number.isSafeInteger(part))) return null;

  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) return null;

  return { major: core[0]!, minor: core[1]!, patch: core[2]!, prerelease };
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) {
    if (left.length === right.length) return 0;
    return left.length === 0 ? 1 : -1;
  }

  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;

    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      if (leftPart.length !== rightPart.length) return leftPart.length > rightPart.length ? 1 : -1;
      return leftPart > rightPart ? 1 : -1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart > rightPart ? 1 : -1;
  }

  return 0;
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const candidateVersion = parseSemanticVersion(candidate);
  const currentVersion = parseSemanticVersion(current);
  if (!candidateVersion || !currentVersion) return false;

  for (const key of ["major", "minor", "patch"] as const) {
    if (candidateVersion[key] !== currentVersion[key]) return candidateVersion[key] > currentVersion[key];
  }
  return comparePrerelease(candidateVersion.prerelease, currentVersion.prerelease) > 0;
}

/** Registry availability must never affect the local Web panel. */
export async function checkNpmUpdate(
  currentVersion: string,
  options: { fetch?: Fetcher; timeoutMs?: number } = {},
): Promise<UpdateCheckDto> {
  try {
    const response = await (options.fetch ?? globalThis.fetch)(NPM_LATEST_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS),
    });
    if (!response.ok) return { latestVersion: null };

    const body = (await response.json()) as unknown;
    if (!body || typeof body !== "object" || typeof (body as { version?: unknown }).version !== "string") {
      return { latestVersion: null };
    }
    const latestVersion = (body as { version: string }).version;
    return { latestVersion: isNewerVersion(latestVersion, currentVersion) ? latestVersion : null };
  } catch {
    return { latestVersion: null };
  }
}
