type PathStyle = "posix" | "windows";

interface ParsedPath {
  style: PathStyle;
  root: string;
  segments: string[];
}

const DRIVE_ABSOLUTE = /^([A-Za-z]):[\\/](.*)$/u;

function normalizedSegments(parts: string[], clampAtRoot = false): string[] | null {
  const segments: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (segments.length === 0) {
        if (clampAtRoot) continue;
        return null;
      }
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  return segments;
}

function parseAbsolutePath(value: string, clampAtRoot = false): ParsedPath | null {
  const drive = value.match(DRIVE_ABSOLUTE);
  if (drive) {
    const segments = normalizedSegments((drive[2] ?? "").split(/[\\/]+/u), clampAtRoot);
    return segments ? { style: "windows", root: `${drive[1]}:\\`, segments } : null;
  }
  if (value.startsWith("\\\\")) {
    const parts = value.replace(/^\\+/u, "").split(/[\\/]+/u);
    const server = parts.shift();
    const share = parts.shift();
    if (!server || !share) return null;
    const segments = normalizedSegments(parts, clampAtRoot);
    return segments ? { style: "windows", root: `\\\\${server}\\${share}\\`, segments } : null;
  }
  if (value.startsWith("/")) {
    const segments = normalizedSegments(value.slice(1).split("/"), clampAtRoot);
    return segments ? { style: "posix", root: "/", segments } : null;
  }
  return null;
}

function formatPath(path: ParsedPath): string {
  if (path.segments.length === 0) return path.root;
  const separator = path.style === "windows" ? "\\" : "/";
  return `${path.root}${path.segments.join(separator)}`;
}

export function isAbsoluteFilesystemPath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\\\") || DRIVE_ABSOLUTE.test(path);
}

export function normalizeAbsoluteFilesystemPath(path: string): string | null {
  const parsed = parseAbsolutePath(path);
  return parsed ? formatPath(parsed) : null;
}

export function parentFilesystemPath(path: string): string {
  const parsed = parseAbsolutePath(path);
  if (!parsed || parsed.segments.length === 0) return parsed ? parsed.root : path;
  parsed.segments.pop();
  return formatPath(parsed);
}

export function filesystemPathName(path: string): string {
  const parsed = parseAbsolutePath(path);
  if (parsed) return parsed.segments.at(-1) ?? parsed.root;
  return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path;
}

export function joinFilesystemPath(base: string, relative: string): string {
  const parsed = parseAbsolutePath(base);
  if (!parsed) return `${base.replace(/[\\/]+$/u, "")}/${relative.replace(/^[\\/]+/u, "")}`;
  const separator = parsed.style === "windows" ? "\\" : "/";
  const child = relative
    .replace(/^[\\/]+/u, "")
    .split(parsed.style === "windows" ? /[\\/]+/u : /\/+/u)
    .join(separator);
  const parent = formatPath(parsed);
  const combined = `${parent}${parent.endsWith(separator) ? "" : separator}${child}`;
  return normalizeAbsoluteFilesystemPath(combined) ?? combined;
}

export function expandFilesystemPath(input: string, homeDir: string): string {
  if (!input) return homeDir;
  if (input === "~") return homeDir;
  if (input.startsWith("~/") || input.startsWith("~\\")) return joinFilesystemPath(homeDir, input.slice(2));
  if (isAbsoluteFilesystemPath(input)) return input;
  return joinFilesystemPath(homeDir, input);
}

export function isSameOrDescendantPath(root: string, candidate: string): boolean {
  const normalizedRoot = normalizeAbsoluteFilesystemPath(root);
  const normalizedCandidate = normalizeAbsoluteFilesystemPath(candidate);
  if (!normalizedRoot || !normalizedCandidate) return false;
  const rootParsed = parseAbsolutePath(normalizedRoot);
  const candidateParsed = parseAbsolutePath(normalizedCandidate);
  if (!rootParsed || !candidateParsed) return false;
  if (rootParsed.style !== candidateParsed.style) return false;
  const separator = rootParsed.style === "windows" ? "\\" : "/";
  const comparableRoot = rootParsed.style === "windows" ? normalizedRoot.toLowerCase() : normalizedRoot;
  const comparableCandidate = rootParsed.style === "windows" ? normalizedCandidate.toLowerCase() : normalizedCandidate;
  if (comparableCandidate === comparableRoot) return true;
  const prefix = comparableRoot.endsWith(separator) ? comparableRoot : `${comparableRoot}${separator}`;
  return comparableCandidate.startsWith(prefix);
}

export function relativeFilesystemPath(root: string, candidate: string): string | null {
  if (!isSameOrDescendantPath(root, candidate)) return null;
  const normalizedRoot = normalizeAbsoluteFilesystemPath(root);
  const normalizedCandidate = normalizeAbsoluteFilesystemPath(candidate);
  if (!normalizedRoot || !normalizedCandidate) return null;
  if (normalizedRoot.toLowerCase() === normalizedCandidate.toLowerCase()) return "";
  return normalizedCandidate.slice(normalizedRoot.length).replace(/^[\\/]+/u, "");
}

export function resolveFilesystemPath(documentPath: string, target: string): string | null {
  const document = parseAbsolutePath(documentPath);
  if (!document) return null;
  if (isAbsoluteFilesystemPath(target)) {
    if (document.style === "windows" && target.startsWith("/") && !target.startsWith("//")) {
      const parsed = parseAbsolutePath(`${document.root}${target.replace(/^\/+/, "")}`, true);
      return parsed ? formatPath(parsed) : null;
    }
    const parsed = parseAbsolutePath(target, true);
    return parsed ? formatPath(parsed) : null;
  }
  const parsed = parseAbsolutePath(
    `${parentFilesystemPath(documentPath)}${document.style === "windows" ? "\\" : "/"}${target}`,
    true,
  );
  return parsed ? formatPath(parsed) : null;
}
