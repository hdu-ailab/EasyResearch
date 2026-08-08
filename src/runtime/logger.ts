import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "./pi-import";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface LogConfig {
  level: LogLevel;
  keepDays: number;
  logDir: string;
}

function parseLevel(value: string | undefined): LogLevel | undefined {
  return LEVELS.includes(value as LogLevel) ? (value as LogLevel) : undefined;
}

/**
 * Resolve the process-level logging config. Order: LAZYRESEARCH_LOG_LEVEL
 * env var, then the global settings.json `lazyresearch.logging` object,
 * then defaults (info, 7 days, <agentDir>/logs). Project settings are never
 * read: the Web server serves many project cwds, so the level is
 * process-level. Invalid configured values fall back to the defaults.
 */
export function resolveLogConfig(agentDir: string): LogConfig {
  const envLevel = parseLevel(process.env.LAZYRESEARCH_LOG_LEVEL);
  let settings: { level?: unknown; keepDays?: unknown; logDir?: unknown } = {};
  try {
    const raw = readFileSync(join(agentDir, "settings.json"), "utf8");
    const parsed = JSON.parse(raw) as { lazyresearch?: { logging?: { level?: unknown; keepDays?: unknown; logDir?: unknown } } };
    settings = parsed?.lazyresearch?.logging ?? {};
  } catch {
    // missing/malformed global settings: defaults apply
  }
  const configuredLevel =
    envLevel ?? parseLevel(typeof settings.level === "string" ? settings.level : undefined) ?? "info";
  const level = configuredLevel;
  const keepDays = typeof settings.keepDays === "number" && settings.keepDays > 0 ? settings.keepDays : 7;
  const logDir = typeof settings.logDir === "string" && settings.logDir.length > 0 ? settings.logDir : join(agentDir, "logs");
  return { level, keepDays, logDir };
}

function dayFile(logDir: string, now: Date = new Date()): string {
  const stamp = now.toISOString().slice(0, 10);
  return join(logDir, `lazyresearch-${stamp}.log`);
}

function formatLine(level: LogLevel, pid: number, scope: string, msg: string, fields?: Record<string, unknown>): string {
  const stamp = new Date().toISOString();
  const fieldText = fields
    ? " " + Object.entries(fields)
        .map(([k, v]) => {
          let rendered: string;
          if (typeof v === "string") {
            rendered = v;
          } else {
            try {
              rendered = JSON.stringify(v) ?? "undefined";
            } catch {
              rendered = "<unserializable>";
            }
          }
          return `${k}=${rendered}`;
        })
        .join(" ")
    : "";
  return `[${stamp}] [${level.toUpperCase()}] [pid=${pid}] [${scope}] ${msg}${fieldText}`;
}

export function createLogger(scope: string, options?: { agentDir?: string; level?: LogLevel; keepDays?: number; logDir?: string }): Logger {
  const agentDir = options?.agentDir ?? getAgentDir();
  const resolved = resolveLogConfig(agentDir);
  const config: LogConfig = {
    level: options?.level ?? resolved.level,
    keepDays: options?.keepDays ?? resolved.keepDays,
    logDir: options?.logDir ?? resolved.logDir,
  };
  const threshold = LEVEL_ORDER[config.level];
  const pid = process.pid;
  let warnedInvalid = false;
  // Spec 5: an invalid env/settings level falls back to info and warns once
  // per logger instance. Only the configured level (no explicit option) warns.
  if (options?.level === undefined) {
    const rawLevel = rawConfiguredLevel(agentDir);
    if (rawLevel !== undefined && parseLevel(rawLevel) === undefined) {
      // eslint-disable-next-line no-console
      console.warn(`[lazyresearch:logger] invalid log level "${rawLevel}", falling back to info`);
    }
  }

  const cleanup = (): void => {
    try {
      const cutoff = Date.now() - config.keepDays * 24 * 60 * 60 * 1000;
      for (const name of readdirSync(config.logDir)) {
        if (!name.startsWith("lazyresearch-") || !name.endsWith(".log")) continue;
        const filePath = join(config.logDir, name);
        const stat = statSync(filePath);
        if (stat.mtimeMs < cutoff) unlinkSync(filePath);
      }
    } catch {
      // best-effort retention cleanup
    }
  };

  const write = (level: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[level] < threshold) return;
    const line = formatLine(level, pid, scope, msg, fields) + "\n";
    try {
      try {
        mkdirSync(config.logDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      cleanup();
      appendFileSync(dayFile(config.logDir), line, "utf8");
    } catch {
      if (!warnedInvalid) {
        warnedInvalid = true;
        // eslint-disable-next-line no-console
        console.error(`[lazyresearch:logger] cannot write log file under ${config.logDir}; logging failed`);
      }
    }
  };

  return {
    debug: (msg, fields) => write("debug", msg, fields),
    info: (msg, fields) => write("info", msg, fields),
    warn: (msg, fields) => write("warn", msg, fields),
    error: (msg, fields) => write("error", msg, fields),
  };
}

/**
 * The raw level string from env or global settings (undefined when neither
 * sets one). Used only to detect invalid values for the spec-5 warning.
 */
function rawConfiguredLevel(agentDir: string): string | undefined {
  const envLevel = process.env.LAZYRESEARCH_LOG_LEVEL;
  if (envLevel !== undefined) return envLevel;
  try {
    const raw = readFileSync(join(agentDir, "settings.json"), "utf8");
    const parsed = JSON.parse(raw) as { lazyresearch?: { logging?: { level?: unknown } } };
    const level = parsed?.lazyresearch?.logging?.level;
    return typeof level === "string" ? level : undefined;
  } catch {
    return undefined;
  }
}
