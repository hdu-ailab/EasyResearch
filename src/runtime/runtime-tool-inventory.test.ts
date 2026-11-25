import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentConfig, RegisteredAgentTool } from "../subagent/agents";
import { createLiveConfiguration, type LiveConfiguration } from "./live-configuration";
import { RuntimeToolInventory, type RuntimeToolSnapshot } from "./runtime-tool-inventory";

function agent(name: string, tools?: string[]): AgentConfig {
  return {
    name, tools, description: name, enabled: true, builtin: false,
    source: "global", filePath: "unused.md", systemPrompt: "",
    effectiveTools: [], effectiveSkills: [], effectiveSkillPaths: [], missingSkills: [],
  };
}

function tool(name: string, path: string, scope: "user" | "project"): RegisteredAgentTool {
  return { name, sourceInfo: { path, scope } };
}

describe("owned Tool inventory scopes", () => {
  let root: string;
  let agentDir: string;
  let projectA: string;
  let projectB: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "easyresearch-tool-scope-"));
    agentDir = join(root, "agent");
    projectA = join(root, "paper-a");
    projectB = join(root, "paper-b");
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    mkdirSync(projectA);
    mkdirSync(projectB);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const main = agent("research-assistant");

  it("retains a registered global source when another project's same-name tool shadows it", () => {
    const inventory = new RuntimeToolInventory();
    inventory.update({}, {
      cwd: projectA, agentName: main.name, generation: 1,
      tools: [{ name: "read" }, tool("shared_tool", join(agentDir, "extensions", "shared.ts"), "user")],
    });
    inventory.update({}, {
      cwd: projectB, agentName: main.name, generation: 2,
      tools: [
        { name: "read" },
        tool("shared_tool", join(projectB, ".easyresearch", "extensions", "shared.ts"), "project"),
        tool("project_only", join(projectB, ".easyresearch", "extensions", "local.ts"), "project"),
      ],
    });

    expect(inventory.project([main])[0]!.effectiveTools).toContain("shared_tool");
    expect(inventory.project([main])[0]!.effectiveTools).not.toContain("project_only");
    expect(inventory.project([main], projectA)[0]!.effectiveTools).not.toContain("project_only");
    expect(inventory.project([main], projectB)[0]!.effectiveTools).toEqual(["read", "shared_tool", "project_only"]);
  });

  it("aggregates root and stage global registrations while keeping exact-cwd registries authoritative", () => {
    const inventory = new RuntimeToolInventory();
    inventory.update({}, {
      cwd: projectA, agentName: main.name, generation: 1,
      tools: [{ name: "read" }, tool("root_tool", join(agentDir, "extensions", "root.ts"), "user")],
    });
    inventory.update({}, {
      cwd: projectB, agentName: "custom-helper", generation: 2,
      tools: [{ name: "read" }, tool("stage_tool", join(agentDir, "extensions", "stage.ts"), "user")],
    });
    const agents = [main, agent("custom-helper"), agent("opted-helper", ["read", "root_tool", "stage_tool", "unknown"])];
    const global = inventory.project(agents);
    expect(global[0]!.effectiveTools).toEqual(expect.arrayContaining(["root_tool", "stage_tool"]));
    expect(global[1]!.effectiveTools).toEqual(["read"]);
    expect(global[2]!.effectiveTools).toEqual(["read", "root_tool", "stage_tool"]);
    expect(inventory.project([agent(main.name, ["read", "unknown"])])[0]!.effectiveTools).toEqual(["read"]);
    expect(inventory.project(agents, projectA)[2]!.effectiveTools).toEqual(["read", "root_tool"]);
    expect(inventory.project(agents, projectB)[2]!.effectiveTools).toEqual(["read", "stage_tool"]);
    expect(inventory.project([main], projectA)[0]!.effectiveTools).not.toContain("stage_tool");
  });

  it("retains an older owned runtime's tools without accepting stale same-owner reports or cross-owner cleanup", () => {
    const inventory = new RuntimeToolInventory();
    const busyOwner = {};
    const idleOwner = {};
    inventory.update(busyOwner, {
      cwd: projectA, agentName: main.name, generation: 1,
      tools: [tool("busy_tool", join(agentDir, "extensions", "busy.ts"), "user")],
    });
    const current: RuntimeToolSnapshot = {
      cwd: projectA, agentName: main.name, generation: 2,
      tools: [tool("current_tool", join(agentDir, "extensions", "current.ts"), "user")],
    };
    inventory.update(idleOwner, current);
    expect(inventory.project([main])[0]!.effectiveTools).toEqual(expect.arrayContaining(["busy_tool", "current_tool"]));
    expect(inventory.project([main], projectA)[0]!.effectiveTools).toEqual(expect.arrayContaining(["busy_tool", "current_tool"]));
    expect(inventory.update(idleOwner, {
      ...current, generation: 1,
      tools: [tool("stale_tool", join(agentDir, "extensions", "stale.ts"), "user")],
    })).toBe(false);
    expect(inventory.update(idleOwner, current)).toBe(false);
    expect(inventory.project([main])[0]!.effectiveTools).not.toContain("stale_tool");

    expect(inventory.update(busyOwner, undefined)).toBe(true);
    expect(inventory.update(busyOwner, undefined)).toBe(false);
    expect(inventory.project([main])[0]!.effectiveTools).toEqual(["current_tool"]);
    expect(inventory.project([main], projectA)[0]!.effectiveTools).toEqual(["current_tool"]);
    inventory.update(idleOwner, { ...current, generation: 3, tools: [] });
    expect(inventory.project([main])[0]!.effectiveTools).not.toContain("current_tool");
  });

  it("deduplicates shared global names without letting cleanup of one owner erase another registration", () => {
    const inventory = new RuntimeToolInventory();
    const first = {};
    const second = {};
    const snapshot: RuntimeToolSnapshot = {
      cwd: projectA, agentName: main.name, generation: 1,
      tools: [tool("shared_tool", join(agentDir, "extensions", "shared.ts"), "user")],
    };
    inventory.update(first, snapshot);
    inventory.update(second, { ...snapshot, cwd: projectB });
    expect(inventory.project([main])[0]!.effectiveTools).toEqual(["shared_tool"]);
    inventory.update(second, undefined);
    expect(inventory.project([main])[0]!.effectiveTools).toEqual(["shared_tool"]);
  });

  it("keeps unattributed external failures in their owning cwd instead of inferring global scope", () => {
    const inventory = new RuntimeToolInventory();
    const privatePath = join(projectA, "helpers", "private-extension.ts");
    const error = { path: privatePath, error: `Cannot load ${join(agentDir, "extensions", "secret.ts")}` };
    inventory.update({}, {
      cwd: projectA, agentName: main.name, generation: 1, tools: [],
      errors: [error],
    });

    expect(inventory.project([main], projectA)[0]!.toolDiagnostics?.join("\n")).toContain(privatePath);
    expect(inventory.project([main])[0]!.toolDiagnostics).toBeUndefined();
    expect(inventory.project([main], projectB)[0]!.toolDiagnostics).toBeUndefined();
  });

  it("honors explicit error source scope even when paths lie outside or inside the global extension directory", () => {
    const inventory = new RuntimeToolInventory(agentDir);
    const globalPath = join(root, "external", "global.ts");
    const projectPath = join(agentDir, "extensions", "project-configured.ts");
    inventory.update({}, {
      cwd: projectA, agentName: main.name, generation: 1, tools: [],
      errors: [{ path: globalPath, scope: "user" }, { path: projectPath, scope: "project" }],
    });
    inventory.update({}, { cwd: projectB, agentName: "custom-helper", generation: 2, tools: [] });

    const globalDiagnostics = inventory.project([main])[0]!.toolDiagnostics?.join("\n") ?? "";
    expect(globalDiagnostics).toContain(globalPath);
    expect(globalDiagnostics).not.toContain(projectPath);
    expect(inventory.project([main], projectA)[0]!.toolDiagnostics?.join("\n")).toContain(projectPath);
    expect(inventory.project([main], projectB)[0]!.toolDiagnostics?.join("\n")).toBe(globalDiagnostics);
  });

  it("infers only physically contained global extension paths, including missing leaves", () => {
    const inventory = new RuntimeToolInventory(agentDir);
    const extensions = join(agentDir, "extensions");
    const globalPath = join(extensions, "broken.ts");
    const missingPath = join(extensions, "new-directory", "missing.ts");
    const siblingPath = join(agentDir, "extensions-other", "private.ts");
    const escapedPath = join(extensions, "project-link", "private.ts");
    const danglingPath = join(extensions, "dangling-link", "private.ts");
    const parentEscapePath = `${extensions}${sep}project-link${sep}..${sep}parent.ts`;
    writeFileSync(globalPath, "");
    writeFileSync(join(projectA, "private.ts"), "");
    writeFileSync(join(root, "parent.ts"), "");
    writeFileSync(join(extensions, "parent.ts"), "");
    symlinkSync(projectA, join(extensions, "project-link"), process.platform === "win32" ? "junction" : "dir");
    symlinkSync(join(root, "absent-project"), join(extensions, "dangling-link"), process.platform === "win32" ? "junction" : "dir");
    // POSIX resolves ".." after following the symlink; Windows normalizes it first.
    const privatePaths = [siblingPath, escapedPath, danglingPath, ...(process.platform === "win32" ? [] : [parentEscapePath])];
    inventory.update({}, {
      cwd: projectA, agentName: main.name, generation: 1, tools: [],
      errors: [globalPath, missingPath, ...privatePaths].map(path => ({ path })),
    });

    const globalDiagnostics = inventory.project([main])[0]!.toolDiagnostics?.join("\n") ?? "";
    expect(globalDiagnostics).toContain(globalPath);
    expect(globalDiagnostics).toContain(missingPath);
    for (const path of privatePaths) {
      expect(globalDiagnostics).not.toContain(path);
      expect(inventory.project([main], projectB)[0]!.toolDiagnostics?.join("\n")).not.toContain(path);
      expect(inventory.project([main], projectA)[0]!.toolDiagnostics?.join("\n")).toContain(path);
    }
  });

  it.runIf(process.platform !== "win32")("keeps symlink-parent diagnostics local in the Bun runtime", () => {
    const extensions = join(agentDir, "extensions");
    writeFileSync(join(root, "parent.ts"), "");
    writeFileSync(join(extensions, "parent.ts"), "");
    symlinkSync(projectA, join(extensions, "project-link"), "dir");
    const path = `${extensions}/project-link/../parent.ts`;
    const output = execFileSync("bun", ["-e", `
const { RuntimeToolInventory } = await import(${JSON.stringify(new URL("./runtime-tool-inventory.ts", import.meta.url).href)});
const inventory = new RuntimeToolInventory(${JSON.stringify(agentDir)});
const agent = ${JSON.stringify(main)};
const cwd = ${JSON.stringify(projectA)};
inventory.update({}, {cwd, agentName: agent.name, generation: 1, tools: [], errors: [{path: ${JSON.stringify(path)}}]});
console.log(JSON.stringify({global: inventory.project([agent]), local: inventory.project([agent], cwd)}));
`], {
      encoding: "utf8", timeout: 20_000,
      env: { ...process.env, HOME: root, USERPROFILE: root, TMPDIR: root, EASYRESEARCH_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
    });
    const result = JSON.parse(output);
    expect(result.global[0].toolDiagnostics).toBeUndefined();
    expect(result.local[0].toolDiagnostics.join("\n")).toContain(path);
  });
});

