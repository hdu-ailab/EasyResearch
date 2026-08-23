import { isAbsolute, win32 } from "node:path";
import {
  DESKTOP_EVENT_PREFIX,
  type DesktopReadyEvent,
  type DesktopSidecarEvent,
} from "./contracts";

const MAX_EVENT_LINE_LENGTH = 64 * 1024;
const PHASES = new Set(["ownership", "setup", "server", "shutdown"]);

export function parseDesktopSidecarLine(line: string): DesktopSidecarEvent | undefined {
  if (!line.startsWith(DESKTOP_EVENT_PREFIX)) return undefined;
  if (line.length > MAX_EVENT_LINE_LENGTH) throw new Error("Desktop sidecar machine event is too large.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.slice(DESKTOP_EVENT_PREFIX.length));
  } catch (error) {
    throw new Error("Desktop sidecar emitted an invalid machine event.", { cause: error });
  }
  if (!isRecord(parsed) || typeof parsed.type !== "string") {
    throw new Error("Desktop sidecar emitted an invalid machine event.");
  }
  if (parsed.type === "desktop.setup" && isBoundedString(parsed.message, 4_096)) {
    return { type: "desktop.setup", message: parsed.message };
  }
  if (parsed.type === "desktop.ready") return parseReadyEvent(parsed);
  if (
    parsed.type === "desktop.error"
    && typeof parsed.phase === "string"
    && PHASES.has(parsed.phase)
    && typeof parsed.code === "string"
    && /^[A-Z][A-Z0-9_]{1,63}$/u.test(parsed.code)
    && isBoundedString(parsed.message, 4_096)
    && isAbsoluteOnEitherPlatform(parsed.logPath)
  ) {
    return {
      type: "desktop.error",
      phase: parsed.phase as "ownership" | "setup" | "server" | "shutdown",
      code: parsed.code,
      message: parsed.message,
      logPath: parsed.logPath as string,
    };
  }
  if (parsed.type === "desktop.stopped") return { type: "desktop.stopped" };
  throw new Error("Desktop sidecar emitted an invalid machine event.");
}

function parseReadyEvent(value: Record<string, unknown>): DesktopReadyEvent {
  if (
    value.owner !== "desktop"
    || !Number.isSafeInteger(value.pid)
    || (value.pid as number) <= 0
    || !isAbsoluteOnEitherPlatform(value.logPath)
    || typeof value.origin !== "string"
  ) {
    throw new Error("Desktop sidecar emitted an invalid ready event.");
  }
  let origin: URL;
  try {
    origin = new URL(value.origin);
  } catch (error) {
    throw new Error("Desktop sidecar ready event did not contain an exact loopback origin.", { cause: error });
  }
  const port = Number(origin.port);
  if (
    origin.protocol !== "http:"
    || origin.hostname !== "127.0.0.1"
    || !Number.isInteger(port)
    || port < 1
    || port > 65_535
    || origin.username !== ""
    || origin.password !== ""
    || origin.pathname !== "/"
    || origin.search !== ""
    || origin.hash !== ""
  ) {
    throw new Error("Desktop sidecar ready event did not contain an exact loopback origin.");
  }
  return {
    type: "desktop.ready",
    origin: origin.origin,
    owner: "desktop",
    pid: value.pid as number,
    logPath: value.logPath as string,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function isAbsoluteOnEitherPlatform(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && (isAbsolute(value) || win32.isAbsolute(value));
}
