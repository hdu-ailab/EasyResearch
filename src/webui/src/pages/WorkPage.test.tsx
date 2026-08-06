// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkPage } from "./WorkPage";
import * as api from "../api";
import type { FileEntryDto } from "../../../web/contracts";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    getSnapshot: vi.fn(),
    connectSessionEvents: vi.fn(),
    sendPrompt: vi.fn(),
    stopSession: vi.fn(),
    abortSession: vi.fn(),
    listConfig: vi.fn().mockResolvedValue([]),
    readConfigFile: vi.fn(),
    writeConfigFile: vi.fn(),
    createConfigDirectory: vi.fn(),
    listEntries: vi.fn(),
    readFileContent: vi.fn(),
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
    vi.mocked(api.abortSession).mockReset();
    vi.mocked(api.listEntries).mockReset();
    vi.mocked(api.readFileContent).mockReset();
    vi.mocked(api.getSnapshot).mockResolvedValue(snapshot);
    vi.mocked(api.listEntries).mockResolvedValue([{ kind: "file", name: "notes.md", path: "/p/notes.md" }]);
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

  it("composer Stop while streaming aborts instead of stopping the session", async () => {
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    expect(screen.queryByRole("button", { name: /stop/i })).toBeNull();
    emit({ type: "message_start", message: { role: "assistant", id: "m3", content: [] } });
    await screen.findByRole("button", { name: /stop/i });
    await userEvent.setup().click(screen.getByRole("button", { name: /stop/i }));
    await waitFor(() => expect(api.abortSession).toHaveBeenCalledWith("s1"));
    expect(api.stopSession).not.toHaveBeenCalled();
  });

  it("agent chips show run status dot and clicking focuses an agent", async () => {
    const user = userEvent.setup();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    const orchestatorChip = screen.getByRole("button", { name: /agent orchestrator/i });
    expect(orchestatorChip.getAttribute("aria-pressed")).toBe("true");
    emit({ type: "message_start", message: { role: "assistant", id: "sm1", content: [], agentId: "literature" } });
    await screen.findByRole("button", { name: /agent literature/i });
    await user.click(screen.getByRole("button", { name: /agent literature/i }));
    expect(screen.getByRole("button", { name: /agent literature/i }).getAttribute("aria-pressed")).toBe("true");
    expect(orchestatorChip.getAttribute("aria-pressed")).toBe("false");
  });

  it("preserves chat state when toggling side panels and back", async () => {
    const user = userEvent.setup();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    await user.type(screen.getByRole("textbox", { name: /message/i }), "keep this");
    await user.click(screen.getByRole("button", { name: /send/i }));
    emit({
      type: "message_start",
      message: { role: "user", content: [{ type: "text", text: "keep this" }] },
    });
    expect(await screen.findByText("keep this")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /agent list/i }));
    expect(screen.getByRole("region", { name: /agent list/i })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /agent list/i }));
    expect(await screen.findByText("keep this")).toBeTruthy();
    expect(screen.getByText("starting research")).toBeTruthy();
  });

  it("files tree shows a chevron for untouched directories and a spinner only while loading", async () => {
    const user = userEvent.setup();
    const pending: Promise<FileEntryDto[]> = new Promise(() => {});
    vi.mocked(api.listEntries).mockImplementation(async (p) => {
      if (p === "/p") return [{ kind: "directory", name: "folder", path: "/p/folder" }];
      return pending;
    });
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    expect(await screen.findByText("folder")).toBeVisible();
    expect(screen.queryByLabelText("Loading folder")).toBeNull();
    expect(screen.getByRole("button", { name: "Expand folder" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Expand folder" }));
    expect(screen.getByLabelText("Loading folder")).toBeVisible();
  });

  it("files panel shows a loading message instead of empty content while the root is pending", async () => {
    const pending: Promise<FileEntryDto[]> = new Promise(() => {});
    vi.mocked(api.listEntries).mockImplementation(async () => pending);
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    expect(await screen.findByText("Loading…")).toBeTruthy();
    expect(screen.queryByText("No files.")).toBeNull();
  });

  it("opens a file from the files panel into a tab and previews its content", async () => {
    const user = userEvent.setup();
    vi.mocked(api.readFileContent).mockResolvedValue({
      path: "/p/notes.md",
      content: "# Notes\n\nplan",
      byteCount: 15,
      truncated: false,
    } as never);
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    await user.click(await screen.findByText("notes.md"));
    expect(api.readFileContent).toHaveBeenCalledWith("/p/notes.md");
    expect(await screen.findByText(/Notes/)).toBeTruthy();
    const tab = screen.getByRole("tab", { name: /notes.md/i });
    expect(tab.getAttribute("aria-selected")).toBe("true");
  });

  it("closing the active tab returns to the transcript", async () => {
    const user = userEvent.setup();
    vi.mocked(api.readFileContent).mockResolvedValue({
      path: "/p/notes.md",
      content: "body",
      byteCount: 4,
      truncated: false,
    } as never);
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    await user.click(await screen.findByText("notes.md"));
    expect(await screen.findByText(/body/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /close notes.md/i }));
    expect(await screen.findByText("starting research")).toBeTruthy();
    expect(screen.queryByRole("tab", { name: /notes.md/i })).toBeNull();
  });

  it("rehydrates from a snapshot event on reconnect", async () => {
    stubEvents();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    emit({
      type: "snapshot",
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready" },
      messages: [{ role: "assistant", content: [{ type: "text", text: "after reconnect" }] }],
    });
    expect(await screen.findByText("after reconnect")).toBeTruthy();
    expect(screen.queryByText("starting research")).toBeNull();
  });

  it("shows tool blocks from live events with running and done states", async () => {
    stubEvents();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} });
    expect(await screen.findByText(/Running tool: bash/)).toBeTruthy();
    emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: {}, isError: false });
    expect(await screen.findByText("bash")).toBeTruthy();
  });

  it("collapses reasoning by default and expands on demand", async () => {
    stubEvents();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    emit({
      type: "snapshot",
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready" },
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "secret chain of thought", thinkingSignature: "reasoning" },
            { type: "text", text: "visible answer" },
          ],
        },
      ],
    });
    const toggle = await screen.findByRole("button", { name: /show details/i });
    expect(screen.queryByText("secret chain of thought")).toBeNull();
    expect(screen.getByText("visible answer")).toBeTruthy();
    await userEvent.setup().click(toggle);
    expect(await screen.findByText("secret chain of thought")).toBeTruthy();
    expect(screen.getByRole("button", { name: /hide details/i })).toBeTruthy();
  });

  it("shows tool arguments and expands tool output on demand", async () => {
    stubEvents();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls -la" } });
    expect(await screen.findByText(/Running tool: bash/)).toBeTruthy();
    expect(screen.getByText("ls -la")).toBeTruthy();
    emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: { output: "file.txt\nnotes.md" }, isError: false });
    expect(screen.queryByText("file.txt")).toBeNull();
    await userEvent.setup().click(screen.getByText(/Running tool: bash/));
    expect(await screen.findByText(/file.txt/)).toBeTruthy();
  });

  it("chat column is the flex-1 remainder and the panel carries the explicit width", async () => {
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    const chat = screen.getByText("starting research").closest("section");
    const panel = screen.getByRole("region", { name: /file browser/i });
    expect(chat).toBeTruthy();
    expect(chat?.className).toContain("flex-1");
    expect(panel.className).toContain("md:shrink-0");
    expect(panel.getAttribute("style")).toMatch(/width:\s*320px/);
  });

  it("resizes the panel within min/max while dragging", async () => {
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    const RO = (globalThis as unknown as { FakeResizeObserver: typeof ResizeObserver }).FakeResizeObserver;
    const observer = (RO as unknown as { instances: { __fire: (n: number) => void }[] }).instances.at(-1);
    expect(observer).toBeTruthy();
    observer!.__fire(1200);
    await waitFor(() => expect(screen.getByRole("region", { name: /file browser/i }).getAttribute("style")).toMatch(/width:\s*320px/));
    const handle = screen.getByRole("button", { name: /resize panel/i });
    const row = screen.getByText("starting research").closest("section")?.parentElement;
    expect(row).toBeTruthy();
    vi.spyOn(row!, "getBoundingClientRect").mockReturnValue({
      right: 1200,
      left: 0,
      top: 0,
      bottom: 600,
      width: 1200,
      height: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    const panel = screen.getByRole("region", { name: /file browser/i });
    fireEvent.pointerDown(handle, { clientX: 880, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(document, { clientX: 820, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(document, { clientX: 820, clientY: 100, pointerId: 1 });
    expect(panel.getAttribute("style")).toMatch(/width:\s*380px/);
  });
});
