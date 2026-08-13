import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPaperAssistantPrompt } from "./pa-config";

const tempDirs: string[] = [];

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "easyresearch-pa-config-"));
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

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("loadPaperAssistantPrompt", () => {
  it("returns the effective project AgentConfig over global, alias, and bundled definitions", async () => {
    const root = makeRoot();
    const cwd = join(root, "project");
    const agentDir = join(root, "global");
    const bundledAgentsDir = join(root, "bundled");
    writeAgent(join(bundledAgentsDir, "agents"), "paper-assistant", definition("Bundled Paper Assistant"));
    writeAgent(join(agentDir, "agents"), "Paper Assistant", definition("Global alias Paper Assistant", ["tools: [bash]"]));
    writeAgent(join(cwd, ".easyresearch", "agents"), "paper-assistant", definition("Project Paper Assistant", [
      "tools: [read, subagent]",
      "skills: [research-project-workflow]",
    ]));

    const config = await loadPaperAssistantPrompt({ cwd, agentDir, bundledAgentsDir });

    expect(config).toMatchObject({
      name: "paper-assistant",
      source: "project",
      tools: ["read", "subagent"],
      skills: ["research-project-workflow"],
      systemPrompt: "Project Paper Assistant",
    });
  });

  it("uses the global alias before the bundled definition", async () => {
    const root = makeRoot();
    const cwd = join(root, "project");
    const agentDir = join(root, "global");
    const bundledAgentsDir = join(root, "bundled");
    writeAgent(join(bundledAgentsDir, "agents"), "paper-assistant", definition("Bundled Paper Assistant"));
    writeAgent(join(agentDir, "agents"), "Paper Assistant", definition("Global alias Paper Assistant", ["tools: [read]"]));

    await expect(loadPaperAssistantPrompt({ cwd, agentDir, bundledAgentsDir })).resolves.toMatchObject({
      name: "paper-assistant",
      source: "global",
      tools: ["read"],
      systemPrompt: "Global alias Paper Assistant",
    });
  });

  it("uses the bundled definition when user definitions are absent", async () => {
    const root = makeRoot();
    const cwd = join(root, "project");
    const agentDir = join(root, "global");
    const bundledAgentsDir = join(root, "bundled");
    writeAgent(join(bundledAgentsDir, "agents"), "paper-assistant", definition("Bundled Paper Assistant"));

    await expect(loadPaperAssistantPrompt({ cwd, agentDir, bundledAgentsDir })).resolves.toMatchObject({
      name: "paper-assistant",
      source: "bundled",
      systemPrompt: "Bundled Paper Assistant",
    });
  });

  it("throws when no valid Paper Assistant definition exists", async () => {
    const root = makeRoot();
    await expect(loadPaperAssistantPrompt({
      cwd: join(root, "project"),
      agentDir: join(root, "global"),
      bundledAgentsDir: join(root, "bundled"),
    })).rejects.toThrow(/Missing valid Paper Assistant definition/);
  });
});
