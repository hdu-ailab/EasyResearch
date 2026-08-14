import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AuthFlowEventDto } from "../../../web/contracts";
import * as api from "../api";
import { useProviderAuthFlow } from "./useProviderAuthFlow";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    listAuthProviders: vi.fn(async () => [
      { id: "anthropic", name: "Anthropic", authMethods: ["api_key"], connectable: true, authStatus: { configured: false } },
      { id: "xai", name: "xAI", authMethods: ["api_key", "oauth"], connectable: true, authStatus: { configured: true } },
      { id: "google-vertex", name: "Google Vertex AI", authMethods: ["api_key"], connectable: false, authStatus: { configured: false }, hint: "ambient" },
    ]),
    startAuthFlow: vi.fn(async () => ({ flowId: "f1" })),
    respondAuthFlow: vi.fn(async () => {}),
    cancelAuthFlow: vi.fn(async () => {}),
    logoutProvider: vi.fn(async () => {}),
    authFlowEventSource: vi.fn((_flowId: string, handlers: api.AuthFlowHandlers) => {
      handlersList.push(handlers);
      return () => {};
    }),
  };
});

const handlersList: api.AuthFlowHandlers[] = [];

function emit(event: AuthFlowEventDto, index = handlersList.length - 1) {
  act(() => handlersList[index]?.onEvent(event));
}

describe("useProviderAuthFlow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlersList.length = 0;
  });

  it("loads providers and computes the connected count", async () => {
    const { result } = renderHook(() => useProviderAuthFlow());
    await waitFor(() => expect(result.current.providers).toHaveLength(3));
    expect(result.current.connectedCount).toBe(1);
    expect(result.current.view).toBe("idle");
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

  it("respond posts the value and clears the pending prompt", async () => {
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
});