import { describe, expect, it } from "vitest";
import { parseAgentRegistry, mergeAgentRegistry, extractRegistryModels, type AgentRegistry } from "./registry";

describe("parseAgentRegistry", () => {
  it("recognizes the lazyresearch.agents key only", () => {
    const reg = parseAgentRegistry({
      lazyresearch: {
        agents: {
          search: { definition: "agents/search.md", tools: ["bash"], skills: ["paper-search"] },
        },
      },
    });
    expect(reg.search?.definition).toBe("agents/search.md");
    expect(parseAgentRegistry({})).toEqual({});
    expect(parseAgentRegistry({ lazyresearch: {} })).toEqual({});
  });

  it("drops malformed entries and non-string scalars", () => {
    const reg = parseAgentRegistry({
      lazyresearch: {
        agents: {
          ok: { definition: "agents/ok.md", model: "p/m", tools: "not-array", subagents: 3 },
          bad: null,
          arr: ["x"],
        },
      },
    });
    expect(reg.ok).toBeDefined();
    expect(reg.ok?.tools).toBeUndefined();
    expect(reg.ok?.subagents).toBeUndefined();
    expect(reg.bad).toBeUndefined();
    expect(reg.arr).toBeUndefined();
  });

  it("keeps only non-empty string models in the model map", () => {
    const reg = { a: { model: "p/m" }, b: { model: "" }, c: { model: 5 }, d: {} } as unknown as AgentRegistry;
    expect(extractRegistryModels(reg)).toEqual({ a: "p/m" });
    expect(extractRegistryModels({})).toBeUndefined();
  });
});

describe("mergeAgentRegistry", () => {
  it("lets project override global per agent field", () => {
    const project = { search: { model: "p2/m2", tools: ["curl"] } };
    const global = { search: { model: "p1/m1", tools: ["bash"], skills: ["paper-search"] } };
    const merged = mergeAgentRegistry(project, global);
    expect(merged.search?.model).toBe("p2/m2");
    expect(merged.search?.tools).toEqual(["curl"]);
    expect(merged.search?.skills).toEqual(["paper-search"]);
  });

  it("keeps global-only agents", () => {
    const merged = mergeAgentRegistry({}, { writing: { definition: "agents/writing.md" } });
    expect(merged.writing?.definition).toBe("agents/writing.md");
  });
});