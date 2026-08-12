import { act, fireEvent, render as renderWithTestingLibrary, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileEntryDto } from "../../../web/contracts";
import * as api from "../api";
import { I18nProvider } from "../i18n/I18nProvider";
import { STORAGE_KEY } from "../preferences";
import { PreferencesProvider } from "../preferences/PreferencesProvider";
import { WorkPage } from "./WorkPage";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    getSnapshot: vi.fn(),
    getChildSnapshot: vi.fn(),
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

function emitInAct(event: unknown) {
  act(() => emit(event));
}

function emitChildHeader(toolCallId: string, agent: string, sessionId: string, step?: number) {
  emitInAct({
    type: "tool_execution_update",
    toolCallId,
    toolName: "subagent",
    partialResult: { details: { subagent: { agent, sessionId, step, status: "running" } } },
  });
}

function emitRawChildEvent(toolCallId: string, agent: string, event: unknown, step?: number) {
  emitInAct({
    type: "tool_execution_update",
    toolCallId,
    toolName: "subagent",
    partialResult: { details: { subagent: { agent, step, status: "running", event } } },
  });
}

function render(ui: ReactElement) {
  return renderWithTestingLibrary(ui, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <PreferencesProvider>
        <I18nProvider>{children}</I18nProvider>
      </PreferencesProvider>
    ),
  });
}

