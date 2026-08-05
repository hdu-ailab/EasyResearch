import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertNoUserExtensions, ExtensionGuardError } from "./extensions-guard";

const originalGetAgentDir = vi.hoisted(() => ({ value: "" }));

vi.mock("./pi-import", () => ({
  getAgentDir: () => originalGetAgentDir.value,
}));

describe("assertNoUserExtensions (ADR-018)", () => {
  let agentDir: string;
  let cwd: string;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "lazy-guard-agent-"));
    cwd = mkdtempSync(join(tmpdir(), "lazy-guard-proj-"));
    originalGetAgentDir.value = agentDir;
  });

  afterEach(() => {
    originalGetAgentDir.value = "";
  });

  it("passes when no extension dirs or settings arrays exist", () => {
    expect(() => assertNoUserExtensions({ cwd })).not.toThrow();
    expect(() => assertNoUserExtensions({})).not.toThrow();
  });

  it("refuses non-empty global extensions directory and names it", () => {
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    writeFileSync(join(agentDir, "extensions", "user.ts"), "export default () => {}");
    expect(() => assertNoUserExtensions()).toThrow(ExtensionGuardError);
    expect(() => assertNoUserExtensions()).toThrow(/extensions/);
  });

  it("ignores an empty extensions directory", () => {
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    expect(() => assertNoUserExtensions()).not.toThrow();
  });

  it("refuses non-empty project extensions directory and names it", () => {
    mkdirSync(join(cwd, ".lazyresearch", "extensions"), { recursive: true });
    writeFileSync(join(cwd, ".lazyresearch", "extensions", "x.ts"), "export default () => {}");
    expect(() => assertNoUserExtensions({ cwd })).toThrow(join(cwd, ".lazyresearch", "extensions"));
    expect(() => assertNoUserExtensions({})).not.toThrow();
  });

  it("refuses non-empty extensions array in global settings.json", () => {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: ["./e.ts"] }));
    expect(() => assertNoUserExtensions()).toThrow(/extensions array in global settings\.json/);
  });

  it("refuses non-empty packages array in project settings.json", () => {
    mkdirSync(join(cwd, ".lazyresearch"), { recursive: true });
    writeFileSync(join(cwd, ".lazyresearch", "settings.json"), JSON.stringify({ packages: ["npm:foo"] }));
    expect(() => assertNoUserExtensions({ cwd })).toThrow(/packages array in project settings\.json/);
    expect(() => assertNoUserExtensions({})).not.toThrow();
  });

  it("collects all offenders into one message", () => {
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    writeFileSync(join(agentDir, "extensions", "a.ts"), "1");
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: ["./e.ts"] }));
    expect(() => assertNoUserExtensions()).toThrow(/extensions array in global settings\.json/);
  });
});
