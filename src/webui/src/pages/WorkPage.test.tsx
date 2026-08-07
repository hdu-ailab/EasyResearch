// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    openSession: vi.fn(),
    stopSession: vi.fn(),
    abortSession: vi.fn(),
    listConfig: vi.fn().mockResolvedValue([]),
    readConfigFile: vi.fn(),
    writeConfigFile: vi.fn(),
    createConfigDirectory: vi.fn(),
    listEntries: vi.fn(),
    readFileContent: vi.fn(),
    listAgents: vi.fn(),
    listModels: vi.fn(),
    getEffectiveModels: vi.fn(),
    setAgentModel: vi.fn(),
  };
});

const snapshot = {
  session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready", sessionFile: "/agent/sessions/--p--/a.jsonl" },
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
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.mocked(api.getSnapshot).mockReset();
    vi.mocked(api.connectSessionEvents).mockReset();
    vi.mocked(api.sendPrompt).mockReset();
    vi.mocked(api.openSession).mockReset();
    vi.mocked(api.stopSession).mockReset();
    vi.mocked(api.abortSession).mockReset();
    vi.mocked(api.listEntries).mockReset();
    vi.mocked(api.readFileContent).mockReset();
    vi.mocked(api.listAgents).mockReset();
    vi.mocked(api.listModels).mockReset();
    vi.mocked(api.getEffectiveModels).mockReset();
    vi.mocked(api.setAgentModel).mockReset();
    vi.mocked(api.listAgents).mockResolvedValue([
      { name: "orchestrator", description: "Runs the pipeline", tools: ["subagent"] },
      { name: "search", description: "Finds papers" },
      { name: "experiment", description: "Runs experiments", subagents: ["search"] },
      { name: "writing", description: "Writes the paper", subagents: ["search", "figures"] },
      { name: "figures", description: "Draws figures" },
    ]);
    vi.mocked(api.listModels).mockResolvedValue([
      { provider: "openai", id: "gpt-4o" },
      { provider: "anthropic", id: "claude" },
    ]);
    vi.mocked(api.getEffectiveModels).mockResolvedValue([
      { name: "orchestrator", model: "openai/gpt-4o", source: "inherit" },
      { name: "search", model: "anthropic/claude", source: "override" },
      { name: "experiment", model: null, source: "inherit" },
      { name: "writing", model: null, source: "inherit" },
      { name: "figures", model: null, source: "inherit" },
    ]);
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

  it("renders a working agent row on send and replaces it with the first real output", async () => {
    const user = userEvent.setup();
    stubEvents();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    await user.type(screen.getByRole("textbox", { name: /message/i }), "continue please");
    await user.click(screen.getByRole("button", { name: /send/i }));
    expect(await screen.findByLabelText("Working")).toBeTruthy();
    emit({
      type: "message_start",
      message: { id: "m0", role: "user", content: [{ type: "text", text: "continue please" }] },
    });
    expect(screen.getByLabelText("Working")).toBeTruthy();
    emit({
      type: "message_start",
      message: { id: "m1", role: "assistant", content: [{ type: "text", text: "on it" }] },
    });
    await waitFor(() => expect(screen.queryByLabelText("Working")).toBeNull());
    expect(await screen.findByText("on it")).toBeTruthy();
  });

  it("clears the working agent row when the send fails", async () => {
    const user = userEvent.setup();
    stubEvents();
    vi.mocked(api.sendPrompt).mockRejectedValue(new Error("boom"));
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    await user.type(screen.getByRole("textbox", { name: /message/i }), "continue please");
    await user.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(screen.queryByLabelText("Working")).toBeNull());
    expect(screen.getByText("boom")).toBeTruthy();
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
    emit({ type: "message_start", message: { role: "assistant", id: "sm1", content: [], agentId: "search" } });
    await screen.findByRole("button", { name: /agent search/i });
    await user.click(screen.getByRole("button", { name: /agent search/i }));
    expect(screen.getByRole("button", { name: /agent search/i }).getAttribute("aria-pressed")).toBe("true");
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
    expect(await screen.findByText("body")).toBeTruthy();
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
    expect(panel.className).toContain("min-[820px]:shrink-0");
    expect(panel.getAttribute("style")).toMatch(/--panel-w:\s*320px/);
  });

  it("resizes the panel within min/max while dragging", async () => {
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    const RO = (globalThis as unknown as { FakeResizeObserver: typeof ResizeObserver }).FakeResizeObserver;
    const observer = (RO as unknown as { instances: { __fire: (n: number) => void }[] }).instances.at(-1);
    expect(observer).toBeTruthy();
    observer!.__fire(1200);
    await waitFor(() => expect(screen.getByRole("region", { name: /file browser/i }).getAttribute("style")).toMatch(/--panel-w:\s*600px/));
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
    expect(panel.getAttribute("style")).toMatch(/--panel-w:\s*660px/);
  });

  it("remembers the dragged width for the session after the first drag", async () => {
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    const RO = (globalThis as unknown as { FakeResizeObserver: typeof ResizeObserver }).FakeResizeObserver;
    const observer = (RO as unknown as { instances: { __fire: (n: number) => void }[] }).instances.at(-1);
    observer!.__fire(1200);
    await waitFor(() => expect(screen.getByRole("region", { name: /file browser/i }).getAttribute("style")).toMatch(/--panel-w:\s*600px/));
    const handle = screen.getByRole("button", { name: /resize panel/i });
    const row = screen.getByText("starting research").closest("section")?.parentElement;
    vi.spyOn(row!, "getBoundingClientRect").mockReturnValue({
      right: 1200, left: 0, top: 0, bottom: 600, width: 1200, height: 600, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);
    const panel = screen.getByRole("region", { name: /file browser/i });
    fireEvent.pointerDown(handle, { clientX: 880, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(document, { clientX: 820, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(document, { clientX: 820, clientY: 100, pointerId: 1 });
    expect(panel.getAttribute("style")).toMatch(/--panel-w:\s*660px/);
    observer!.__fire(1600);
    await waitFor(() => expect(panel.getAttribute("style")).toMatch(/--panel-w:\s*660px/));
  });

  it("never lets the drag shrink the panel below one third of the screen", async () => {
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    const RO = (globalThis as unknown as { FakeResizeObserver: typeof ResizeObserver }).FakeResizeObserver;
    const observer = (RO as unknown as { instances: { __fire: (n: number) => void }[] }).instances.at(-1);
    observer!.__fire(1200);
    await waitFor(() => expect(screen.getByRole("region", { name: /file browser/i }).getAttribute("style")).toMatch(/--panel-w:\s*600px/));
    const handle = screen.getByRole("button", { name: /resize panel/i });
    const row = screen.getByText("starting research").closest("section")?.parentElement;
    vi.spyOn(row!, "getBoundingClientRect").mockReturnValue({
      right: 1200, left: 0, top: 0, bottom: 600, width: 1200, height: 600, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);
    const panel = screen.getByRole("region", { name: /file browser/i });
    fireEvent.pointerDown(handle, { clientX: 880, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(document, { clientX: 1880, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(document, { clientX: 1880, clientY: 100, pointerId: 1 });
    expect(panel.getAttribute("style")).toMatch(/--panel-w:\s*341px/);
  });

  it("shows Chat by default below 820px and exposes persistent view tabs", async () => {
    vi.stubGlobal("innerWidth", 390);
    render(<WorkPage id="s1" cwd="/papers/fault-diagnosis" onBack={() => {}} />);
    expect(await screen.findByRole("tab", { name: /chat/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: /chat/i })).toBeVisible();
    expect(screen.getByTitle("/papers/fault-diagnosis")).toHaveTextContent("fault-diagnosis");
  });

  it("preserves file browser state while switching mobile views", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("innerWidth", 390);
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await user.click(await screen.findByRole("tab", { name: /files/i }));
    const filter = screen.getByRole("textbox", { name: /filter files/i });
    await user.type(filter, "notes");
    await user.click(screen.getByRole("tab", { name: /chat/i }));
    await user.click(screen.getByRole("tab", { name: /files/i }));
    expect(screen.getByRole("textbox", { name: /filter files/i })).toHaveValue("notes");
  });

  it("resets to Chat and closes the desktop panel when the viewport narrows below 820px", async () => {
    vi.stubGlobal("innerWidth", 900);
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await userEvent.setup().click(await screen.findByRole("button", { name: /agent list/i }));
    expect(screen.getByRole("region", { name: /agent list/i })).toBeTruthy();
    vi.stubGlobal("innerWidth", 800);
    fireEvent(window, new Event("resize"));
    await waitFor(() => expect(screen.getByRole("tab", { name: /chat/i })).toHaveAttribute("aria-selected", "true"));
    expect(screen.queryByRole("region", { name: /agent list/i })).toBeNull();
  });

  it("keeps the current mobile view across in-mobile resizes without resetting to Chat", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("innerWidth", 800);
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await user.click(await screen.findByRole("tab", { name: /files/i }));
    expect(screen.getByRole("tab", { name: /files/i })).toHaveAttribute("aria-selected", "true");
    vi.stubGlobal("innerWidth", 700);
    fireEvent(window, new Event("resize"));
    expect(screen.getByRole("tab", { name: /files/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /chat/i })).toHaveAttribute("aria-selected", "false");
  });

  it("mounts FileBrowser and AgentList once while switching mobile views", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("innerWidth", 390);
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    await user.click(screen.getByRole("tab", { name: /files/i }));
    await user.click(screen.getByRole("tab", { name: /agents/i }));
    await user.click(screen.getByRole("tab", { name: /chat/i }));
    expect(api.listEntries).toHaveBeenCalledTimes(1);
    expect(api.listAgents).toHaveBeenCalledTimes(1);
    expect(api.listModels).toHaveBeenCalledTimes(1);
    expect(api.getEffectiveModels).toHaveBeenCalledTimes(1);
  });

  it("marks the panel invisible after the close transition ends", async () => {
    const user = userEvent.setup();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    await user.click(screen.getByRole("button", { name: /agent list/i }));
    const region = screen.getByRole("region", { name: /agent list/i });
    expect(region.className).not.toContain("invisible");
    await user.click(screen.getByRole("button", { name: /agent list/i }));
    await waitFor(() => {
      expect(region.className).toContain("min-[820px]:w-0");
      expect(region.className).toContain("min-[820px]:opacity-0");
      expect(region.className).toContain("invisible");
    });
  });

  it("disables panel transitions while drag-resizing", async () => {
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    const handle = screen.getByRole("button", { name: /resize panel/i });
    fireEvent.pointerDown(handle, { clientX: 880, clientY: 100, pointerId: 1 });
    const region = screen.getByRole("region", { name: /file browser/i });
    expect(region.className).not.toContain("transition-");
    fireEvent.pointerUp(document, { clientX: 880, clientY: 100, pointerId: 1 });
    expect(region.className).toContain("transition-[width,opacity]");
  });

  it("keeps the resize handle reachable while clipping panel content internally", async () => {
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    const region = screen.getByRole("region", { name: /file browser/i });
    expect(region.className).not.toContain("overflow-hidden");
    const wrapper = region.querySelector(".animate-v2-fade-in");
    expect(wrapper?.className).toContain("overflow-hidden");
    const handle = screen.getByRole("button", { name: /resize panel/i });
    expect(region.contains(handle)).toBe(true);
    expect(handle.className).toContain("min-[820px]:block");
  });

  it("fades the content wrapper when switching between panel views", async () => {
    const user = userEvent.setup();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    const filesRegion = screen.getByRole("region", { name: /file browser/i });
    const filesWrapper = filesRegion.querySelector(".animate-v2-fade-in");
    expect(filesWrapper).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /agent list/i }));
    const agentsRegion = screen.getByRole("region", { name: /agent list/i });
    const agentsWrapper = agentsRegion.querySelector(".animate-v2-fade-in");
    expect(agentsWrapper).toBeTruthy();
    expect(agentsWrapper).not.toBe(filesWrapper);
  });

  it("renders the full five-agent roster in the agents view with serial copy", async () => {
    const user = userEvent.setup();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    await user.click(screen.getByRole("button", { name: /agent list/i }));
    const region = screen.getByRole("region", { name: /agent list/i });
    await waitFor(() => {
      for (const display of ["Orchestrator", "Search", "Experiment", "Writing", "Figures"]) {
        expect(within(region).getAllByText(display).length).toBeGreaterThan(0);
      }
    });
    expect(within(region).getByText(/serially/i)).toBeTruthy();
    expect(within(region).queryByText(/parallel/i)).toBeNull();
  });

  it("agent cards show localized descriptions and no Subagents rows", async () => {
    const user = userEvent.setup();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    await user.click(screen.getByRole("button", { name: /agent list/i }));
    const region = screen.getByRole("region", { name: /agent list/i });
    expect(await within(region).findByText(/Orchestrator for the paper pipeline/)).toBeTruthy();
    expect(within(region).getByText(/Experiment agent/)).toBeTruthy();
    expect(within(region).queryByText("Subagents")).toBeNull();
    expect(within(region).queryByText("search, figures")).toBeNull();
  });

  it("keeps the orchestrator card when the agents endpoint fails", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listAgents).mockRejectedValue(new Error("boom"));
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    await user.click(screen.getByRole("button", { name: /agent list/i }));
    const region = screen.getByRole("region", { name: /agent list/i });
    expect(await within(region).findByText("Orchestrator")).toBeTruthy();
  });

  it("shows each agent's effective model in its model dropdown", async () => {
    const user = userEvent.setup();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    await user.click(screen.getByRole("button", { name: /agent list/i }));
    const region = screen.getByRole("region", { name: /agent list/i });
    const combos = within(region).getAllByRole("combobox");
    expect(combos.length).toBe(5);
    expect(combos[0]!).toHaveValue("openai/gpt-4o");
    expect(combos[1]!).toHaveValue("anthropic/claude");
    expect(combos[2]!).toHaveValue("");
    expect(within(combos[2]!).getByText("Default model")).toBeTruthy();
    expect(within(region).queryByText(/inherits session/)).toBeNull();
  });

  it("selecting the default option on an overridden agent clears its model", async () => {
    const user = userEvent.setup();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    await user.click(screen.getByRole("button", { name: /agent list/i }));
    const region = screen.getByRole("region", { name: /agent list/i });
    const searchCombo = within(region).getAllByRole("combobox")[1] as HTMLSelectElement;
    await user.selectOptions(searchCombo, "");
    await waitFor(() => expect(api.setAgentModel).toHaveBeenCalledWith("s1", "search", null));
  });

  it("applying a model to an agent writes it immediately, with no Set button", async () => {
    const user = userEvent.setup();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    await user.click(screen.getByRole("button", { name: /agent list/i }));
    const region = screen.getByRole("region", { name: /agent list/i });
    const searchCombo = within(region).getAllByRole("combobox")[1] as HTMLSelectElement;
    await user.selectOptions(searchCombo, "openai/gpt-4o");
    await waitFor(() => expect(api.setAgentModel).toHaveBeenCalledWith("s1", "search", "openai/gpt-4o"));
    expect(within(region).queryByRole("button", { name: /^set$/i })).toBeNull();
  });

  it("shows a session-ended notice and keeps the transcript on session_deactivated", async () => {
    stubEvents();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    emit({ type: "session_deactivated", sessionId: "s1" });
    expect(await screen.findByText(/session ended/i)).toBeTruthy();
    expect(screen.getByText("write a paper")).toBeTruthy();
    expect(screen.getByText("starting research")).toBeTruthy();
  });

  it("auto-reopens the deactivated session and re-sends the message", async () => {
    const user = userEvent.setup();
    stubEvents();
    vi.mocked(api.sendPrompt)
      .mockRejectedValueOnce(new api.ApiError(404, { error: "Unknown session: s1" }))
      .mockResolvedValueOnce(undefined);
    vi.mocked(api.openSession).mockResolvedValueOnce({
      id: "s2",
      cwd: "/p",
      sessionFile: "/agent/sessions/--p--/a.jsonl",
      isStreaming: false,
      status: "ready",
    } as never);
    vi.mocked(api.getSnapshot).mockResolvedValueOnce(snapshot).mockResolvedValue({
      session: { id: "s2", cwd: "/p", isStreaming: false, status: "ready" },
      messages: [{ role: "user", content: [{ type: "text", text: "continue please" }] }],
    } as never);
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    await user.type(screen.getByRole("textbox", { name: /message/i }), "continue please");
    await user.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(api.openSession).toHaveBeenCalledWith("/agent/sessions/--p--/a.jsonl"));
    expect(api.sendPrompt).toHaveBeenCalledTimes(2);
    expect(api.sendPrompt).toHaveBeenLastCalledWith("s2", "continue please");
    await waitFor(() => expect(api.connectSessionEvents).toHaveBeenCalledTimes(2));
    expect(api.connectSessionEvents).toHaveBeenNthCalledWith(1, "s1", expect.anything());
    expect(api.connectSessionEvents).toHaveBeenNthCalledWith(2, "s2", expect.anything());
    expect(unsubscribeFn).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(await screen.findByText("continue please")).toBeTruthy();
  });

  it("re-subs scribes events when reopening returns the same session id", async () => {
    const user = userEvent.setup();
    stubEvents();
    vi.mocked(api.sendPrompt)
      .mockRejectedValueOnce(new api.ApiError(404, { error: "Unknown session: s1" }))
      .mockResolvedValueOnce(undefined);
    vi.mocked(api.openSession).mockResolvedValueOnce({
      id: "s1",
      cwd: "/p",
      sessionFile: "/agent/sessions/--p--/a.jsonl",
      isStreaming: false,
      status: "ready",
    } as never);
    vi.mocked(api.getSnapshot).mockResolvedValueOnce(snapshot).mockResolvedValue({
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready" },
      messages: [{ role: "user", content: [{ type: "text", text: "continue please" }] }],
    } as never);
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    await user.type(screen.getByRole("textbox", { name: /message/i }), "continue please");
    await user.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(api.openSession).toHaveBeenCalledWith("/agent/sessions/--p--/a.jsonl"));
    await waitFor(() => expect(api.connectSessionEvents).toHaveBeenCalledTimes(2));
    expect(api.connectSessionEvents).toHaveBeenNthCalledWith(1, "s1", expect.anything());
    expect(api.connectSessionEvents).toHaveBeenNthCalledWith(2, "s1", expect.anything());
    expect(api.sendPrompt).toHaveBeenLastCalledWith("s1", "continue please");
    emit({
      type: "message_start",
      message: { role: "user", content: [{ type: "text", text: "continue please" }] },
    });
    expect(await screen.findByText("continue please")).toBeTruthy();
  });

  it("shows the error text for a plain HTTP failure without reopening", async () => {
    const user = userEvent.setup();
    stubEvents();
    vi.mocked(api.sendPrompt).mockRejectedValue(new api.ApiError(500, { error: "server exploded" }));
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    await user.type(screen.getByRole("textbox", { name: /message/i }), "continue please");
    await user.click(screen.getByRole("button", { name: /send/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("server exploded");
    expect(api.openSession).not.toHaveBeenCalled();
    expect(api.sendPrompt).toHaveBeenCalledTimes(1);
  });
});
