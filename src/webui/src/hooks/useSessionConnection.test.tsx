import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { useSessionConnection } from "./useSessionConnection";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    getSnapshot: vi.fn(),
    connectSessionEvents: vi.fn(),
    sendPrompt: vi.fn(),
    openSession: vi.fn(),
    abortSession: vi.fn(),
  };
});

const initialSnapshot = {
  session: {
    id: "s1",
    cwd: "/paper",
    sessionFile: "/agent/sessions/--paper--/session.jsonl",
    isStreaming: false,
    status: "ready",
  },
  messages: [{ role: "assistant", content: [{ type: "text", text: "snapshot text" }] }],
  subagents: [],
} as never;

let handlers: api.SessionEventHandlers[];

function emit(event: unknown, index = handlers.length - 1) {
  act(() => handlers[index]?.onEvent(event));
}

describe("useSessionConnection", () => {
  beforeEach(() => {
    handlers = [];
    vi.mocked(api.getSnapshot).mockReset().mockResolvedValue(initialSnapshot);
    vi.mocked(api.connectSessionEvents)
      .mockReset()
      .mockImplementation((_id, nextHandlers) => {
        handlers.push(nextHandlers);
        return vi.fn();
      });
    vi.mocked(api.sendPrompt).mockReset().mockResolvedValue(undefined);
    vi.mocked(api.openSession).mockReset();
    vi.mocked(api.abortSession).mockReset().mockResolvedValue(undefined);
  });

  it("hydrates the parent session and lets reconnect snapshots replace ordinary transcript state", async () => {
    const { result } = renderHook(() => useSessionConnection({ initialSessionId: "s1", cwd: "/paper" }));

    await waitFor(() => expect(result.current.view.messages[0]?.text).toBe("snapshot text"));
    expect(result.current.status).toBe("ready");
    expect(result.current.sessionPath).toBe("/agent/sessions/--paper--/session.jsonl");

    emit({
      type: "message_start",
      message: { id: "stale", role: "assistant", content: [{ type: "text", text: "stale live text" }] },
    });
    emit({
      type: "snapshot",
      session: { id: "s1", cwd: "/paper", isStreaming: false, status: "ready" },
      messages: [{ role: "assistant", content: [{ type: "text", text: "authoritative reconnect" }] }],
      subagents: [],
    });

    expect(result.current.view.messages.map((message) => message.text)).toEqual(["authoritative reconnect"]);
  });

  it("reduces the parent run lifecycle independently from message completion", async () => {
    const { result } = renderHook(() => useSessionConnection({ initialSessionId: "s1", cwd: "/paper" }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    emit({ type: "agent_start" });
    emit({ type: "message_start", message: { id: "m1", role: "assistant", content: [] } });
    emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "streamed" },
    });
    emit({
      type: "message_end",
      message: { id: "m1", role: "assistant", content: [{ type: "text", text: "streamed answer" }] },
    });

    expect(result.current.view.messages.at(-1)?.text).toBe("streamed answer");
    expect(result.current.view.messages.at(-1)?.streaming).toBe(false);
    expect(result.current.view.isStreaming).toBe(true);

    emit({ type: "agent_settled" });
    expect(result.current.view.isStreaming).toBe(false);
  });

  it("clears pending ownership and reports a send failure", async () => {
    vi.mocked(api.sendPrompt).mockRejectedValueOnce(new Error("prompt failed"));
    const { result } = renderHook(() => useSessionConnection({ initialSessionId: "s1", cwd: "/paper" }));
    await waitFor(() => expect(result.current.sessionPath).not.toBeNull());

    await act(async () => result.current.send("continue"));

    expect(result.current.accepting).toBe(false);
    expect(result.current.pendingOutput).toBe(false);
    expect(result.current.notice).toBe("prompt failed");
  });

  it("reopens an unknown session and waits for its event snapshot before resending", async () => {
    vi.mocked(api.sendPrompt)
      .mockRejectedValueOnce(new api.ApiError(404, { error: "Unknown session: s1" }))
      .mockResolvedValueOnce(undefined);
    vi.mocked(api.openSession).mockResolvedValueOnce({
      id: "s2",
      cwd: "/paper",
      sessionFile: "/agent/sessions/--paper--/session.jsonl",
      isStreaming: false,
      status: "ready",
    });
    vi.mocked(api.getSnapshot)
      .mockResolvedValueOnce(initialSnapshot)
      .mockResolvedValue({
        session: { id: "s2", cwd: "/paper", isStreaming: false, status: "ready" },
        messages: [],
        subagents: [],
      } as never);
    const { result } = renderHook(() => useSessionConnection({ initialSessionId: "s1", cwd: "/paper" }));
    await waitFor(() => expect(result.current.sessionPath).not.toBeNull());

    let sending!: Promise<void>;
    act(() => {
      sending = result.current.send("continue");
    });
    await waitFor(() => expect(vi.mocked(api.connectSessionEvents).mock.calls.map(([id]) => id)).toEqual(["s1", "s2"]));
    expect(api.sendPrompt).toHaveBeenCalledTimes(1);

    emit({
      type: "snapshot",
      session: { id: "s2", cwd: "/paper", isStreaming: false, status: "ready" },
      messages: [],
      subagents: [],
    });
    await act(async () => sending);

    expect(api.openSession).toHaveBeenCalledWith("/agent/sessions/--paper--/session.jsonl");
    expect(api.sendPrompt).toHaveBeenLastCalledWith("s2", "continue");
    expect(result.current.sessionId).toBe("s2");
    expect(result.current.accepting).toBe(false);
    expect(result.current.notice).toBeNull();
  });

  it("ends local run and pending state after a successful abort", async () => {
    const { result } = renderHook(() => useSessionConnection({ initialSessionId: "s1", cwd: "/paper" }));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    emit({ type: "agent_start" });

    await act(async () => result.current.abort());

    expect(api.abortSession).toHaveBeenCalledWith("s1");
    expect(result.current.view.isStreaming).toBe(false);
    expect(result.current.status).toBe("ready");
    expect(result.current.pendingOutput).toBe(false);
  });
});
