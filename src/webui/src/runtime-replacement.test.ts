import { describe, expect, it, vi } from "vitest";
import type { AppRoute } from "./router";
import * as replacementModule from "./runtime-replacement";
import { type RuntimeReplacementBrowser, reloadForRuntimeReplacement } from "./runtime-replacement";

type PollForRuntimeReplacement = (
  oldBootId: string,
  dependencies: {
    readStatus(signal: AbortSignal): Promise<{ bootId: string }>;
    waitForNextAttempt(signal: AbortSignal): Promise<void>;
    signal: AbortSignal;
    timedOut(): boolean;
  },
) => Promise<"replaced" | "timed-out" | "cancelled">;

function runtimePoller(): PollForRuntimeReplacement | undefined {
  return (
    replacementModule as typeof replacementModule & {
      pollForRuntimeReplacement?: PollForRuntimeReplacement;
    }
  ).pollForRuntimeReplacement;
}

describe("runtime replacement routing", () => {
  it.each([
    [{ page: "home", settingsOpen: true }, "#/?settings=1", "#/"],
    [
      { page: "work", session: { id: "s 1", cwd: "/a b?c=1&d" }, settingsOpen: true },
      "#/work/s%201?cwd=%2Fa%20b%3Fc%3D1%26d&settings=1",
      "#/work/s%201?cwd=%2Fa%20b%3Fc%3D1%26d",
    ],
    [
      {
        page: "config",
        returnTo: {
          page: "work",
          session: { id: "s 1", cwd: "/a b?c=1&d" },
          settingsOpen: true,
        },
      },
      "#/config?returnTo=ignored-by-helper",
      "#/work/s%201?cwd=%2Fa%20b%3Fc%3D1%26d",
    ],
    [{ page: "config", returnTo: null }, "#/config", "#/"],
  ] as const)("normalizes %s to its canonical host before reload", (route, currentHash, expectedHash) => {
    const replaceState = vi.fn();
    const reload = vi.fn();
    const historyState = { retained: true };

    reloadForRuntimeReplacement(
      route as AppRoute,
      {
        history: { state: historyState, replaceState },
        location: { hash: currentHash },
        reload,
      } as RuntimeReplacementBrowser,
    );

    expect(replaceState).toHaveBeenCalledOnce();
    expect(replaceState).toHaveBeenCalledWith(historyState, "", expectedHash);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("reloads without replacing an already canonical host hash", () => {
    const replaceState = vi.fn();
    const reload = vi.fn();

    reloadForRuntimeReplacement({ page: "work", session: { id: "s-1", cwd: "/paper" } }, {
      history: { state: null, replaceState },
      location: { hash: "#/work/s-1?cwd=%2Fpaper" },
      reload,
    } as RuntimeReplacementBrowser);

    expect(replaceState).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledOnce();
  });
});

describe("runtime replacement polling", () => {
  it("retries sequentially through same-id and connection failures until a nonempty boot id changes", async () => {
    const poll = runtimePoller();
    expect(poll).toBeTypeOf("function");
    if (!poll) return;
    const statuses = [{ bootId: "boot-old" }, new Error("connection refused"), { bootId: "" }, { bootId: "boot-new" }];
    let activeReads = 0;
    let maxActiveReads = 0;
    const readStatus = vi.fn(async () => {
      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      const next = statuses.shift();
      activeReads -= 1;
      if (next instanceof Error) throw next;
      return next!;
    });
    const waitForNextAttempt = vi.fn(async () => {});

    await expect(
      poll("boot-old", {
        readStatus,
        waitForNextAttempt,
        signal: new AbortController().signal,
        timedOut: () => false,
      }),
    ).resolves.toBe("replaced");

    expect(readStatus).toHaveBeenCalledTimes(4);
    expect(waitForNextAttempt).toHaveBeenCalledTimes(3);
    expect(maxActiveReads).toBe(1);
  });

  it("returns timed-out when the bounded deadline aborts an in-flight status read", async () => {
    const poll = runtimePoller();
    expect(poll).toBeTypeOf("function");
    if (!poll) return;
    const controller = new AbortController();
    let deadlineReached = false;
    const readStatus = (signal: AbortSignal) =>
      new Promise<{ bootId: string }>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    const result = poll("boot-old", {
      readStatus,
      waitForNextAttempt: async () => {},
      signal: controller.signal,
      timedOut: () => deadlineReached,
    });

    deadlineReached = true;
    controller.abort();

    await expect(result).resolves.toBe("timed-out");
  });

  it("returns cancelled when unmount aborts polling before the deadline", async () => {
    const poll = runtimePoller();
    expect(poll).toBeTypeOf("function");
    if (!poll) return;
    const controller = new AbortController();
    const result = poll("boot-old", {
      readStatus: (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        }),
      waitForNextAttempt: async () => {},
      signal: controller.signal,
      timedOut: () => false,
    });

    controller.abort();

    await expect(result).resolves.toBe("cancelled");
  });
});
