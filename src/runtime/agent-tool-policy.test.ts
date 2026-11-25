import { describe, expect, it } from "vitest";
import { selectAgentTools, type RegisteredAgentTool } from "../subagent/agents";

describe("native Tool exposure in Agent selection", () => {
  const exposures = ["direct", "model-only", "codemode", "deferred", "hidden"] as const;
  const registered: RegisteredAgentTool[] = [
    { name: "read", sourceInfo: { path: "builtin:read" } },
    ...exposures.map(exposure => ({ name: `${exposure}_tool`, exposure, sourceInfo: { path: "/authored/extension.ts", scope: "user" } })),
  ];
  const visible = exposures.filter(exposure => exposure !== "hidden").map(exposure => `${exposure}_tool`);

  it("excludes only hidden registrations from the default Research Assistant selection", () => {
    expect(selectAgentTools({ name: "research-assistant" }, registered)).toEqual(["read", ...visible]);
  });

  it.each(["research-assistant", "custom", "experiment"])("keeps %s's explicit allowlist subordinate to hidden withdrawal", name => {
    expect(selectAgentTools({ name, tools: ["read", ...exposures.map(exposure => `${exposure}_tool`), "unknown"] }, registered))
      .toEqual(["read", ...visible]);
  });

  it("retains empty specialist isolation regardless of user-tool exposure", () => {
    expect(selectAgentTools({ name: "custom", tools: [] }, registered)).toEqual(["read"]);
  });
});
