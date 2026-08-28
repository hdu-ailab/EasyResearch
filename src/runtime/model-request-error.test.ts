import { describe, expect, it } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import {
  ModelRequestError,
  assertModelRequestReady,
} from "./model-request-error";

const model = { provider: "deepseek", id: "deepseek-v4-flash" } as Model<any>;

function runtime(options: { available?: boolean; configured?: boolean; provider?: boolean } = {}) {
  return {
    getAvailableSnapshot: () => options.available ? [model] : [],
    getProvider: () => options.provider === false ? undefined : { id: "deepseek" },
    getProviderAuthStatus: () => ({ configured: options.configured === true }),
  };
}

describe("assertModelRequestReady", () => {
  it("classifies a missing effective model", () => {
    expect(captureError(() => assertModelRequestReady(runtime(), undefined))).toMatchObject({
      code: "MODEL_REQUIRED",
    });
  });

  it("classifies a registered provider that still needs authentication", () => {
    expect(captureError(() => assertModelRequestReady(runtime(), model))).toMatchObject({
      code: "PROVIDER_AUTH_REQUIRED",
    });
  });

  it("classifies an authenticated but filtered model as unavailable", () => {
    expect(captureError(() => assertModelRequestReady(runtime({ configured: true }), model))).toMatchObject({
      code: "MODEL_UNAVAILABLE",
    });
  });

  it("accepts an available model", () => {
    expect(() => assertModelRequestReady(runtime({ available: true }), model)).not.toThrow();
  });
});

function captureError(operation: () => void): ModelRequestError {
  try {
    operation();
  } catch (error) {
    if (error instanceof ModelRequestError) return error;
    throw error;
  }
  throw new Error("Expected model request failure");
}