describe("runtime-backed Tool metadata", () => {
  it("projects registered tools by scope and opt-in, publishes without reload, and removes stale names", async () => {
    const root = mkdtempSync(join(tmpdir(), "easyresearch-tool-inventory-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "paper");
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    mkdirSync(cwd);
    for (const [name, tools] of [
      ["custom-helper", "[]"],
      ["opted-helper", "[read, global_tool, project_tool, unknown_tool]"],
    ]) writeFileSync(join(agentDir, "agents", `${name}.md`), `---\nname: ${name}\ndescription: Test helper\ntools: ${tools}\n---\nHelp.`);
    const live = createLiveConfiguration({
      agentDir, catalogOptions: { homeDir: root },
      modelValidator: {
        async prepareModelCatalog() { return { registeredModels: [], availableModels: [], commit() {}, rollback() {} }; },
        currentAvailableModels: () => [],
      },
    }) as LiveConfiguration & {
      updateRuntimeTools?(owner: object, snapshot: {
        cwd: string; agentName: string; generation: number;
        tools: Array<{ name: string; sourceInfo: { path: string; scope: "user" | "project" } }>;
        errors?: Array<{ path: string; error: string }>;
      } | undefined): void;
    };
    try {
      await live.start();
      const generation = live.generation;
      const owner = {};
      const updates: unknown[] = [];
      live.subscribe(event => updates.push(event));
      live.updateRuntimeTools?.(owner, {
        cwd, generation, agentName: "research-assistant",
        tools: [
          { name: "global_tool", sourceInfo: { path: join(agentDir, "extensions", "custom.ts"), scope: "user" } },
          { name: "project_tool", sourceInfo: { path: join(cwd, ".easyresearch", "extensions", "local.ts"), scope: "project" } },
        ],
        errors: [{ path: join(agentDir, "extensions", "bad.ts"), error: "SECRET_PROVIDER_VALUE" }],
      });
      const global = await live.resolveAgents();
      const local = await live.resolveAgents(cwd);
      expect(global.find(agent => agent.name === "research-assistant")?.effectiveTools).toContain("global_tool");
      expect(global.find(agent => agent.name === "research-assistant")?.effectiveTools).not.toContain("project_tool");
      expect(local.find(agent => agent.name === "research-assistant")?.effectiveTools).toContain("project_tool");
      expect(local.find(agent => agent.name === "custom-helper")?.effectiveTools).not.toContain("global_tool");
      expect(local.find(agent => agent.name === "opted-helper")?.effectiveTools).toEqual(["read", "global_tool", "project_tool"]);
      expect(JSON.stringify(local)).not.toContain("SECRET_PROVIDER_VALUE");
      expect(JSON.stringify(local)).toContain("bad.ts");
      expect(live.generation).toBe(generation);
      expect(updates).toContainEqual(expect.objectContaining({ toolsChanged: true, runtimeChanged: false }));

      live.updateRuntimeTools?.(owner, { cwd, generation, agentName: "research-assistant", tools: [] });
      expect((await live.resolveAgents(cwd)).find(agent => agent.name === "opted-helper")?.effectiveTools).toEqual(["read"]);
      live.updateRuntimeTools?.(owner, undefined);
      expect((await live.resolveAgents()).find(agent => agent.name === "research-assistant")?.effectiveTools).not.toContain("global_tool");
    } finally {
      await live.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
