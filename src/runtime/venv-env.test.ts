import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SKILL_VENV_ENV, injectSkillVenvEnv, skillVenvDir } from "./venv-env";

let root: string;
let originalEnv: string | undefined;
let originalAgentDir: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "venv-env-"));
  originalEnv = process.env[SKILL_VENV_ENV];
  originalAgentDir = process.env.EASYRESEARCH_CODING_AGENT_DIR;
  delete process.env[SKILL_VENV_ENV];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (originalEnv === undefined) delete process.env[SKILL_VENV_ENV];
  else process.env[SKILL_VENV_ENV] = originalEnv;
  if (originalAgentDir === undefined) delete process.env.EASYRESEARCH_CODING_AGENT_DIR;
  else process.env.EASYRESEARCH_CODING_AGENT_DIR = originalAgentDir;
});

describe("skillVenvDir", () => {
  it("joins agentDir with venv", () => {
    expect(skillVenvDir("/x/agent")).toBe("/x/agent/venv");
  });
});

describe("injectSkillVenvEnv", () => {
  it("sets the env var when the venv bin exists", () => {
    const agentDir = join(root, "agent");
    process.env.EASYRESEARCH_CODING_AGENT_DIR = agentDir;
    const venvDir = skillVenvDir(agentDir);
    const bin = process.platform === "win32" ? join(venvDir, "Scripts") : join(venvDir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, process.platform === "win32" ? "python.exe" : "python"), "");
    expect(injectSkillVenvEnv()).toBe(venvDir);
    expect(process.env[SKILL_VENV_ENV]).toBe(venvDir);
  });

  it("does not set the env var when the venv is absent", () => {
    process.env.EASYRESEARCH_CODING_AGENT_DIR = join(root, "agent");
    expect(injectSkillVenvEnv()).toBeUndefined();
    expect(process.env[SKILL_VENV_ENV]).toBeUndefined();
  });
});
