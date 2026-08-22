import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createResearchAssistantConfigResolver, loadResearchAssistantPrompt } from "./research-assistant-config";

const tempDirs: string[] = [];

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "easyresearch-research-assistant-config-"));
  tempDirs.push(dir);
  return dir;
}

function definition(body: string, fields: string[] = []): string {
  return [
    "---",
    "name: research-assistant",
    "description: Research Assistant",
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

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("loadResearchAssistantPrompt", () => {
  it("ignores project Agent files and returns the global definition over bundled", async () => {
    const root = makeRoot();
    const cwd = join(root, "project");
    const agentDir = join(root, "global");
    const bundledAgentsDir = join(root, "bundled");
    writeAgent(join(bundledAgentsDir, "agents"), "research-assistant", definition("Bundled Research Assistant"));
    writeAgent(join(agentDir, "agents"), "Research Assistant", definition("Global alias Research Assistant", ["tools: [bash]"]));
    writeAgent(join(cwd, ".easyresearch", "agents"), "research-assistant", definition("Project Research Assistant", [
      "tools: [read, subagent]",
      "skills: [research-project-workflow]",
    ]));

    const config = await loadResearchAssistantPrompt({ cwd, agentDir, bundledAgentsDir });

    expect(config).toMatchObject({
      name: "research-assistant",
      source: "global",
      tools: ["bash"],
      skills: undefined,
      systemPrompt: "Global alias Research Assistant",
    });
  });

  it("uses the global alias before the bundled definition", async () => {
    const root = makeRoot();
    const cwd = join(root, "project");
    const agentDir = join(root, "global");
    const bundledAgentsDir = join(root, "bundled");
    writeAgent(join(bundledAgentsDir, "agents"), "research-assistant", definition("Bundled Research Assistant"));
    writeAgent(join(agentDir, "agents"), "Research Assistant", definition("Global alias Research Assistant", ["tools: [read]"]));

    await expect(loadResearchAssistantPrompt({ cwd, agentDir, bundledAgentsDir })).resolves.toMatchObject({
      name: "research-assistant",
      source: "global",
      tools: ["read"],
      systemPrompt: "Global alias Research Assistant",
    });
  });

  it("uses the bundled definition when user definitions are absent", async () => {
    const root = makeRoot();
    const cwd = join(root, "project");
    const agentDir = join(root, "global");
    const bundledAgentsDir = join(root, "bundled");
    writeAgent(join(bundledAgentsDir, "agents"), "research-assistant", definition("Bundled Research Assistant"));

    await expect(loadResearchAssistantPrompt({ cwd, agentDir, bundledAgentsDir })).resolves.toMatchObject({
      name: "research-assistant",
      source: "bundled",
      systemPrompt: "Bundled Research Assistant",
    });
  });

  it("throws when no valid Research Assistant definition exists", async () => {
    const root = makeRoot();
    await expect(loadResearchAssistantPrompt({
      cwd: join(root, "project"),
      agentDir: join(root, "global"),
      bundledAgentsDir: join(root, "bundled"),
    })).rejects.toThrow(/Missing valid Research Assistant definition/);
  });

  it("does not retain a stale cached definition between resolutions", async () => {
    const root = makeRoot();
    const cwd = join(root, "project");
    const agentDir = join(root, "global");
    const bundledAgentsDir = join(root, "bundled");
    const globalAgents = join(agentDir, "agents");
    writeAgent(join(bundledAgentsDir, "agents"), "research-assistant", definition("Bundled Research Assistant"));
    writeAgent(globalAgents, "research-assistant", definition("Global v1", ["tools: [read]"]));
    const resolver = createResearchAssistantConfigResolver({ agentDir, bundledAgentsDir });

    await expect(resolver.resolve(cwd)).resolves.toMatchObject({
      systemPrompt: "Global v1",
      tools: ["read"],
    });
    writeAgent(globalAgents, "research-assistant", definition("Global v2", ["tools: [bash]"]));

    await expect(resolver.resolve(cwd)).resolves.toMatchObject({
      systemPrompt: "Global v2",
      tools: ["bash"],
    });
  });
});
