import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME, ENV_CONFIG_ROOT, findProjectConfigRoot, getAgentDir, getConfigRoot } from "./paths";

describe("paths", () => {
  const realEnv = process.env[ENV_CONFIG_ROOT];
  const realHome = process.env.HOME;

  afterEach(() => {
    if (realEnv === undefined) delete process.env[ENV_CONFIG_ROOT];
    else process.env[ENV_CONFIG_ROOT] = realEnv;
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
  });

  it("defaults to ~/.lazyresearch", () => {
    delete process.env[ENV_CONFIG_ROOT];
    expect(getConfigRoot("/some/random/dir")).toBe(join(homedir(), CONFIG_DIR_NAME));
  });

  it("honors LAZYRESEARCH_CONFIG_DIR override", () => {
    process.env[ENV_CONFIG_ROOT] = "/tmp/lazy-test";
    expect(getConfigRoot("/anywhere")).toBe("/tmp/lazy-test");
  });

  it("expands tildes in the override", () => {
    process.env[ENV_CONFIG_ROOT] = "~/lazy-test";
    expect(getConfigRoot("/anywhere")).toBe(join(homedir(), "lazy-test"));
  });

  it("agent dir nests under the config root", () => {
    process.env[ENV_CONFIG_ROOT] = "/tmp/lazy-test";
    expect(getAgentDir()).toBe("/tmp/lazy-test/agent");
  });

  it("prefers a project-level config root found from cwd", () => {
    delete process.env[ENV_CONFIG_ROOT];
    const project = mkdtempSync(join(process.env.HOME ?? "/tmp", "lazy-proj-"));
    mkdirSync(join(project, CONFIG_DIR_NAME, "agent"), { recursive: true });
    writeFileSync(join(project, CONFIG_DIR_NAME, "config.json"), "{}", "utf-8");

    try {
      expect(getConfigRoot(join(project, "sub", "deep"))).toBe(join(project, CONFIG_DIR_NAME));
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("treats a bare .lazyresearch dir without markers as not a project root", () => {
    delete process.env[ENV_CONFIG_ROOT];
    const project = mkdtempSync(join(process.env.HOME ?? "/tmp", "lazy-proj-"));
    mkdirSync(join(project, CONFIG_DIR_NAME), { recursive: true });

    try {
      expect(getConfigRoot(join(project, "sub"))).toBe(join(homedir(), CONFIG_DIR_NAME));
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
