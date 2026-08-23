import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const MAX_PREFERENCE_BYTES = 16 * 1024;
const PREFERENCE_KEYS = new Set([
  "chatFontSize",
  "filesFontSize",
  "language",
  "autoExpandThinking",
  "autoExpandTools",
  "expandSubagentOutput",
]);

export function desktopPreferencePath(userDataDir: string): string {
  return join(userDataDir, "webui-preferences.json");
}

export function readDesktopPreferenceBlob(userDataDir: string): string | undefined {
  try {
    const raw = readFileSync(desktopPreferencePath(userDataDir), "utf8");
    validatePreferenceBlob(raw);
    return raw;
  } catch {
    return undefined;
  }
}

export function writeDesktopPreferenceBlob(userDataDir: string, raw: string | null): void {
  const path = desktopPreferencePath(userDataDir);
  if (raw === null) {
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return;
  }
  validatePreferenceBlob(raw);
  mkdirSync(userDataDir, { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, raw, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function validatePreferenceBlob(raw: string): void {
  if (Buffer.byteLength(raw, "utf8") > MAX_PREFERENCE_BYTES) {
    throw new Error("Desktop Web preference blob exceeds 16 KiB.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("Desktop Web preference blob is not valid JSON.", { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Desktop Web preference blob must be an object.");
  }
  const value = parsed as Record<string, unknown>;
  if (Object.keys(value).some((key) => !PREFERENCE_KEYS.has(key))) {
    throw new Error("Desktop Web preference blob contains unsupported fields.");
  }
  if (
    !isIntegerInRange(value.chatFontSize, 10, 20)
    || !isIntegerInRange(value.filesFontSize, 10, 20)
    || (value.language !== "en" && value.language !== "zh-CN")
    || typeof value.autoExpandThinking !== "boolean"
    || typeof value.autoExpandTools !== "boolean"
    || typeof value.expandSubagentOutput !== "boolean"
  ) {
    throw new Error("Desktop Web preference blob does not match the Web preference schema.");
  }
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= minimum
    && value <= maximum;
}
