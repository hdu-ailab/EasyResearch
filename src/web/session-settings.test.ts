import { describe, expect, it, vi } from "vitest";
import { ConfigServiceError } from "./config-files";
import { readWebSessionIdleTimeout, resolveWebSessionIdleTimeout } from "./session-settings";

const DEFAULT_TIMEOUT = 3_600_000;

describe("resolveWebSessionIdleTimeout", () => {
  it("uses one hour when the setting is missing", () => {
    expect(resolveWebSessionIdleTimeout({})).toBe(DEFAULT_TIMEOUT);
  });

  it("accepts positive safe integer milliseconds", () => {
    expect(resolveWebSessionIdleTimeout({ easyresearch: { web: { sessionIdleTimeoutMs: 12_345 } } })).toBe(12_345);
  });

  it("treats zero as immediate and minus one as disabled", () => {
    expect(resolveWebSessionIdleTimeout({ easyresearch: { web: { sessionIdleTimeoutMs: 0 } } })).toBe(0);
    expect(resolveWebSessionIdleTimeout({ easyresearch: { web: { sessionIdleTimeoutMs: -1 } } })).toBe(-1);
  });

  it("falls back for invalid values", () => {
    expect(resolveWebSessionIdleTimeout({ easyresearch: { web: { sessionIdleTimeoutMs: -2 } } })).toBe(DEFAULT_TIMEOUT);
    expect(resolveWebSessionIdleTimeout({ easyresearch: { web: { sessionIdleTimeoutMs: 1.5 } } })).toBe(DEFAULT_TIMEOUT);
    expect(resolveWebSessionIdleTimeout({ easyresearch: { web: { sessionIdleTimeoutMs: "1h" } } })).toBe(DEFAULT_TIMEOUT);
    expect(
      resolveWebSessionIdleTimeout({
        easyresearch: { web: { sessionIdleTimeoutMs: Number.MAX_SAFE_INTEGER + 1 } },
      }),
    ).toBe(DEFAULT_TIMEOUT);
    expect(resolveWebSessionIdleTimeout({ easyresearch: { web: { sessionIdleTimeoutMs: Number.NaN } } })).toBe(
      DEFAULT_TIMEOUT,
    );
  });
});

describe("readWebSessionIdleTimeout", () => {
  it("reads only the global settings file", async () => {
    const read = vi.fn().mockResolvedValue(
      JSON.stringify({ easyresearch: { web: { sessionIdleTimeoutMs: 9876 } } }),
    );
    await expect(readWebSessionIdleTimeout({ read } as never)).resolves.toBe(9876);
    expect(read).toHaveBeenCalledWith({ scope: "global", path: "settings.json" });
  });

  it("reads a timeout from BOM-prefixed settings accepted by Pi", async () => {
    const read = vi.fn().mockResolvedValue(
      `\uFEFF${JSON.stringify({ easyresearch: { web: { sessionIdleTimeoutMs: 5432 } } })}`,
    );

    await expect(readWebSessionIdleTimeout({ read } as never)).resolves.toBe(5432);
  });

  it("uses the default when the global settings file is missing", async () => {
    const read = vi.fn().mockRejectedValue(new ConfigServiceError(404, "does not exist"));
    await expect(readWebSessionIdleTimeout({ read } as never)).resolves.toBe(DEFAULT_TIMEOUT);
  });

  it("uses the default when settings JSON is malformed", async () => {
    const read = vi.fn().mockResolvedValue("{");
    await expect(readWebSessionIdleTimeout({ read } as never)).resolves.toBe(DEFAULT_TIMEOUT);
  });

  it("rethrows unrelated config errors", async () => {
    const failure = new Error("permission denied");
    const read = vi.fn().mockRejectedValue(failure);
    await expect(readWebSessionIdleTimeout({ read } as never)).rejects.toBe(failure);
  });
});
