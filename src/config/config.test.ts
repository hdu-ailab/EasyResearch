import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, sanitizeConfig } from "./config";
import { loadConfig, saveConfig } from "./load";

describe("config", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lazy-config-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("sanitize keeps only known fields", () => {
    const cfg = sanitizeConfig({ model: "a/b", unknown: 123, experimentMode: "remote" });
    expect(cfg.model).toBe("a/b");
    expect(cfg.experimentMode).toBe("remote");
    expect((cfg as Record<string, unknown>).unknown).toBeUndefined();
  });

  it("sanitize defaults to local experiment mode", () => {
    expect(sanitizeConfig(undefined).experimentMode).toBe("local");
    expect(sanitizeConfig({ experimentMode: "remote" }).experimentMode).toBe("remote");
  });

  it("sanitize ignores blank model strings", () => {
    expect(sanitizeConfig({ model: "   " }).model).toBeUndefined();
  });

  it("round-trips through save/load", () => {
    const cfg: typeof DEFAULT_CONFIG = { ...DEFAULT_CONFIG, model: "x/y", experimentMode: "remote" };
    const path = join(dir, "config.json");
    saveConfig(cfg, path);
    expect(loadConfig(path)).toEqual(cfg);
  });

  it("load returns defaults for missing file", () => {
    expect(loadConfig(join(dir, "nope.json"))).toEqual(DEFAULT_CONFIG);
  });

  it("load returns defaults for corrupt file", () => {
    const path = join(dir, "bad.json");
    const { writeFileSync } = require("node:fs");
    writeFileSync(path, "not json", "utf-8");
    expect(loadConfig(path)).toEqual(DEFAULT_CONFIG);
  });
});
