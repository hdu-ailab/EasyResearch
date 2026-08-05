import { describe, expect, it } from "vitest";
import { buildPiArgs, describeModel } from "./tool";

describe("buildPiArgs", () => {
  it("always uses json, prompt-only, sessionless execution mode", () => {
    const agent = maker("literature", "");
    const args = buildPiArgs(agent, undefined, "task");
    expect(args.slice(0, 3)).toEqual(["--mode", "json", "-p"]);
    expect(args).toContain("--no-session");
  });

  it("selects the agent model over the orchestrator fallback", () => {
    const agent = maker("literature", "oc/mimo-v2.5-free");
    const args = buildPiArgs(agent, "opencode/deepseek-v4-flash-free", "task");
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("oc/mimo-v2.5-free");
  });

  it("falls back to the orchestrator model when the agent has none (ADR-008)", () => {
    const agent = maker("literature", "");
    const args = buildPiArgs(agent, "opencode/deepseek-v4-flash-free", "task");
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("opencode/deepseek-v4-flash-free");
  });

  it("passes the agent tools as a comma list", () => {
    const agent = maker("literature", "", "read, bash, arxiv");
    const args = buildPiArgs(agent, undefined, "task");
    expect(args).toContain("--tools");
    expect(args[args.indexOf("--tools") + 1]).toBe("read,bash,arxiv");
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

function maker(name: string, model: string, tools = ""): {
  name: string;
  description: string;
  tools: string[] | undefined;
  model: string | undefined;
  systemPrompt: string;
  source: "global";
  filePath: string;
} {
  return {
    name,
    description: "test agent",
    tools: tools ? tools.split(", ").map((t) => t.trim()).filter(Boolean) : undefined,
    model: model || undefined,
    systemPrompt: "",
    source: "global",
    filePath: name,
  };
}