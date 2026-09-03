import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicConfigurationEvent } from "../../../web/contracts";
import * as api from "../api";
import { useConfigurationEvents } from "./useConfigurationEvents";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    connectConfigurationEvents: vi.fn(),
    replaceConfigurationProjectWatches: vi.fn(),
  };
});

interface ReplacementRequest {
  revision: number;
  cwds: string[];
}

interface ReplacementResult {
  applied: boolean;
  revision: number;
}

type ReplaceConfigurationProjectWatches = (leaseId: string, request: ReplacementRequest) => Promise<ReplacementResult>;

const configurationApi = api as typeof api & {
  replaceConfigurationProjectWatches: ReplaceConfigurationProjectWatches;
};

let handlers: { onEvent: (event: PublicConfigurationEvent) => void; onError: () => void };
let disconnect: () => void;

function updated(generation: number, projectWatchLeaseId?: string, bootId = "boot-a"): PublicConfigurationEvent {
  return {
    type: "config.updated",
    bootId,
    generation,
    agentsChanged: true,
    modelsChanged: false,
    skillsChanged: true,
    runtimeChanged: true,
    ...(projectWatchLeaseId === undefined ? {} : { projectWatchLeaseId }),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settle<T>(pending: ReturnType<typeof deferred<T>>, value: T): Promise<void> {
  await act(async () => {
    pending.resolve(value);
    await pending.promise;
    await Promise.resolve();
  });
}

beforeEach(() => {
  disconnect = vi.fn();
  vi.mocked(api.connectConfigurationEvents)
    .mockReset()
    .mockImplementation((next) => {
      handlers = next;
      return disconnect;
    });
  vi.mocked(configurationApi.replaceConfigurationProjectWatches)
    .mockReset()
    .mockImplementation((_leaseId, request) => Promise.resolve({ applied: true, revision: request.revision }));
});

describe("useConfigurationEvents", () => {
  it("owns one connection, keeps generations monotonic, and clears errors on recovery", () => {
    const view = renderHook(() => useConfigurationEvents());
    expect(api.connectConfigurationEvents).toHaveBeenCalledOnce();
    expect(view.result.current).toMatchObject({ bootId: null, generation: 0, runtimeReplaced: false });
    expect(view.result.current.error).toBeNull();

    act(() => handlers.onEvent(updated(2)));
    expect(view.result.current).toMatchObject({ generation: 2, error: null });

    act(() =>
      handlers.onEvent({
        type: "config.error",
        bootId: "boot-a",
        generation: 2,
        message: "Invalid Agent configuration",
      }),
    );
    expect(view.result.current).toMatchObject({ generation: 2, error: "Invalid Agent configuration" });

    act(() => handlers.onEvent(updated(1)));
    expect(view.result.current).toMatchObject({ generation: 2, error: "Invalid Agent configuration" });

    act(() => handlers.onEvent(updated(3)));
    expect(view.result.current).toMatchObject({ generation: 3, error: null });
    expect(api.connectConfigurationEvents).toHaveBeenCalledOnce();

    view.unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("retains the accepted generation across a transport error and recovers on the same native stream", () => {
    const { result } = renderHook(() => useConfigurationEvents());
    act(() => handlers.onEvent(updated(4)));
    act(() => handlers.onError());
    expect(result.current.generation).toBe(4);
    expect(result.current.error).toMatch(/Reconnecting/);
    expect(api.connectConfigurationEvents).toHaveBeenCalledOnce();

    act(() => handlers.onEvent(updated(5)));
    expect(result.current).toMatchObject({ generation: 5, error: null });
  });

  it("advances the frontend revision for availability without clearing a configuration error", () => {
    const { result } = renderHook(() => useConfigurationEvents());
    act(() => handlers.onEvent(updated(4)));
    act(() =>
      handlers.onEvent({
        type: "config.error",
        bootId: "boot-a",
        generation: 4,
        availabilityEpoch: 1,
        message: "Invalid Agent configuration",
      }),
    );
    const revision = result.current.revision;

    act(() =>
      handlers.onEvent({
        type: "config.updated",
        bootId: "boot-a",
        generation: 4,
        availabilityEpoch: 2,
        availabilityChanged: true,
        agentsChanged: false,
        modelsChanged: false,
        skillsChanged: false,
        runtimeChanged: false,
      }),
    );

    expect(result.current).toMatchObject({
      generation: 4,
      availabilityEpoch: 2,
      revision: revision + 1,
      error: "Invalid Agent configuration",
    });
  });

  it.each([
    [5, 4, "equal generation with stale availability"],
    [6, 4, "advanced generation with stale availability"],
    [4, 6, "stale generation with advanced availability"],
  ] as const)(
    "rejects a same-boot event when either counter regresses: %s/%s (%s)",
    (generation, availabilityEpoch, _description) => {
      const { result } = renderHook(() => useConfigurationEvents());
      act(() =>
        handlers.onEvent({
          type: "config.updated",
          bootId: "boot-a",
          generation: 5,
          availabilityEpoch: 5,
          availabilityChanged: true,
          agentsChanged: true,
          modelsChanged: true,
          skillsChanged: true,
          runtimeChanged: true,
        }),
      );
      const accepted = result.current;

      act(() =>
        handlers.onEvent({
          type: "config.error",
          bootId: "boot-a",
          generation,
          availabilityEpoch,
          message: "Stale state must not replace the accepted snapshot",
        }),
      );

      expect(result.current).toBe(accepted);
    },
  );

  it("acquires a lease from valid or error events and replays current intent on reconnect", () => {
    const { result } = renderHook(() => useConfigurationEvents());

    act(() => {
      result.current.setProjectInterests("work", ["/exact/Project", "/exact/Project"]);
      result.current.setProjectInterests("settings", ["/exact/project"]);
    });
    expect(configurationApi.replaceConfigurationProjectWatches).not.toHaveBeenCalled();

    act(() => handlers.onEvent(updated(5, "lease/first")));
    expect(configurationApi.replaceConfigurationProjectWatches).toHaveBeenNthCalledWith(1, "lease/first", {
      revision: 0,
      cwds: ["/exact/Project", "/exact/project"],
    });
    expect(result.current).toMatchObject({ generation: 5, error: null });

    act(() =>
      handlers.onEvent({
        type: "config.error",
        bootId: "boot-a",
        generation: 4,
        message: "Stale reconnect error",
        projectWatchLeaseId: "lease/second",
      }),
    );
    expect(configurationApi.replaceConfigurationProjectWatches).toHaveBeenNthCalledWith(2, "lease/second", {
      revision: 1,
      cwds: ["/exact/Project", "/exact/project"],
    });
    expect(result.current).toMatchObject({ generation: 5, error: null });
    expect(api.connectConfigurationEvents).toHaveBeenCalledOnce();
  });

  it.each([
    [1, "lower"],
    [100, "equal"],
    [101, "higher"],
  ] as const)("signals one runtime replacement for a different boot with %s counters (%s)", (generation, _label) => {
    const { result } = renderHook(() => useConfigurationEvents());
    act(() => handlers.onEvent(updated(100, "lease-a", "boot-a")));
    const revision = result.current.revision;
    const replacementCalls = vi.mocked(configurationApi.replaceConfigurationProjectWatches).mock.calls.length;

    act(() =>
      handlers.onEvent({
        type: "config.error",
        bootId: "boot-b",
        generation,
        availabilityEpoch: generation,
        message: "Successor state must not enter the old page",
        projectWatchLeaseId: "lease-b",
      }),
    );

    expect(result.current).toMatchObject({
      bootId: "boot-a",
      generation: 100,
      revision,
      error: null,
      runtimeReplaced: true,
    });
    expect(configurationApi.replaceConfigurationProjectWatches).toHaveBeenCalledTimes(replacementCalls);
    const replacedState = result.current;

    act(() => {
      handlers.onEvent(updated(generation + 1, "lease-b-next", "boot-b"));
      handlers.onEvent(updated(generation + 2, "lease-c", "boot-c"));
      handlers.onError();
    });

    expect(result.current).toBe(replacedState);
    expect(configurationApi.replaceConfigurationProjectWatches).toHaveBeenCalledTimes(replacementCalls);
  });

  it("establishes a fresh successor boot as the baseline without a replacement loop", () => {
    const { result } = renderHook(() => useConfigurationEvents());

    act(() => handlers.onEvent(updated(1, "lease-b", "boot-b")));

    expect(result.current).toMatchObject({
      bootId: "boot-b",
      generation: 1,
      revision: 1,
      runtimeReplaced: false,
    });
    expect(configurationApi.replaceConfigurationProjectWatches).toHaveBeenCalledWith("lease-b", {
      revision: 0,
      cwds: [],
    });
  });

  it("sends each exact-string owner-union change once and removes empty owners", () => {
    const { result } = renderHook(() => useConfigurationEvents());
    act(() => handlers.onEvent(updated(1, "lease-one")));

    act(() => result.current.setProjectInterests("work", ["/Project", "/Project", "/project/"]));
    act(() => result.current.setProjectInterests("work", ["/project/", "/Project", "/Project"]));
    act(() => result.current.setProjectInterests("settings", ["/Project", "/B"]));
    act(() => result.current.setProjectInterests("config", ["/B"]));
    act(() => result.current.setProjectInterests("settings", []));
    act(() => result.current.setProjectInterests("work", []));
    act(() => result.current.setProjectInterests("config", []));

    expect(vi.mocked(configurationApi.replaceConfigurationProjectWatches).mock.calls).toEqual([
      ["lease-one", { revision: 0, cwds: [] }],
      ["lease-one", { revision: 1, cwds: ["/Project", "/project/"] }],
      ["lease-one", { revision: 2, cwds: ["/Project", "/project/", "/B"] }],
      ["lease-one", { revision: 3, cwds: ["/B"] }],
      ["lease-one", { revision: 4, cwds: [] }],
    ]);
    for (const [, request] of vi.mocked(configurationApi.replaceConfigurationProjectWatches).mock.calls) {
      expect(Number.isSafeInteger(request.revision)).toBe(true);
    }
  });

  it("ignores a late old lease and decreasing out-of-order responses from the current lease", async () => {
    const leaseA = deferred<ReplacementResult>();
    const leaseBReplay = deferred<ReplacementResult>();
    const leaseBOlder = deferred<ReplacementResult>();
    const leaseBCurrent = deferred<ReplacementResult>();
    const pending = [leaseA, leaseBReplay, leaseBOlder, leaseBCurrent];
    vi.mocked(configurationApi.replaceConfigurationProjectWatches).mockImplementation((_leaseId, request) => {
      const next = pending.shift();
      return next?.promise ?? Promise.resolve({ applied: true, revision: request.revision });
    });
    const view = renderHook(() => useConfigurationEvents());

    act(() => view.result.current.setProjectInterests("work", ["/current"]));
    act(() => handlers.onEvent(updated(1, "lease-A")));
    act(() => handlers.onEvent(updated(2, "lease-B")));
    act(() => view.result.current.setProjectInterests("settings", ["/shared"]));
    act(() => view.result.current.setProjectInterests("config", ["/next"]));

    expect(vi.mocked(configurationApi.replaceConfigurationProjectWatches).mock.calls).toEqual([
      ["lease-A", { revision: 0, cwds: ["/current"] }],
      ["lease-B", { revision: 1, cwds: ["/current"] }],
      ["lease-B", { revision: 2, cwds: ["/current", "/shared"] }],
      ["lease-B", { revision: 3, cwds: ["/current", "/shared", "/next"] }],
    ]);
    expect(api.connectConfigurationEvents).toHaveBeenCalledOnce();

    await settle(leaseBCurrent, { applied: true, revision: 3 });
    await settle(leaseA, { applied: true, revision: 0 });
    await settle(leaseBOlder, { applied: false, revision: 2 });
    await settle(leaseBReplay, { applied: false, revision: 1 });
    expect(configurationApi.replaceConfigurationProjectWatches).toHaveBeenCalledTimes(4);

    act(() => view.result.current.setProjectInterests("work", ["/final"]));
    expect(configurationApi.replaceConfigurationProjectWatches).toHaveBeenNthCalledWith(5, "lease-B", {
      revision: 4,
      cwds: ["/final", "/shared", "/next"],
    });
    expect(api.connectConfigurationEvents).toHaveBeenCalledOnce();

    view.unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("retries one failed replacement with a higher revision and reports a second failure", async () => {
    const first = deferred<ReplacementResult>();
    const second = deferred<ReplacementResult>();
    vi.mocked(configurationApi.replaceConfigurationProjectWatches)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const view = renderHook(() => useConfigurationEvents());
    act(() => view.result.current.setProjectInterests("work", ["/current"]));
    act(() => handlers.onEvent(updated(1, "lease-one")));

    await act(async () => {
      first.reject(new Error("temporary acquisition failure"));
      await first.promise.catch(() => {});
      await Promise.resolve();
    });
    expect(configurationApi.replaceConfigurationProjectWatches).toHaveBeenNthCalledWith(2, "lease-one", {
      revision: 1,
      cwds: ["/current"],
    });
    expect(view.result.current.error).toBeNull();

    await act(async () => {
      second.reject(new Error("still unavailable"));
      await second.promise.catch(() => {});
      await Promise.resolve();
    });
    expect(configurationApi.replaceConfigurationProjectWatches).toHaveBeenCalledTimes(2);
    expect(view.result.current.error).toMatch(/monitoring/i);

    act(() => handlers.onEvent(updated(2)));
    expect(view.result.current.error).toBeNull();
  });

  it("does not retry a failed replacement after its lease or intent is stale", async () => {
    const staleLease = deferred<ReplacementResult>();
    const staleIntent = deferred<ReplacementResult>();
    vi.mocked(configurationApi.replaceConfigurationProjectWatches)
      .mockReturnValueOnce(staleLease.promise)
      .mockReturnValueOnce(staleIntent.promise)
      .mockResolvedValue({ applied: true, revision: 2 });
    const { result } = renderHook(() => useConfigurationEvents());
    act(() => result.current.setProjectInterests("work", ["/first"]));
    act(() => handlers.onEvent(updated(1, "lease-one")));
    act(() => handlers.onEvent(updated(2, "lease-two")));
    act(() => result.current.setProjectInterests("work", ["/second"]));

    await act(async () => {
      staleLease.reject(new Error("old lease failed"));
      staleIntent.reject(new Error("old intent failed"));
      await Promise.all([staleLease.promise.catch(() => {}), staleIntent.promise.catch(() => {})]);
      await Promise.resolve();
    });

    expect(vi.mocked(configurationApi.replaceConfigurationProjectWatches).mock.calls).toEqual([
      ["lease-one", { revision: 0, cwds: ["/first"] }],
      ["lease-two", { revision: 1, cwds: ["/first"] }],
      ["lease-two", { revision: 2, cwds: ["/second"] }],
    ]);
    expect(result.current.error).toBeNull();
  });

  it("closes on unmount and ignores late events, setters, and async completions", async () => {
    const pending = deferred<ReplacementResult>();
    vi.mocked(configurationApi.replaceConfigurationProjectWatches).mockReturnValue(pending.promise);
    const view = renderHook(() => useConfigurationEvents());
    const setProjectInterests = view.result.current.setProjectInterests;
    act(() => handlers.onEvent(updated(1, "lease-one")));
    expect(configurationApi.replaceConfigurationProjectWatches).toHaveBeenCalledOnce();

    view.unmount();
    setProjectInterests("work", ["/late-owner"]);
    handlers.onEvent(updated(2, "lease-two"));
    await settle(pending, { applied: false, revision: 3 });

    expect(disconnect).toHaveBeenCalledOnce();
    expect(configurationApi.replaceConfigurationProjectWatches).toHaveBeenCalledOnce();
  });
});
