import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createLogger, dayStamp, resolveLogConfig } from "./logger";

function makeAgentDir(): string {
  return mkdtempSync(join(tmpdir(), "lazy-log-"));
}

function logFiles(agentDir: string): string[] {
  return readdirSync(join(agentDir, "logs")).filter((f) => f.startsWith("easyresearch-")).sort();
}

describe("dayStamp", () => {
  it("keeps a late-evening timestamp in the same day", () => {
    expect(dayStamp(new Date(2026, 7, 8, 23, 59))).toBe("2026-08-08");
  });

  it("keeps local midnight in the same day", () => {
    expect(dayStamp(new Date(2026, 7, 8, 0, 0))).toBe("2026-08-08");
  });

  it("rolls over just past midnight", () => {
    expect(dayStamp(new Date(2026, 7, 9, 0, 1))).toBe("2026-08-09");
  });

  it("zero-pads month and day", () => {
    expect(dayStamp(new Date(2026, 0, 5))).toBe("2026-01-05");
  });

  it("handles month 11 as December", () => {
    expect(dayStamp(new Date(2026, 11, 31))).toBe("2026-12-31");
  });
});

describe("resolveLogConfig", () => {
  it("defaults to info and 7 days with logs dir under the agent dir", () => {
    const agentDir = makeAgentDir();
    expect(resolveLogConfig(agentDir)).toEqual({ level: "info", keepDays: 7, logDir: join(agentDir, "logs") });
  });

  it("reads level/keepDays/logDir from global settings.json", () => {
    const agentDir = makeAgentDir();
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ easyresearch: { logging: { level: "debug", keepDays: 3, logDir: "/tmp/alt-logs" } } }),
    );
    expect(resolveLogConfig(agentDir)).toEqual({ level: "debug", keepDays: 3, logDir: "/tmp/alt-logs" });
  });

  it("reads logging configuration from BOM-prefixed settings accepted by Pi", () => {
    const agentDir = makeAgentDir();
    writeFileSync(
      join(agentDir, "settings.json"),
      `\uFEFF${JSON.stringify({
        easyresearch: { logging: { level: "debug", keepDays: 5, logDir: "/tmp/bom-logs" } },
      })}`,
    );

    expect(resolveLogConfig(agentDir)).toEqual({ level: "debug", keepDays: 5, logDir: "/tmp/bom-logs" });
  });

  it("env EASYRESEARCH_LOG_LEVEL wins over settings", () => {
    const agentDir = makeAgentDir();
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ easyresearch: { logging: { level: "debug" } } }));
    const previous = process.env.EASYRESEARCH_LOG_LEVEL;
    process.env.EASYRESEARCH_LOG_LEVEL = "warn";
    try {
      expect(resolveLogConfig(agentDir).level).toBe("warn");
    } finally {
      if (previous === undefined) delete process.env.EASYRESEARCH_LOG_LEVEL;
      else process.env.EASYRESEARCH_LOG_LEVEL = previous;
    }
  });

  it("invalid configured level falls back to info", () => {
    const agentDir = makeAgentDir();
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ easyresearch: { logging: { level: "verbose" } } }));
    expect(resolveLogConfig(agentDir).level).toBe("info");
  });
});

describe("invalid-level warning (spec 5)", () => {
  it("warns once on invalid configured level, silent on valid", () => {
    const agentDir = makeAgentDir();
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ easyresearch: { logging: { level: "verbose" } } }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const logger = createLogger("t", { agentDir });
      logger.info("a");
      logger.info("b");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }

    const warn2 = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ easyresearch: { logging: { level: "info" } } }));
      createLogger("t2", { agentDir }).info("c");
      expect(warn2).not.toHaveBeenCalled();
    } finally {
      warn2.mockRestore();
    }
  });

  it("warns once on invalid EASYRESEARCH_LOG_LEVEL env value, env wins over settings", () => {
    const agentDir = makeAgentDir();
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ easyresearch: { logging: { level: "info" } } }));
    const previous = process.env.EASYRESEARCH_LOG_LEVEL;
    process.env.EASYRESEARCH_LOG_LEVEL = "verbose";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const logger = createLogger("t", { agentDir });
      expect(process.env.EASYRESEARCH_LOG_LEVEL).toBe("verbose");
      logger.info("a");
      logger.info("b");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain('invalid log level "verbose"');
    } finally {
      warn.mockRestore();
      if (previous === undefined) delete process.env.EASYRESEARCH_LOG_LEVEL;
      else process.env.EASYRESEARCH_LOG_LEVEL = previous;
    }
  });

  it("warns for an invalid level read from BOM-prefixed settings", () => {
    const agentDir = makeAgentDir();
    writeFileSync(
      join(agentDir, "settings.json"),
      `\uFEFF${JSON.stringify({ easyresearch: { logging: { level: "verbose" } } })}`,
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      createLogger("bom", { agentDir });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain('invalid log level "verbose"');
    } finally {
      warn.mockRestore();
    }
  });
});

