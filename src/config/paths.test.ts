import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME, ENV_CONFIG_ROOT, getAgentDir, getConfigRoot } from "./paths";

describe("paths", () => {
  const realEnv = process.env[ENV_CONFIG_ROOT];

  afterEach(() => {
    if (realEnv === undefined) delete process.env[ENV_CONFIG_ROOT];
    else process.env[ENV_CONFIG_ROOT] = realEnv;
  });

  it("defaults to ~/.lazyresearch", () => {
    delete process.env[ENV_CONFIG_ROOT];
    expect(getConfigRoot()).toBe(join(homedir(), CONFIG_DIR_NAME));
  });

  it("honors LAZYRESEARCH_CONFIG_DIR override", () => {
    process.env[ENV_CONFIG_ROOT] = "/tmp/lazy-test";
    expect(getConfigRoot()).toBe("/tmp/lazy-test");
  });

  it("expands tildes in the override", () => {
    process.env[ENV_CONFIG_ROOT] = "~/lazy-test";
    expect(getConfigRoot()).toBe(join(homedir(), "lazy-test"));
  });

  it("agent dir nests under the config root", () => {
    process.env[ENV_CONFIG_ROOT] = "/tmp/lazy-test";
    expect(getAgentDir()).toBe("/tmp/lazy-test/agent");
  });
});
