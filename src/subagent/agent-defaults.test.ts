import { describe, expect, it } from "vitest";
import { parseAgentDefaults } from "./agent-defaults";

describe("parseAgentDefaults", () => {
  it("parses sparse defaults for built-in and custom Agent ids", () => {
    expect(parseAgentDefaults({
      easyresearch: {
        agentDefaults: {
          "paper-assistant": { model: "openai/gpt-4o", thinking: "max" },
          reviewer: { thinking: "high" },
          "审稿人": {},
        },
      },
    })).toEqual({
      "paper-assistant": { model: "openai/gpt-4o", thinking: "max" },
      reviewer: { thinking: "high" },
      "审稿人": {},
    });
  });

  it("does not revive legacy Agent registries", () => {
    expect(parseAgentDefaults({
      easyresearch: { agents: { search: { model: "legacy/model" } } },
      lazyresearch: { agents: { search: { model: "older/model" } } },
    })).toEqual({});
  });

  it.each([
    { agentDefaults: [], label: "non-object map" },
    { agentDefaults: { search: null }, label: "non-object entry" },
    { agentDefaults: { search: { model: "openai" } }, label: "malformed model" },
    { agentDefaults: { search: { thinking: "ultra" } }, label: "invalid thinking" },
    { agentDefaults: { search: { tools: ["read"] } }, label: "unknown entry field" },
  ])("rejects a $label", ({ agentDefaults }) => {
    expect(() => parseAgentDefaults({ easyresearch: { agentDefaults } })).toThrow(/Agent default/i);
  });
});