describe("createLogger", () => {
  it("filters messages below the configured level", () => {
    const agentDir = makeAgentDir();
    const logger = createLogger("test", { agentDir, level: "info" });
    logger.debug("hidden");
    logger.info("shown");
    logger.error("boom", { code: 42 });
    const content = readFileSync(logFiles(agentDir).map((f) => join(agentDir, "logs", f))[0]!, "utf8");
    expect(content).not.toContain("hidden");
    expect(content).toContain("shown");
    expect(content).toContain("boom code=42");
  });

  it("writes a day file with timestamp, level, pid, scope", () => {
    const agentDir = makeAgentDir();
    const logger = createLogger("scope-a", { agentDir, level: "debug" });
    logger.info("hello");
    const files = logFiles(agentDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^easyresearch-\d{4}-\d{2}-\d{2}\.log$/);
    const line = readFileSync(join(agentDir, "logs", files[0]!), "utf8").trim();
    expect(line).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[INFO\] \[pid=\d+\] \[scope-a\] hello$/);
  });

  it("appends across logger instances to the same day file", async () => {
    const agentDir = makeAgentDir();
    const logger = createLogger("t", { agentDir, level: "info" });
    logger.info("day1");
    // Simulate the next day by rewriting the file mtime is unnecessary:
    // the file name is derived per write from the current date, so force a
    // second file by manipulating the clock is not feasible; instead assert
    // that writes across an explicit logDir stay in one file and that a
    // second createLogger instance appends to the same file.
    const logger2 = createLogger("t", { agentDir, level: "info" });
    logger2.info("day1b");
    expect(logFiles(agentDir)).toHaveLength(1);
    const content = readFileSync(join(agentDir, "logs", logFiles(agentDir)[0]!), "utf8");
    expect(content).toContain("day1");
    expect(content).toContain("day1b");
  });

  it("deletes log files older than keepDays on a new write", async () => {
    const agentDir = makeAgentDir();
    mkdirSync(join(agentDir, "logs"), { recursive: true });
    const oldFile = join(agentDir, "logs", "easyresearch-2000-01-01.log");
    const freshFile = join(agentDir, "logs", "easyresearch-2099-01-01.log");
    writeFileSync(oldFile, "old");
    writeFileSync(freshFile, "fresh");
    const oldTime = new Date("2000-01-01").getTime();
    const freshTime = new Date("2099-01-01").getTime();
    const { utimesSync } = await import("node:fs");
    utimesSync(oldFile, oldTime / 1000, oldTime / 1000);
    utimesSync(freshFile, freshTime / 1000, freshTime / 1000);
    const logger = createLogger("t", { agentDir, level: "info", keepDays: 7 });
    logger.info("now");
    const remaining = logFiles(agentDir);
    expect(remaining).not.toContain("easyresearch-2000-01-01.log");
    expect(remaining).toContain("easyresearch-2099-01-01.log");
  });

  it("never throws into application logic on unwritable log dir", () => {
    const agentDir = makeAgentDir();
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ easyresearch: { logging: { logDir: "/proc/definitely/not/writable" } } }));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const logger = createLogger("t", { agentDir, level: "info" });
      expect(() => logger.info("no crash")).not.toThrow();
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
    }
  });

  it("degrades unserializable fields without throwing", () => {
    const agentDir = makeAgentDir();
    const logger = createLogger("test", { agentDir, level: "info" });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => logger.info("big", { tokens: 1n })).not.toThrow();
    expect(() => logger.info("circ", circular)).not.toThrow();
    const content = readFileSync(logFiles(agentDir).map((f) => join(agentDir, "logs", f))[0]!, "utf8");
    expect(content).toContain("big");
    expect(content).toContain("circ");
    expect(content).toContain("tokens=<unserializable>");
    expect(content).toContain("self=<unserializable>");
  });

  it("escapes line terminators in string field values", () => {
    const agentDir = makeAgentDir();
    const logger = createLogger("test", { agentDir, level: "info" });
    logger.info("msg", { note: "line1\nline2\rx" });
    const content = readFileSync(logFiles(agentDir).map((f) => join(agentDir, "logs", f))[0]!, "utf8");
    expect(content.trim().split("\n")).toHaveLength(1);
    expect(content).toContain("note=line1\\nline2\\rx");
  });
});
