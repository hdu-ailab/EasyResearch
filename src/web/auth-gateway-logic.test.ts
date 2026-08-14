import { describe, it, expect, vi } from "vitest";
import {
  assembleProviderInfo,
  singleFlightGuard,
  resolveTimeoutMs,
  summarizeCredential,
} from "./auth-gateway-logic";

describe("assembleProviderInfo", () => {
  it("marks connectable when api-key login exists", () => {
    const provider = {
      id: "anthropic",
      name: "Anthropic",
      auth: { apiKey: { name: "Anthropic API key", login: vi.fn() } },
    };
    const info = assembleProviderInfo(
      provider as never,
      { configured: true, source: "stored" },
      { source: "ANTHROPIC_API_KEY", type: "api_key" } as never,
    );
    expect(info.id).toBe("anthropic");
    expect(info.authMethods).toEqual(["api_key"]);
    expect(info.connectable).toBe(true);
    expect(info.authStatus).toEqual({ configured: true, source: "stored" });
  });

  it("marks connectable false and surfaces a hint for ambient-only providers", () => {
    const provider = {
      id: "google-vertex",
      name: "Google Vertex AI",
      auth: { apiKey: { name: "ADC", resolve: vi.fn() } },
    };
    const info = assembleProviderInfo(provider as never, { configured: false }, undefined);
    expect(info.authMethods).toEqual(["api_key"]);
    expect(info.connectable).toBe(false);
    expect(info.hint).toBeTruthy();
  });

  it("surfaces both auth methods when both are present", () => {
    const provider = {
      id: "xai",
      name: "xAI",
      auth: {
        apiKey: { name: "xAI API key", login: vi.fn() },
        oauth: { name: "xAI subscription", login: vi.fn() },
      },
    };
    const info = assembleProviderInfo(provider as never, { configured: false }, undefined);
    expect(info.authMethods.sort()).toEqual(["api_key", "oauth"]);
    expect(info.connectable).toBe(true);
  });

  it("omits source when the authCheck is undefined", () => {
    const provider = {
      id: "openai",
      name: "OpenAI",
      auth: { apiKey: { name: "OpenAI API key", login: vi.fn() } },
    };
    const info = assembleProviderInfo(provider as never, { configured: false }, undefined);
    expect(info.source).toBeUndefined();
  });

  it("marks modelsJson for providers declared in models.json", () => {
    const provider = {
      id: "my-local-llm",
      name: "My Local LLM",
      auth: {},
    };
    const ids = new Set(["my-local-llm"]);
    const info = assembleProviderInfo(provider as never, { configured: false }, undefined, ids);
    expect(info.modelsJson).toBe(true);
  });

  it("leaves modelsJson false for built-in providers", () => {
    const provider = {
      id: "anthropic",
      name: "Anthropic",
      auth: { apiKey: { name: "Anthropic API key", login: vi.fn() } },
    };
    const info = assembleProviderInfo(provider as never, { configured: true, source: "stored" }, undefined);
    expect(info.modelsJson).toBe(false);
  });
});

describe("singleFlightGuard", () => {
  it("accepts the first acquire and rejects a second while busy", () => {
    const guard = singleFlightGuard();
    expect(guard.tryAcquire("flow-1")).toBe(true);
    expect(guard.tryAcquire("flow-2")).toBe(false);
    guard.release("flow-1");
    expect(guard.tryAcquire("flow-3")).toBe(true);
  });

  it("reports the active flow", () => {
    const guard = singleFlightGuard();
    expect(guard.active()).toBeNull();
    guard.tryAcquire("f1");
    expect(guard.active()).toBe("f1");
    guard.release("f9"); // release of unknown id is a no-op
    expect(guard.active()).toBe("f1");
    guard.release("f1");
    expect(guard.active()).toBeNull();
  });
});

describe("resolveTimeoutMs", () => {
  it("returns 10 minutes default and respects overrides", () => {
    expect(resolveTimeoutMs(undefined)).toBe(600_000);
    expect(resolveTimeoutMs(0)).toBe(0);
    expect(resolveTimeoutMs(-1)).toBe(-1);
    expect(resolveTimeoutMs(30_000)).toBe(30_000);
  });
});

describe("summarizeCredential", () => {
  it("summarizes an api_key credential", () => {
    expect(summarizeCredential({ type: "api_key", key: "sk-abc" } as never)).toEqual({ type: "api_key" });
  });
  it("summarizes an oauth credential exposing the expiry only", () => {
    const summary = summarizeCredential({
      type: "oauth",
      refresh: "r",
      access: "a",
      expires: 123,
    } as never);
    expect(summary).toEqual({ type: "oauth", expires: 123 });
  });
});