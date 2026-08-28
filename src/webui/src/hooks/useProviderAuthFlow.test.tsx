import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthFlowEventDto, AuthProviderInfoDto } from "../../../web/contracts";
import * as api from "../api";
import { useProviderAuthFlow } from "./useProviderAuthFlow";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    listAuthProviders: vi.fn(async () => [
      {
        id: "anthropic",
        name: "Anthropic",
        authMethods: ["api_key"],
        connectable: true,
        authStatus: { configured: false },
      },
      {
        id: "xai",
        name: "xAI",
        authMethods: ["api_key", "oauth"],
        connectable: true,
        authStatus: { configured: true },
      },
      {
        id: "google-vertex",
        name: "Google Vertex AI",
        authMethods: ["api_key"],
        connectable: false,
        authStatus: { configured: false },
        hint: "ambient",
      },
    ]),
    startAuthFlow: vi.fn(async () => ({ flowId: "f1" })),
    respondAuthFlow: vi.fn(async () => {}),
    cancelAuthFlow: vi.fn(async () => {}),
    deleteProvider: vi.fn(async () => ({
      providerId: "custom",
      credentialsRemoved: true,
      cacheRemoved: true,
      warnings: [],
    })),
    logoutProvider: vi.fn(async () => {}),
    authFlowEventSource: vi.fn((_flowId: string, handlers: api.AuthFlowHandlers) => {
      handlersList.push(handlers);
      return () => {};
    }),
  };
});

