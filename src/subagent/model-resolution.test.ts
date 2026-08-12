import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_MODEL_ENTRY, extractAgentModels, resolveEffectiveModel, resolveModelForSpawn } from "./model-resolution";

const getAgentDirMock = vi.hoisted(() => vi.fn(() => "/fake/agent"));
vi.mock("../runtime/pi-import", () => ({ getAgentDir: getAgentDirMock }));

let root: string;
let project: string;
let globalAgent: string;

function writeAgent(agentRoot: string, name: string, model?: string): void {
  mkdirSync(join(agentRoot, "agents"), { recursive: true });
  writeFileSync(join(agentRoot, "agents", `${name}.md`), `---\nname: ${name}\ndescription: ${name}\n${model ? `model: ${model}\n` : ""}---\nPrompt\n`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "easyresearch-models-"));
  project = join(root, "project");
  globalAgent = join(root, "global");
  mkdirSync(project, { recursive: true });
  getAgentDirMock.mockReturnValue(globalAgent);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("resolveEffectiveModel", () => {
  it("prefers the session override", () => {
    expect(resolveEffectiveModel("openai/gpt-4o", { search: "a/b" }, { search: "x/y" }, "o/1", "search")).toEqual({ model: "openai/gpt-4o", source: "override" });
  });

  it("uses project, global, then assistant inheritance", () => {
    expect(resolveEffectiveModel(undefined, { search: "a/b" }, { search: "x/y" }, "o/1", "search")).toEqual({ model: "a/b", source: "project" });
    expect(resolveEffectiveModel(undefined, undefined, { search: "x/y" }, "o/1", "search")).toEqual({ model: "x/y", source: "global" });
    expect(resolveEffectiveModel(undefined, undefined, undefined, "o/1", "search")).toEqual({ model: "o/1", source: "inherit" });
    expect(resolveEffectiveModel(undefined, undefined, undefined, undefined, "search")).toBeNull();
  });
});

describe("extractAgentModels", () => {
  it("reads models from effective Markdown agents", async () => {
    writeAgent(globalAgent, "search", "a/1");
    writeAgent(globalAgent, "writing", "b/2");
    expect(await extractAgentModels(project, globalAgent)).toEqual({ search: "a/1", writing: "b/2" });
  });

  it("does not read JSON settings as an agent source", async () => {
    mkdirSync(globalAgent, { recursive: true });
    writeFileSync(join(globalAgent, "settings.json"), JSON.stringify({ easyresearch: { agents: { search: { model: "x/y" } } } }));
    expect(await extractAgentModels(project, globalAgent)).toBeUndefined();
  });
});

describe("resolveModelForSpawn", () => {
  const ctx = (rows: Array<{ type: string; customType?: string; data?: unknown }>) => ({
    cwd: project,
    sessionManager: { getEntries: () => rows },
  });
  const override = (model: string | null) => [{ type: "custom", customType: AGENT_MODEL_ENTRY, data: { agent: "search", model } }];

  it("uses the project Markdown model over global", async () => {
    writeAgent(globalAgent, "search", "b/2");
    const projectRoot = join(project, ".easyresearch");
    writeAgent(projectRoot, "search", "a/1");
    await expect(resolveModelForSpawn(ctx([]), "search", "o/1")).resolves.toBe("a/1");
  });

  it("lets a session override win and null reset to Markdown", async () => {
    writeAgent(globalAgent, "search", "b/2");
    await expect(resolveModelForSpawn(ctx(override("x/9")), "search", "o/1")).resolves.toBe("x/9");
    await expect(resolveModelForSpawn(ctx(override(null)), "search", "o/1")).resolves.toBe("b/2");
  });

  it("inherits the assistant model when no Markdown model exists", async () => {
    await expect(resolveModelForSpawn(ctx([]), "search", "o/1")).resolves.toBe("o/1");
    await expect(resolveModelForSpawn(ctx([]), "search", undefined)).resolves.toBeUndefined();
  });
});
