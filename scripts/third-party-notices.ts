import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
  THIRD_PARTY_LICENSE_OVERRIDES,
  type ThirdPartyLicenseOverride,
} from "./third-party-license-overrides";

export const THIRD_PARTY_NOTICES_FILE = "THIRD_PARTY_NOTICES.txt";
export const THIRD_PARTY_NOTICE_ROOTS = [
  { name: "axios", version: "1.19.0" },
  { name: "open-websearch", version: "2.1.11" },
] as const;

export interface ThirdPartyTextFile {
  fileName: string;
  text: string;
}

export interface ThirdPartyNoticeEntry {
  name: string;
  version: string;
  license: string;
  licenseTexts: readonly ThirdPartyTextFile[];
  noticeTexts: readonly ThirdPartyTextFile[];
}

interface LockPackageMetadata {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalPeers?: string[];
}

interface LockPackage {
  identity: string;
  metadata: LockPackageMetadata;
}

interface BunLock {
  workspaces?: Record<
    string,
    {
      dependencies?: Record<string, string>;
    }
  >;
  packages: Record<string, unknown>;
}

interface PackageOwner {
  lockKey: string;
  packageDir: string;
}

interface PackageResolution extends PackageOwner {
  ancestors: PackageOwner[];
}

interface PackageManifest {
  name?: unknown;
  version?: unknown;
  license?: unknown;
  licenses?: unknown;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseJsonFile(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function stripJsonComments(text: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    const nextCharacter = text[index + 1];
    if (inString) {
      result += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      result += character;
      continue;
    }
    if (character === "/" && nextCharacter === "/") {
      result += "  ";
      index += 2;
      while (index < text.length && text[index] !== "\n") {
        result += text[index] === "\r" ? "\r" : " ";
        index += 1;
      }
      if (index < text.length) result += text[index];
      continue;
    }
    if (character === "/" && nextCharacter === "*") {
      result += "  ";
      index += 2;
      while (
        index < text.length &&
        !(text[index] === "*" && text[index + 1] === "/")
      ) {
        result += text[index] === "\n" || text[index] === "\r" ? text[index] : " ";
        index += 1;
      }
      if (index >= text.length) throw new Error("Invalid JSONC: unterminated block comment");
      result += " ";
      index += 1;
      continue;
    }
    result += character;
  }
  return result;
}

function stripTrailingJsonCommas(text: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (inString) {
      result += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      result += character;
      continue;
    }
    if (character === ",") {
      let nextIndex = index + 1;
      while (nextIndex < text.length && /\s/.test(text[nextIndex]!)) nextIndex += 1;
      if (text[nextIndex] === "}" || text[nextIndex] === "]") continue;
    }
    result += character;
  }
  return result;
}

function parseJsonc(text: string): unknown {
  const bun = (globalThis as {
    Bun?: { JSONC?: { parse(value: string): unknown } };
  }).Bun;
  if (bun?.JSONC) return bun.JSONC.parse(text);

  return JSON.parse(stripTrailingJsonCommas(stripJsonComments(text)));
}

function parseLock(projectRoot: string): BunLock {
  const parsed = parseJsonc(readFileSync(join(projectRoot, "bun.lock"), "utf8"));
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid bun.lock: expected an object");
  }
  const lock = parsed as Partial<BunLock>;
  if (!lock.packages || typeof lock.packages !== "object") {
    throw new Error("Invalid bun.lock: missing packages");
  }
  return lock as BunLock;
}

function parseLockPackage(lockKey: string, row: unknown): LockPackage {
  if (!Array.isArray(row) || typeof row[0] !== "string") {
    throw new Error(`Invalid bun.lock package row for ${lockKey}`);
  }
  const metadata = row[2];
  if (metadata !== undefined && (!metadata || typeof metadata !== "object")) {
    throw new Error(`Invalid bun.lock package metadata for ${lockKey}`);
  }
  return {
    identity: row[0],
    metadata: (metadata ?? {}) as LockPackageMetadata,
  };
}

function splitIdentity(identity: string): { name: string; version: string } {
  const separator = identity.lastIndexOf("@");
  if (separator <= 0 || separator === identity.length - 1) {
    throw new Error(`Invalid package identity in bun.lock: ${identity}`);
  }
  return {
    name: identity.slice(0, separator),
    version: identity.slice(separator + 1),
  };
}

function normalizeText(text: string): string {
  const normalized = text.replace(/\r\n?/g, "\n").replace(/\n+$/g, "");
  return `${normalized}\n`;
}

