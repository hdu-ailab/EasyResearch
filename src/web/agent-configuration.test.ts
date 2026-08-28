import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfigurationPatch } from "./contracts";
import { createAgentPatchService, patchGlobalAgent } from "./agent-configuration";
import { repairDanglingAgentDefaults } from "../runtime/agent-default-repair";
import { readGlobalAgent } from "./agent-resources";
import { ConfigFileService } from "./config-files";

const SEARCH_WITH_DEFAULTS = `---
name: search
description: Search agent
model: old/model
thinking: low
tools:
  - read
---

Search prompt.
`;

const WRITING_AGENT = `---
name: writing
description: Writing agent
---

Writing prompt.
`;

describe("patchGlobalAgent", () => {
  let agentDir: string;
  let config: ConfigFileService;

  beforeEach(() => {
    agentDir = mkdtempSync(join("/dev/shm", "easyresearch-agent-config-"));
    config = new ConfigFileService(agentDir);
  });

  afterEach(() => rmSync(agentDir, { recursive: true, force: true }));

  function writeAgent(name: string, content: string): void {
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    writeFileSync(join(agentDir, "agents", `${name}.md`), content);
  }

  function agentBytes(): Record<string, Buffer> {
    const directory = join(agentDir, "agents");
    if (!existsSync(directory)) return {};
    return Object.fromEntries(
      readdirSync(directory)
        .filter((name) => name.endsWith(".md"))
        .sort()
        .map((name) => [name, readFileSync(join(directory, name))]),
    );
  }

  async function expectRejectedWithoutWrites(
    name: string,
    patch: AgentConfigurationPatch,
    modelExists: (model: string) => boolean = () => true,
  ): Promise<void> {
    writeAgent("search", SEARCH_WITH_DEFAULTS);
    writeAgent("writing", WRITING_AGENT);
    const before = agentBytes();

    await expect(patchGlobalAgent(config, name, patch, modelExists)).rejects.toMatchObject({ status: 400 });

    expect(agentBytes()).toEqual(before);
  }

  it("sets model and thinking together without changing Agent files", async () => {
    writeAgent("search", SEARCH_WITH_DEFAULTS);
    writeAgent("writing", WRITING_AGENT);
    const searchBefore = readFileSync(join(agentDir, "agents", "search.md"));
    const writingBefore = readFileSync(join(agentDir, "agents", "writing.md"));

    const saved = await patchGlobalAgent(
      config,
      "search",
      { model: "openai/gpt-4o", thinking: "high" },
      (model) => model === "openai/gpt-4o",
    );

    expect(saved).toMatchObject({ name: "search", source: "global", model: "openai/gpt-4o", thinking: "high" });
    expect(readFileSync(join(agentDir, "agents", "search.md"))).toEqual(searchBefore);
    expect(readFileSync(join(agentDir, "agents", "writing.md"))).toEqual(writingBefore);
    expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))).toEqual({
      easyresearch: {
        agentDefaults: {
          search: { model: "openai/gpt-4o", thinking: "high" },
        },
      },
    });
  });

  it("stores custom Agent defaults in global settings without rewriting its Markdown", async () => {
    const reviewer = `---\nname: reviewer\ndescription: Reviewer\nmodel: legacy/model\nthinking: low\n---\nReview prompt.\n`;
    writeAgent("reviewer", reviewer);
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ theme: "dark", easyresearch: { enable_dot_agents_skill: true } }, null, 2),
    );

    const saved = await patchGlobalAgent(
      config,
      "reviewer",
      { model: "openai/gpt-4o", thinking: "high" },
      (model) => model === "openai/gpt-4o",
    );

    expect(saved).toMatchObject({ name: "reviewer", model: "openai/gpt-4o", thinking: "high" });
    expect(readFileSync(join(agentDir, "agents", "reviewer.md"), "utf8")).toBe(reviewer);
    expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))).toEqual({
      theme: "dark",
      easyresearch: {
        enable_dot_agents_skill: true,
        agentDefaults: {
          reviewer: { model: "openai/gpt-4o", thinking: "high" },
        },
      },
    });
  });

  it("clears settings values without removing residual Markdown fields", async () => {
    writeAgent("search", SEARCH_WITH_DEFAULTS);
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ easyresearch: { agentDefaults: { search: { model: "openai/gpt-4o", thinking: "high" } } } }),
    );

    await patchGlobalAgent(config, "search", { model: null, thinking: null }, () => true);

    const content = readFileSync(join(agentDir, "agents", "search.md"), "utf8");
    expect(content).toBe(SEARCH_WITH_DEFAULTS);
    expect(await readGlobalAgent(config, "search")).toMatchObject({ model: undefined, thinking: undefined });
    expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))).toEqual({});
  });

  it("configures a bundled Agent without materializing a global copy", async () => {
    writeAgent("reviewer", `---\nname: reviewer\ndescription: Reviewer\n---\n\nReview prompt.\n`);
    const reviewerBefore = readFileSync(join(agentDir, "agents", "reviewer.md"));
    expect(existsSync(join(agentDir, "agents", "search.md"))).toBe(false);

    const saved = await patchGlobalAgent(config, "search", { thinking: "medium" }, () => true);

    const target = join(agentDir, "agents", "search.md");
    expect(existsSync(target)).toBe(false);
    expect(saved).toMatchObject({ name: "search", source: "bundled", thinking: "medium" });
    expect(readFileSync(join(agentDir, "agents", "reviewer.md"))).toEqual(reviewerBefore);
  });

  it("rejects an unknown Agent without changing any Agent file", async () => {
    writeAgent("search", SEARCH_WITH_DEFAULTS);
    writeAgent("writing", WRITING_AGENT);
    const before = agentBytes();

    await expect(
      patchGlobalAgent(config, "no-such-agent", { thinking: "high" }, () => true),
    ).rejects.toMatchObject({ status: 404 });

    expect(agentBytes()).toEqual(before);
  });

  it("rejects unknown patch keys before changing either requested field", async () => {
    await expectRejectedWithoutWrites(
      "search",
      { model: "openai/gpt-4o", thinking: "high", unexpected: true } as AgentConfigurationPatch,
      () => true,
    );
  });

  it("rejects invalid thinking before changing a valid model", async () => {
    await expectRejectedWithoutWrites(
      "search",
      { model: "openai/gpt-4o", thinking: "ultra" } as unknown as AgentConfigurationPatch,
      () => true,
    );
  });

  it.each(["", "openai", "/gpt-4o", "openai/", " openai/gpt-4o", "openai/gpt-4o\nthinking: max"])(
    "rejects malformed model reference %j",
    async (model) => {
      await expectRejectedWithoutWrites("search", { model }, () => true);
    },
  );

  it("rejects a well-formed model absent from the supplied catalog before changing thinking", async () => {
    await expectRejectedWithoutWrites(
      "search",
      { model: "openai/gpt-4o", thinking: "high" },
      () => false,
    );
  });

  it("returns the authoritative specialist inheritance repair for a truly unknown PATCH model", async () => {
    writeAgent("search", SEARCH_WITH_DEFAULTS);
    let repairAwareConfig!: ConfigFileService;
    const onAuthoritativeWrite = vi.fn(async () => {
      await repairDanglingAgentDefaults(repairAwareConfig, [{
        agentName: "search",
        danglingModel: "removed/missing-model",
      }]);
    });
    repairAwareConfig = new ConfigFileService(agentDir, { onAuthoritativeWrite });
    const patchAgent = createAgentPatchService(
      repairAwareConfig,
      async () => [],
      { repairUnknownModels: true },
    );

    const saved = await patchAgent("search", {
      model: "removed/missing-model",
      thinking: "high",
    });

    expect(onAuthoritativeWrite).toHaveBeenCalledOnce();
    expect(saved).toMatchObject({
      name: "search",
      model: undefined,
      thinking: "high",
      modelRepair: {
        requested: "removed/missing-model",
        inherited: true,
      },
    });
    expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))).toEqual({
      easyresearch: { agentDefaults: { search: { thinking: "high" } } },
    });
  });

  it("keeps unrelated Markdown bytes outside an Agent-default patch", async () => {
    writeAgent(
      "search",
      "---\nname: search\ndescription: Search agent\ntools: read\n---\nSearch prompt.\n",
    );
    writeAgent("writing", WRITING_AGENT);
    const before = agentBytes();

    await expect(
      patchGlobalAgent(config, "search", { thinking: "high" }, () => true),
    ).resolves.toMatchObject({ thinking: "high" });

    expect(agentBytes()).toEqual(before);
  });

  it("leaves quoted CRLF legacy fields untouched", async () => {
    const content = [
      "---",
      "name: search",
      "description: Search agent",
      '"model": old/model',
      "'thinking': low",
      "---",
      "First body line.",
      "Second body line.",
      "",
    ].join("\r\n");
    writeAgent("search", content);

    const saved = await patchGlobalAgent(
      config,
      "search",
      { model: null, thinking: "high" },
      () => true,
    );

    expect(saved).toMatchObject({ model: undefined, thinking: "high" });
    expect(readFileSync(join(agentDir, "agents", "search.md"), "utf8")).toBe(content);
  });
});
