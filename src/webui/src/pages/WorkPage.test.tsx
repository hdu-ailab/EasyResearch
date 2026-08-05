// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkPage } from "./WorkPage";
import * as api from "../api";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    getSnapshot: vi.fn(),
    connectSessionEvents: vi.fn(),
    sendPrompt: vi.fn(),
    stopSession: vi.fn(),
    restartSession: vi.fn(),
  };
});

const snapshot = {
  session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready" },
  messages: [
    { role: "user", content: [{ type: "text", text: "write a paper" }] },
    { role: "assistant", content: [{ type: "text", text: "starting research" }] },
  ],
} as never;

let latestHandlers: { onEvent: (e: unknown) => void; onError: () => void } | null = null;
let unsubscribeFn: ReturnType<typeof vi.fn>;

function stubEvents() {
  unsubscribeFn = vi.fn();
  latestHandlers = null;
  vi.mocked(api.connectSessionEvents).mockImplementation((_id, h) => {
    latestHandlers = h;
    return unsubscribeFn as unknown as () => void;
  });
}

function emit(event: unknown) {
  latestHandlers?.onEvent(event);
}

describe("WorkPage", () => {
  beforeEach(() => {
    vi.mocked(api.getSnapshot).mockReset();
    vi.mocked(api.connectSessionEvents).mockReset();
    vi.mocked(api.sendPrompt).mockReset();
    vi.mocked(api.stopSession).mockReset();
    vi.mocked(api.restartSession).mockReset();
    vi.mocked(api.getSnapshot).mockResolvedValue(snapshot);
    stubEvents();
  });

  it("renders snapshot messages before live events", async () => {
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    expect(await screen.findByText("write a paper")).toBeTruthy();
    expect(screen.getByText("starting research")).toBeTruthy();
  });

  it("sends nonblank text via sendPrompt and keeps the user message visible", async () => {
    const user = userEvent.setup();
    stubEvents();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    await user.type(screen.getByRole("textbox", { name: /message/i }), "continue please");
    await user.click(screen.getByRole("button", { name: /send/i }));
    expect(api.sendPrompt).toHaveBeenCalledWith("s1", "continue please");
    emit({
      type: "message_start",
      message: { role: "user", content: [{ type: "text", text: "continue please" }] },
    });
    expect(await screen.findByText("continue please")).toBeTruthy();
  });

  it("does not send blank input", async () => {
    const user = userEvent.setup();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    await user.type(screen.getByRole("textbox", { name: /message/i }), "   ");
    await user.click(screen.getByRole("button", { name: /send/i }));
    expect(api.sendPrompt).not.toHaveBeenCalled();
  });

  it("streams message_update deltas into a single assistant row", async () => {
    stubEvents();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    emit({
      type: "message_start",
      message: { role: "assistant", id: "m1", content: [{ type: "text", text: "" }] },
    });
    emit({
      type: "message_update",
      message: { role: "assistant", id: "m1", content: [{ type: "text", text: "tok" }] },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "tok" },
    });
    emit({
      type: "message_update",
      message: { role: "assistant", id: "m1", content: [{ type: "text", text: "tok2" }] },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "2" },
    });
    expect(await screen.findByText(/tok2/)).toBeTruthy();
    const rows = screen.getAllByRole("listitem");
    expect(rows.filter((r) => r.textContent?.includes("tok2"))).toHaveLength(1);
  });

  it("surfaces model/auth failure after prompt in the transcript", async () => {
    stubEvents();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    emit({
      type: "message_start",
      message: { role: "assistant", id: "m2", content: [], errorMessage: "provider auth failed" },
    });
    expect(await screen.findByText(/provider auth failed/)).toBeTruthy();
    expect(screen.queryByText(/auth failed/i)).toBeTruthy();
  });

  it("unmount only closes EventSource, never stops the session", async () => {
    const { unmount } = render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    unmount();
    expect(unsubscribeFn).toHaveBeenCalled();
    expect(api.stopSession).not.toHaveBeenCalled();
  });

  it("Stop confirms, calls stopSession, and keeps Restart usable", async () => {
    const user = userEvent.setup();
    window.confirm = vi.fn(() => true);
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    await user.click(screen.getByRole("button", { name: /stop/i }));
    expect(window.confirm).toHaveBeenCalled();
    await waitFor(() => expect(api.stopSession).toHaveBeenCalledWith("s1"));
    expect(screen.getByRole("button", { name: /restart/i })).toBeTruthy();
  });

  it("Restart calls restartSession and reconnects events", async () => {
    const user = userEvent.setup();
    vi.mocked(api.restartSession).mockResolvedValue({
      id: "s2",
      cwd: "/p",
      sessionFile: "/agent/s2.jsonl",
      isStreaming: false,
      status: "ready",
    } as never);
    vi.mocked(api.getSnapshot)
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce({
        session: { id: "s2", cwd: "/p", isStreaming: false, status: "ready" },
        messages: [{ role: "assistant", content: [{ type: "text", text: "after restart" }] }],
      } as never);
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    await user.click(screen.getByRole("button", { name: /restart/i }));
    await waitFor(() => expect(api.restartSession).toHaveBeenCalledWith("s1"));
    expect(await screen.findByText("after restart")).toBeTruthy();
  });
});
