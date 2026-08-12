import { act, renderHook, waitFor } from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSnapshotDto } from "../../../web/contracts";
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

const initialSnapshot: SessionSnapshotDto = {
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function reopenedSession(id = "s2") {
  return {
    id,
    cwd: "/paper",
    sessionFile: "/agent/sessions/--paper--/session.jsonl",
    isStreaming: false,
    status: "ready" as const,
  };
}

function unknownSession() {
  return new api.ApiError(404, { error: "Unknown session: s1" });
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

  it("survives StrictMode effect replay and continues hydrating, receiving events, and sending", async () => {
    const delayedSnapshot = deferred<SessionSnapshotDto>();
    const delayedSend = deferred<void>();
    vi.mocked(api.getSnapshot)
      .mockReset()
      .mockImplementation(() => delayedSnapshot.promise);
    vi.mocked(api.sendPrompt).mockReturnValueOnce(delayedSend.promise);
    const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
    const { result } = renderHook(() => useSessionConnection({ initialSessionId: "s1", cwd: "/paper" }), {
      wrapper,
    });

    delayedSnapshot.resolve(initialSnapshot);
    await waitFor(() => expect(result.current.view.messages[0]?.text).toBe("snapshot text"));
    emit({ type: "agent_start" });
    emit({ type: "message_start", message: { id: "strict", role: "assistant", content: [] } });
    emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "after replay" },
    });
    let sending!: Promise<void>;
    act(() => {
      sending = result.current.send("continue");
    });
    delayedSend.resolve();
    await act(async () => sending);

    expect(result.current.view.messages.at(-1)?.text).toBe("after replay");
    expect(api.sendPrompt).toHaveBeenCalledWith("s1", "continue");
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
    vi.mocked(api.sendPrompt).mockRejectedValueOnce(unknownSession()).mockResolvedValueOnce(undefined);
    vi.mocked(api.openSession).mockResolvedValueOnce(reopenedSession());
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

  it("does not let delayed reopen HTTP overwrite its authoritative SSE snapshot and live events", async () => {
    const delayedHttp = deferred<SessionSnapshotDto>();
    vi.mocked(api.sendPrompt).mockRejectedValueOnce(unknownSession()).mockResolvedValueOnce(undefined);
    vi.mocked(api.openSession).mockResolvedValueOnce(reopenedSession());
    vi.mocked(api.getSnapshot)
      .mockResolvedValueOnce(initialSnapshot)
      .mockImplementation(() => delayedHttp.promise);
    const { result } = renderHook(() => useSessionConnection({ initialSessionId: "s1", cwd: "/paper" }));
    await waitFor(() => expect(result.current.sessionPath).not.toBeNull());

    let sending!: Promise<void>;
    act(() => {
      sending = result.current.send("continue");
    });
    await waitFor(() => expect(handlers).toHaveLength(2));
    emit({
      type: "snapshot",
      session: reopenedSession(),
      messages: [{ role: "assistant", content: [{ type: "text", text: "authoritative SSE" }] }],
      subagents: [],
    });
    emit({
      type: "message_start",
      message: { id: "live", role: "assistant", content: [{ type: "text", text: "new live output" }] },
    });
    act(() =>
      delayedHttp.resolve({
        ...initialSnapshot,
        session: reopenedSession(),
        messages: [{ role: "assistant", content: [{ type: "text", text: "stale HTTP" }] }],
      } as never),
    );
    await act(async () => sending);

    expect(result.current.view.messages.map((message) => message.text)).toEqual([
      "authoritative SSE",
      "new live output",
    ]);
  });

  it("ignores old-generation HTTP, events, and errors after the session changes", async () => {
    const oldHttp = deferred<SessionSnapshotDto>();
    const currentHttp = deferred<SessionSnapshotDto>();
    vi.mocked(api.getSnapshot)
      .mockImplementationOnce(() => oldHttp.promise)
      .mockImplementationOnce(() => currentHttp.promise);
    vi.mocked(api.sendPrompt).mockRejectedValueOnce(unknownSession()).mockResolvedValueOnce(undefined);
    vi.mocked(api.openSession).mockResolvedValueOnce(reopenedSession());
    const { result } = renderHook(() => useSessionConnection({ initialSessionId: "s1", cwd: "/paper" }));
    emit({
      type: "snapshot",
      session: reopenedSession("s1"),
      messages: [{ role: "assistant", content: [{ type: "text", text: "initial SSE" }] }],
      subagents: [],
    });
    await waitFor(() => expect(result.current.sessionPath).not.toBeNull());

    let sending!: Promise<void>;
    act(() => {
      sending = result.current.send("continue");
    });
    await waitFor(() => expect(handlers).toHaveLength(2));
    emit(
      {
        type: "snapshot",
        session: reopenedSession(),
        messages: [{ role: "assistant", content: [{ type: "text", text: "current SSE" }] }],
        subagents: [],
      },
      1,
    );
    act(() =>
      currentHttp.resolve({
        ...initialSnapshot,
        session: reopenedSession(),
        messages: [{ role: "assistant", content: [{ type: "text", text: "current HTTP" }] }],
      } as never),
    );
    await act(async () => sending);

    act(() =>
      oldHttp.resolve({
        ...initialSnapshot,
        session: { ...reopenedSession("old-session"), status: "error" },
        messages: [{ role: "assistant", content: [{ type: "text", text: "old HTTP" }] }],
      } as never),
    );
    emit(
      {
        type: "message_start",
        message: { id: "old-event", role: "assistant", content: [{ type: "text", text: "old event" }] },
      },
      0,
    );
    act(() => handlers[0]?.onError());

    expect(result.current.sessionId).toBe("s2");
    expect(result.current.status).toBe("ready");
    expect(result.current.notice).toBeNull();
    expect(result.current.view.messages.map((message) => message.text)).toEqual(["current SSE"]);
  });

  it("cancels a pending reopen on abort and never resends afterward", async () => {
    vi.mocked(api.sendPrompt).mockRejectedValueOnce(unknownSession()).mockResolvedValueOnce(undefined);
    vi.mocked(api.openSession).mockResolvedValueOnce(reopenedSession());
    const { result } = renderHook(() => useSessionConnection({ initialSessionId: "s1", cwd: "/paper" }));
    await waitFor(() => expect(result.current.sessionPath).not.toBeNull());

    let settled = false;
    let sending!: Promise<void>;
    act(() => {
      sending = result.current.send("continue").then(() => {
        settled = true;
      });
    });
    await waitFor(() => expect(handlers).toHaveLength(2));
    await act(async () => result.current.abort());
    await waitFor(() => expect(settled).toBe(true));
    emit({
      type: "snapshot",
      session: reopenedSession(),
      messages: [],
      subagents: [],
    });
    await sending;

    expect(api.sendPrompt).toHaveBeenCalledTimes(1);
    expect(result.current.accepting).toBe(false);
    expect(result.current.pendingOutput).toBe(false);
  });

  it("settles and prevents resend when a newer send supersedes a pending reopen", async () => {
    vi.mocked(api.sendPrompt)
      .mockRejectedValueOnce(unknownSession())
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);
    vi.mocked(api.openSession).mockResolvedValueOnce(reopenedSession());
    const { result } = renderHook(() => useSessionConnection({ initialSessionId: "s1", cwd: "/paper" }));
    await waitFor(() => expect(result.current.sessionPath).not.toBeNull());

    let firstSettled = false;
    let firstSend!: Promise<void>;
    act(() => {
      firstSend = result.current.send("first").then(() => {
        firstSettled = true;
      });
    });
    await waitFor(() => expect(handlers).toHaveLength(2));
    await act(async () => result.current.send("second"));
    await waitFor(() => expect(firstSettled).toBe(true));
    emit({
      type: "snapshot",
      session: reopenedSession(),
      messages: [],
      subagents: [],
    });
    await firstSend;

    expect(api.sendPrompt).toHaveBeenCalledTimes(2);
    expect(api.sendPrompt).toHaveBeenNthCalledWith(1, "s1", "first");
    expect(api.sendPrompt).toHaveBeenNthCalledWith(2, "s2", "second");
  });

  it("rejects a pending reopen when the stream errors before its snapshot", async () => {
    vi.mocked(api.sendPrompt).mockRejectedValueOnce(unknownSession()).mockResolvedValueOnce(undefined);
    vi.mocked(api.openSession).mockResolvedValueOnce(reopenedSession());
    const { result } = renderHook(() => useSessionConnection({ initialSessionId: "s1", cwd: "/paper" }));
    await waitFor(() => expect(result.current.sessionPath).not.toBeNull());

    let settled = false;
    let sending!: Promise<void>;
    act(() => {
      sending = result.current.send("continue").then(() => {
        settled = true;
      });
    });
    await waitFor(() => expect(handlers).toHaveLength(2));
    act(() => handlers[1]?.onError());
    await waitFor(() => expect(settled).toBe(true));
    await sending;

    expect(api.sendPrompt).toHaveBeenCalledTimes(1);
    expect(result.current.accepting).toBe(false);
    expect(result.current.pendingOutput).toBe(false);
    expect(result.current.notice).toBe("Connection lost — events will resume when the browser reconnects.");
  });

  it("settles a pending reopen when the hook unmounts", async () => {
    vi.mocked(api.sendPrompt).mockRejectedValueOnce(unknownSession()).mockResolvedValueOnce(undefined);
    vi.mocked(api.openSession).mockResolvedValueOnce(reopenedSession());
    const { result, unmount } = renderHook(() => useSessionConnection({ initialSessionId: "s1", cwd: "/paper" }));
    await waitFor(() => expect(result.current.sessionPath).not.toBeNull());

    let settled = false;
    let sending!: Promise<void>;
    act(() => {
      sending = result.current.send("continue").then(() => {
        settled = true;
      });
    });
    await waitFor(() => expect(handlers).toHaveLength(2));
    unmount();
    await waitFor(() => expect(settled).toBe(true));
    await sending;

    expect(api.sendPrompt).toHaveBeenCalledTimes(1);
  });

  it("preserves the actionable reopen error instead of restoring the unknown-session error", async () => {
    vi.mocked(api.sendPrompt).mockRejectedValueOnce(unknownSession());
    vi.mocked(api.openSession).mockRejectedValueOnce(new Error("Session file can no longer be reopened"));
    const { result } = renderHook(() => useSessionConnection({ initialSessionId: "s1", cwd: "/paper" }));
    await waitFor(() => expect(result.current.sessionPath).not.toBeNull());

    await act(async () => result.current.send("continue"));

    expect(result.current.notice).toBe("Session file can no longer be reopened");
    expect(result.current.accepting).toBe(false);
    expect(result.current.pendingOutput).toBe(false);
  });

  it("ends local run and pending state after a successful abort", async () => {
    const { result } = renderHook(() => useSessionConnection({ initialSessionId: "s1", cwd: "/paper" }));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    emit({ type: "agent_start" });
    emit({ type: "message_start", message: { id: "abort-row", role: "assistant", content: [] } });
    emit({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "working" },
    });
    expect(result.current.status).toBe("running");

    await act(async () => result.current.abort());

    expect(api.abortSession).toHaveBeenCalledWith("s1");
    expect(result.current.view.isStreaming).toBe(false);
    expect(result.current.view.activeMessageKey).toBeUndefined();
    expect(result.current.view.messages.at(-1)).toMatchObject({ streaming: false, isThinking: false });
    expect(result.current.status).toBe("ready");
    expect(result.current.accepting).toBe(false);
    expect(result.current.pendingOutput).toBe(false);

    emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " stale" },
    });
    expect(result.current.view.messages.at(-1)?.text).not.toContain("stale");
  });

  it.each([
    ["typed stream error", { type: "error", error: "stream failed" }, "error"],
    ["session deactivation", { type: "session_deactivated" }, "stopped"],
  ] as const)("clears all local run ownership on %s", async (_name, terminalEvent, expectedStatus) => {
    const pendingPrompt = deferred<void>();
    vi.mocked(api.sendPrompt).mockReturnValueOnce(pendingPrompt.promise);
    const { result } = renderHook(() => useSessionConnection({ initialSessionId: "s1", cwd: "/paper" }));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => void result.current.send("continue"));
    emit({ type: "agent_start" });
    emit({ type: "message_start", message: { id: "terminal-row", role: "assistant", content: [] } });
    emit({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "working" },
    });

    emit(terminalEvent);

    expect(result.current.status).toBe(expectedStatus);
    expect(result.current.accepting).toBe(false);
    expect(result.current.pendingOutput).toBe(false);
    expect(result.current.view.isStreaming).toBe(false);
    expect(result.current.view.activeMessageKey).toBeUndefined();
    expect(result.current.view.messages.at(-1)).toMatchObject({ streaming: false, isThinking: false });
    emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " stale" },
    });
    expect(result.current.view.messages.at(-1)?.text).not.toContain("stale");
    pendingPrompt.resolve();
  });
});