function readTextFile(filePath: string): string {
  return normalizeText(readFileSync(filePath, "utf8"));
}

function isLicenseFile(fileName: string): boolean {
  const upperName = fileName.toUpperCase();
  return upperName.startsWith("LICENSE") || upperName.startsWith("LICENCE");
}

function readRootLegalFiles(
  packageDir: string,
  predicate: (fileName: string) => boolean,
): ThirdPartyTextFile[] {
  return readdirSync(packageDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && predicate(entry.name))
    .map((entry) => entry.name)
    .sort(compareCodePoints)
    .map((fileName) => ({
      fileName,
      text: readTextFile(join(packageDir, fileName)),
    }));
}

function licenseValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (
    value &&
    typeof value === "object" &&
    "type" in value &&
    typeof value.type === "string" &&
    value.type.trim()
  ) {
    return value.type.trim();
  }
  return undefined;
}

function packageLicense(manifest: PackageManifest): string | undefined {
  const primary = licenseValue(manifest.license);
  if (primary) return primary;
  if (!Array.isArray(manifest.licenses)) return undefined;
  const licenses = manifest.licenses.map(licenseValue);
  if (licenses.some((value) => value === undefined)) return undefined;
  return [...new Set(licenses)].join(" OR ") || undefined;
}

function requireRegularFile(filePath: string, message: string): void {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    throw new Error(message);
  }
}

function readRequiredLicenseFile(
  packageDir: string,
  identity: string,
  fileName: string,
): ThirdPartyTextFile {
  const filePath = join(packageDir, fileName);
  requireRegularFile(
    filePath,
    `Required license file ${fileName} missing for ${identity}`,
  );
  const text = readTextFile(filePath);
  if (!text.trim()) {
    throw new Error(`Empty required license file ${fileName} for ${identity}`);
  }
  return { fileName, text };
}

function reviewedLicenseText(
  projectRoot: string,
  packageDir: string,
  identity: string,
  override: ThirdPartyLicenseOverride,
): ThirdPartyTextFile[] {
  if ("requiredLicenseFile" in override) {
    return [readRequiredLicenseFile(packageDir, identity, override.requiredLicenseFile)];
  }
  if ("readmeFile" in override) {
    const filePath = join(packageDir, override.readmeFile);
    requireRegularFile(filePath, `Reviewed README ${override.readmeFile} missing for ${identity}`);
    const readme = readTextFile(filePath);
    const readmeLines = readme.split("\n");
    const headingLines = normalizeText(override.heading).slice(0, -1).split("\n");
    const headingLineIndex = readmeLines.findIndex((_, startIndex) =>
      headingLines.every(
        (headingLine, offset) =>
          readmeLines[startIndex + offset]?.trimEnd() === headingLine.trimEnd(),
      ),
    );
    if (headingLineIndex < 0) {
      throw new Error(`Reviewed README heading missing for ${identity}: ${override.heading}`);
    }
    return [
      {
        fileName: override.readmeFile,
        text: normalizeText(readmeLines.slice(headingLineIndex).join("\n")),
      },
    ];
  }

  const filePath = join(projectRoot, override.licenseTextFile);
  requireRegularFile(
    filePath,
    `Reviewed license text ${override.licenseTextFile} missing for ${identity}`,
  );
  const bytes = readFileSync(filePath);
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (actualHash !== override.upstreamSha256) {
    throw new Error(`Reviewed license hash mismatch for ${identity}`);
  }
  return [
    {
      fileName: basename(override.licenseTextFile),
      text: normalizeText(bytes.toString("utf8")),
    },
  ];
}

