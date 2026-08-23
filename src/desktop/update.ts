const LATEST_RELEASE_URL = "https://api.github.com/repos/hdu-ailab/EasyResearch/releases/latest";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface SemanticVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<number | string>;
}

export interface DesktopReleaseUpdate {
  version: string;
  url: string;
}

export function parseSemanticVersion(value: string): SemanticVersion {
  const match = value.match(
    /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u,
  );
  if (!match) throw new Error(`Invalid semantic version: ${value}`);
  const core = [match[1], match[2], match[3]].map(Number);
  if (core.some((part) => !Number.isSafeInteger(part))) {
    throw new Error(`Invalid semantic version: ${value}`);
  }
  const prerelease = match[4]
    ? match[4].split(".").map((identifier): number | string => {
      if (!/^\d+$/u.test(identifier)) return identifier;
      if (identifier.length > 1 && identifier.startsWith("0")) {
        throw new Error(`Invalid semantic version: ${value}`);
      }
      const numeric = Number(identifier);
      if (!Number.isSafeInteger(numeric)) throw new Error(`Invalid semantic version: ${value}`);
      return numeric;
    })
    : [];
  return { major: core[0]!, minor: core[1]!, patch: core[2]!, prerelease };
}

export function compareSemanticVersions(left: string, right: string): -1 | 0 | 1 {
  const a = parseSemanticVersion(left);
  const b = parseSemanticVersion(right);
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] < b[key]) return -1;
    if (a[key] > b[key]) return 1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = a.prerelease[index];
    const rightIdentifier = b.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    if (typeof leftIdentifier === "number" && typeof rightIdentifier === "string") return -1;
    if (typeof leftIdentifier === "string" && typeof rightIdentifier === "number") return 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

export async function checkDesktopUpdate(
  currentVersion: string,
  options: { fetch?: FetchLike; timeoutMs?: number } = {},
): Promise<DesktopReleaseUpdate | null> {
  parseSemanticVersion(currentVersion);
  const response = await (options.fetch ?? fetch)(LATEST_RELEASE_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": `EasyResearch/${currentVersion}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
  });
  if (!response.ok) throw new Error(`GitHub Release check returned HTTP ${response.status}.`);
  const body = await response.json() as { tag_name?: unknown; html_url?: unknown };
  if (typeof body.tag_name !== "string" || typeof body.html_url !== "string") {
    throw new Error("GitHub Release check returned malformed metadata.");
  }
  const latest = parseSemanticVersion(body.tag_name);
  const version = formatSemanticVersion(latest);
  const url = validateReleaseUrl(body.html_url, body.tag_name);
  return compareSemanticVersions(version, currentVersion) > 0 ? { version, url } : null;
}

function formatSemanticVersion(version: SemanticVersion): string {
  const core = `${version.major}.${version.minor}.${version.patch}`;
  return version.prerelease.length > 0 ? `${core}-${version.prerelease.join(".")}` : core;
}

function validateReleaseUrl(value: string, tag: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error("GitHub Release metadata contained an invalid release URL.", { cause: error });
  }
  if (
    url.origin !== "https://github.com"
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
    || url.pathname !== `/hdu-ailab/EasyResearch/releases/tag/${tag}`
  ) {
    throw new Error("GitHub Release metadata contained an invalid release URL.");
  }
  return url.href;
}
