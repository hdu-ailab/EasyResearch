import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_THINKING_LEVEL,
  AGENT_THINKING_ENTRY,
  extractAgentThinking,
  resolveEffectiveThinking,
  resolveThinkingForSpawn,
} from "./thinking-resolution";

const piMocks = vi.hoisted(() => ({
  getAgentDir: vi.fn(() => "/fake/agent"),
  parseFrontmatter: (content: string) => {
    const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(content);
    const frontmatter = Object.fromEntries(
      (match?.[1] ?? "")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const index = line.indexOf(":");
          return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
        }),
    );
    return { frontmatter, body: match?.[2] ?? content };
  },
}));
vi.mock("../runtime/pi-import", () => ({
  getAgentDir: piMocks.getAgentDir,
  importPi: vi.fn(async () => ({ parseFrontmatter: piMocks.parseFrontmatter })),
}));

let root: string;
let project: string;
let globalAgent: string;

function writeAgent(agentRoot: string, name: string, thinking?: string): void {
  mkdirSync(join(agentRoot, "agents"), { recursive: true });
  writeFileSync(
    join(agentRoot, "agents", `${name}.md`),
    `---\nname: ${name}\ndescription: ${name}\n${thinking ? `thinking: ${thinking}\n` : ""}---\nPrompt\n`,
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "easyresearch-thinking-"));
  project = join(root, "project");
  globalAgent = join(root, "global");
  mkdirSync(project, { recursive: true });
  piMocks.getAgentDir.mockReturnValue(globalAgent);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("resolveEffectiveThinking", () => {
  it("prefers the session override", () => {
    expect(resolveEffectiveThinking("high", { search: "medium" }, { search: "low" }, "off", "search")).toEqual({
      thinking: "high",
      source: "override",
    });
  });

  it("uses project, global, then Paper Assistant inheritance", () => {
    expect(resolveEffectiveThinking(undefined, { search: "high" }, { search: "low" }, "off", "search")).toEqual({
      thinking: "high",
      source: "default",
    });
    expect(resolveEffectiveThinking(undefined, undefined, { search: "low" }, "off", "search")).toEqual({
      thinking: "low",
      source: "default",
    });
    expect(resolveEffectiveThinking(undefined, undefined, undefined, "off", "search")).toEqual({
      thinking: "off",
      source: "inherit",
    });
    expect(resolveEffectiveThinking(undefined, undefined, undefined, undefined, "search")).toBeNull();
  });
});

describe("extractAgentThinking", () => {
  it("reads thinking levels from effective Markdown agents", async () => {
    writeAgent(globalAgent, "search", "high");
    writeAgent(globalAgent, "writing", "low");
    expect(await extractAgentThinking(project, globalAgent)).toEqual({ search: "high", writing: "low" });
  });

  it("returns no config when no agent sets a thinking level", async () => {
    writeAgent(globalAgent, "search");
    expect(await extractAgentThinking(project, globalAgent)).toBeUndefined();
  });
});

describe("resolveThinkingForSpawn", () => {
  const ctx = (rows: Array<{ type: string; customType?: string; data?: unknown }>) => ({
    cwd: project,
    sessionManager: { getEntries: () => rows },
  });
  const override = (thinking: string | null) => [
    { type: "custom", customType: AGENT_THINKING_ENTRY, data: { agent: "search", thinking } },
  ];

  it("uses the project Markdown thinking over global", async () => {
    writeAgent(globalAgent, "search", "low");
    const projectRoot = join(project, ".easyresearch");
    writeAgent(projectRoot, "search", "high");
    await expect(resolveThinkingForSpawn(ctx([]), "search", "off")).resolves.toBe("high");
  });

  it("lets a session override win and a null reset fall back to Markdown", async () => {
    writeAgent(globalAgent, "search", "low");
    await expect(resolveThinkingForSpawn(ctx(override("high")), "search", "off")).resolves.toBe("high");
    await expect(resolveThinkingForSpawn(ctx(override(null)), "search", "off")).resolves.toBe("low");
  });

  it("inherits the Paper Assistant level and defaults to off", async () => {
    await expect(resolveThinkingForSpawn(ctx([]), "search", "medium")).resolves.toBe("medium");
    await expect(resolveThinkingForSpawn(ctx([]), "search", undefined)).resolves.toBe(DEFAULT_THINKING_LEVEL);
  });
});