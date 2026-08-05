import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createOrchestratorExtension, loadOrchestratorPrompt } from "./orchestrator-extension";

const tempDirs: string[] = [];

function makeAgentsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lazyresearch-agents-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("loadOrchestratorPrompt", () => {
  it("reads the orchestrator body from the agents dir", () => {
    const agentsDir = makeAgentsDir();
    writeFileSync(
      join(agentsDir, "orchestrator.md"),
      "---\nname: orchestrator\ntools: subagent\n---\n\nYou are the orchestrator\n",
    );

    const prompt = loadOrchestratorPrompt(agentsDir);
    expect(prompt).toContain("You are the orchestrator");
    expect(prompt).not.toContain("---");
  });

  it("throws when the global orchestrator definition is missing", () => {
    const agentsDir = makeAgentsDir();
    expect(() => loadOrchestratorPrompt(agentsDir)).toThrow(/Missing global orchestrator definition/);
  });

  it("throws on an orchestrator file without frontmatter", () => {
    const agentsDir = makeAgentsDir();
    writeFileSync(join(agentsDir, "orchestrator.md"), "no frontmatter here\n");
    expect(() => loadOrchestratorPrompt(agentsDir)).toThrow(/frontmatter/i);
  });
});

describe("createOrchestratorExtension", () => {
  it("appends the orchestrator prompt to the base system prompt once", async () => {
    const agentsDir = makeAgentsDir();
    writeFileSync(
      join(agentsDir, "orchestrator.md"),
      "---\nname: orchestrator\ntools: subagent\n---\n\nOrchestrator body\n",
    );

    const extension = createOrchestratorExtension({ agentsDir });
    const registerTool = vi.fn();
    let capturedHandler: ((event: { systemPrompt: string }) => unknown) | undefined;
    const api = {
      registerTool,
      on: vi.fn((event: string, handler: (event: { systemPrompt: string }) => unknown) => {
        if (event === "before_agent_start") capturedHandler = handler;
      }),
    };
    await (extension as ExtensionFactory)(api as never);

    expect(registerTool).toHaveBeenCalledTimes(1);
    const result = capturedHandler?.({ systemPrompt: "pi base" }) as { systemPrompt: string };
    expect(result.systemPrompt).toContain("pi base");
    expect(result.systemPrompt).toContain("Orchestrator body");
    expect(result.systemPrompt.indexOf("pi base")).toBeLessThan(result.systemPrompt.indexOf("Orchestrator body"));
    expect(result.systemPrompt.split("Orchestrator body")).toHaveLength(2);
  });
});