function collectPackageEntry(
  projectRoot: string,
  resolution: PackageResolution,
  lockPackage: LockPackage,
): ThirdPartyNoticeEntry {
  const lockIdentity = splitIdentity(lockPackage.identity);
  const manifestPath = join(resolution.packageDir, "package.json");
  requireRegularFile(
    manifestPath,
    `Installed package metadata missing for ${lockPackage.identity}`,
  );
  const manifest = parseJsonFile(manifestPath) as PackageManifest;
  const installedIdentity = `${String(manifest.name)}@${String(manifest.version)}`;
  if (manifest.name !== lockIdentity.name || manifest.version !== lockIdentity.version) {
    throw new Error(
      `Installed package identity ${installedIdentity} does not match lock ${lockPackage.identity}`,
    );
  }

  const override = THIRD_PARTY_LICENSE_OVERRIDES[lockPackage.identity];
  const declaredLicense = packageLicense(manifest);
  if (!declaredLicense && !override) {
    throw new Error(`Missing license metadata for ${lockPackage.identity}`);
  }
  if (declaredLicense && override && declaredLicense !== override.license) {
    throw new Error(
      `License metadata mismatch for ${lockPackage.identity}: expected ${override.license}, found ${declaredLicense}`,
    );
  }
  const license = declaredLicense ?? override!.license;
  let licenseTexts = readRootLegalFiles(resolution.packageDir, isLicenseFile);
  let requiredLicenseText: ThirdPartyTextFile | undefined;
  if (override && "requiredLicenseFile" in override) {
    requiredLicenseText = readRequiredLicenseFile(
      resolution.packageDir,
      lockPackage.identity,
      override.requiredLicenseFile,
    );
  }
  if (licenseTexts.length === 0) {
    if (!override) {
      throw new Error(`No reviewed license text for ${lockPackage.identity}`);
    }
    licenseTexts = requiredLicenseText
      ? [requiredLicenseText]
      : reviewedLicenseText(
          projectRoot,
          resolution.packageDir,
          lockPackage.identity,
          override,
        );
  }
  if (licenseTexts.every((file) => file.text.trim().length === 0)) {
    throw new Error(`Empty license text for ${lockPackage.identity}`);
  }

  return {
    name: lockIdentity.name,
    version: lockIdentity.version,
    license,
    licenseTexts,
    noticeTexts: readRootLegalFiles(
      resolution.packageDir,
      (fileName) =>
        fileName === "NOTICE" || fileName === "NOTICE.txt" || fileName === "NOTICE.md",
    ),
  };
}

function resolveDependency(
  projectRoot: string,
  lock: BunLock,
  current: PackageResolution,
  dependencyName: string,
): PackageResolution | undefined {
  const owners = [current, ...current.ancestors];
  for (const [index, owner] of owners.entries()) {
    const candidateKey = `${owner.lockKey}/${dependencyName}`;
    const candidateDir = join(owner.packageDir, "node_modules", dependencyName);
    if (lock.packages[candidateKey] && existsSync(candidateDir)) {
      return {
        lockKey: candidateKey,
        packageDir: candidateDir,
        ancestors: owners.slice(index),
      };
    }
  }
  const rootDir = join(projectRoot, "node_modules", dependencyName);
  if (lock.packages[dependencyName] && existsSync(rootDir)) {
    return { lockKey: dependencyName, packageDir: rootDir, ancestors: [] };
  }
  return undefined;
}

function validateAxiosIdentities(lock: BunLock): void {
  const identities = new Set<string>();
  for (const [lockKey, row] of Object.entries(lock.packages)) {
    const lockPackage = parseLockPackage(lockKey, row);
    if (splitIdentity(lockPackage.identity).name === "axios") {
      identities.add(lockPackage.identity);
    }
  }
  if (
    identities.size > 0 &&
    (identities.size !== 1 || !identities.has("axios@1.19.0"))
  ) {
    throw new Error(
      `Multiple Axios lock identities: ${[...identities].sort(compareCodePoints).join(", ")}`,
    );
  }
}

function rootResolution(
  projectRoot: string,
  lock: BunLock,
  projectDependencies: Record<string, unknown>,
  root: { name: string; version: string },
): PackageResolution {
  const expectedIdentity = `${root.name}@${root.version}`;
  const declaredVersion = projectDependencies[root.name];
  if (declaredVersion !== root.version) {
    throw new Error(
      `Root version mismatch for ${expectedIdentity}: package.json has ${root.name}@${String(declaredVersion)}`,
    );
  }
  const workspaceVersion = lock.workspaces?.[""]?.dependencies?.[root.name];
  if (workspaceVersion !== root.version) {
    throw new Error(
      `Root version mismatch for ${expectedIdentity}: bun.lock workspace has ${root.name}@${String(workspaceVersion)}`,
    );
  }
  const row = lock.packages[root.name];
  if (!row) {
    throw new Error(`Root package missing from bun.lock: ${expectedIdentity}`);
  }
  const actualIdentity = parseLockPackage(root.name, row).identity;
  if (actualIdentity !== expectedIdentity) {
    throw new Error(
      `Root version mismatch for ${expectedIdentity}: bun.lock has ${actualIdentity}`,
    );
  }
  const packageDir = join(projectRoot, "node_modules", root.name);
  if (!existsSync(packageDir)) {
    throw new Error(`Installed root package missing: ${expectedIdentity}`);
  }
  return { lockKey: root.name, packageDir, ancestors: [] };
}

