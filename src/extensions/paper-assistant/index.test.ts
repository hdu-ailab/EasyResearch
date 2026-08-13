import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createPaperAssistantExtension } from "./index";

const tempDirs: string[] = [];

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "easyresearch-paper-assistant-"));
  tempDirs.push(dir);
  return dir;
}

function definition(body: string, fields: string[] = []): string {
  return [
    "---",
    "name: paper-assistant",
    "description: Paper Assistant",
    ...fields,
    "---",
    body,
    "",
  ].join("\n");
}

function writeAgent(directory: string, name: string, content: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${name}.md`), content, "utf8");
}

beforeEach(() => {
  process.env.EASYRESEARCH_RPC_CHILD = "1";
});

afterEach(() => {
  delete process.env.EASYRESEARCH_RPC_CHILD;
  delete process.env.EASYRESEARCH_AGENTS_ALLOWLIST;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface ExtensionHarness {
  handlers: Map<string, (...args: any[]) => any>;
  setActiveTools: ReturnType<typeof vi.fn>;
}

async function loadExtension(options: Parameters<typeof createPaperAssistantExtension>[0]): Promise<ExtensionHarness> {
  const handlers = new Map<string, (...args: any[]) => any>();
  const setActiveTools = vi.fn();
  const api = {
    getAllTools: vi.fn(() => ["read", "bash", "custom-tool", "subagent", "web-search"].map((name) => ({ name }))),
    on: vi.fn((event: string, handler: (...args: any[]) => any) => handlers.set(event, handler)),
    setActiveTools,
  };
  await (createPaperAssistantExtension(options) as ExtensionFactory)(api as never);
  return { handlers, setActiveTools };
}

describe("createPaperAssistantExtension definition application", () => {
  it("applies one exact-cwd definition to active tools", async () => {
    const root = makeRoot();
    const cwd = join(root, "project");
    const agentDir = join(root, "global");
    const bundledAgentsDir = join(root, "bundled");
    writeAgent(join(bundledAgentsDir, "agents"), "paper-assistant", definition("Bundled Paper Assistant"));
    writeAgent(join(cwd, ".easyresearch", "agents"), "paper-assistant", definition("Project Paper Assistant", [
      "tools: [read, subagent]",
      "skills: [research-project-workflow]",
    ]));
    const { handlers, setActiveTools } = await loadExtension({ agentDir, bundledAgentsDir });

    await handlers.get("session_start")?.({ reason: "startup" }, { cwd, mode: "rpc" });
    expect(setActiveTools).toHaveBeenCalledWith(["read", "subagent"]);
  });

  it("appends the effective system prompt at before_agent_start", async () => {
    const root = makeRoot();
    const cwd = join(root, "project");
    const agentDir = join(root, "global");
    const bundledAgentsDir = join(root, "bundled");
    writeAgent(join(bundledAgentsDir, "agents"), "paper-assistant", definition("Bundled Paper Assistant"));
    writeAgent(join(cwd, ".easyresearch", "agents"), "paper-assistant", definition("Project Paper Assistant", [
      "tools: [read, subagent]",
    ]));
    const { handlers } = await loadExtension({ agentDir, bundledAgentsDir });

    const prompt = await handlers.get("before_agent_start")?.(
      { systemPrompt: "Pi base" },
      { cwd },
    );
    expect(prompt.systemPrompt).toContain("Pi base");
    expect(prompt.systemPrompt).toContain("Project Paper Assistant");
  });

  it("resolves Skill roots from the effective definition's skills", async () => {
    const root = makeRoot();
    const cwd = join(root, "project");
    const agentDir = join(root, "global");
    const bundledAgentsDir = join(root, "bundled");
    const bundledSkillsDir = join(root, "skills");
    const workflowSkill = join(bundledSkillsDir, "research-project-workflow");
    mkdirSync(workflowSkill, { recursive: true });
    writeFileSync(join(workflowSkill, "SKILL.md"), "# Workflow\n", "utf8");
    writeAgent(join(bundledAgentsDir, "agents"), "paper-assistant", definition("Bundled Paper Assistant"));
    writeAgent(join(cwd, ".easyresearch", "agents"), "paper-assistant", definition("Project Paper Assistant", [
      "skills: [research-project-workflow]",
    ]));
    const { handlers } = await loadExtension({ agentDir, bundledAgentsDir, bundledSkillsDir });

    const resources = await handlers.get("resources_discover")?.({ cwd, reason: "startup" }, { cwd });
    expect(resources.skillPaths).toEqual([workflowSkill]);
  });

  it("activates every registered tool and controlled Skill root for empty capability lists", async () => {
    const root = makeRoot();
    const cwd = join(root, "project");
    const agentDir = join(root, "global");
    const bundledAgentsDir = join(root, "bundled");
    const bundledSkillsDir = join(root, "skills");
    const projectSkills = join(cwd, ".easyresearch", "skills");
    const globalSkills = join(agentDir, "skills");
    for (const directory of [projectSkills, globalSkills, bundledSkillsDir]) mkdirSync(directory, { recursive: true });
    writeAgent(join(bundledAgentsDir, "agents"), "paper-assistant", definition("All capabilities", ["tools: []", "skills: []"]));
    const { handlers, setActiveTools } = await loadExtension({ agentDir, bundledAgentsDir, bundledSkillsDir });

    await handlers.get("session_start")?.({ reason: "startup" }, { cwd, mode: "tui" });
    expect(setActiveTools).toHaveBeenCalledWith(["read", "bash", "custom-tool", "subagent", "web-search"]);

    const resources = await handlers.get("resources_discover")?.({ cwd, reason: "startup" }, { cwd });
    expect(resources.skillPaths).toEqual([projectSkills, globalSkills, bundledSkillsDir]);
  });
});
