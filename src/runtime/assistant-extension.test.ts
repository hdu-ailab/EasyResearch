import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createAssistantExtension, loadAssistantPrompt } from "./assistant-extension";

const tempDirs: string[] = [];

function makeAgentsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "easyresearch-agents-"));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  process.env.EASYRESEARCH_RPC_CHILD = "1";
});

afterEach(() => {
  delete process.env.EASYRESEARCH_RPC_CHILD;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("loadAssistantPrompt", () => {
  it("reads the assistant body from the agents dir", async () => {
    const agentsDir = makeAgentsDir();
    writeFileSync(
      join(agentsDir, "assistant.md"),
      "---\nname: assistant\ntools: subagent\n---\n\nYou are the assistant\n",
    );

    const prompt = await loadAssistantPrompt(agentsDir);
    expect(prompt).toContain("You are the assistant");
    expect(prompt).not.toContain("---");
  });

  it("throws when the global assistant definition is missing", async () => {
    const agentsDir = makeAgentsDir();
    await expect(loadAssistantPrompt(agentsDir)).rejects.toThrow(/Missing global assistant definition/);
  });

  it("uses the bundled assistant definition when the global copy is missing", async () => {
    const agentsDir = makeAgentsDir();
    const bundledDir = makeAgentsDir();
    writeFileSync(join(bundledDir, "assistant.md"), "---\nname: assistant\n---\nBundled assistant\n");
    await expect(loadAssistantPrompt(agentsDir, undefined, bundledDir)).resolves.toContain("Bundled assistant");
  });

  it("throws on an assistant file without frontmatter", async () => {
    const agentsDir = makeAgentsDir();
    writeFileSync(join(agentsDir, "assistant.md"), "no frontmatter here\n");
    await expect(loadAssistantPrompt(agentsDir)).rejects.toThrow(/frontmatter/i);
  });
});

describe("createAssistantExtension", () => {
  it("appends the assistant prompt to the base system prompt once", async () => {
    const agentsDir = makeAgentsDir();
    writeFileSync(
      join(agentsDir, "assistant.md"),
      "---\nname: assistant\ntools: subagent\n---\n\nAssistant body\n",
    );

    const extension = createAssistantExtension({ agentsDir });
    const registerTool = vi.fn();
    let capturedHandler: ((event: { systemPrompt: string }) => unknown) | undefined;
    let trustHandler: (() => unknown) | undefined;
    const api = {
      registerTool,
      on: vi.fn((event: string, handler: (event: { systemPrompt: string }) => unknown) => {
        if (event === "before_agent_start") capturedHandler = handler;
        if (event === "project_trust") trustHandler = handler as () => unknown;
      }),
    };
    await (extension as ExtensionFactory)(api as never);

    expect(registerTool).toHaveBeenCalledTimes(2);
    const toolNames = registerTool.mock.calls.map((call) => (call[0] as { name: string }).name);
    expect(toolNames).toContain("subagent");
    expect(toolNames).toContain("web-search");
    const result = capturedHandler?.({ systemPrompt: "pi base" }) as { systemPrompt: string };
    expect(result.systemPrompt).toContain("pi base");
    expect(result.systemPrompt).toContain("Assistant body");
    expect(result.systemPrompt.indexOf("pi base")).toBeLessThan(result.systemPrompt.indexOf("Assistant body"));
    expect(result.systemPrompt.split("Assistant body")).toHaveLength(2);
  });

  it("always answers project_trust with yes (ADR-018)", async () => {
    const agentsDir = makeAgentsDir();
    writeFileSync(
      join(agentsDir, "assistant.md"),
      "---\nname: assistant\ntools: subagent\n---\n\nBody\n",
    );

    const extension = createAssistantExtension({ agentsDir });
    let trustHandler: (() => unknown) | undefined;
    const api = {
      registerTool: vi.fn(),
      on: vi.fn((event: string, handler: unknown) => {
        if (event === "project_trust") trustHandler = handler as () => unknown;
      }),
    };
    await (extension as ExtensionFactory)(api as never);

    expect(trustHandler).toBeDefined();
    expect(trustHandler?.()).toEqual({ trusted: "yes" });
  });
});