export function collectThirdPartyNoticeEntries(
  projectRoot: string,
  roots: readonly { name: string; version: string }[] = THIRD_PARTY_NOTICE_ROOTS,
): ThirdPartyNoticeEntry[] {
  const lock = parseLock(projectRoot);
  validateAxiosIdentities(lock);
  const projectManifest = parseJsonFile(join(projectRoot, "package.json")) as {
    dependencies?: Record<string, unknown>;
  };
  const projectDependencies = projectManifest.dependencies ?? {};
  const queue = roots.map((root) =>
    rootResolution(projectRoot, lock, projectDependencies, root),
  );
  const visited = new Set<string>();
  const entries = new Map<string, ThirdPartyNoticeEntry>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    const visitKey = `${current.lockKey}\0${current.packageDir}`;
    if (visited.has(visitKey)) continue;
    visited.add(visitKey);

    const lockPackage = parseLockPackage(current.lockKey, lock.packages[current.lockKey]);
    const entry = collectPackageEntry(projectRoot, current, lockPackage);
    const identity = `${entry.name}@${entry.version}`;
    const existing = entries.get(identity);
    if (existing && JSON.stringify(existing) !== JSON.stringify(entry)) {
      throw new Error(`Conflicting legal material for ${identity}`);
    }
    entries.set(identity, existing ?? entry);

    const requiredDependencies = lockPackage.metadata.dependencies ?? {};
    for (const dependencyName of Object.keys(requiredDependencies).sort(compareCodePoints)) {
      const dependency = resolveDependency(projectRoot, lock, current, dependencyName);
      if (!dependency) {
        throw new Error(
          `Unresolved production dependency ${dependencyName} from ${current.lockKey}`,
        );
      }
      queue.push(dependency);
    }

    const optionalDependencies = lockPackage.metadata.optionalDependencies ?? {};
    for (const dependencyName of Object.keys(optionalDependencies).sort(compareCodePoints)) {
      if (dependencyName in requiredDependencies) continue;
      const dependency = resolveDependency(projectRoot, lock, current, dependencyName);
      if (dependency) queue.push(dependency);
    }

    const optionalPeers = new Set(lockPackage.metadata.optionalPeers ?? []);
    const peerDependencies = lockPackage.metadata.peerDependencies ?? {};
    for (const dependencyName of Object.keys(peerDependencies).sort(compareCodePoints)) {
      if (
        dependencyName in requiredDependencies ||
        dependencyName in optionalDependencies ||
        optionalPeers.has(dependencyName)
      ) {
        continue;
      }
      const dependency = resolveDependency(projectRoot, lock, current, dependencyName);
      if (dependency) queue.push(dependency);
    }
  }

  return [...entries.values()].sort((left, right) => {
    const nameOrder = compareCodePoints(left.name, right.name);
    return nameOrder || compareCodePoints(left.version, right.version);
  });
}

export function renderThirdPartyNotices(
  entries: readonly ThirdPartyNoticeEntry[],
): string {
  const sections = [...entries]
    .sort((a, b) => {
      const nameOrder = a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      return nameOrder || (a.version < b.version ? -1 : a.version > b.version ? 1 : 0);
    })
    .map((entry) =>
      [
        "================================================================================",
        `${entry.name}@${entry.version}`,
        `License: ${entry.license}`,
        ...entry.licenseTexts.flatMap((file) => [
          `--- ${file.fileName} ---`,
          file.text.trimEnd(),
        ]),
        ...entry.noticeTexts.flatMap((file) => [
          `--- ${file.fileName} ---`,
          file.text.trimEnd(),
        ]),
      ].join("\n"),
    );
  return `${sections.join("\n\n")}\n`;
}

export function generateThirdPartyNotices(projectRoot: string): string {
  return renderThirdPartyNotices(collectThirdPartyNoticeEntries(projectRoot));
}

export function assertThirdPartyNoticesFile(
  filePath: string,
  expectedContents: string,
): void {
  if (!existsSync(filePath)) {
    throw new Error(`Missing third-party notices file: ${filePath}`);
  }
  const actual = readFileSync(filePath);
  const expected = Buffer.from(expectedContents, "utf8");
  if (!actual.equals(expected)) {
    throw new Error(`Changed third-party notices file: ${filePath}`);
  }
}
