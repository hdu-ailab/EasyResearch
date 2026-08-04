import { describe, expect, it } from "vitest";
import { buildModelError, resolveModel, splitModelSpec } from "./session";

const stubRuntime = {
  getModel: (provider: string, id: string) =>
    provider === "test" && id === "mimo" ? ({ id: "mimo", provider: "test" } as any) : undefined,
};

describe("splitModelSpec", () => {
  it("splits provider/model", () => {
    expect(splitModelSpec("9router-local/oc/mimo-v2.5-free")).toEqual([
      "9router-local",
      "oc/mimo-v2.5-free",
    ]);
  });

  it("handles spec without provider", () => {
    expect(splitModelSpec("mimo")).toEqual(["", "mimo"]);
  });
});

describe("resolveModel", () => {
  it("returns the model when provider and id match", () => {
    expect(resolveModel(stubRuntime, "test/mimo")?.id).toBe("mimo");
  });

  it("returns undefined for unknown model", () => {
    expect(resolveModel(stubRuntime, "test/unknown")).toBeUndefined();
  });

  it("returns undefined for unknown provider", () => {
    expect(resolveModel(stubRuntime, "nope/mimo")).toBeUndefined();
  });
});

describe("buildModelError", () => {
  it("mentions the config file when no spec given", () => {
    const msg = buildModelError(undefined);
    expect(msg).toContain("config.json");
    expect(msg).toContain("--model");
  });

  it("mentions the missing spec when given", () => {
    const msg = buildModelError("test/unknown");
    expect(msg).toContain("test/unknown");
    expect(msg).toContain("models.json");
  });
});
