import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createAssistantExtension, loadAssistantConfig } from "./assistant-extension";

const tempDirs: string[] = [];

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "easyresearch-assistant-"));
  tempDirs.push(dir);
  return dir;
}

function definition(body: string, fields: string[] = []): string {
  return [
    "---",
    "name: assistant",
    "description: Assistant",
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

describe("loadAssistantConfig", () => {
  it("returns the effective project AgentConfig over global, alias, and bundled definitions", async () => {
    const root = makeRoot();
    const cwd = join(root, "project");
    const agentDir = join(root, "global");
    const bundledAgentsDir = join(root, "bundled");
    writeAgent(join(bundledAgentsDir, "agents"), "assistant", definition("Bundled assistant"));
    writeAgent(join(agentDir, "agents"), "Paper Assistant", definition("Global alias assistant", ["tools: [bash]"]));
    writeAgent(join(cwd, ".easyresearch", "agents"), "assistant", definition("Project assistant", [
      "tools: [read, subagent]",
      "skills: [research-project-workflow]",
    ]));

    const config = await loadAssistantConfig({ cwd, agentDir, bundledAgentsDir });

    expect(config).toMatchObject({
      name: "assistant",
      source: "project",
      tools: ["read", "subagent"],
      skills: ["research-project-workflow"],
      systemPrompt: "Project assistant",
    });
  });

  it("uses the global alias before the bundled definition", async () => {
    const root = makeRoot();
    const cwd = join(root, "project");
    const agentDir = join(root, "global");
    const bundledAgentsDir = join(root, "bundled");
    writeAgent(join(bundledAgentsDir, "agents"), "assistant", definition("Bundled assistant"));
    writeAgent(join(agentDir, "agents"), "Paper Assistant", definition("Global alias assistant", ["tools: [read]"]));

    await expect(loadAssistantConfig({ cwd, agentDir, bundledAgentsDir })).resolves.toMatchObject({
      name: "assistant",
      source: "global",
      tools: ["read"],
      systemPrompt: "Global alias assistant",
    });
  });

  it("uses the bundled definition when user definitions are absent", async () => {
    const root = makeRoot();
    const cwd = join(root, "project");
    const agentDir = join(root, "global");
    const bundledAgentsDir = join(root, "bundled");
    writeAgent(join(bundledAgentsDir, "agents"), "assistant", definition("Bundled assistant"));

    await expect(loadAssistantConfig({ cwd, agentDir, bundledAgentsDir })).resolves.toMatchObject({
      name: "assistant",
      source: "bundled",
      systemPrompt: "Bundled assistant",
    });
  });

  it("throws when no valid Assistant definition exists", async () => {
    const root = makeRoot();
    await expect(loadAssistantConfig({
      cwd: join(root, "project"),
      agentDir: join(root, "global"),
      bundledAgentsDir: join(root, "bundled"),
    })).rejects.toThrow(/assistant definition/i);
  });
});

interface ExtensionHarness {
  handlers: Map<string, (...args: any[]) => any>;
  registeredTools: Array<{ name: string; execute?: (...args: any[]) => Promise<any> }>;
  setActiveTools: ReturnType<typeof vi.fn>;
}

async function loadExtension(options: Parameters<typeof createAssistantExtension>[0]): Promise<ExtensionHarness> {
  const handlers = new Map<string, (...args: any[]) => any>();
  const registeredTools: Array<{ name: string; execute?: (...args: any[]) => Promise<any> }> = [];
  const setActiveTools = vi.fn();
  const api = {
    appendEntry: vi.fn(),
    getAllTools: vi.fn(() => ["read", "bash", "custom-tool", "subagent", "web-search"].map((name) => ({ name }))),
    on: vi.fn((event: string, handler: (...args: any[]) => any) => handlers.set(event, handler)),
    registerTool: vi.fn((tool: { name: string; execute?: (...args: any[]) => Promise<any> }) => registeredTools.push(tool)),
    setActiveTools,
  };
  await (createAssistantExtension(options) as ExtensionFactory)(api as never);
  return { handlers, registeredTools, setActiveTools };
}

describe("createAssistantExtension", () => {
  it("applies one exact-cwd definition to tools, Skills, prompt, and subagents", async () => {
    const root = makeRoot();
    const cwd = join(root, "project");
    const agentDir = join(root, "global");
    const bundledAgentsDir = join(root, "bundled");
    const bundledSkillsDir = join(root, "skills");
    const workflowSkill = join(bundledSkillsDir, "research-project-workflow");
    mkdirSync(workflowSkill, { recursive: true });
    writeFileSync(join(workflowSkill, "SKILL.md"), "# Workflow\n", "utf8");
    writeAgent(join(bundledAgentsDir, "agents"), "assistant", definition("Bundled assistant"));
    writeAgent(join(bundledAgentsDir, "agents"), "search", definition("Search").replace("name: assistant", "name: search"));
    writeAgent(join(bundledAgentsDir, "agents"), "writing", definition("Writing").replace("name: assistant", "name: writing"));
    writeAgent(join(cwd, ".easyresearch", "agents"), "assistant", definition("Project assistant", [
      "tools: [read, subagent]",
      "skills: [research-project-workflow]",
      "subagents: [search]",
    ]));
    process.env.EASYRESEARCH_AGENTS_ALLOWLIST = "writing";
    const { handlers, registeredTools, setActiveTools } = await loadExtension({
      agentDir,
      bundledAgentsDir,
      bundledSkillsDir,
    });

    await handlers.get("session_start")?.({ reason: "startup" }, { cwd, mode: "rpc" });
    expect(setActiveTools).toHaveBeenCalledWith(["read", "subagent"]);

    const resources = await handlers.get("resources_discover")?.({ cwd, reason: "startup" }, { cwd });
    expect(resources.skillPaths).toEqual([workflowSkill]);

    const prompt = await handlers.get("before_agent_start")?.(
      { systemPrompt: "Pi base" },
      { cwd },
    );
    expect(prompt.systemPrompt).toContain("Pi base");
    expect(prompt.systemPrompt).toContain("Project assistant");

    const subagent = registeredTools.find((tool) => tool.name === "subagent");
    const result = await subagent?.execute?.(
      "call-1",
      {},
      undefined,
      undefined,
      { cwd, sessionManager: { getEntries: () => [] } },
    );
    expect(result.content[0].text).toContain("search (bundled)");
    expect(result.content[0].text).not.toContain("writing (bundled)");
    expect(process.env.EASYRESEARCH_AGENTS_ALLOWLIST).toBe("writing");
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
    writeAgent(join(bundledAgentsDir, "agents"), "assistant", definition("All capabilities", ["tools: []", "skills: []"]));
    const { handlers, setActiveTools } = await loadExtension({ agentDir, bundledAgentsDir, bundledSkillsDir });

    await handlers.get("session_start")?.({ reason: "startup" }, { cwd, mode: "tui" });
    expect(setActiveTools).toHaveBeenCalledWith(["read", "bash", "custom-tool", "subagent", "web-search"]);

    const resources = await handlers.get("resources_discover")?.({ cwd, reason: "startup" }, { cwd });
    expect(resources.skillPaths).toEqual([projectSkills, globalSkills, bundledSkillsDir]);
  });

  it("always answers project_trust with yes (ADR-018)", async () => {
    const root = makeRoot();
    const bundledAgentsDir = join(root, "bundled");
    writeAgent(join(bundledAgentsDir, "agents"), "assistant", definition("Body"));
    const { handlers } = await loadExtension({
      agentDir: join(root, "global"),
      bundledAgentsDir,
    });

    expect(handlers.get("project_trust")?.()).toEqual({ trusted: "yes" });
  });
});
