import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  buildPiArgs,
  describeModel,
  filterAgentsByAllowlist,
  resolveInheritedSession,
  sessionNameFor,
  SUBAGENT_SESSION_PREFIX,
} from "./tool";
import { releaseSubagentLock, tryAcquireSubagentLock } from "./serial";

describe("buildPiArgs", () => {
  it("uses json + prompt-only mode, mounts the subagent extension, names the session line, and never uses --no-session", () => {
    const agent = maker("search");
    const args = buildPiArgs(agent, undefined, "task");
    expect(args.slice(0, 3)).toEqual(["--mode", "json", "-p"]);
    expect(args).toContain("--extension");
    expect(args).toContain("--name");
    expect(args[args.indexOf("--name") + 1]).toBe(`${SUBAGENT_SESSION_PREFIX}search`);
    expect(args).not.toContain("--no-session");
  });

  it("adds --session when inheriting a session line (ADR-022)", () => {
    const agent = maker("search");
    const args = buildPiArgs(agent, undefined, "task", "/tmp/lazyresearch-search.jsonl");
    expect(args).toContain("--session");
    expect(args[args.indexOf("--session") + 1]).toBe("/tmp/lazyresearch-search.jsonl");
  });

  it("does not add --session for a fresh session (ADR-022)", () => {
    const agent = maker("search");
    const args = buildPiArgs(agent, undefined, "task");
    expect(args).not.toContain("--session");
  });

  it("adds --model with the resolved model", () => {
    const agent = maker("search");
    const args = buildPiArgs(agent, "oc/mimo-v2.5-free", "task");
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("oc/mimo-v2.5-free");
  });

  it("omits --model when no model is resolved", () => {
    const agent = maker("search");
    const args = buildPiArgs(agent, undefined, "task");
    expect(args).not.toContain("--model");
  });

  it("passes the agent tools as a comma list", () => {
    const agent = maker("search", "read, bash, arxiv");
    const args = buildPiArgs(agent, undefined, "task");
    expect(args).toContain("--tools");
    expect(args[args.indexOf("--tools") + 1]).toBe("read,bash,arxiv");
  });
});

describe("sessionNameFor", () => {
  it("names session lines with the lazyresearch prefix (ADR-022)", () => {
    expect(sessionNameFor("search")).toBe(`${SUBAGENT_SESSION_PREFIX}search`);
  });
});

describe("filterAgentsByAllowlist (ADR-022)", () => {
  const agents = [maker("search"), maker("experiment"), maker("writing")];

  it("keeps all agents without an allowlist (orchestrator runtime)", () => {
    expect(filterAgentsByAllowlist(agents, undefined).map((a) => a.name)).toEqual(["search", "experiment", "writing"]);
  });

  it("filters to the declared allowlist", () => {
    expect(filterAgentsByAllowlist(agents, "search").map((a) => a.name)).toEqual(["search"]);
    expect(filterAgentsByAllowlist(agents, "search,figures").map((a) => a.name)).toEqual(["search"]);
  });

  it("allows no agents for an empty allowlist", () => {
    expect(filterAgentsByAllowlist(agents, "")).toEqual([]);
  });
});

describe("serial lock (ADR-022)", () => {
  it("rejects a second acquisition while one invocation is active", () => {
    releaseSubagentLock();
    expect(tryAcquireSubagentLock()).toBe(true);
    expect(tryAcquireSubagentLock()).toBe(false);
    releaseSubagentLock();
    expect(tryAcquireSubagentLock()).toBe(true);
    releaseSubagentLock();
  });
});

describe("resolveInheritedSession (ADR-022)", () => {
  let dir: string;
  const cwd = "/tmp/lazyresearch-pipeline";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lazy-sessions-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeSession(name: string | undefined, headerTimestamp: string): string {
    const filePath = join(dir, `${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`);
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: crypto.randomUUID(), timestamp: headerTimestamp, cwd }),
    ];
    if (name !== undefined) {
      lines.push(
        JSON.stringify({
          type: "session_info",
          id: "e5f6g7h8",
          parentId: null,
          timestamp: headerTimestamp,
          name,
        }),
      );
    }
    writeFileSync(filePath, lines.join("\n"), "utf8");
    return filePath;
  }

  it("returns undefined when the agent has no named session yet", async () => {
    makeSession("lazyresearch:writing", "2026-08-06T00:00:00.000Z");
    expect(await resolveInheritedSession(cwd, "search", dir)).toBeUndefined();
  });

  it("picks the most recent of the agent's named session lines", async () => {
    const older = makeSession("lazyresearch:search", "2026-08-06T01:00:00.000Z");
    const newer = makeSession("lazyresearch:search", "2026-08-06T02:00:00.000Z");
    makeSession("lazyresearch:writing", "2026-08-06T03:00:00.000Z");
    expect(await resolveInheritedSession(cwd, "search", dir)).toBe(newer);
    expect(newer).not.toBe(older);
  });
});

describe("describeModel", () => {
  it("returns provider/id for a known model", () => {
    expect(describeModel({ model: { provider: "openrouter", id: "deepseek" } } as never)).toBe(
      "openrouter/deepseek",
    );
  });

  it("returns undefined without a model", () => {
    expect(describeModel({} as never)).toBeUndefined();
  });
});

function maker(name: string, tools = ""): {
  name: string;
  description: string;
  tools: string[] | undefined;
  subagents: string[] | undefined;
  systemPrompt: string;
  source: "global";
  filePath: string;
} {
  return {
    name,
    description: "test agent",
    tools: tools ? tools.split(", ").map((t) => t.trim()).filter(Boolean) : undefined,
    subagents: undefined,
    systemPrompt: "",
    source: "global",
    filePath: name,
  };
}
