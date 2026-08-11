import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertSafeExtensionSources, ExtensionGuardError } from "./extensions-guard";

const originalGetAgentDir = vi.hoisted(() => ({ value: "" }));

vi.mock("./pi-import", () => ({
  getAgentDir: () => originalGetAgentDir.value,
}));

describe("assertSafeExtensionSources (ADR-032)", () => {
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

  it("passes when no settings arrays exist", () => {
    expect(() => assertSafeExtensionSources({ cwd })).not.toThrow();
    expect(() => assertSafeExtensionSources({})).not.toThrow();
  });

  it("allows extension discovery directories (global and project)", () => {
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    mkdirSync(join(cwd, ".easyresearch", "extensions"), { recursive: true });
    writeFileSync(join(cwd, ".easyresearch", "extensions", "x.ts"), "export default () => {}");
    expect(() => assertSafeExtensionSources({ cwd })).not.toThrow();
  });

  it("allows a non-empty extensions array pointing to safe local paths", () => {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: ["./e.ts", "~/my-ext"] }));
    expect(() => assertSafeExtensionSources({ cwd })).not.toThrow();
  });

  it("passes for an empty packages array", () => {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
    expect(() => assertSafeExtensionSources()).not.toThrow();
  });

  it("refuses a non-empty packages array in global settings.json", () => {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:foo"] }));
    expect(() => assertSafeExtensionSources()).toThrow(ExtensionGuardError);
    expect(() => assertSafeExtensionSources()).toThrow(/packages array in global settings\.json/);
  });

  it("refuses a non-empty packages array in project settings.json", () => {
    mkdirSync(join(cwd, ".easyresearch"), { recursive: true });
    writeFileSync(join(cwd, ".easyresearch", "settings.json"), JSON.stringify({ packages: ["git:foo"] }));
    expect(() => assertSafeExtensionSources({ cwd })).toThrow(/packages array in project settings\.json/);
    expect(() => assertSafeExtensionSources({})).not.toThrow();
  });

  it("refuses an extensions array entry inside the foreign ~/.pi tree (absolute)", () => {
    const piExtension = join(homedir(), ".pi", "agent", "extensions", "e.ts");
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [piExtension] }));
    expect(() => assertSafeExtensionSources()).toThrow(ExtensionGuardError);
    expect(() => assertSafeExtensionSources()).toThrow(/e\.ts in global settings\.json/);
  });

  it("refuses an extensions array entry pointing into ~/.pi via a ~/ path", () => {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: ["~/.pi/agent/extensions/e.ts"] }));
    expect(() => assertSafeExtensionSources()).toThrow(ExtensionGuardError);
    expect(() => assertSafeExtensionSources()).toThrow(/~\/\.pi\/agent\/extensions\/e\.ts in global settings\.json/);
  });

  it("allows a local extension path that merely resembles .pi but is not inside the home tree", () => {
    const local = join(cwd, "my", ".pi-like", "e.ts");
    mkdirSync(join(cwd, "my", ".pi-like"), { recursive: true });
    mkdirSync(join(cwd, ".easyresearch"), { recursive: true });
    writeFileSync(join(cwd, ".easyresearch", "settings.json"), JSON.stringify({ extensions: [local] }));
    expect(() => assertSafeExtensionSources({ cwd })).not.toThrow();
  });

  it("collects all offenders into one message", () => {
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ packages: ["npm:foo"], extensions: ["~/.pi/x.ts", "./ok.ts"] }),
    );
    const error = () => assertSafeExtensionSources();
    expect(error).toThrow(/packages array in global settings\.json/);
    expect(error).toThrow(/~\/\.pi\/x\.ts in global settings\.json/);
    expect(error).not.toThrow(/\.\/ok\.ts/);
  });
});