const handlersList: api.AuthFlowHandlers[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function provider(id: string, configured: boolean): AuthProviderInfoDto {
  return {
    id,
    name: id,
    authMethods: ["api_key"],
    connectable: true,
    authStatus: { configured },
    modelsJson: false,
  };
}

function emit(event: AuthFlowEventDto, index = handlersList.length - 1) {
  act(() => handlersList[index]?.onEvent(event));
}

describe("useProviderAuthFlow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlersList.length = 0;
    vi.mocked(api.listAuthProviders)
      .mockReset()
      .mockResolvedValue([
        provider("anthropic", false),
        {
          ...provider("xai", true),
          name: "xAI",
          authMethods: ["api_key", "oauth"],
        },
        {
          ...provider("google-vertex", false),
          name: "Google Vertex AI",
          connectable: false,
          hint: "ambient",
        },
      ]);
  });

  it("loads providers and computes the connected count", async () => {
    const { result } = renderHook(() => useProviderAuthFlow());
    await waitFor(() => expect(result.current.providers).toHaveLength(3));
    expect(result.current.connectedCount).toBe(1);
    expect(result.current.providersLoaded).toBe(true);
    expect(result.current.view).toBe("idle");
  });

  it("keeps only the latest generation refresh and ignores an older response", async () => {
    const older = deferred<AuthProviderInfoDto[]>();
    const newer = deferred<AuthProviderInfoDto[]>();
    vi.mocked(api.listAuthProviders).mockReset().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const view = renderHook(({ generation }: { generation: number }) => useProviderAuthFlow(generation), {
      initialProps: { generation: 1 },
    });
    await waitFor(() => expect(api.listAuthProviders).toHaveBeenCalledOnce());

    view.rerender({ generation: 2 });
    await waitFor(() => expect(api.listAuthProviders).toHaveBeenCalledTimes(2));
    await act(async () => newer.resolve([provider("new-a", true), provider("new-b", true)]));
    await waitFor(() => expect(view.result.current.connectedCount).toBe(2));
    await act(async () => older.resolve([provider("old", true)]));

    expect(view.result.current.providers.map(({ id }) => id)).toEqual(["new-a", "new-b"]);
    expect(view.result.current.connectedCount).toBe(2);
  });

  it("preserves the last provider state when a generation refresh fails", async () => {
    const view = renderHook(({ generation }: { generation: number }) => useProviderAuthFlow(generation), {
      initialProps: { generation: 1 },
    });
    await waitFor(() => expect(view.result.current.connectedCount).toBe(1));
    vi.mocked(api.listAuthProviders).mockRejectedValueOnce(new Error("provider list unavailable"));

    view.rerender({ generation: 2 });
    await waitFor(() => expect(api.listAuthProviders).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(view.result.current.providersError).toBe("provider list unavailable"));

    expect(view.result.current.connectedCount).toBe(1);
    expect(view.result.current.providersLoaded).toBe(true);
  });

  it("starts a flow and surfaces a prompt event", async () => {
    const { result } = renderHook(() => useProviderAuthFlow());
    await waitFor(() => expect(result.current.providers).toHaveLength(3));
    await act(async () => {
      await result.current.start("anthropic", "api_key");
    });
    expect(result.current.view).toBe("flow");
    expect(api.startAuthFlow).toHaveBeenCalledWith({ providerId: "anthropic", type: "api_key" });
    emit({ type: "prompt", kind: "secret", message: "API key" });
    await waitFor(() => expect(result.current.pendingPrompt?.kind).toBe("secret"));
  });

  it("accumulates notify events in order", async () => {
    const { result } = renderHook(() => useProviderAuthFlow());
    await waitFor(() => expect(result.current.providers).toHaveLength(3));
    await act(async () => {
      await result.current.start("xai", "oauth");
    });
    emit({ type: "notify", event: { kind: "auth_url", url: "https://x/authorize" } });
    emit({ type: "notify", event: { kind: "device_code", userCode: "ABCD", verificationUri: "https://x/device" } });
    await waitFor(() => expect(result.current.notifies).toHaveLength(2));
    expect(result.current.notifies[0]?.kind).toBe("auth_url");
    expect(result.current.notifies[1]?.kind).toBe("device_code");
  });

  it("advances to done with a warning when present", async () => {
    const { result } = renderHook(() => useProviderAuthFlow());
    await waitFor(() => expect(result.current.providers).toHaveLength(3));
    await act(async () => {
      await result.current.start("anthropic", "api_key");
    });
    emit({ type: "done", credential: { type: "api_key" }, warning: "credential saved; refresh pending" });
    await waitFor(() => expect(result.current.view).toBe("done"));
    expect(result.current.warning).toBe("credential saved; refresh pending");
  });

  it("advances to error with a message and reason", async () => {
    const { result } = renderHook(() => useProviderAuthFlow());
    await waitFor(() => expect(result.current.providers).toHaveLength(3));
    await act(async () => {
      await result.current.start("anthropic", "api_key");
    });
    emit({ type: "error", message: "provider rejected", reason: "reject" });
    await waitFor(() => expect(result.current.view).toBe("error"));
    expect(result.current.errorMessage).toBe("provider rejected");
    expect(result.current.errorReason).toBe("reject");
  });

  it("returns to idle without an error card when a flow is aborted", async () => {
    const { result } = renderHook(() => useProviderAuthFlow());
    await waitFor(() => expect(result.current.providers).toHaveLength(3));
    await act(async () => {
      await result.current.start("anthropic", "api_key");
    });
    emit({ type: "error", message: "The operation was aborted.", reason: "aborted" });
    await waitFor(() => expect(result.current.view).toBe("idle"));
    expect(result.current.errorMessage).toBeUndefined();
    expect(result.current.errorReason).toBeUndefined();
    expect(result.current.activeProviderId).toBeUndefined();
  });

  it("respond posts the value and keeps the prompt until the next event", async () => {
    const { result } = renderHook(() => useProviderAuthFlow());
    await waitFor(() => expect(result.current.providers).toHaveLength(3));
    await act(async () => {
      await result.current.start("anthropic", "api_key");
    });
    emit({ type: "prompt", kind: "secret", message: "API key" });
    await waitFor(() => expect(result.current.pendingPrompt).toBeTruthy());
    await act(async () => {
      await result.current.respond("sk-abc");
    });
    expect(api.respondAuthFlow).toHaveBeenCalledWith("f1", "sk-abc");
    // The prompt is not wiped optimistically: a newer prompt (or done/error)
    // arriving over SSE replaces it, so a respond/SSE race cannot blank a
    // prompt that was already superseded.
    expect(result.current.pendingPrompt?.kind).toBe("secret");
    emit({ type: "done", credential: { type: "api_key" } });
    await waitFor(() => expect(result.current.view).toBe("done"));
    expect(result.current.pendingPrompt).toBeNull();
  });

  it("cancel posts the cancel and returns to idle via backToList", async () => {
    const { result } = renderHook(() => useProviderAuthFlow());
    await waitFor(() => expect(result.current.providers).toHaveLength(3));
    await act(async () => {
      await result.current.start("anthropic", "api_key");
    });
    await act(async () => {
      await result.current.cancel();
    });
    expect(api.cancelAuthFlow).toHaveBeenCalledWith("f1");
    act(() => {
      result.current.backToList();
    });
    expect(result.current.view).toBe("idle");
    expect(result.current.activeProviderId).toBeUndefined();
  });

  it("logout calls the api and refreshes", async () => {
    const { result } = renderHook(() => useProviderAuthFlow());
    await waitFor(() => expect(result.current.providers).toHaveLength(3));
    await act(async () => {
      await result.current.logout("xai");
    });
    expect(api.logoutProvider).toHaveBeenCalledWith("xai");
    expect(api.listAuthProviders).toHaveBeenCalledTimes(2); // initial + refresh
  });

  it("deletes a custom provider and refreshes", async () => {
    const { result } = renderHook(() => useProviderAuthFlow());
    await waitFor(() => expect(result.current.providers).toHaveLength(3));
    await act(async () => {
      await result.current.deleteProvider("custom");
    });
    expect(api.deleteProvider).toHaveBeenCalledWith("custom");
    expect(api.listAuthProviders).toHaveBeenCalledTimes(2);
  });

  it("ignores stale events from an earlier generation after backToList + restart", async () => {
    const { result } = renderHook(() => useProviderAuthFlow());
    await waitFor(() => expect(result.current.providers).toHaveLength(3));
    await act(async () => {
      await result.current.start("anthropic", "api_key");
    });
    const firstHandlers = handlersList[0];
    act(() => {
      result.current.backToList();
    });
    await act(async () => {
      await result.current.start("xai", "oauth");
    });
    emit({ type: "prompt", kind: "text", message: "stale" }, 0);
    expect(result.current.pendingPrompt).toBeNull();
    expect(firstHandlers).toBeDefined();
  });

  it("pins configured and models.json-declared providers above the rest", async () => {
    vi.mocked(api.listAuthProviders).mockResolvedValueOnce([
      {
        id: "a",
        name: "A",
        authMethods: ["api_key"],
        connectable: true,
        authStatus: { configured: false },
        modelsJson: false,
      },
      {
        id: "b",
        name: "B",
        authMethods: ["api_key"],
        connectable: true,
        authStatus: { configured: true },
        modelsJson: false,
      },
      {
        id: "c",
        name: "C",
        authMethods: ["api_key"],
        connectable: false,
        authStatus: { configured: false },
        modelsJson: true,
      },
      {
        id: "d",
        name: "D",
        authMethods: ["api_key"],
        connectable: true,
        authStatus: { configured: false },
        modelsJson: false,
      },
    ] as never);
    const { result } = renderHook(() => useProviderAuthFlow());
    await waitFor(() => expect(result.current.providers).toHaveLength(4));
    expect(result.current.providers.map((p) => p.id)).toEqual(["b", "c", "a", "d"]);
  });

  it("closes the stream on a terminal done event so a later onerror is ignored", async () => {
    const unsubs: Array<() => void> = [];
    vi.mocked(api.authFlowEventSource).mockImplementation((_flowId, h) => {
      handlersList.push(h);
      const unsub = vi.fn();
      unsubs.push(unsub);
      return unsub;
    });
    const { result } = renderHook(() => useProviderAuthFlow());
    await waitFor(() => expect(result.current.providers).toHaveLength(3));
    await act(async () => {
      await result.current.start("anthropic", "api_key");
    });
    emit({ type: "done", credential: { type: "api_key" } });
    await waitFor(() => expect(result.current.view).toBe("done"));
    expect(unsubs[unsubs.length - 1]).toHaveBeenCalled();
    act(() => handlersList[handlersList.length - 1]?.onError());
    expect(result.current.view).toBe("done");
    expect(result.current.errorMessage).toBeUndefined();
  });

  it("surfaces a startAuthFlow failure in the error view instead of sticking in flow", async () => {
    vi.mocked(api.startAuthFlow).mockRejectedValueOnce(new Error("another auth flow is active"));
    const { result } = renderHook(() => useProviderAuthFlow());
    await waitFor(() => expect(result.current.providers).toHaveLength(3));
    await act(async () => {
      await result.current.start("anthropic", "api_key");
    });
    expect(result.current.view).toBe("error");
    expect(result.current.errorMessage).toContain("another auth flow is active");
  });

  it("backToList cancels any active server-side flow", async () => {
    const { result } = renderHook(() => useProviderAuthFlow());
    await waitFor(() => expect(result.current.providers).toHaveLength(3));
    await act(async () => {
      await result.current.start("anthropic", "api_key");
    });
    act(() => {
      result.current.backToList();
    });
    expect(api.cancelAuthFlow).toHaveBeenCalledWith("f1");
    expect(result.current.view).toBe("idle");
  });

  it("replaces progress notifies instead of accumulating them", async () => {
    const { result } = renderHook(() => useProviderAuthFlow());
    await waitFor(() => expect(result.current.providers).toHaveLength(3));
    await act(async () => {
      await result.current.start("anthropic", "api_key");
    });
    emit({ type: "notify", event: { kind: "progress", message: "step one" } });
    emit({ type: "notify", event: { kind: "progress", message: "step two" } });
    emit({ type: "notify", event: { kind: "info", message: "hello", links: [] } });
    await waitFor(() => expect(result.current.notifies).toHaveLength(2));
    expect(result.current.notifies[0]?.kind).toBe("progress");
    expect(result.current.notifies[0]).toMatchObject({ message: "step two" });
    expect(result.current.notifies[1]).toMatchObject({ kind: "info", message: "hello" });
  });

  it("cancels the active flow on unmount", async () => {
    const { result, unmount } = renderHook(() => useProviderAuthFlow());
    await waitFor(() => expect(result.current.providers).toHaveLength(3));
    await act(async () => {
      await result.current.start("anthropic", "api_key");
    });
    unmount();
    expect(api.cancelAuthFlow).toHaveBeenCalledWith("f1");
  });
});