describe("WorkPage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.mocked(api.getSnapshot).mockReset();
    vi.mocked(api.getChildSnapshot).mockReset();
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
      {
        name: "paper-assistant",
        description: "Runs the pipeline",
        enabled: true,
        builtin: true,
        source: "bundled",
        filePath: "paper-assistant.md",
        tools: ["subagent"],
        effectiveTools: ["subagent"],
        effectiveSkills: [],
        missingSkills: [],
      },
      {
        name: "search",
        description: "Finds papers",
        enabled: true,
        builtin: true,
        source: "bundled",
        filePath: "search.md",
        effectiveTools: [],
        effectiveSkills: [],
        missingSkills: [],
      },
      {
        name: "experiment",
        description: "Runs experiments",
        enabled: true,
        builtin: true,
        source: "bundled",
        filePath: "experiment.md",
        effectiveTools: [],
        effectiveSkills: [],
        missingSkills: [],
        subagents: ["search"],
      },
      {
        name: "writing",
        description: "Writes the paper",
        enabled: true,
        builtin: true,
        source: "bundled",
        filePath: "writing.md",
        effectiveTools: [],
        effectiveSkills: [],
        missingSkills: [],
        subagents: ["search", "figures"],
      },
      {
        name: "figures",
        description: "Draws figures",
        enabled: true,
        builtin: true,
        source: "bundled",
        filePath: "figures.md",
        effectiveTools: [],
        effectiveSkills: [],
        missingSkills: [],
      },
    ]);
    vi.mocked(api.listModels).mockResolvedValue([
      { provider: "openai", id: "gpt-4o" },
      { provider: "anthropic", id: "claude" },
    ]);
    vi.mocked(api.getEffectiveModels).mockResolvedValue([
      { name: "paper-assistant", model: "openai/gpt-4o", source: "inherit" },
      { name: "search", model: "anthropic/claude", source: "override" },
      { name: "experiment", model: null, source: "inherit" },
      { name: "writing", model: null, source: "inherit" },
      { name: "figures", model: null, source: "inherit" },
    ]);
    vi.mocked(api.getSnapshot).mockResolvedValue(snapshot);
    vi.mocked(api.getChildSnapshot).mockResolvedValue({
      session: { id: "child-default", cwd: "/p", sessionName: "easyresearch:search" },
      messages: [],
    });
    vi.mocked(api.listEntries).mockResolvedValue([{ kind: "file", name: "notes.md", path: "/p/notes.md" }]);
    stubEvents();
  });

  it("keeps Home first and places the workspace 4px below the topbar", async () => {
    const onBack = vi.fn();
    const user = userEvent.setup();
    render(<WorkPage id="s1" cwd="/p" onBack={onBack} />);
    await screen.findByText("starting research");

    const home = screen.getByRole("button", { name: /back to home/i });
    expect(home).not.toHaveAttribute("aria-current");
    await user.click(home);
    expect(onBack).toHaveBeenCalledOnce();
    const conversation = screen.getByRole("tabpanel", { name: /^chat$/i });
    expect(conversation.parentElement).toHaveClass("px-2", "pb-2", "pt-[4px]");
    expect(conversation.parentElement).not.toHaveClass("p-2");
  });

  it("renders snapshot messages before live events", async () => {
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    expect(await screen.findByText("write a paper")).toBeTruthy();
    expect(screen.getByText("starting research")).toBeTruthy();
  });

  it("does not render an empty assistant bubble for reasoning-only tool-call messages", async () => {
    vi.mocked(api.getSnapshot).mockResolvedValue({
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready" },
      subagents: [],
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "first reasoning" },
            { type: "toolCall", id: "tool-1", name: "bash", arguments: '{"command":"first"}' },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "second reasoning" },
            { type: "toolCall", id: "tool-2", name: "bash", arguments: '{"command":"second"}' },
          ],
        },
      ],
    } as never);

    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);

    const conversation = await screen.findByLabelText("Conversation");
    const reasoningButtons = within(conversation).getAllByRole("button", { name: /show details/i });
    expect(reasoningButtons).toHaveLength(2);
    for (const button of reasoningButtons) {
      expect(button.closest("li")?.querySelector("div.v2-md")).toBeNull();
    }
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

  it("replaces the working agent row when the first real output is a tool call", async () => {
    const user = userEvent.setup();
    stubEvents();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    await user.type(screen.getByRole("textbox", { name: /message/i }), "inspect files");
    await user.click(screen.getByRole("button", { name: /send/i }));
    expect(await screen.findByLabelText("Working")).toBeTruthy();

    emit({
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "bash",
      args: { command: "ls" },
    });

    await waitFor(() => expect(screen.queryByLabelText("Working")).toBeNull());
    expect(await screen.findByText(/Running tool: bash/)).toBeTruthy();
  });

  it("jumps to the bottom on send even when the transcript was scrolled up", async () => {
    const user = userEvent.setup();
    stubEvents();
    let flushFrame: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      flushFrame = callback;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    const el = screen.getByLabelText("Conversation") as HTMLDivElement;
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => 400 });
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 200 });
    el.scrollTop = 100;
    fireEvent.scroll(el);

    await user.type(screen.getByRole("textbox", { name: /message/i }), "continue please");
    await user.click(screen.getByRole("button", { name: /send/i }));
    flushFrame?.(0);

    await waitFor(() => expect(el.scrollTop).toBe(400));
  });

  it("jumps to the bottom on every send while the previous prompt remains pending", async () => {
    const user = userEvent.setup();
    let flushFrame: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      flushFrame = callback;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const flushCapturedFrame = () => {
      const callback = flushFrame;
      flushFrame = undefined;
      callback?.(0);
    };
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    const el = screen.getByLabelText("Conversation") as HTMLDivElement;
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => 400 });
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 200 });
    flushCapturedFrame();

    el.scrollTop = 100;
    fireEvent.scroll(el);
    await user.type(screen.getByRole("textbox", { name: /message/i }), "first prompt");
    await user.click(screen.getByRole("button", { name: /send/i }));
    flushCapturedFrame();
    expect(el.scrollTop).toBe(400);

    el.scrollTop = 100;
    fireEvent.scroll(el);
    await user.type(screen.getByRole("textbox", { name: /message/i }), "second prompt");
    await user.click(screen.getByRole("button", { name: /send/i }));
    flushCapturedFrame();

    expect(el.scrollTop).toBe(400);
    expect(api.sendPrompt).toHaveBeenCalledTimes(2);
  });

  it("jumps to the bottom when switching to a child agent tab", async () => {
    const user = userEvent.setup();
    stubEvents();
    let flushFrame: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      flushFrame = callback;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.mocked(api.getChildSnapshot).mockResolvedValue({
      session: { id: "child-switch", cwd: "/p", sessionName: "easyresearch:search" },
      messages: [
        { role: "user", content: [{ type: "text", text: "child task" }] },
        { role: "assistant", content: [{ type: "text", text: "child answer" }] },
      ],
    } as never);
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    const el = screen.getByLabelText("Conversation") as HTMLDivElement;
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => 400 });
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 200 });
    el.scrollTop = 100;
    fireEvent.scroll(el);

    emitInAct({
      type: "tool_execution_start",
      toolCallId: "sub-switch",
      toolName: "subagent",
      args: { agent: "search", task: "find" },
    });
    emitChildHeader("sub-switch", "search", "child-switch");
    await user.click(await screen.findByRole("button", { name: /agent search/i }));
    flushFrame?.(0);

    await waitFor(() => expect(el.scrollTop).toBe(400));
    expect(await screen.findByText("child answer")).toBeTruthy();
  });

  it("jumps on every switch between an already loaded child and the assistant", async () => {
    const user = userEvent.setup();
    let flushFrame: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      flushFrame = callback;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const flushCapturedFrame = () => {
      const callback = flushFrame;
      flushFrame = undefined;
      callback?.(0);
    };
    vi.mocked(api.getSnapshot).mockResolvedValue({
      session: { id: "s1", cwd: "/p", isStreaming: true, status: "running" },
      messages: [
        { role: "user", timestamp: 1000, content: [{ type: "text", text: "parent task" }] },
        { role: "assistant", timestamp: 1001, content: [{ type: "text", text: "parent answer" }] },
      ],
      subagents: [],
    } as never);
    vi.mocked(api.getChildSnapshot).mockResolvedValue({
      session: { id: "child-loaded", cwd: "/p", sessionName: "easyresearch:search" },
      messages: [
        { role: "user", timestamp: 1000, content: [{ type: "text", text: "child task" }] },
        { role: "assistant", timestamp: 1001, content: [{ type: "text", text: "child answer loaded" }] },
      ],
    } as never);
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    expect(await screen.findByText("parent answer")).toBeTruthy();
    const el = screen.getByLabelText("Conversation") as HTMLDivElement;
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => 400 });
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 200 });
    flushCapturedFrame();

    emitInAct({
      type: "tool_execution_start",
      toolCallId: "sub-loaded",
      toolName: "subagent",
      args: { agent: "search", task: "find" },
    });
    emitChildHeader("sub-loaded", "search", "child-loaded");
    await user.click(await screen.findByRole("button", { name: /agent search/i }));
    expect(await screen.findByText("child answer loaded")).toBeTruthy();
    flushCapturedFrame();

    el.scrollTop = 100;
    fireEvent.scroll(el);
    await user.click(screen.getByRole("button", { name: /agent paper assistant/i }));
    flushCapturedFrame();
    expect(el.scrollTop).toBe(400);

    el.scrollTop = 100;
    fireEvent.scroll(el);
    await user.click(screen.getByRole("button", { name: /agent search/i }));
    flushCapturedFrame();
    expect(el.scrollTop).toBe(400);
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
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "tok" },
    });
    emit({
      type: "message_update",
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

  it("does not reconnect the session stream when browser preferences change", async () => {
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    expect(api.connectSessionEvents).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
    });

    await waitFor(() => expect(api.connectSessionEvents).toHaveBeenCalledTimes(1));
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

  it("shows a bounded latest-message preview and auto-collapses an untouched temporary tab", async () => {
    const latestMessage = "scanning arxiv for recent fault-diagnosis papers";
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    const assistantTab = screen.getByRole("button", { name: /agent paper assistant/i });
    expect(assistantTab.getAttribute("aria-pressed")).toBe("true");
    emitInAct({
      type: "tool_execution_start",
      toolCallId: "sub-1",
      toolName: "subagent",
      args: { agent: "search", task: "find papers" },
    });
    const searchTab = await screen.findByRole("button", { name: /agent search/i });
    expect(searchTab.getAttribute("aria-pressed")).toBe("false");
    emitInAct({
      type: "tool_execution_update",
      toolCallId: "sub-1",
      toolName: "subagent",
      args: { agent: "search" },
      partialResult: { details: { subagent: { agent: "search", step: 1, status: "running", latestMessage } } },
    });
    const preview = within(searchTab).getByTitle(latestMessage);
    expect(preview).toHaveClass("max-w-64", "truncate");
    const cardMessage = within(screen.getByLabelText(/conversation/i)).getByText(latestMessage);
    expect(cardMessage.closest("article")).not.toBeNull();
    emitInAct({
      type: "tool_execution_end",
      toolCallId: "sub-1",
      toolName: "subagent",
      result: "done",
      isError: false,
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: /agent search/i })).toBeNull());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /agent paper assistant/i }).getAttribute("aria-pressed")).toBe("true"),
    );
  });

  it("retains a selected temporary tab and promotes it to an exact UUID tab", async () => {
    const user = userEvent.setup();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    emitInAct({
      type: "tool_execution_start",
      toolCallId: "sub-promote",
      toolName: "subagent",
      args: { agent: "search", task: "find" },
    });
    emitInAct({
      type: "tool_execution_update",
      toolCallId: "sub-promote",
      toolName: "subagent",
      partialResult: {
        details: { subagent: { agent: "search", sessionId: "child-promoted", latestMessage: "linked" } },
      },
    });
    await user.click(await screen.findByRole("button", { name: /agent search/i }));
    expect(await screen.findByRole("button", { name: /Close agent tab:/ })).toBeVisible();
    emitInAct({ type: "tool_execution_end", toolCallId: "sub-promote", toolName: "subagent", result: "done" });

    expect(await screen.findByRole("button", { name: /agent search/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Close agent tab:/ })).toBeVisible();
  });

  it("keeps a selected pre-header tab focused when its first header adds step and UUID", async () => {
    const user = userEvent.setup();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    emitInAct({
      type: "tool_execution_start",
      toolCallId: "sub-first-header",
      toolName: "subagent",
      args: { agent: "search", task: "find" },
    });
    const temporary = await screen.findByRole("button", { name: /agent search/i });
    await user.click(temporary);
    expect(temporary).toHaveAttribute("aria-pressed", "true");

    emitChildHeader("sub-first-header", "search", "child-first-header", 1);

    const promoted = await screen.findByRole("button", { name: /agent search/i });
    expect(promoted).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Close agent tab:/ })).toBeVisible();
  });

  it("loads inherited history exactly once when a retained temporary tab receives a delayed UUID", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getChildSnapshot).mockResolvedValue({
      session: { id: "child-delayed", cwd: "/p", sessionName: "easyresearch:search" },
      messages: [{ role: "user", content: [{ type: "text", text: "inherited before this dispatch" }] }],
    } as never);
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    emitInAct({
      type: "tool_execution_start",
      toolCallId: "sub-delayed",
      toolName: "subagent",
      args: { agent: "search", task: "find" },
    });
    await user.click((await screen.findAllByRole("button", { name: "View details" })).at(-1)!);
    expect(api.getChildSnapshot).not.toHaveBeenCalled();

    emitInAct({
      type: "tool_execution_update",
      toolCallId: "sub-delayed",
      toolName: "subagent",
      partialResult: { details: { subagent: { agent: "search", sessionId: "child-delayed" } } },
    });

    expect(await screen.findByText("inherited before this dispatch")).toBeVisible();
    expect(api.getChildSnapshot).toHaveBeenCalledWith("s1", "child-delayed");
    expect(api.getChildSnapshot).toHaveBeenCalledTimes(1);
  });

  it("opens complete child history from View details with child labels and a disabled composer", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getSnapshot).mockResolvedValue({
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready" },
      subagents: [
        { toolCallId: "sub-history", childSessionId: "child-history", agent: "search", latestMessage: "saved result" },
      ],
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "sub-history", name: "subagent", arguments: '{"agent":"search"}' }],
        },
        { role: "toolResult", toolCallId: "sub-history", toolName: "subagent", content: [], isError: false },
      ],
    } as never);
    vi.mocked(api.getChildSnapshot).mockResolvedValue({
      session: { id: "child-history", cwd: "/p", sessionName: "easyresearch:search" },
      messages: [
        { role: "user", content: [{ type: "text", text: "older inherited task" }] },
        { role: "assistant", content: [{ type: "text", text: "complete child answer" }] },
      ],
    } as never);
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "View details" }));

    expect(api.getChildSnapshot).toHaveBeenCalledWith("s1", "child-history");
    expect(await screen.findByText("older inherited task")).toBeVisible();
    expect(screen.getByText("complete child answer")).toBeVisible();
    const conversation = screen.getByLabelText("Conversation");
    expect(conversation).toHaveTextContent("Paper Assistant");
    expect(conversation).toHaveTextContent("Search");
    expect(screen.getByRole("textbox", { name: /message/i })).toBeDisabled();
    expect(within(conversation).queryByRole("button", { name: "View details" })).toBeNull();
  });

  it("reduces nested child deltas and tools in order, then closes without abort and reopens from its card", async () => {
    const user = userEvent.setup();
    let resolveChild!: (value: Awaited<ReturnType<typeof api.getChildSnapshot>>) => void;
    vi.mocked(api.getSnapshot).mockResolvedValue({
      session: { id: "s1", cwd: "/p", isStreaming: true, status: "running" },
      subagents: [{ toolCallId: "sub-live", childSessionId: "child-live", agent: "search" }],
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "sub-live", name: "subagent", arguments: '{"agent":"search"}' }],
        },
      ],
    } as never);
    vi.mocked(api.getChildSnapshot).mockReturnValue(
      new Promise((resolve) => {
        resolveChild = resolve;
      }),
    );
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "View details" }));
    emitChildHeader("sub-live", "search", "child-live");
    emitRawChildEvent("sub-live", "search", {
      type: "message_start",
      message: { id: "cm", role: "assistant", content: [] },
    });
    emitRawChildEvent("sub-live", "search", {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "live " },
    });
    emitRawChildEvent("sub-live", "search", {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "tokens" },
    });
    emitRawChildEvent("sub-live", "search", {
      type: "tool_execution_start",
      toolCallId: "ct",
      toolName: "bash",
      args: { command: "ls" },
    });
    emitRawChildEvent("sub-live", "search", {
      type: "tool_execution_end",
      toolCallId: "ct",
      toolName: "bash",
      result: { output: "done" },
    });
    expect(await screen.findByText("live tokens")).toBeVisible();
    resolveChild({
      session: { id: "child-live", cwd: "/p", sessionName: "easyresearch:search" },
      messages: [{ role: "user", content: [{ type: "text", text: "older task" }] }],
    } as never);
    expect(await screen.findByText("older task")).toBeVisible();
    expect(screen.getByText("live tokens")).toBeVisible();
    const rows = [...screen.getByLabelText("Conversation").querySelectorAll("li")].map((row) => row.textContent ?? "");
    expect(rows.findIndex((row) => row.includes("live tokens"))).toBeLessThan(
      rows.findIndex((row) => row.includes("bash")),
    );

    await user.click(screen.getByRole("button", { name: /Close agent tab:/ }));
    expect(api.abortSession).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "View details" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "View details" }));
    expect(await screen.findByText("live tokens")).toBeVisible();
    expect(api.getChildSnapshot).toHaveBeenCalledTimes(1);
  });

  it("shows duplicate UUID labels and keeps a child 404 inline without losing the parent transcript", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getSnapshot).mockResolvedValue({
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready" },
      subagents: [
        { toolCallId: "sub-one", childSessionId: "11111111-aaaa", agent: "search", latestMessage: "first card" },
        { toolCallId: "sub-two", childSessionId: "22222222-bbbb", agent: "search", latestMessage: "second card" },
      ],
      messages: [
        { role: "user", content: [{ type: "text", text: "parent remains" }] },
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "sub-one", name: "subagent", arguments: '{"agent":"search"}' },
            { type: "toolCall", id: "sub-two", name: "subagent", arguments: '{"agent":"search"}' },
          ],
        },
      ],
    } as never);
    vi.mocked(api.getChildSnapshot).mockRejectedValue(new api.ApiError(404, { error: "missing" }));
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    const details = await screen.findAllByRole("button", { name: "View details" });
    await user.click(details[0]!);
    await user.click(screen.getByRole("button", { name: /agent paper assistant/i }));
    await user.click((await screen.findAllByRole("button", { name: "View details" }))[1]!);
    expect(screen.getByRole("button", { name: /agent search · 11111111/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /agent search · 22222222/i })).toBeVisible();
    expect(await screen.findByText("Child session unavailable.")).toBeVisible();
    expect(screen.getAllByRole("button", { name: /Close agent tab:/ })).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: /agent paper assistant/i }));
    expect(screen.getByText("parent remains")).toBeVisible();
  });

  it("refreshes every open child snapshot when the parent SSE snapshot reconnects", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getSnapshot).mockResolvedValue({
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready" },
      subagents: [{ toolCallId: "sub-refresh", childSessionId: "child-refresh", agent: "search" }],
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "sub-refresh", name: "subagent", arguments: '{"agent":"search"}' }],
        },
      ],
    } as never);
    vi.mocked(api.getChildSnapshot)
      .mockResolvedValueOnce({
        session: { id: "child-refresh", cwd: "/p", sessionName: "easyresearch:search" },
        messages: [{ id: "child-message", role: "assistant", content: [{ type: "text", text: "before reconnect" }] }],
      } as never)
      .mockResolvedValueOnce({
        session: { id: "child-refresh", cwd: "/p", sessionName: "easyresearch:search" },
        messages: [
          { id: "child-message", role: "assistant", content: [{ type: "text", text: "recovered from JSONL" }] },
        ],
      } as never);
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "View details" }));
    expect(await screen.findByText("before reconnect")).toBeVisible();

    emitInAct({
      type: "snapshot",
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready" },
      subagents: [{ toolCallId: "sub-refresh", childSessionId: "child-refresh", agent: "search" }],
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "sub-refresh", name: "subagent", arguments: '{"agent":"search"}' }],
        },
      ],
    });

    expect(await screen.findByText("recovered from JSONL")).toBeVisible();
    expect(api.getChildSnapshot).toHaveBeenCalledTimes(2);
  });

  it("queues one reconnect refresh when the child snapshot is already in flight", async () => {
    const user = userEvent.setup();
    let resolveInitial!: (value: Awaited<ReturnType<typeof api.getChildSnapshot>>) => void;
    vi.mocked(api.getSnapshot).mockResolvedValue({
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready" },
      subagents: [{ toolCallId: "sub-overlap", childSessionId: "child-overlap", agent: "search" }],
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "sub-overlap", name: "subagent", arguments: '{"agent":"search"}' }],
        },
      ],
    } as never);
    vi.mocked(api.getChildSnapshot)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveInitial = resolve;
          }),
      )
      .mockResolvedValueOnce({
        session: { id: "child-overlap", cwd: "/p", sessionName: "easyresearch:search" },
        messages: [
          { id: "child-message", role: "assistant", content: [{ type: "text", text: "recovered after overlap" }] },
        ],
      } as never);
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "View details" }));
    expect(api.getChildSnapshot).toHaveBeenCalledTimes(1);

    emitInAct({
      type: "snapshot",
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready" },
      subagents: [{ toolCallId: "sub-overlap", childSessionId: "child-overlap", agent: "search" }],
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "sub-overlap", name: "subagent", arguments: '{"agent":"search"}' }],
        },
      ],
    });
    act(() =>
      resolveInitial({
        session: { id: "child-overlap", cwd: "/p", sessionName: "easyresearch:search" },
        messages: [
          { id: "child-message", role: "assistant", content: [{ type: "text", text: "stale in-flight response" }] },
        ],
      } as never),
    );

    expect(await screen.findByText("recovered after overlap")).toBeVisible();
    expect(api.getChildSnapshot).toHaveBeenCalledTimes(2);
  });

  it("retries a failed child load after close and reopen without duplicate concurrent requests", async () => {
    const user = userEvent.setup();
    let rejectFirst!: (error: unknown) => void;
    vi.mocked(api.getSnapshot).mockResolvedValue({
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready" },
      subagents: [{ toolCallId: "sub-retry", childSessionId: "child-retry", agent: "search" }],
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "sub-retry", name: "subagent", arguments: '{"agent":"search"}' }],
        },
      ],
    } as never);
    vi.mocked(api.getChildSnapshot)
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockResolvedValueOnce({
        session: { id: "child-retry", cwd: "/p", sessionName: "easyresearch:search" },
        messages: [{ role: "assistant", content: [{ type: "text", text: "retry recovered" }] }],
      } as never);
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    const details = await screen.findByRole("button", { name: "View details" });
    act(() => {
      details.click();
      details.click();
    });
    expect(api.getChildSnapshot).toHaveBeenCalledTimes(1);
    act(() => rejectFirst(new api.ApiError(404, { error: "temporarily missing" })));
    expect(await screen.findByText("Child session unavailable.")).toBeVisible();

    await user.click(screen.getByRole("button", { name: /Close agent tab:/ }));
    await user.click(await screen.findByRole("button", { name: "View details" }));
    expect(await screen.findByText("retry recovered")).toBeVisible();
    expect(api.getChildSnapshot).toHaveBeenCalledTimes(2);
  });

  it("keeps subagent selection and stop as sibling buttons with independent effects", async () => {
    const user = userEvent.setup();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    emitInAct({
      type: "tool_execution_start",
      toolCallId: "sub-2",
      toolName: "subagent",
      args: { agent: "search", task: "find papers" },
    });
    const select = await screen.findByRole("button", { name: /agent search/i });
    const stop = await screen.findByRole("button", { name: /stop agent/i });
    const assistant = screen.getByRole("button", { name: /agent paper assistant/i });
    expect(select.contains(stop)).toBe(false);
    expect(select.parentElement).toBe(stop.parentElement);
    expect(select.parentElement).toHaveClass("rounded-full", "border");

    await user.click(stop);
    await waitFor(() => expect(api.abortSession).toHaveBeenCalledWith("s1"));
    expect(select).toHaveAttribute("aria-pressed", "false");
    expect(assistant).toHaveAttribute("aria-pressed", "true");

    await user.click(select);
    expect(select).toHaveAttribute("aria-pressed", "true");
    expect(assistant).toHaveAttribute("aria-pressed", "false");
  });

  it("keeps a retained chain UUID active while creating and promoting the next step tab", async () => {
    const user = userEvent.setup();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    emitInAct({
      type: "tool_execution_start",
      toolCallId: "chain-1",
      toolName: "subagent",
      args: {
        chain: [
          { agent: "search", task: "find" },
          { agent: "writing", task: "draft" },
        ],
      },
    });
    emitInAct({
      type: "tool_execution_update",
      toolCallId: "chain-1",
      toolName: "subagent",
      partialResult: { details: { subagent: { agent: "search", step: 1, latestMessage: "papers found" } } },
    });

    const searchTab = await screen.findByRole("button", { name: /agent search/i });
    await user.click((await screen.findAllByRole("button", { name: "View details" })).at(-1)!);
    expect(searchTab).toHaveAttribute("aria-pressed", "true");
    const conversation = screen.getByLabelText(/conversation/i);
    expect(within(conversation).queryByText("papers found")).toBeNull();
    emitChildHeader("chain-1", "search", "child-search", 1);
    expect(await screen.findByRole("button", { name: /agent search/i })).toHaveAttribute("aria-pressed", "true");

    emitInAct({
      type: "tool_execution_update",
      toolCallId: "chain-1",
      toolName: "subagent",
      partialResult: { details: { subagent: { agent: "writing", step: 2, latestMessage: "drafting method" } } },
    });

    const writingTab = await screen.findByRole("button", { name: /agent writing/i });
    expect(writingTab).not.toBe(searchTab);
    expect(writingTab).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: /agent search/i })).toHaveAttribute("aria-pressed", "true");
    expect(within(writingTab).getByTitle("drafting method")).toBeVisible();
    expect(within(conversation).queryByText("drafting method")).toBeNull();

    await user.click(writingTab);
    emitChildHeader("chain-1", "writing", "child-writing", 2);
    expect(await screen.findByRole("button", { name: /agent writing/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /agent search/i })).toBeVisible();
  });

  it("opens every historical chain UUID through compact per-step details actions", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getSnapshot).mockResolvedValue({
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready" },
      subagents: [
        { toolCallId: "chain-history", childSessionId: "child-history-search", agent: "search", step: 1 },
        { toolCallId: "chain-history", childSessionId: "child-history-writing", agent: "writing", step: 2 },
      ],
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "chain-history", name: "subagent", arguments: '{"chain":[]}' }],
        },
        { role: "toolResult", toolCallId: "chain-history", toolName: "subagent", content: [], isError: false },
      ],
    } as never);
    vi.mocked(api.getChildSnapshot).mockImplementation(
      async (_parentId, childId) =>
        ({
          session: {
            id: childId,
            cwd: "/p",
            sessionName: childId.endsWith("search") ? "easyresearch:search" : "easyresearch:writing",
          },
          messages: [{ role: "assistant", content: [{ type: "text", text: `history for ${childId}` }] }],
        }) as never,
    );
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);

    await user.click(await screen.findByRole("button", { name: "View details: Step 1" }));
    expect(await screen.findByText("history for child-history-search")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /agent paper assistant/i }));
    await user.click(screen.getByRole("button", { name: "View details: Step 2" }));

    expect(await screen.findByText("history for child-history-writing")).toBeVisible();
    expect(screen.getByRole("button", { name: /agent search/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /agent writing/i })).toBeVisible();
  });

  it("shows truthful settled unmapped copy without an unclosable details tab", async () => {
    vi.mocked(api.getSnapshot).mockResolvedValue({
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready" },
      subagents: [],
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "old-unmapped", name: "subagent", arguments: '{"agent":"search"}' }],
        },
        { role: "toolResult", toolCallId: "old-unmapped", toolName: "subagent", content: [], isError: false },
      ],
    } as never);
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);

    expect(await screen.findByText("No progress was saved before this run ended.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "View details" })).toBeNull();
    expect(screen.queryByRole("button", { name: /agent search/i })).toBeNull();
  });

  it("maps the running chain status to the currently displayed agent name", async () => {
    const user = userEvent.setup();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    emitInAct({
      type: "tool_execution_start",
      toolCallId: "chain-status",
      toolName: "subagent",
      args: {
        chain: [
          { agent: "search", task: "find" },
          { agent: "writing", task: "draft" },
        ],
      },
    });
    emitInAct({
      type: "tool_execution_update",
      toolCallId: "chain-status",
      toolName: "subagent",
      partialResult: { details: { subagent: { agent: "writing", step: 2, latestMessage: "drafting" } } },
    });
    await user.click(screen.getByRole("button", { name: /agent list/i }));
    const region = screen.getByRole("region", { name: /agent list/i });
    const writingCard = (await within(region).findByText(/^Writing agent\./)).closest(".rounded-md");
    const searchCard = within(region)
      .getByText(/^Web research agent\./)
      .closest(".rounded-md");
    expect(writingCard).not.toBeNull();
    expect(searchCard).not.toBeNull();
    expect(within(writingCard as HTMLElement).getByText(/working/i)).toBeTruthy();
    expect(within(searchCard as HTMLElement).getByText(/^idle$/i)).toBeTruthy();
  });

  it("disables the composer on a subagent session line (history browse only)", async () => {
    vi.mocked(api.getSnapshot).mockResolvedValue({
      session: { id: "s3", cwd: "/p", isStreaming: false, status: "ready", sessionName: "easyresearch:search" },
      messages: [{ role: "user", content: [{ type: "text", text: "Task: search" }] }],
    } as never);
    render(<WorkPage id="s3" cwd="/p" onBack={() => {}} />);
    await screen.findByText("Task: search");
    expect(screen.getByText(/history only/i)).toBeTruthy();
    expect(screen.getByRole("textbox", { name: /message/i })).toBeDisabled();
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

  it("routes valid file watcher events to the file browser and ignores out-of-root events", async () => {
    let entries: FileEntryDto[] = [{ kind: "file", name: "notes.md", path: "/p/notes.md" }];
    vi.mocked(api.listEntries).mockImplementation(async () => entries);
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    await screen.findByText("notes.md");

    entries = [...entries, { kind: "file", name: "generated.md", path: "/p/generated.md" }];
    emitInAct({
      type: "file.watcher.updated",
      properties: { file: "/p/generated.md", event: "add" },
    });
    expect(await screen.findByText("generated.md")).toBeVisible();
    const callsAfterValidEvent = vi.mocked(api.listEntries).mock.calls.length;

    emitInAct({
      type: "file.watcher.updated",
      properties: { file: "/outside/generated.md", event: "add" },
    });
    expect(vi.mocked(api.listEntries).mock.calls.length).toBe(callsAfterValidEvent);
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
    emitInAct({
      type: "snapshot",
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready" },
      messages: [{ role: "assistant", content: [{ type: "text", text: "after reconnect" }] }],
    });
    expect(await screen.findByText("after reconnect")).toBeTruthy();
    expect(screen.queryByText("starting research")).toBeNull();
  });

  it("rehydrates a running subagent tab and card, then updates both in place", async () => {
    const latestMessage = "verifying metadata for the selected papers";
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    emitInAct({
      type: "snapshot",
      session: { id: "s1", cwd: "/p", isStreaming: true, status: "running" },
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "sub-reconnect",
              name: "subagent",
              arguments: '{"agent":"search","task":"find papers"}',
            },
          ],
        },
      ],
    });

    const select = await screen.findByRole("button", { name: /agent search/i });
    const conversation = screen.getByLabelText(/conversation/i);
    const waiting = within(conversation).getByText(/waiting for the first progress message/i);
    const card = waiting.closest("article");
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getByText(/running/i)).toBeTruthy();

    emitInAct({
      type: "tool_execution_update",
      toolCallId: "sub-reconnect",
      toolName: "subagent",
      partialResult: { details: { subagent: { agent: "search", step: 1, status: "running", latestMessage } } },
    });

    expect(screen.getByRole("button", { name: /agent search/i })).toBe(select);
    expect(within(select).getByTitle(latestMessage)).toBeTruthy();
    const cardMessage = within(conversation).getByText(latestMessage);
    expect(cardMessage.closest("article")).toBe(card);
  });

  it("keeps usable live chain progress when reconnect completes with whitespace-only failure output", async () => {
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    emitInAct({
      type: "tool_execution_start",
      toolCallId: "sub-failed-reconnect",
      toolName: "subagent",
      args: {
        chain: [
          { agent: "search", task: "find" },
          { agent: "writing", task: "draft" },
        ],
      },
    });
    emitInAct({
      type: "tool_execution_update",
      toolCallId: "sub-failed-reconnect",
      toolName: "subagent",
      partialResult: {
        details: { subagent: { agent: "writing", step: 2, latestMessage: "usable live progress" } },
      },
    });
    const liveCard = within(screen.getByLabelText(/conversation/i))
      .getByText("usable live progress")
      .closest("article");

    emitInAct({
      type: "snapshot",
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready" },
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "sub-failed-reconnect",
              name: "subagent",
              arguments: '{"chain":[{"agent":"search","task":"find"},{"agent":"writing","task":"draft"}]}',
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "sub-failed-reconnect",
          toolName: "subagent",
          content: [{ type: "text", text: " \n\t " }],
          isError: true,
        },
      ],
    });

    const conversation = screen.getByLabelText(/conversation/i);
    const retained = await within(conversation).findByText("usable live progress");
    expect(retained.closest("article")).toBe(liveCard);
    expect(within(liveCard as HTMLElement).getByText("Writing")).toBeTruthy();
    expect(within(liveCard as HTMLElement).getByText("Step 2")).toBeTruthy();
    expect(within(liveCard as HTMLElement).getByText("Failed")).toBeTruthy();
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

  it("does not render a live toolResult message_start as a system bubble", async () => {
    stubEvents();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    emit({
      type: "message_start",
      message: {
        role: "toolResult",
        toolCallId: "t1",
        toolName: "bash",
        content: [{ type: "text", text: "duplicated bash output" }],
        isError: false,
      },
    });
    emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } });
    emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: {}, isError: false });
    const conversation = screen.getByLabelText(/conversation/i);
    await within(conversation).findByText("bash");
    expect(within(conversation).queryByText("duplicated bash output")).toBeNull();
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
    emit({
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "bash",
      result: { output: "file.txt\nnotes.md" },
      isError: false,
    });
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
    await waitFor(() =>
      expect(screen.getByRole("region", { name: /file browser/i }).getAttribute("style")).toMatch(/--panel-w:\s*600px/),
    );
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
    await waitFor(() =>
      expect(screen.getByRole("region", { name: /file browser/i }).getAttribute("style")).toMatch(/--panel-w:\s*600px/),
    );
    const handle = screen.getByRole("button", { name: /resize panel/i });
    const row = screen.getByText("starting research").closest("section")?.parentElement;
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
    observer!.__fire(1600);
    await waitFor(() => expect(panel.getAttribute("style")).toMatch(/--panel-w:\s*660px/));
  });

  it("never lets the drag shrink the panel below one third of the screen", async () => {
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    const RO = (globalThis as unknown as { FakeResizeObserver: typeof ResizeObserver }).FakeResizeObserver;
    const observer = (RO as unknown as { instances: { __fire: (n: number) => void }[] }).instances.at(-1);
    observer!.__fire(1200);
    await waitFor(() =>
      expect(screen.getByRole("region", { name: /file browser/i }).getAttribute("style")).toMatch(/--panel-w:\s*600px/),
    );
    const handle = screen.getByRole("button", { name: /resize panel/i });
    const row = screen.getByText("starting research").closest("section")?.parentElement;
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

  it("renders the full five-agent roster in the agents view", async () => {
    const user = userEvent.setup();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    await user.click(screen.getByRole("button", { name: /agent list/i }));
    const region = screen.getByRole("region", { name: /agent list/i });
    await waitFor(() => {
      for (const display of ["Paper Assistant", "Search", "Experiment", "Writing", "Figures"]) {
        expect(within(region).getAllByText(display).length).toBeGreaterThan(0);
      }
    });
  });

  it("agent cards show localized descriptions and no Subagents rows", async () => {
    const user = userEvent.setup();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    await user.click(screen.getByRole("button", { name: /agent list/i }));
    const region = screen.getByRole("region", { name: /agent list/i });
    expect(await within(region).findByText(/Paper Assistant for the paper pipeline/)).toBeTruthy();
    expect(within(region).getByText(/Experiment agent/)).toBeTruthy();
    expect(within(region).queryByText("Subagents")).toBeNull();
    expect(within(region).queryByText("search, figures")).toBeNull();
  });

  it("keeps the Paper Assistant card when the agents endpoint fails", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listAgents).mockRejectedValue(new Error("boom"));
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    await user.click(screen.getByRole("button", { name: /agent list/i }));
    const region = screen.getByRole("region", { name: /agent list/i });
    expect(await within(region).findByText("Paper Assistant")).toBeTruthy();
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

  it("keeps the transcript without a session-ended notice on session_deactivated", async () => {
    stubEvents();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    emitInAct({ type: "session_deactivated", sessionId: "s1" });
    expect(screen.queryByText(/session ended/i)).toBeNull();
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
    vi.mocked(api.getSnapshot)
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValue({
        session: { id: "s2", cwd: "/p", isStreaming: false, status: "ready" },
        messages: [{ role: "user", content: [{ type: "text", text: "continue please" }] }],
      } as never);
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    await user.type(screen.getByRole("textbox", { name: /message/i }), "continue please");
    await user.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(api.openSession).toHaveBeenCalledWith("/agent/sessions/--p--/a.jsonl"));
    await waitFor(() => expect(api.connectSessionEvents).toHaveBeenCalledTimes(2));
    expect(api.connectSessionEvents).toHaveBeenNthCalledWith(1, "s1", expect.anything());
    expect(api.connectSessionEvents).toHaveBeenNthCalledWith(2, "s2", expect.anything());
    expect(unsubscribeFn).toHaveBeenCalledTimes(1);
    emitInAct({
      type: "snapshot",
      session: { id: "s2", cwd: "/p", isStreaming: false, status: "ready" },
      messages: [{ role: "user", content: [{ type: "text", text: "continue please" }] }],
      subagents: [],
    });
    await waitFor(() => expect(api.sendPrompt).toHaveBeenCalledTimes(2));
    expect(api.sendPrompt).toHaveBeenLastCalledWith("s2", "continue please");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(await screen.findByText("continue please")).toBeTruthy();
  });

  it("waits for the reopened SSE subscription before sending the prompt", async () => {
    const user = userEvent.setup();
    let connections = 0;
    let secondSendConnections = 0;
    vi.mocked(api.connectSessionEvents).mockImplementation((_id, handlers) => {
      connections += 1;
      latestHandlers = handlers;
      if (connections === 2) {
        handlers.onEvent({
          type: "snapshot",
          session: { id: "s2", cwd: "/p", isStreaming: false, status: "ready" },
          messages: [{ role: "user", content: [{ type: "text", text: "continue please" }] }],
          subagents: [],
        });
      }
      return vi.fn();
    });
    vi.mocked(api.sendPrompt)
      .mockRejectedValueOnce(new api.ApiError(404, { error: "Unknown session: s1" }))
      .mockImplementationOnce(async () => {
        secondSendConnections = connections;
      });
    vi.mocked(api.openSession).mockResolvedValueOnce({
      id: "s2",
      cwd: "/p",
      sessionFile: "/agent/sessions/--p--/a.jsonl",
      isStreaming: false,
      status: "ready",
    } as never);
    vi.mocked(api.getSnapshot)
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValue({
        session: { id: "s2", cwd: "/p", isStreaming: false, status: "ready" },
        messages: [{ role: "user", content: [{ type: "text", text: "continue please" }] }],
        subagents: [],
      } as never);

    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} />);
    await screen.findByText("starting research");
    await user.type(screen.getByRole("textbox", { name: /message/i }), "continue please");
    await user.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => expect(api.sendPrompt).toHaveBeenCalledTimes(2));
    expect(secondSendConnections).toBe(2);
    expect(await screen.findByText("continue please")).toBeVisible();
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
    vi.mocked(api.getSnapshot)
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValue({
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
    emitInAct({
      type: "snapshot",
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready" },
      messages: [{ role: "user", content: [{ type: "text", text: "continue please" }] }],
      subagents: [],
    });
    await waitFor(() => expect(api.sendPrompt).toHaveBeenCalledTimes(2));
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
