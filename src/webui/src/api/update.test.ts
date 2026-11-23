import { afterEach, describe, expect, it, vi } from "vitest";
import { LATEST_RELEASE_PAGE, type UpdateSnapshot } from "../../../runtime/update-contract";
import { getUpdateSnapshot, parseUpdateResult, parseUpdateSnapshot, requestUpdateAction } from "./update";

const snapshot: UpdateSnapshot = {
  revision: 4,
  operationId: "operation-a",
  owner: "cli",
  phase: "available",
  currentVersion: "1.0.0",
  latestVersion: "1.0.1",
  releaseUrl: LATEST_RELEASE_PAGE,
  canDownload: false,
  canInstall: true,
  canActivate: false,
  canCancel: false,
};

afterEach(() => {
  delete window.easyresearchDesktop;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("update API boundary", () => {
  it("rejects malformed capabilities and progress before they can authorize controls", () => {
    expect(parseUpdateSnapshot(snapshot)).toEqual(snapshot);
    for (const invalid of [
      { canInstall: "true" },
      { revision: -1 },
      { bytesReceived: NaN },
      { bytesReceived: 10, bytesTotal: 5 },
      { phase: "successful" },
      { releaseUrl: "https://example.com/installer" },
      { operationId: 3 },
      { operationId: null },
      { canReveal: "true" },
    ])
      expect(() => parseUpdateSnapshot({ ...snapshot, ...invalid })).toThrow();
  });

  it("admits only well-formed busy responses for force confirmation", () => {
    expect(parseUpdateResult({ code: "RUNTIME_BUSY", activeSessions: 2, authFlowActive: false })).toEqual({
      code: "RUNTIME_BUSY",
      activeSessions: 2,
      authFlowActive: false,
    });
    expect(() => parseUpdateResult({ code: "RUNTIME_BUSY", activeSessions: -1, authFlowActive: false })).toThrow();
    expect(() => parseUpdateResult({ code: "RUNTIME_BUSY", activeSessions: 0, authFlowActive: "false" })).toThrow();
  });

  it("posts only the selected host action and operation id to the same-origin API", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(snapshot));
    vi.stubGlobal("fetch", fetcher);
    await expect(requestUpdateAction({ action: "install", operationId: "operation-a" })).resolves.toEqual(snapshot);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/update/action",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ action: "install", operationId: "operation-a" }),
      }),
    );
  });

  it("preserves a typed HTTP409 busy result for explicit force confirmation", async () => {
    const busy = { code: "RUNTIME_BUSY", activeSessions: 1, authFlowActive: true };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(busy, { status: 409 })));
    await expect(requestUpdateAction({ action: "activate", operationId: "operation-a" })).resolves.toEqual(busy);
  });

  it("bounds a missing host acknowledgement without issuing a cancellation", async () => {
    vi.useFakeTimers();
    const actions: unknown[] = [];
    window.easyresearchDesktop = {
      platform: "win32",
      version: "1.0.0",
      persistWebUiPreferences() {},
      updateAction: (action) => {
        actions.push(action);
        return new Promise(() => {});
      },
    };
    const result = requestUpdateAction({ action: "install", operationId: "operation-a" }).catch(
      (error: Error) => error.message,
    );
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(await result).toMatch(/timed out/);
    expect(actions).toEqual([{ action: "install", operationId: "operation-a" }]);
  });

  it("allows the host's long download/preparation response while progress and cancellation remain separate", async () => {
    vi.useFakeTimers();
    let finish!: (value: UpdateSnapshot) => void;
    window.easyresearchDesktop = {
      platform: "win32",
      version: "1.0.0",
      persistWebUiPreferences() {},
      updateAction: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    };
    let settled = false;
    const request = requestUpdateAction({ action: "download", operationId: "operation-a" }).finally(() => {
      settled = true;
    });
    // Metadata controls are short, but a verified installer download is not an acknowledgement-only call.
    void request.catch(() => {});
    await vi.advanceTimersByTimeAsync(20_000);
    expect(settled).toBe(false);
    finish({ ...snapshot, owner: "desktop", phase: "downloaded" });
    await expect(request).resolves.toMatchObject({ phase: "downloaded" });
  });

  it("uses the desktop bridge exclusively and never falls through to npm", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const desktop = { ...snapshot, owner: "desktop" as const };
    window.easyresearchDesktop = {
      platform: "win32",
      version: "1.0.0",
      persistWebUiPreferences() {},
      updateSnapshot: async () => desktop,
      updateAction: async () => desktop,
      onUpdate: () => () => {},
    };
    await expect(getUpdateSnapshot()).resolves.toEqual(desktop);
    await expect(requestUpdateAction({ action: "check" })).resolves.toEqual(desktop);
    expect(fetcher).not.toHaveBeenCalled();
    window.easyresearchDesktop = { platform: "win32", version: "1.0.0", persistWebUiPreferences() {} };
    await expect(getUpdateSnapshot()).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
