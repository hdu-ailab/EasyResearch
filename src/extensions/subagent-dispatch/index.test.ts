import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createSubagentDispatchExtension } from "./index";
import { SubagentExecutionError } from "../../subagent/tool";

const tempDirs: string[] = [];

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "easyresearch-subagent-dispatch-"));
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
  delete process.env.EASYRESEARCH_AGENTS_ALLOWLIST;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function loadExtension(options: Parameters<typeof createSubagentDispatchExtension>[0]) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const registeredTools: Array<{ name: string; execute?: (...args: any[]) => Promise<any> }> = [];
  const api = {
    appendEntry: vi.fn(),
    on: vi.fn((event: string, handler: (...args: any[]) => any) => handlers.set(event, handler)),
    registerTool: vi.fn((tool: { name: string; execute?: (...args: any[]) => Promise<any> }) => registeredTools.push(tool)),
  };
  await (createSubagentDispatchExtension(options) as ExtensionFactory)(api as never);
  return { registeredTools };
}

describe("createSubagentDispatchExtension allowlist agentProvider", () => {
  it("exposes only specialists permitted by the effective paper-assistant subagents", async () => {
    const root = makeRoot();
    const cwd = join(root, "project");
    const agentDir = join(root, "global");
    const bundledAgentsDir = join(root, "bundled");
    writeAgent(join(bundledAgentsDir, "agents"), "paper-assistant", definition("Bundled Paper Assistant"));
    writeAgent(join(bundledAgentsDir, "agents"), "search", definition("Search").replace("name: paper-assistant", "name: search"));
    writeAgent(join(bundledAgentsDir, "agents"), "writing", definition("Writing").replace("name: paper-assistant", "name: writing"));
    writeAgent(join(cwd, ".easyresearch", "agents"), "paper-assistant", definition("Project Paper Assistant", [
      "subagents: [search]",
    ]));
    process.env.EASYRESEARCH_AGENTS_ALLOWLIST = "writing";
    const { registeredTools } = await loadExtension({ agentDir, bundledAgentsDir });

    const subagent = registeredTools.find((tool) => tool.name === "subagent");
    const error = await subagent?.execute?.(
      "call-1",
      {},
      undefined,
      undefined,
      { cwd, sessionManager: { getEntries: () => [] } },
    ).catch((value) => value);
    expect(error).toBeInstanceOf(SubagentExecutionError);
    expect(error.message).toContain("search (bundled)");
    expect(error.message).not.toContain("writing (bundled)");
    expect(process.env.EASYRESEARCH_AGENTS_ALLOWLIST).toBe("writing");
  });

  it("keeps a disabled Paper Assistant available without exposing it or disabled specialists for dispatch", async () => {
    const root = makeRoot();
    const cwd = join(root, "project");
    const agentDir = join(root, "global");
    const bundledAgentsDir = join(root, "bundled");
    writeAgent(join(bundledAgentsDir, "agents"), "paper-assistant", definition("Disabled Paper Assistant", [
      "enable: false",
      "tools: [read, subagent]",
    ]));
    writeAgent(join(bundledAgentsDir, "agents"), "search", definition("Search").replace("name: paper-assistant", "name: search"));
    writeAgent(join(bundledAgentsDir, "agents"), "writing", definition("Writing", ["enable: false"])
      .replace("name: paper-assistant", "name: writing"));
    const { registeredTools } = await loadExtension({ agentDir, bundledAgentsDir });

    const error = await registeredTools.find((tool) => tool.name === "subagent")?.execute?.(
      "call-omitted-policy",
      {},
      undefined,
      undefined,
      { cwd, sessionManager: { getEntries: () => [] } },
    ).catch((value) => value);
    expect(error).toBeInstanceOf(SubagentExecutionError);
    expect(error.message).toContain("search (bundled)");
    expect(error.message).not.toContain("paper-assistant (bundled)");
    expect(error.message).not.toContain("writing (bundled)");
  });
});
