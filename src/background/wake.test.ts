import { describe, expect, it } from "vitest";
import { withoutBackgroundWake } from "./wake";

describe("managed steering wake projection", () => {
  it("removes only the host control and preserves actual notices and user instructions", () => {
    const input = [
      { role: "user", content: "Continue with the correction" },
      { role: "custom", customType: "easyresearch:background-wake", content: "", display: false },
      { role: "custom", customType: "easyresearch:background-result", content: "result", display: false },
      { role: "custom", customType: "easyresearch:restart", content: "continue", display: false },
    ];
    expect(withoutBackgroundWake(input)).toEqual([input[0], input[2], input[3]]);
    expect(input).toHaveLength(4);
  });
});
