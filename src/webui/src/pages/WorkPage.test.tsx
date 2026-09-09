import { act, fireEvent, render as renderWithTestingLibrary, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ComponentProps, createRef, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileEntryDto, SubagentSessionSummaryDto, SubagentSupervisorEventDto } from "../../../web/contracts";
import * as api from "../api";
import { I18nProvider } from "../i18n/I18nProvider";
import { STORAGE_KEY } from "../preferences";
import { PreferencesProvider } from "../preferences/PreferencesProvider";
import { hydrateTranscript, observerFor } from "../testing/transcriptTest";
import { WorkPage } from "./WorkPage";

const fileQueueProbe = vi.hoisted(() => ({ pending: 0 }));

vi.mock("../components/FileBrowser", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../components/FileBrowser")>();
  return {
    ...actual,
    FileBrowser: (props: ComponentProps<typeof actual.FileBrowser>) => {
      fileQueueProbe.pending = props.fileEvents?.length ?? 0;
      return <actual.FileBrowser {...props} />;
    },
  };
});

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
    patchAgent: vi.fn(),
    getSessionCommands: vi.fn().mockResolvedValue([]),
    getSessionTree: vi.fn().mockResolvedValue({
      tree: [],
      leafId: null,
      filterMode: "default",
      skipBranchSummaryPrompt: false,
    }),
    navigateSessionTree: vi.fn().mockResolvedValue(undefined),
    compactSession: vi.fn(),
    getApiUsageSettings: vi.fn(),
    getApiUsageStatistics: vi.fn(),
    renameSession: vi.fn(),
  };
});

const snapshotMessages = [
  { role: "user", content: [{ type: "text", text: "write a paper" }] },
  { role: "assistant", content: [{ type: "text", text: "starting research" }] },
];
const snapshotValue = {
  session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready", sessionFile: "/agent/sessions/--p--/a.jsonl" },
  timeline: snapshotMessages.map((message, index) => ({ kind: "message", entryId: `snapshot-${index}`, message })),
};
const snapshot = snapshotValue as never;

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
  if (event && typeof event === "object" && (event as { type?: unknown }).type === "snapshot") {
    const value = event as Record<string, unknown>;
    const messages = Array.isArray(value.messages) ? value.messages : undefined;
    latestHandlers?.onEvent({
      runtimeConfigurationGeneration: 0,
      compactionPolicy: { triggerPercent: 70, enabled: true },
      ...value,
      ...(value.timeline === undefined && messages !== undefined
        ? {
            timeline: messages.map((message, index) => ({
              kind: "message",
              entryId:
                message && typeof message === "object" && typeof (message as { id?: unknown }).id === "string"
                  ? (message as { id: string }).id
                  : `event-${index}`,
              message,
            })),
          }
        : {}),
    });
    return;
  }
  latestHandlers?.onEvent(event);
}

function emitInAct(event: unknown) {
  act(() => emit(event));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function dragTransfer() {
  const values = new Map<string, string>();
  return {
    effectAllowed: "uninitialized",
    dropEffect: "none",
    protected: false,
    get types() {
      return [...values.keys()];
    },
    setData(type: string, value: string) {
      values.set(type, value);
    },
    getData(type: string) {
      return this.protected ? "" : (values.get(type) ?? "");
    },
  };
}

function supervisorEvent(
  overrides: Partial<SubagentSupervisorEventDto> & Pick<SubagentSupervisorEventDto, "toolCallId">,
): SubagentSupervisorEventDto {
  const agent = overrides.agent ?? "search";
  return {
    type: "subagent_supervisor",
    launchId: `launch-${overrides.toolCallId}`,
    ownerSessionId: "s1",
    agent,
    agentId: `${agent}_${overrides.toolCallId}`,
    childSessionId: `child-${overrides.toolCallId}`,
    status: "working",
    ...overrides,
  };
}

function emitSupervisor(
  overrides: Partial<SubagentSupervisorEventDto> & Pick<SubagentSupervisorEventDto, "toolCallId">,
) {
  emitInAct(supervisorEvent(overrides));
}

function emitSupervisorChildEvent(
  overrides: Partial<SubagentSupervisorEventDto> &
    Pick<SubagentSupervisorEventDto, "toolCallId" | "childSessionId"> & { event: unknown },
) {
  emitSupervisor({ ...overrides, event: overrides.event as SubagentSupervisorEventDto["event"] });
}

function subagentSummary(
  toolCallId: string,
  childSessionId: string,
  agent = "search",
  overrides: Partial<SubagentSessionSummaryDto> = {},
): SubagentSessionSummaryDto {
  return {
    ownerSessionId: "s1",
    toolCallId,
    childSessionId,
    agent,
    agentId: `${agent}_${toolCallId}`,
    launchId: `launch-${toolCallId}`,
    status: "complete" as const,
    ...overrides,
  };
}

function normalizeTimelineSnapshot<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  const snapshot = value as Record<string, unknown>;
  if (Array.isArray(snapshot.timeline) || !Array.isArray(snapshot.messages)) return value;
  return {
    ...snapshot,
    timeline: snapshot.messages.map((message, index) => ({
      kind: "message",
      entryId:
        message && typeof message === "object" && typeof (message as { id?: unknown }).id === "string"
          ? (message as { id: string }).id
          : message && typeof message === "object" && (message as { timestamp?: unknown }).timestamp !== undefined
            ? `${typeof (message as { role?: unknown }).role === "string" ? (message as { role: string }).role : "message"}:${String((message as { timestamp: unknown }).timestamp)}`
            : `snapshot:${index}`,
      message,
    })),
  } as T;
}

function normalizeSnapshotMock(mock: ReturnType<typeof vi.fn>) {
  const implementation = mock.getMockImplementation() as ((...args: unknown[]) => unknown) | undefined;
  if (!implementation) return;
  mock.mockImplementation(async (...args: unknown[]) => normalizeTimelineSnapshot(await implementation(...args)));
}

function render(ui: ReactElement) {
  normalizeSnapshotMock(vi.mocked(api.getSnapshot) as ReturnType<typeof vi.fn>);
  normalizeSnapshotMock(vi.mocked(api.getChildSnapshot) as ReturnType<typeof vi.fn>);
  const result = renderWithTestingLibrary(ui, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <PreferencesProvider>
        <I18nProvider>{children}</I18nProvider>
      </PreferencesProvider>
    ),
  });
  hydrateTranscript(result.container);
  return result;
}

function panelObserver(panel = screen.getByRole("region", { name: /file browser/i })) {
  const observer = observerFor(panel.parentElement as HTMLElement);
  expect(observer).toBeTruthy();
  return observer as unknown as { __fire: (n: number) => void };
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
    vi.mocked(api.patchAgent).mockReset();
    vi.mocked(api.getSessionCommands).mockReset();
    vi.mocked(api.getSessionCommands).mockResolvedValue([
      { name: "name", description: "Rename the current session", source: "extension" },
      { name: "history", description: "Browse the current session tree", source: "extension" },
      { name: "compact", description: "Compact the current session context", source: "extension" },
      { name: "statistics", description: "Show API usage statistics", source: "extension" },
    ]);
    vi.mocked(api.getSessionTree).mockReset();
    vi.mocked(api.getSessionTree).mockResolvedValue({
      tree: [],
      leafId: null,
      filterMode: "default",
      skipBranchSummaryPrompt: false,
    });
    vi.mocked(api.navigateSessionTree).mockReset();
    vi.mocked(api.navigateSessionTree).mockResolvedValue({ cancelled: false, leafId: null });
    vi.mocked(api.compactSession).mockReset();
    vi.mocked(api.compactSession).mockResolvedValue({ state: "running" });
    vi.mocked(api.getApiUsageSettings).mockReset().mockResolvedValue({ showApiUsageDetails: false });
    vi.mocked(api.getApiUsageStatistics)
      .mockReset()
      .mockResolvedValue({
        rootSessionId: "s1",
        total: {
          records: 0,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cacheWrite1h: 0,
          reasoning: 0,
          totalTokens: 0,
          cacheHitRate: null,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        sessions: [],
        partial: false,
        warnings: [],
      });
    vi.mocked(api.listAgents).mockResolvedValue([
      {
        name: "research-assistant",
        description: "Runs the pipeline",
        enabled: true,
        builtin: true,
        source: "bundled",
        filePath: "research-assistant.md",
        model: "openai/gpt-4o",
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
        model: "anthropic/claude",
        thinking: "high",
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
      {
        name: "review",
        description: "Reviews source artifacts",
        enabled: true,
        builtin: true,
        source: "bundled",
        filePath: "review.md",
        effectiveTools: [],
        effectiveSkills: [],
        missingSkills: [],
        subagents: ["search"],
      },
    ]);
    vi.mocked(api.listModels).mockResolvedValue([
      {
        provider: "openai",
        id: "gpt-4o",
        reasoning: true,
        thinkingLevelMap: {},
        available: true,
        authRequired: false,
      },
      {
        provider: "anthropic",
        id: "claude",
        reasoning: false,
        thinkingLevelMap: {},
        available: true,
        authRequired: false,
      },
    ]);
    vi.mocked(api.patchAgent).mockImplementation(async (name, patch) => ({
      name,
      description: name === "search" ? "Finds papers" : "Agent",
      enabled: true,
      builtin: true,
      source: "global",
      filePath: `/agent/agents/${name}.md`,
      ...(patch.model ? { model: patch.model } : {}),
      ...(patch.thinking ? { thinking: patch.thinking } : {}),
      effectiveTools: [],
      effectiveSkills: [],
      missingSkills: [],
    }));
    vi.mocked(api.renameSession).mockReset();
    vi.mocked(api.renameSession).mockResolvedValue(undefined);
    vi.mocked(api.getSnapshot).mockResolvedValue(snapshot);
    vi.mocked(api.getChildSnapshot).mockResolvedValue({
      session: { id: "child-default", cwd: "/p", sessionName: "easyresearch:search" },
      timeline: [],
      subagents: [],
    });
    vi.mocked(api.listEntries).mockResolvedValue([{ kind: "file", name: "notes.md", path: "/p/notes.md" }]);
    stubEvents();
  });

  it.each([
    {
      cwd: "/p",
      path: "/p/notes.md",
      filtered: false,
      target: "transcript",
      draft: "",
      start: 0,
      end: 0,
      expected: "/p/notes.md ",
      streaming: false,
    },
    {
      cwd: "/p",
      path: "/p/notes.md",
      filtered: true,
      target: "input",
      draft: "Read OLD please",
      start: 5,
      end: 8,
      expected: "Read /p/notes.md please",
      streaming: false,
    },
    {
      cwd: String.raw`D:\papers`,
      path: String.raw`D:\papers\paper notes.md`,
      filtered: false,
      target: "transcript",
      draft: "Readthis",
      start: 4,
      end: 4,
      expected: String.raw`Read D:\papers\paper notes.md this`,
      streaming: false,
    },
    {
      cwd: "/p",
      path: "/p/notes.md",
      filtered: false,
      target: "input",
      draft: "Read\n",
      start: 5,
      end: 5,
      expected: "Read\n/p/notes.md ",
      streaming: true,
    },
  ])(
    "inserts a tree path into $target (filtered=$filtered, cwd=$cwd, streaming=$streaming) without reading or sending",
    async ({ cwd, path, filtered, target, draft, start, end, expected, streaming }) => {
      const user = userEvent.setup();
      vi.mocked(api.listEntries).mockResolvedValue([{ kind: "file", name: "notes.md", path }]);
      vi.mocked(api.getSnapshot).mockResolvedValue({
        ...snapshotValue,
        session: { ...snapshotValue.session, cwd, isStreaming: streaming, status: streaming ? "running" : "ready" },
      } as never);
      render(<WorkPage id="s1" cwd={cwd} onBack={() => {}} onOpenSettings={() => {}} />);
      await screen.findByText("starting research");
      const input = screen.getByRole("textbox", { name: /message/i }) as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: draft } });
      input.focus();
      input.setSelectionRange(start, end);
      fireEvent.select(input);
      if (filtered) {
        const filter = within(screen.getByRole("region", { name: /file browser/i })).getByRole("textbox", {
          name: "Filter files",
        });
        expect(filter).toBeVisible();
        expect(filter).toBeEnabled();
        await user.click(filter);
        fireEvent.change(filter, { target: { value: "notes" } });
      }
      const file = await screen.findByRole("treeitem", { name: /notes.md/ });
      expect(file).toHaveAttribute("draggable", "true");
      const dataTransfer = dragTransfer();
      fireEvent.dragStart(file, { dataTransfer });
      const surface = target === "input" ? input : screen.getByLabelText("Conversation");
      dataTransfer.protected = true;
      fireEvent.dragEnter(surface, { dataTransfer });
      expect(fireEvent.dragOver(surface, { dataTransfer })).toBe(false);
      expect(screen.getByText("Drop to insert file path")).toBeVisible();
      dataTransfer.protected = false;
      fireEvent.drop(surface, { dataTransfer });
      expect(input.value).toBe(expected);
      await waitFor(() => expect(input).toHaveFocus());
      expect(input.selectionStart).toBe(
        expected.indexOf(path) + path.length + (draft.slice(end).startsWith(" ") ? 0 : 1),
      );
      expect(input.selectionEnd).toBe(input.selectionStart);
      expect(screen.queryByText("Drop to insert file path")).toBeNull();
      expect(api.sendPrompt).not.toHaveBeenCalled();
      expect(api.readFileContent).not.toHaveBeenCalled();
      fireEvent.dragStart(file, { dataTransfer });
      fireEvent.drop(surface, { dataTransfer });
      expect(input.value.match(/notes\.md/g)).toHaveLength(2);
    },
  );

  it("clears drag feedback on nested leave, cancellation, and leaving the chat", async () => {
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    const file = await screen.findByRole("treeitem", { name: /notes.md/ });
    const chat = screen.getByRole("tabpanel", { name: /^chat$/i });
    const input = screen.getByRole("textbox", { name: /message/i });
    const dataTransfer = dragTransfer();
    fireEvent.dragStart(file, { dataTransfer });
    fireEvent.dragEnter(chat, { dataTransfer });
    fireEvent.dragEnter(input, { dataTransfer });
    fireEvent.dragLeave(chat, { dataTransfer });
    expect(screen.getByText("Drop to insert file path")).toBeVisible();
    fireEvent.dragLeave(input, { dataTransfer });
    expect(screen.queryByText("Drop to insert file path")).toBeNull();
    fireEvent.dragEnter(chat, { dataTransfer });
    fireEvent.dragEnd(file, { dataTransfer });
    expect(screen.queryByText("Drop to insert file path")).toBeNull();
    expect(input).toHaveValue("");
  });

  it("rejects directories and external file drops without navigating or changing the draft", async () => {
    vi.mocked(api.listEntries).mockResolvedValue([{ kind: "directory", name: "papers", path: "/p/papers" }]);
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    const directory = await screen.findByRole("treeitem", { name: /papers/ });
    expect(directory).not.toHaveAttribute("draggable", "true");
    const dataTransfer = dragTransfer();
    fireEvent.dragStart(directory, { dataTransfer });
    expect(dataTransfer.types).toEqual([]);
    dataTransfer.setData("Files", "external.pdf");
    const input = screen.getByRole("textbox", { name: /message/i });
    fireEvent.change(input, { target: { value: "keep draft" } });
    expect(fireEvent.drop(input, { dataTransfer })).toBe(false);
    expect(input).toHaveValue("keep draft");
    expect(screen.queryByText("Drop to insert file path")).toBeNull();
  });

  it("rejects a drop if prompt acceptance disables the composer during the drag", async () => {
    const user = userEvent.setup();
    const pending = deferred<void>();
    vi.mocked(api.sendPrompt).mockReturnValue(pending.promise);
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    const file = await screen.findByRole("treeitem", { name: /notes.md/ });
    const input = screen.getByRole("textbox", { name: /message/i });
    await user.type(input, "send this");
    const dataTransfer = dragTransfer();
    fireEvent.dragStart(file, { dataTransfer });
    fireEvent.dragEnter(input, { dataTransfer });
    expect(screen.getByText("Drop to insert file path")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(input).toBeDisabled();
    expect(screen.queryByText("Drop to insert file path")).toBeNull();
    fireEvent.drop(input, { dataTransfer });
    expect(input).toHaveValue("");
    await act(async () => pending.resolve());
  });

  it.each(["malformed", "foreign-root", "outside-root"])("rejects a %s internal path payload", async (mode) => {
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    const file = await screen.findByRole("treeitem", { name: /notes.md/ });
    const dataTransfer = dragTransfer();
    fireEvent.dragStart(file, { dataTransfer });
    expect(dataTransfer.types.length).toBeGreaterThan(0);
    const type = dataTransfer.types[0]!;
    const payload = JSON.parse(dataTransfer.getData(type));
    dataTransfer.setData(
      type,
      mode === "malformed"
        ? "not json"
        : JSON.stringify({
            ...payload,
            ...(mode === "foreign-root" ? { root: "/other" } : { path: "/p/../other/notes.md" }),
          }),
    );
    const input = screen.getByRole("textbox", { name: /message/i });
    fireEvent.drop(input, { dataTransfer });
    expect(input).toHaveValue("");
    expect(api.sendPrompt).not.toHaveBeenCalled();
  });

  it("keeps Home first and places the workspace 4px below the topbar", async () => {
    const onBack = vi.fn();
    const user = userEvent.setup();
    render(<WorkPage id="s1" cwd="/p" onBack={onBack} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");

    const home = screen.getByRole("button", { name: /back to home/i });
    expect(home).not.toHaveAttribute("aria-current");
    await user.click(home);
    expect(onBack).toHaveBeenCalledOnce();
    const conversation = screen.getByRole("tabpanel", { name: /^chat$/i });
    expect(conversation.parentElement).toHaveClass("px-2", "pb-2", "pt-[4px]");
    expect(conversation).not.toHaveClass("v2-work-enter");
    expect(conversation.parentElement).not.toHaveClass("p-2");
  });

  it("shows only the Windows project directory name in the mobile topbar", async () => {
    vi.stubGlobal("innerWidth", 390);
    const cwd = String.raw`D:\papers\fault-study`;
    render(<WorkPage id="s1" cwd={cwd} onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");

    expect(screen.getByTitle(cwd)).toHaveTextContent("fault-study");
    expect(screen.getByTitle(cwd)).not.toHaveTextContent(cwd);
  });

  it("opens the rename dialog with typed /name arguments and saves through the rename endpoint", async () => {
    stubEvents();
    const user = userEvent.setup();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");

    const input = screen.getByRole("textbox", { name: /message/i });
    await user.type(input, "/name Paper v2{Enter}");

    const nameInput = await screen.findByRole("textbox", { name: /session name/i });
    expect(nameInput).toHaveValue("Paper v2");
    expect(api.sendPrompt).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(api.renameSession).toHaveBeenCalledWith("s1", "Paper v2"));
    expect(screen.queryByRole("dialog", { name: /rename session/i })).toBeNull();
  });

  it("opens rename immediately when autocomplete selects /name", async () => {
    const user = userEvent.setup();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");

    const input = screen.getByRole("textbox", { name: /message/i });
    await user.type(input, "/na{Enter}");

    expect(await screen.findByRole("dialog", { name: /rename session/i })).toBeVisible();
    expect(api.sendPrompt).not.toHaveBeenCalled();
  });

  it("opens /statistics without sending model-visible slash text", async () => {
    const user = userEvent.setup();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");

    const input = screen.getByRole("textbox", { name: /message/i });
    await user.type(input, "/statistics{Enter}");

    expect(await screen.findByRole("dialog", { name: /api usage statistics/i })).toBeVisible();
    expect(api.getApiUsageStatistics).toHaveBeenCalledWith("s1");
    expect(api.sendPrompt).not.toHaveBeenCalled();
  });

  it("applies the daemon-owned API usage visibility setting to the Work transcript", async () => {
    vi.mocked(api.getApiUsageSettings).mockResolvedValue({ showApiUsageDetails: true });
    const usage = {
      input: 5,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 7,
      cacheHitRate: 0,
      cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.2 },
    };
    vi.mocked(api.getSnapshot).mockResolvedValue({
      ...snapshotValue,
      timeline: [
        { kind: "message", entryId: "user-entry", message: snapshotMessages[0] },
        { kind: "message", entryId: "assistant-entry", message: snapshotMessages[1] },
      ],
      inlineUsage: [
        {
          id: "assistant-entry",
          sessionId: "s1",
          source: "assistant",
          timestamp: "2026-08-25T00:00:00.000Z",
          anchor: { kind: "message", messageEntryId: "assistant-entry" },
          provider: "openai",
          model: "test-model",
          usage,
        },
      ],
    } as never);

    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);

    expect(await screen.findByLabelText("API usage details")).toHaveTextContent("test-model");
    expect(api.getApiUsageSettings).toHaveBeenCalled();
  });

  it("renders a persisted compaction disclosure from the root snapshot timeline", async () => {
    vi.mocked(api.getSnapshot).mockResolvedValue({
      ...snapshotValue,
      timeline: [
        {
          kind: "message",
          entryId: "user-1",
          message: snapshotMessages[0],
        },
        {
          kind: "message",
          entryId: "assistant-1",
          message: snapshotMessages[1],
        },
        {
          kind: "compaction",
          entryId: "compact-1",
          timestamp: "2026-09-01T00:00:00.000Z",
          summary: "Persisted compacted context",
        },
      ],
    } as never);

    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);

    expect(await screen.findByRole("button", { name: "Session compacted" })).toHaveAttribute("aria-expanded", "false");
  });

  it("renders persisted compaction disclosures in retained child tabs", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getSnapshot).mockResolvedValue({
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready" },
      subagents: [subagentSummary("child-tool", "child-compacted")],
      timeline: [
        {
          kind: "message",
          entryId: "parent-tool-call",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "child-tool", name: "subagent", arguments: '{"agent":"search"}' }],
          },
        },
      ],
    } as never);
    vi.mocked(api.getChildSnapshot).mockResolvedValue({
      session: { id: "child-compacted", cwd: "/p", sessionName: "easyresearch:search" },
      timeline: [
        {
          kind: "message",
          entryId: "child-answer",
          message: { role: "assistant", content: [{ type: "text", text: "child answer" }] },
        },
        {
          kind: "compaction",
          entryId: "child-compaction",
          timestamp: "2026-09-01T00:00:00.000Z",
          summary: "Child compressed context",
        },
      ],
      subagents: [],
    } as never);
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);

    await user.click(await screen.findByRole("button", { name: "View details" }));

    expect(await screen.findByText("child answer")).toBeVisible();
    expect(screen.getByRole("button", { name: "Session compacted" })).toHaveAttribute("aria-expanded", "false");
  });

  it("refetches commands only for increasing root-applied generations and rebases on a lower reconnect snapshot", async () => {
    const initialSnapshot = deferred<Awaited<ReturnType<typeof api.getSnapshot>>>();
    vi.mocked(api.getSnapshot).mockReturnValue(initialSnapshot.promise);
    const snapshotWithGeneration = {
      ...snapshotValue,
      messages: [],
      runtimeConfigurationGeneration: 4,
      compactionPolicy: { triggerPercent: 70, enabled: true },
      compactionState: "idle",
      subagents: [],
    } as never;
    const view = renderWithTestingLibrary(
      <WorkPage id="s1" cwd="/p" configurationGeneration={1} onBack={() => {}} onOpenSettings={() => {}} />,
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <PreferencesProvider>
            <I18nProvider>{children}</I18nProvider>
          </PreferencesProvider>
        ),
      },
    );

    const commandCallsBeforeSnapshot = vi.mocked(api.getSessionCommands).mock.calls.length;
    await act(async () => {
      initialSnapshot.resolve(snapshotWithGeneration);
      await initialSnapshot.promise;
    });
    await waitFor(() => expect(api.getSessionCommands).toHaveBeenCalledTimes(commandCallsBeforeSnapshot + 1));
    expect(commandCallsBeforeSnapshot).toBe(0);
    expect(api.getSessionCommands).toHaveBeenCalledOnce();
    vi.mocked(api.getSessionCommands).mockClear();

    view.rerender(
      <WorkPage id="s1" cwd="/p" configurationGeneration={2} onBack={() => {}} onOpenSettings={() => {}} />,
    );
    await act(async () => {});
    expect(api.getSessionCommands).not.toHaveBeenCalled();

    emitInAct({ type: "runtime_configuration_applied", generation: 5 });
    await waitFor(() => expect(api.getSessionCommands).toHaveBeenCalledTimes(1));
    emitInAct({ type: "runtime_configuration_applied", generation: 5 });
    emitInAct({ type: "runtime_configuration_applied", generation: 3 });
    expect(api.getSessionCommands).toHaveBeenCalledTimes(1);

    emitInAct({
      type: "snapshot",
      runtimeConfigurationGeneration: 2,
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready" },
      messages: snapshotMessages,
      subagents: [],
    });
    await act(async () => {});
    expect(api.getSessionCommands).toHaveBeenCalledTimes(1);

    emitInAct({ type: "runtime_configuration_applied", generation: 3 });
    await waitFor(() => expect(api.getSessionCommands).toHaveBeenCalledTimes(2));
  });

  it("clears newer commands and invalidates their in-flight response on a lower authoritative snapshot", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getSnapshot).mockResolvedValue({
      ...snapshotValue,
      runtimeConfigurationGeneration: 4,
      compactionPolicy: { triggerPercent: 70, enabled: true },
      compactionState: "idle",
      subagents: [],
    } as never);
    const newerResponse = deferred<Awaited<ReturnType<typeof api.getSessionCommands>>>();
    vi.mocked(api.getSessionCommands)
      .mockReset()
      .mockResolvedValueOnce([{ name: "newer-skill", description: "Newer", source: "skill" }])
      .mockReturnValueOnce(newerResponse.promise);
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");
    await waitFor(() => expect(api.getSessionCommands).toHaveBeenCalledOnce());

    const input = screen.getByRole("textbox", { name: /message/i });
    await user.type(input, "/");
    expect(await screen.findByRole("option", { name: /newer-skill/ })).toBeVisible();

    emitInAct({ type: "runtime_configuration_applied", generation: 5 });
    await waitFor(() => expect(api.getSessionCommands).toHaveBeenCalledTimes(2));
    emitInAct({
      type: "snapshot",
      runtimeConfigurationGeneration: 2,
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready" },
      messages: snapshotMessages,
      subagents: [],
    });

    await waitFor(() => expect(screen.queryByRole("option", { name: /newer-skill/ })).toBeNull());
    await act(async () => {
      newerResponse.resolve([{ name: "stale-newer-skill", description: "Stale", source: "skill" }]);
      await newerResponse.promise;
    });
    expect(screen.queryByRole("option", { name: /stale-newer-skill/ })).toBeNull();
  });

  it("keeps newer applied-generation command data when an older request resolves last", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getSnapshot).mockResolvedValue({
      ...snapshotValue,
      runtimeConfigurationGeneration: 0,
      compactionPolicy: { triggerPercent: 70, enabled: true },
      compactionState: "idle",
      subagents: [],
    } as never);
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");
    await waitFor(() => expect(api.getSessionCommands).toHaveBeenCalledOnce());
    const stale = deferred<Awaited<ReturnType<typeof api.getSessionCommands>>>();
    vi.mocked(api.getSessionCommands)
      .mockReset()
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce([{ name: "fresh-skill", description: "Fresh", source: "skill" }]);

    emitInAct({ type: "runtime_configuration_applied", generation: 1 });
    await waitFor(() => expect(api.getSessionCommands).toHaveBeenCalledOnce());
    emitInAct({ type: "runtime_configuration_applied", generation: 2 });
    await waitFor(() => expect(api.getSessionCommands).toHaveBeenCalledTimes(2));

    const input = screen.getByRole("textbox", { name: /message/i });
    await user.type(input, "/");
    expect(await screen.findByRole("option", { name: /fresh-skill/ })).toBeVisible();

    await act(async () => {
      stale.resolve([{ name: "stale-skill", description: "Stale", source: "skill" }]);
      await stale.promise;
    });
    expect(screen.getByRole("option", { name: /fresh-skill/ })).toBeVisible();
    expect(screen.queryByRole("option", { name: /stale-skill/ })).toBeNull();
  });

  it("opens /history, navigates with the keyboard, and restores Pi editor text", async () => {
    vi.mocked(api.getSessionTree).mockResolvedValue({
      leafId: "a2",
      filterMode: "default",
      skipBranchSummaryPrompt: false,
      tree: [
        { id: "u1", parentId: null, role: "user", kind: "user", text: "Original question" },
        { id: "a1", parentId: "u1", role: "assistant", kind: "assistant", text: "First answer" },
        { id: "u2", parentId: "a1", role: "user", kind: "user", text: "Current branch" },
        { id: "a2", parentId: "u2", role: "assistant", kind: "assistant", text: "Current answer" },
      ],
    });
    vi.mocked(api.navigateSessionTree).mockResolvedValue({
      cancelled: false,
      editorText: "Original question",
      leafId: null,
    });
    const user = userEvent.setup();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");

    const input = screen.getByRole("textbox", { name: /message/i });
    await user.type(input, "/his{Enter}");

    const history = await screen.findByRole("dialog", { name: /history/i });
    const tree = within(history).getByRole("tree");
    const filter = within(history).getByRole("combobox", { name: /history filter/i });
    expect(filter).toHaveValue("user-only");
    expect(
      within(tree)
        .getAllByRole("treeitem")
        .map((item) => item.textContent),
    ).toEqual([expect.stringContaining("Original question"), expect.stringContaining("Current branch")]);

    await user.selectOptions(filter, "messages");
    expect(
      within(tree)
        .getAllByRole("treeitem")
        .map((item) => item.textContent),
    ).toEqual([
      expect.stringContaining("Original question"),
      expect.stringContaining("First answer"),
      expect.stringContaining("Current branch"),
      expect.stringContaining("Current answer"),
    ]);

    within(tree).getAllByRole("treeitem")[0]?.focus();
    await user.keyboard("{Enter}");
    const summaryDialog = await screen.findByRole("dialog", { name: /summarize branch/i });
    await user.click(within(summaryDialog).getByRole("button", { name: /no summary/i }));

    await waitFor(() => expect(api.navigateSessionTree).toHaveBeenCalledWith("s1", "u1", { summarize: false }));
    await waitFor(() => expect(input).toHaveValue("Original question"));
    expect(screen.queryByRole("dialog", { name: /^history$/i })).toBeNull();
    expect(api.sendPrompt).not.toHaveBeenCalled();
  });

  it("requests typed /compact instructions without sending slash text to the model", async () => {
    vi.mocked(api.compactSession).mockResolvedValue({ state: "queued" });
    const user = userEvent.setup();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");

    await user.type(screen.getByRole("textbox", { name: /message/i }), "/compact Keep experiment decisions{Enter}");

    await waitFor(() => expect(api.compactSession).toHaveBeenCalledWith("s1", "Keep experiment decisions"));
    expect(api.sendPrompt).not.toHaveBeenCalled();
  });

  it.each([
    { accepted: "queued", latest: "running", failed: false },
    { accepted: "running", latest: "idle", failed: false },
    { accepted: "queued", latest: "idle", failed: true },
  ] as const)(
    "keeps newer compaction SSE state $latest after a late $accepted acknowledgement (failed=$failed)",
    async ({ accepted, latest, failed }) => {
      const user = userEvent.setup();
      const pending = deferred<Awaited<ReturnType<typeof api.compactSession>>>();
      vi.mocked(api.compactSession).mockReturnValueOnce(pending.promise);
      vi.mocked(api.getSnapshot).mockResolvedValue({
        ...snapshotValue,
        contextUsage: { tokens: 40_000, contextWindow: 100_000, percent: 40 },
      } as never);
      vi.mocked(api.getSessionTree).mockResolvedValue({
        tree: [
          { id: "u1", parentId: null, role: "user", kind: "user", text: "Original question" },
          { id: "a1", parentId: "u1", role: "assistant", kind: "assistant", text: "Current answer" },
        ],
        leafId: "a1",
        filterMode: "default",
        skipBranchSummaryPrompt: true,
      });
      render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
      await screen.findByText("starting research");
      const input = screen.getByRole("textbox", { name: "Message" });
      fireEvent.change(input, { target: { value: "/compact" } });
      await user.click(screen.getByRole("button", { name: "Send" }));
      expect(api.compactSession).toHaveBeenCalledOnce();

      emitInAct({ type: "compaction_state_changed", state: "running" });
      if (failed) emitInAct({ type: "compaction_end", errorMessage: "Summary failed" });
      emitInAct({ type: "compaction_state_changed", state: latest });
      await act(async () => pending.resolve({ state: accepted }));
      emitInAct({ type: "agent_settled" });
      const capacity = screen.getByRole("progressbar", { name: /context capacity/i });
      if (latest === "running") {
        expect(capacity).toHaveAttribute("aria-valuetext", expect.stringMatching(/Compacting/i));
      } else {
        expect(capacity).not.toHaveAttribute("aria-valuetext", expect.stringMatching(/Compacting|Queued/i));
      }
      if (failed) expect(screen.getByRole("alert")).toHaveTextContent("Summary failed");
      fireEvent.change(input, { target: { value: "/history" } });
      await user.click(screen.getByRole("button", { name: "Send" }));
      const history = await screen.findByRole("dialog", { name: /^history$/i });
      const entry = within(history).getByRole("treeitem");
      if (latest === "running") {
        expect(entry).toHaveAttribute("aria-disabled", "true");
        await user.click(entry);
        expect(api.navigateSessionTree).not.toHaveBeenCalled();
      } else {
        expect(entry).not.toHaveAttribute("aria-disabled", "true");
        await user.click(entry);
        await waitFor(() => expect(api.navigateSessionTree).toHaveBeenCalledWith("s1", "u1", { summarize: false }));
      }
      expect(api.sendPrompt).not.toHaveBeenCalled();
    },
  );

  it("clears a rejected command notice when the next normal message is sent", async () => {
    vi.mocked(api.compactSession).mockRejectedValueOnce(new Error("Nothing to compact"));
    const user = userEvent.setup();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");
    const input = screen.getByRole("textbox", { name: /message/i });

    await user.type(input, "/compact{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Nothing to compact");

    await user.type(input, "continue{Enter}");
    await waitFor(() => expect(api.sendPrompt).toHaveBeenCalledWith("s1", "continue"));
    expect(screen.queryByText("Nothing to compact")).toBeNull();
  });

  it("shows neutral native context capacity and the accepted policy in the Agent header", async () => {
    vi.mocked(api.getSnapshot).mockResolvedValue({
      ...snapshotValue,
      contextUsage: { tokens: 91_000, contextWindow: 100_000, percent: 91 },
      compactionState: "queued",
      compactionPolicy: { triggerPercent: 75, enabled: true },
    } as never);
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);

    const capacity = await screen.findByRole("progressbar", { name: /context capacity/i });

    expect(capacity).toHaveAttribute("aria-valuenow", "91");
    expect(capacity).toHaveAttribute("aria-valuetext", expect.stringMatching(/91k \/ 100k.*91%.*75%.*queued/i));
    expect(capacity.closest("[data-context-severity]")).toBeNull();
    expect(screen.queryByText("91%")).toBeNull();
    expect(screen.getByText("91k / 100k")).toBeInTheDocument();
    expect(capacity.closest("[data-agent-tab-trailing]")).toBeTruthy();
  });

  it("keeps history browseable but disables navigation during native compaction", async () => {
    vi.mocked(api.getSnapshot).mockResolvedValue({
      ...snapshotValue,
      compactionState: "running",
    } as never);
    vi.mocked(api.getSessionTree).mockResolvedValue({
      tree: [
        { id: "u1", parentId: null, role: "user", kind: "user", text: "Original question" },
        { id: "a1", parentId: "u1", role: "assistant", kind: "assistant", text: "Current answer" },
      ],
      leafId: "a1",
      filterMode: "default",
      skipBranchSummaryPrompt: true,
    });
    const user = userEvent.setup();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");

    await user.type(screen.getByRole("textbox", { name: /message/i }), "/history{Enter}");

    const history = await screen.findByRole("dialog", { name: /^history$/i });
    expect(within(history).getAllByRole("treeitem")[0]).toHaveAttribute("aria-disabled", "true");
    await user.keyboard("{Home}{Enter}");
    expect(api.navigateSessionTree).not.toHaveBeenCalled();
  });

  it("hides context capacity on read-only child tabs", async () => {
    vi.mocked(api.getSnapshot).mockResolvedValue({
      ...snapshotValue,
      contextUsage: { tokens: 40_000, contextWindow: 100_000, percent: 40 },
      compactionState: "idle",
    } as never);
    const user = userEvent.setup();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    expect(await screen.findByRole("progressbar", { name: /context capacity/i })).toBeVisible();
    emitInAct({
      type: "tool_execution_start",
      toolCallId: "sub-capacity",
      toolName: "subagent",
      args: { agent: "search", task: "find papers" },
    });

    await user.click(await screen.findByRole("button", { name: /agent search/i }));

    expect(screen.queryByRole("progressbar", { name: /context capacity/i })).toBeNull();
  });

  it("shows the session name in the topbar and updates it live on session_info_changed", async () => {
    stubEvents();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");

    emitInAct({ type: "session_info_changed", name: "My Paper" });
    expect(screen.getByTitle("My Paper")).toBeTruthy();

    emitInAct({ type: "session_info_changed", name: undefined });
    expect(screen.queryByTitle("My Paper")).toBeNull();
  });

  it("opens settings from the topbar settings button", async () => {
    const onOpenSettings = vi.fn();
    const settingsButtonRef = createRef<HTMLButtonElement>();
    const user = userEvent.setup();
    render(
      <WorkPage
        id="s1"
        cwd="/p"
        onBack={() => {}}
        onOpenSettings={onOpenSettings}
        settingsButtonRef={settingsButtonRef}
      />,
    );
    await screen.findByText("starting research");

    const settingsButton = screen.getByRole("button", { name: "Settings" });
    expect(settingsButtonRef.current).toBe(settingsButton);
    await user.click(settingsButton);
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("renders snapshot messages before live events", async () => {
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
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

    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);

    const conversation = await screen.findByLabelText("Conversation");
    const reasoningButtons = within(conversation).getAllByRole("button", { name: /thinking process/i });
    expect(reasoningButtons).toHaveLength(2);
    for (const button of reasoningButtons) {
      expect(button.closest("li")?.querySelector("div.v2-md")).toBeNull();
    }
  });

  it("sends nonblank text via sendPrompt and keeps the user message visible", async () => {
    const user = userEvent.setup();
    stubEvents();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
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
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");
    await user.type(screen.getByRole("textbox", { name: /message/i }), "   ");
    await user.click(screen.getByRole("button", { name: /send/i }));
    expect(api.sendPrompt).not.toHaveBeenCalled();
  });

  it("renders a working agent row on send and replaces it with the first real output", async () => {
    const user = userEvent.setup();
    stubEvents();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");
    const input = screen.getByRole("textbox", { name: /message/i });
    expect(input).toBeVisible();
    expect(input).toBeEnabled();
    fireEvent.change(input, { target: { value: "continue please" } });
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
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");
    const input = screen.getByRole("textbox", { name: /message/i });
    expect(input).toBeVisible();
    expect(input).toBeEnabled();
    fireEvent.change(input, { target: { value: "inspect files" } });
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
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");
    const el = screen.getByLabelText("Conversation") as HTMLDivElement;
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => 400 });
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 200 });
    el.scrollTop = 100;
    fireEvent.scroll(el);

    const input = screen.getByRole("textbox", { name: /message/i });
    expect(input).toBeVisible();
    expect(input).toBeEnabled();
    fireEvent.change(input, { target: { value: "continue please" } });
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
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");
    const el = screen.getByLabelText("Conversation") as HTMLDivElement;
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => 400 });
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 200 });
    flushCapturedFrame();

    el.scrollTop = 100;
    fireEvent.scroll(el);
    const input = screen.getByRole("textbox", { name: /message/i });
    expect(input).toBeVisible();
    expect(input).toBeEnabled();
    fireEvent.change(input, { target: { value: "first prompt" } });
    await user.click(screen.getByRole("button", { name: /send/i }));
    flushCapturedFrame();
    expect(el.scrollTop).toBe(400);

    el.scrollTop = 100;
    fireEvent.scroll(el);
    expect(input).toBeVisible();
    expect(input).toBeEnabled();
    fireEvent.change(input, { target: { value: "second prompt" } });
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
      subagents: [],
    } as never);
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
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
    emitSupervisor({
      toolCallId: "sub-switch",
      agent: "search",
      agentId: "search_0",
      childSessionId: "child-switch",
    });
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
      subagents: [],
    } as never);
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    expect(await screen.findByText("parent answer")).toBeTruthy();
    const tabs = within(screen.getByTestId("agent-tab-group"));
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
    emitSupervisor({
      toolCallId: "sub-loaded",
      agent: "search",
      agentId: "search_0",
      childSessionId: "child-loaded",
    });
    await user.click(await tabs.findByRole("button", { name: /agent search/i }));
    expect(await screen.findByText("child answer loaded")).toBeTruthy();
    flushCapturedFrame();

    el.scrollTop = 100;
    fireEvent.scroll(el);
    await user.click(tabs.getByRole("button", { name: /agent research assistant/i }));
    flushCapturedFrame();
    expect(el.scrollTop).toBe(400);

    el.scrollTop = 100;
    fireEvent.scroll(el);
    await user.click(tabs.getByRole("button", { name: /agent search/i }));
    flushCapturedFrame();
    expect(el.scrollTop).toBe(400);
  });

  it("clears the working agent row when the send fails", async () => {
    const user = userEvent.setup();
    stubEvents();
    vi.mocked(api.sendPrompt).mockRejectedValue(new Error("boom"));
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");
    const input = screen.getByRole("textbox", { name: /message/i });
    expect(input).toBeVisible();
    expect(input).toBeEnabled();
    fireEvent.change(input, { target: { value: "continue please" } });
    await user.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(screen.queryByLabelText("Working")).toBeNull());
    expect(screen.getByText("boom")).toBeTruthy();
  });

  it("streams message_update deltas into a single assistant row", async () => {
    stubEvents();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
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
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");
    emit({
      type: "message_start",
      message: { role: "assistant", id: "m2", content: [], errorMessage: "provider auth failed" },
    });
    expect(await screen.findByText(/provider auth failed/)).toBeTruthy();
    expect(screen.queryByText(/auth failed/i)).toBeTruthy();
  });

  it("unmount only closes EventSource, never stops the session", async () => {
    const { unmount } = render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");
    unmount();
    expect(unsubscribeFn).toHaveBeenCalled();
    expect(api.stopSession).not.toHaveBeenCalled();
  });

  it("does not reconnect the session stream when browser preferences change", async () => {
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");
    expect(api.connectSessionEvents).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
    });

    await waitFor(() => expect(api.connectSessionEvents).toHaveBeenCalledTimes(1));
  });

  it("composer Stop aborts each run without stopping the connected session", async () => {
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");
    expect(screen.queryByRole("button", { name: /stop/i })).toBeNull();
    emitInAct({ type: "agent_start" });
    await screen.findByRole("button", { name: /stop/i });
    await userEvent.setup().click(screen.getByRole("button", { name: /stop/i }));
    await waitFor(() => expect(api.abortSession).toHaveBeenCalledWith("s1"));
    expect(api.stopSession).not.toHaveBeenCalled();

    emitInAct({ type: "agent_settled" });
    emitInAct({ type: "agent_start" });
    await userEvent.setup().click(await screen.findByRole("button", { name: /stop/i }));
    await waitFor(() => expect(api.abortSession).toHaveBeenCalledTimes(2));
    expect(api.stopSession).not.toHaveBeenCalled();
  });

  it("shows a bounded latest-message preview and auto-collapses an untouched temporary tab", async () => {
    const latestMessage = "scanning arxiv for recent fault-diagnosis papers";
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");
    const assistantTab = screen.getByRole("button", { name: /agent research assistant/i });
    expect(assistantTab.getAttribute("aria-pressed")).toBe("true");
    emitInAct({
      type: "tool_execution_start",
      toolCallId: "sub-1",
      toolName: "subagent",
      args: { agent: "search", task: "find papers" },
    });
    const searchTab = await screen.findByRole("button", { name: /agent search/i });
    expect(searchTab.getAttribute("aria-pressed")).toBe("false");
    emitSupervisor({
      toolCallId: "sub-1",
      agent: "search",
      agentId: "search_0",
      childSessionId: "child-sub-1",
      latestMessage,
    });
    // The tab bar shows only the agent id (no running preview), while the
    // transcript card still surfaces the latest message.
    const preview = within(searchTab).queryByTitle(latestMessage);
    expect(preview).toBeNull();
    const cardMessage = within(screen.getByLabelText(/conversation/i)).getByText(latestMessage);
    expect(cardMessage.closest("article")).not.toBeNull();
    emitSupervisor({
      toolCallId: "sub-1",
      agent: "search",
      agentId: "search_0",
      childSessionId: "child-sub-1",
      status: "complete",
      latestMessage: "done",
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: /agent search/i })).toBeNull());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /agent research assistant/i }).getAttribute("aria-pressed")).toBe(
        "true",
      ),
    );
  });

  it("retains a selected temporary tab and promotes it to an exact UUID tab", async () => {
    const user = userEvent.setup();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");
    const tabs = within(screen.getByTestId("agent-tab-group"));
    emitInAct({
      type: "tool_execution_start",
      toolCallId: "sub-promote",
      toolName: "subagent",
      args: { agent: "search", task: "find" },
    });
    emitSupervisor({
      toolCallId: "sub-promote",
      agent: "search",
      agentId: "search_0",
      childSessionId: "child-promoted",
      latestMessage: "linked",
    });
    await user.click(await tabs.findByRole("button", { name: /agent search/i }));
    expect(await tabs.findByRole("button", { name: /Stop and close agent:/ })).toBeVisible();
    emitSupervisor({
      toolCallId: "sub-promote",
      agent: "search",
      agentId: "search_0",
      childSessionId: "child-promoted",
      status: "complete",
      latestMessage: "done",
    });

    expect(await tabs.findByRole("button", { name: /agent search/i })).toHaveAttribute("aria-pressed", "true");
    expect(tabs.getByRole("button", { name: /Close agent tab:/ })).toBeVisible();
  });

  it("keeps a selected temporary tab focused when its supervisor frame promotes the UUID", async () => {
    const user = userEvent.setup();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
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
    expect(temporary).toHaveFocus();

    emitSupervisor({
      toolCallId: "sub-first-header",
      agent: "search",
      agentId: "search_0",
      childSessionId: "child-first-header",
    });

    const promoted = await screen.findByRole("button", { name: /agent search/i });
    expect(promoted).toHaveAttribute("aria-pressed", "true");
    expect(promoted).toHaveFocus();
    expect(screen.getByRole("button", { name: /Stop and close agent:/ })).toBeVisible();
  });

  it("renders mapped live child output in a retained temporary tab after its tool row disappears", async () => {
    const user = userEvent.setup();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");
    emitInAct({
      type: "tool_execution_start",
      toolCallId: "sub-mapped-temp",
      toolName: "subagent",
      args: { agent: "search", task: "find" },
    });
    await user.click(await screen.findByRole("button", { name: /agent search/i }));

    emitInAct({
      type: "snapshot",
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready" },
      messages: [],
      subagents: [],
    });
    expect(screen.getByRole("button", { name: /agent search/i })).toHaveAttribute("aria-pressed", "true");

    emitSupervisorChildEvent({
      toolCallId: "sub-mapped-temp",
      agent: "search",
      agentId: "search_0",
      childSessionId: "child-mapped-temp",
      event: {
        type: "message_start",
        message: { role: "assistant", content: [{ type: "text", text: "live output after reconnect" }] },
      } as never,
    });

    expect(await screen.findByText("live output after reconnect")).toBeVisible();
  });

  it("loads inherited history exactly once when a retained temporary tab receives a delayed UUID", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getChildSnapshot).mockResolvedValue({
      session: { id: "child-delayed", cwd: "/p", sessionName: "easyresearch:search" },
      messages: [{ role: "user", content: [{ type: "text", text: "inherited before this dispatch" }] }],
      subagents: [],
    } as never);
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");
    emitInAct({
      type: "tool_execution_start",
      toolCallId: "sub-delayed",
      toolName: "subagent",
      args: { agent: "search", task: "find" },
    });
    await user.click((await screen.findAllByRole("button", { name: "View details" })).at(-1)!);
    expect(api.getChildSnapshot).not.toHaveBeenCalled();

    emitSupervisor({
      toolCallId: "sub-delayed",
      agent: "search",
      agentId: "search_0",
      childSessionId: "child-delayed",
    });

    expect(await screen.findByText("inherited before this dispatch")).toBeVisible();
    expect(api.getChildSnapshot).toHaveBeenCalledWith("s1", "child-delayed");
    expect(api.getChildSnapshot).toHaveBeenCalledTimes(1);
  });

  it("opens complete child history from View details with child labels and a disabled composer", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getSnapshot).mockResolvedValue({
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready" },
      subagents: [subagentSummary("sub-history", "child-history", "search", { latestMessage: "saved result" })],
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
      subagents: [],
    } as never);
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "View details" }));

    expect(api.getChildSnapshot).toHaveBeenCalledWith("s1", "child-history");
    expect(await screen.findByText("older inherited task")).toBeVisible();
    expect(screen.getByText("complete child answer")).toBeVisible();
    const conversation = screen.getByLabelText("Conversation");
    expect(conversation).toHaveTextContent("Research Assistant");
    expect(conversation).toHaveTextContent("Search");
    expect(screen.getByRole("textbox", { name: /message/i })).toBeDisabled();
    const dataTransfer = dragTransfer();
    fireEvent.dragStart(await screen.findByRole("treeitem", { name: /notes.md/ }), { dataTransfer });
    fireEvent.dragEnter(conversation, { dataTransfer });
    fireEvent.drop(screen.getByRole("textbox", { name: /message/i }), { dataTransfer });
    expect(screen.getByRole("textbox", { name: /message/i })).toHaveValue("");
    expect(screen.queryByText("Drop to insert file path")).toBeNull();
    expect(within(conversation).queryByRole("button", { name: "View details" })).toBeNull();
  });

  it("reduces nested child deltas and tools in order, then stops and closes before reopening from its card", async () => {
    const user = userEvent.setup();
    let resolveChild!: (value: Awaited<ReturnType<typeof api.getChildSnapshot>>) => void;
    vi.mocked(api.getSnapshot).mockResolvedValue({
      session: { id: "s1", cwd: "/p", isStreaming: true, status: "running" },
      subagents: [
        {
          ownerSessionId: "s1",
          toolCallId: "sub-live",
          childSessionId: "child-live",
          agent: "search",
          agentId: "search_0",
          launchId: "launch-live",
          status: "working",
        },
      ],
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
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    const conversation = within(screen.getByLabelText("Conversation"));
    const tabs = within(screen.getByTestId("agent-tab-group"));
    await user.click(await conversation.findByRole("button", { name: "View details" }));
    emitSupervisorChildEvent({
      toolCallId: "sub-live",
      agent: "search",
      agentId: "search_0",
      childSessionId: "child-live",
      event: {
        type: "message_start",
        message: { role: "assistant", content: [], timestamp: 100 },
      } as never,
    });
    emitSupervisorChildEvent({
      toolCallId: "sub-live",
      agent: "search",
      agentId: "search_0",
      childSessionId: "child-live",
      event: {
        type: "message_update",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "live " },
      },
    });
    emitSupervisorChildEvent({
      toolCallId: "sub-live",
      agent: "search",
      agentId: "search_0",
      childSessionId: "child-live",
      event: {
        type: "message_update",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "tokens" },
      },
    });
    emitSupervisorChildEvent({
      toolCallId: "sub-live",
      agent: "search",
      agentId: "search_0",
      childSessionId: "child-live",
      event: { type: "tool_execution_start", toolCallId: "ct", toolName: "bash", args: { command: "ls" } },
    });
    emitSupervisorChildEvent({
      toolCallId: "sub-live",
      agent: "search",
      agentId: "search_0",
      childSessionId: "child-live",
      event: {
        type: "tool_execution_end",
        toolCallId: "ct",
        toolName: "bash",
        result: { output: "done" },
        isError: false,
      },
    });
    expect(await screen.findByText("live tokens")).toBeVisible();
    act(() =>
      resolveChild({
        session: { id: "child-live", cwd: "/p", sessionName: "easyresearch:search" },
        messages: [{ role: "user", content: [{ type: "text", text: "older task" }] }],
        subagents: [],
      } as never),
    );
    expect(tabs.getByRole("button", { name: "Agent search_0" })).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByText("older task")).toBeVisible();
    expect(screen.getByText("live tokens")).toBeVisible();
    const rows = [...screen.getByLabelText("Conversation").querySelectorAll("li")].map((row) => row.textContent ?? "");
    expect(rows.findIndex((row) => row.includes("live tokens"))).toBeLessThan(
      rows.findIndex((row) => row.includes("bash")),
    );

    await user.click(tabs.getByRole("button", { name: /Stop and close agent:/ }));
    await waitFor(() => expect(api.abortSession).toHaveBeenCalledWith("s1"));
    expect(await conversation.findByRole("button", { name: "View details" })).toBeVisible();
    await user.click(conversation.getByRole("button", { name: "View details" }));
    expect(await screen.findByText("live tokens")).toBeVisible();
    expect(api.getChildSnapshot).toHaveBeenCalledTimes(1);
  });

  it("hydrates direct child subagents and routes nested envelopes and Pi events to their exact views", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getSnapshot).mockResolvedValue({
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready" },
      subagents: [
        subagentSummary("root-writing", "child-writing", "writing", {
          agentId: "writing_0",
          latestMessage: "writing complete",
        }),
      ],
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "root-writing", name: "subagent", arguments: '{"agent":"writing"}' }],
        },
      ],
    } as never);
    vi.mocked(api.getChildSnapshot).mockImplementation(async (_parentId, childId) => {
      if (childId === "child-writing") {
        return {
          session: { id: childId, cwd: "/p", sessionName: "easyresearch:writing" },
          messages: [
            {
              role: "assistant",
              content: [{ type: "toolCall", id: "nested-shared", name: "subagent", arguments: '{"agent":"search"}' }],
            },
          ],
          subagents: [
            subagentSummary("nested-shared", "grandchild-search", "search", {
              ownerSessionId: "child-writing",
              agentId: "search_nested",
              status: "working",
              latestMessage: "nested working",
            }),
          ],
        } as never;
      }
      return {
        session: { id: childId, cwd: "/p", sessionName: "easyresearch:search" },
        messages: [],
        subagents: [],
      } as never;
    });
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    const tabs = within(screen.getByTestId("agent-tab-group"));

    await user.click(
      await within(screen.getByLabelText("Conversation")).findByRole("button", { name: "View details" }),
    );
    const nestedCard = (await screen.findByText("nested working")).closest("article");
    expect(nestedCard).not.toBeNull();
    expect(within(nestedCard as HTMLElement).getByText("Running…")).toBeVisible();

    await user.click(await tabs.findByRole("button", { name: "Agent search_nested" }));
    await waitFor(() => expect(api.getChildSnapshot).toHaveBeenCalledWith("s1", "grandchild-search"));
    await user.click(tabs.getByRole("button", { name: "Agent writing_0" }));

    emitSupervisor({
      ownerSessionId: "child-writing",
      toolCallId: "nested-shared",
      launchId: "launch-nested",
      agent: "search",
      agentId: "search_nested",
      childSessionId: "grandchild-search",
      status: "working",
      latestMessage: "nested still working",
      event: {
        type: "message_start",
        message: { role: "assistant", content: [{ type: "text", text: "grandchild live" }] },
      } as never,
    });

    await user.click(tabs.getByRole("button", { name: "Agent search_nested" }));
    expect(await screen.findByText("grandchild live")).toBeVisible();
    await user.click(tabs.getByRole("button", { name: "Agent writing_0" }));

    emitSupervisor({
      ownerSessionId: "child-writing",
      toolCallId: "nested-shared",
      launchId: "launch-nested",
      agent: "search",
      agentId: "search_nested",
      childSessionId: "grandchild-search",
      status: "error",
      latestMessage: "nested failed",
    });

    const failedNestedCard = (await screen.findByText("nested failed")).closest("article");
    expect(failedNestedCard).not.toBeNull();
    expect(within(failedNestedCard as HTMLElement).getByText("Failed")).toBeVisible();
    expect(tabs.getByRole("button", { name: "Agent search_nested" })).toHaveTextContent("Error");
    await user.click(tabs.getByRole("button", { name: /agent research assistant/i }));
    const rootCard = screen.getByText("writing complete").closest("article");
    expect(within(rootCard as HTMLElement).getByText("Completed")).toBeVisible();
    expect(within(rootCard as HTMLElement).queryByText("nested failed")).toBeNull();
  });

  it.each([
    { ownerLoaded: true, batched: false },
    { ownerLoaded: false, batched: false },
    { ownerLoaded: true, batched: true },
    { ownerLoaded: false, batched: true },
  ])(
    "starts nested card thinking fresh across reconnect (owner loaded=$ownerLoaded, batched=$batched)",
    async ({ ownerLoaded, batched }) => {
      const user = userEvent.setup();
      const writing = subagentSummary("root-writing", "child-writing", "writing", {
        agentId: "writing_0",
        status: "working",
      });
      const search = subagentSummary("nested-search", "grandchild-search", "search", {
        ownerSessionId: "child-writing",
        agentId: "search_nested",
        status: "working",
        latestMessage: "previous answer",
      });
      const parent = {
        session: { id: "s1", cwd: "/p", isStreaming: false, status: "running" },
        subagents: ownerLoaded ? [writing, search] : [writing],
        messages: [
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "root-writing", name: "subagent", arguments: { agent: "writing" } }],
          },
        ],
      };
      const child = normalizeTimelineSnapshot({
        session: { id: "child-writing", cwd: "/p", sessionName: "easyresearch:writing" },
        subagents: [search],
        messages: [
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "nested-search", name: "subagent", arguments: { agent: "search" } }],
          },
        ],
      });
      const pending = deferred<Awaited<ReturnType<typeof api.getChildSnapshot>>>();
      const initial = deferred<Awaited<ReturnType<typeof api.getChildSnapshot>>>();
      const refreshed = { ...child, subagents: [{ ...search, latestMessage: "newer answer" }] };
      vi.mocked(api.getSnapshot).mockResolvedValue(parent as never);
      vi.mocked(api.getChildSnapshot)
        .mockReturnValueOnce(ownerLoaded ? Promise.resolve(child as never) : initial.promise)
        .mockReturnValueOnce(pending.promise);
      render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
      await user.click(await screen.findByRole("button", { name: "View details" }));
      if (ownerLoaded) expect(await screen.findByText("previous answer")).toBeVisible();
      else await waitFor(() => expect(api.getChildSnapshot).toHaveBeenCalledTimes(1));
      const delta = (text: string) =>
        emitSupervisor({
          ...search,
          event: {
            type: "message_update",
            assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: text },
          } as never,
        });
      const reconnect = {
        type: "snapshot",
        ...parent,
        subagents: [writing, { ...search, latestMessage: "newer answer" }],
      };
      if (batched) {
        act(() => {
          delta("discarded prefix");
          delta("Old thought");
          emit(reconnect);
        });
      } else {
        delta("Old thought");
        if (ownerLoaded) expect(await screen.findByText("Old thought")).toBeVisible();
        emitInAct(reconnect);
      }
      if (!ownerLoaded) {
        await act(async () =>
          initial.resolve(normalizeTimelineSnapshot({ session: child.session, subagents: [], messages: [] }) as never),
        );
      }
      await waitFor(() => expect(api.getChildSnapshot).toHaveBeenCalledTimes(2));
      if (!ownerLoaded) await act(async () => pending.resolve(refreshed as never));
      expect(screen.queryByText("Old thought")).toBeNull();
      expect(screen.getByText("newer answer")).toBeVisible();
      delta("New suffix");
      expect(await screen.findByText("New suffix")).toBeVisible();
      if (ownerLoaded) await act(async () => pending.resolve(refreshed as never));
      expect(screen.getByText("New suffix")).toBeVisible();
      expect(screen.queryByText(/Old thought/)).toBeNull();
      expect(screen.getByRole("textbox", { name: "Message" })).toBeDisabled();
    },
  );

  it("replays a nested terminal frame that arrives before its owner snapshot", async () => {
    const user = userEvent.setup();
    let resolveOwner!: (value: Awaited<ReturnType<typeof api.getChildSnapshot>>) => void;
    vi.mocked(api.getSnapshot).mockResolvedValue({
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready" },
      subagents: [subagentSummary("root-writing", "child-writing", "writing", { agentId: "writing_0" })],
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "root-writing", name: "subagent", arguments: '{"agent":"writing"}' }],
        },
      ],
    } as never);
    vi.mocked(api.getChildSnapshot).mockReturnValue(
      new Promise((resolve) => {
        resolveOwner = resolve;
      }),
    );
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "View details" }));

    emitSupervisor({
      ownerSessionId: "child-writing",
      toolCallId: "nested-search",
      launchId: "launch-nested",
      agent: "search",
      agentId: "search_0",
      childSessionId: "grandchild-search",
      status: "error",
      latestMessage: "failed before hydration",
    });
    act(() =>
      resolveOwner({
        session: { id: "child-writing", cwd: "/p", sessionName: "easyresearch:writing" },
        messages: [
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "nested-search", name: "subagent", arguments: '{"agent":"search"}' }],
          },
        ],
        subagents: [
          subagentSummary("nested-search", "grandchild-search", "search", {
            ownerSessionId: "child-writing",
            agentId: "search_0",
            status: "working",
            latestMessage: "stale persisted progress",
          }),
        ],
      } as never),
    );

    const failedCard = (await screen.findByText("failed before hydration")).closest("article");
    expect(failedCard).not.toBeNull();
    expect(within(failedCard as HTMLElement).getByText("Failed")).toBeVisible();
  });

  it("shows unique same-role Agent ids and keeps a child 404 inline without losing the parent transcript", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getSnapshot).mockResolvedValue({
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready" },
      subagents: [
        subagentSummary("sub-one", "11111111-aaaa", "search", {
          agentId: "search_0",
          latestMessage: "first card",
        }),
        subagentSummary("sub-two", "22222222-bbbb", "search", {
          agentId: "search_1",
          latestMessage: "second card",
        }),
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
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    const details = await screen.findAllByRole("button", { name: "View details" });
    await user.click(details[0]!);
    await user.click(screen.getByRole("button", { name: /agent research assistant/i }));
    await user.click((await screen.findAllByRole("button", { name: "View details" }))[1]!);
    expect(screen.getByRole("button", { name: "Agent search_0" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Agent search_1" })).toBeVisible();
    expect(await screen.findByText("Child session unavailable.")).toBeVisible();
    expect(screen.getAllByRole("button", { name: /Close agent tab:/ })).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: /agent research assistant/i }));
    expect(screen.getByText("parent remains")).toBeVisible();
  });

  it.each(["before-delta", "during-delta", "at-termination", "overlapping-final"])(
    "streams a retained Working child without a message start when reconnect history resolves %s",
    async (historyTiming) => {
      const user = userEvent.setup();
      const parent = {
        session: { id: "s1", cwd: "/p", isStreaming: false, status: "running" },
        subagents: [subagentSummary("sub-cursor", "child-cursor", "search", { status: "working" })],
        messages: [
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "sub-cursor", name: "subagent", arguments: { agent: "search" } }],
          },
        ],
      };
      const child = normalizeTimelineSnapshot({
        session: { id: "child-cursor", cwd: "/p", sessionName: "easyresearch:search" },
        subagents: [],
        messages: [
          { id: "dispatch", role: "user", content: "Find papers" },
          { id: "prior-answer", role: "assistant", content: "Previous complete answer" },
          ...(historyTiming === "before-delta"
            ? [
                {
                  id: "read-call",
                  role: "assistant",
                  content: [{ type: "toolCall", id: "read-paper", name: "read", arguments: { path: "/p/paper.md" } }],
                },
                {
                  id: "read-result",
                  role: "toolResult",
                  toolCallId: "read-paper",
                  toolName: "read",
                  content: "Paper data",
                },
              ]
            : []),
        ],
      });
      const pending = deferred<Awaited<ReturnType<typeof api.getChildSnapshot>>>();
      vi.mocked(api.getSnapshot).mockResolvedValue(parent as never);
      vi.mocked(api.getChildSnapshot)
        .mockResolvedValueOnce(child as never)
        .mockReturnValueOnce(pending.promise);
      render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
      await user.click(await screen.findByRole("button", { name: "View details" }));
      expect(await screen.findByText("Previous complete answer")).toBeVisible();
      expect(screen.getByRole("textbox", { name: "Message" })).toBeDisabled();

      emitInAct({ type: "snapshot", ...parent });
      await waitFor(() => expect(api.getChildSnapshot).toHaveBeenCalledTimes(2));
      if (historyTiming === "before-delta") await act(async () => pending.resolve(child as never));
      emitSupervisorChildEvent({
        toolCallId: "sub-cursor",
        childSessionId: "child-cursor",
        event: {
          type: "message_update",
          assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Checking new evidence" },
        } as never,
      });
      expect(await screen.findByRole("button", { name: /Thinking: Checking new evidence/ })).toBeVisible();
      emitSupervisorChildEvent({
        toolCallId: "sub-cursor",
        childSessionId: "child-cursor",
        event: {
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Live suffix after reconnect" },
        } as never,
      });
      expect(await screen.findByText("Live suffix after reconnect")).toBeVisible();
      expect(screen.getByText("Previous complete answer")).toBeVisible();
      expect(screen.getByRole("textbox", { name: "Message" })).toBeDisabled();

      const finalMessage = {
        role: "assistant",
        timestamp: 30,
        content: [
          { type: "thinking", thinking: "Checking new evidence" },
          { type: "text", text: "Full body. Live suffix after reconnect" },
        ],
      };
      if (historyTiming === "at-termination") {
        await act(async () => {
          emit(supervisorEvent({ toolCallId: "sub-cursor", childSessionId: "child-cursor", status: "error" }));
          pending.resolve(child as never);
        });
      } else {
        if (historyTiming === "during-delta") await act(async () => pending.resolve(child as never));
        if (historyTiming === "overlapping-final")
          await act(async () =>
            pending.resolve({
              session: child.session,
              subagents: [],
              timeline: [
                { kind: "message", entryId: "dispatch", message: { role: "user", content: "Find papers" } },
                {
                  kind: "message",
                  entryId: "prior-answer",
                  message: { role: "assistant", id: "prior-answer", content: "Previous complete answer" },
                },
                { kind: "message", entryId: "persisted-new", message: finalMessage },
              ],
            } as never),
          );
        expect(screen.getByText("Live suffix after reconnect")).toBeVisible();
        emitSupervisorChildEvent({
          toolCallId: "sub-cursor",
          childSessionId: "child-cursor",
          event: { type: "message_end", message: finalMessage } as never,
        });
        expect(await screen.findByText("Full body. Live suffix after reconnect")).toBeVisible();
        expect(screen.queryByText("Live suffix after reconnect")).toBeNull();
        emitSupervisor({ toolCallId: "sub-cursor", childSessionId: "child-cursor", status: "complete" });
      }
      expect(await screen.findByRole("button", { name: "Thinking process" })).toBeVisible();
      expect(screen.getByText("Previous complete answer")).toBeVisible();
      expect(screen.getByRole("textbox", { name: "Message" })).toBeDisabled();
      await user.click(screen.getByRole("button", { name: /agent research assistant/i }));
      expect(screen.getByRole("textbox", { name: "Message" })).toBeEnabled();
      expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
      expect(api.sendPrompt).not.toHaveBeenCalled();
    },
  );

  it.each([
    { status: "complete", duringHydration: false, answerEntryId: "answer-entry" },
    { status: "working", duringHydration: false, answerEntryId: "stream:3" },
    { status: "working", duringHydration: true, answerEntryId: "answer-entry" },
    { status: "working", duringHydration: true, answerEntryId: "stream:4" },
  ] as const)(
    "replaces pre-reconnect child partials with $status history and preserves newer deltas ($duringHydration, $answerEntryId)",
    async ({ status, duringHydration, answerEntryId }) => {
      const user = userEvent.setup();
      const parent = {
        session: { id: "s1", cwd: "/p", isStreaming: false, status: "running" },
        subagents: [subagentSummary("sub-reconnect", "child-reconnect", "search", { status: "working" })],
        messages: [
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "sub-reconnect", name: "subagent", arguments: { agent: "search" } }],
          },
        ],
      };
      const child = {
        session: { id: "child-reconnect", cwd: "/p", sessionName: "easyresearch:search" },
        subagents: [],
        timeline: [
          {
            kind: "message",
            entryId: "dispatch-entry",
            message: { role: "user", timestamp: 10, content: "Find evidence" },
          },
          {
            kind: "message",
            entryId: "prior-entry",
            message: {
              role: "assistant",
              timestamp: 11,
              content: [
                { type: "text", text: "Prior answer" },
                { type: "toolCall", id: "prior-read", name: "read", arguments: { path: "/p/evidence.md" } },
              ],
            },
          },
          {
            kind: "message",
            entryId: "read-entry",
            message: {
              role: "toolResult",
              timestamp: 12,
              toolCallId: "prior-read",
              toolName: "read",
              content: "Earlier evidence",
            },
          },
        ],
      };
      const pending = deferred<Awaited<ReturnType<typeof api.getChildSnapshot>>>();
      vi.mocked(api.getSnapshot).mockResolvedValue(parent as never);
      vi.mocked(api.getChildSnapshot)
        .mockResolvedValueOnce(child as never)
        .mockReturnValueOnce(pending.promise);
      const view = render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
      await user.click(await screen.findByRole("button", { name: "View details" }));
      await screen.findByText("Prior answer");
      const delta = (text: string) =>
        emitSupervisorChildEvent({
          toolCallId: "sub-reconnect",
          childSessionId: "child-reconnect",
          event: {
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
          } as never,
        });
      delta("suffix");
      expect(screen.getByText("suffix")).toBeVisible();

      act(() => latestHandlers?.onError());
      emitInAct({
        type: "snapshot",
        ...parent,
        session: { ...parent.session, status: status === "working" ? "running" : "ready" },
        subagents: [subagentSummary("sub-reconnect", "child-reconnect", "search", { status })],
      });
      await waitFor(() => expect(api.getChildSnapshot).toHaveBeenCalledTimes(2));
      if (duringHydration) {
        delta("Post-snapshot delta");
        emitSupervisorChildEvent({
          toolCallId: "sub-reconnect",
          childSessionId: "child-reconnect",
          event: {
            type: "tool_execution_start",
            toolCallId: "nested-launch",
            toolName: "subagent",
            args: { agent: "writing" },
          } as never,
        });
        emitSupervisor({
          ownerSessionId: "child-reconnect",
          toolCallId: "nested-launch",
          childSessionId: "nested-child",
          agent: "writing",
          agentId: "writing_0",
          latestMessage: "Nested progress",
        });
      }
      await act(async () =>
        pending.resolve({
          ...child,
          timeline: [
            ...child.timeline,
            {
              kind: "message",
              entryId: answerEntryId,
              message: { role: "assistant", timestamp: 20, content: "Complete body with suffix" },
            },
          ],
        } as never),
      );

      expect(await screen.findByText("Complete body with suffix")).toBeVisible();
      expect(screen.queryByText("suffix")).toBeNull();
      expect(screen.getByText("Prior answer")).toBeVisible();
      expect(screen.getByRole("textbox", { name: "Message" })).toBeDisabled();
      if (status === "working") {
        if (duringHydration) {
          expect(screen.getByText("Post-snapshot delta")).toBeVisible();
          expect(screen.getByText("Nested progress")).toBeVisible();
          expect(screen.getByRole("button", { name: "Agent writing_0" })).toBeVisible();
          delta(" and more");
          expect(screen.getByText("Post-snapshot delta and more")).toBeVisible();
        } else {
          delta("Next live response");
          expect(screen.getByText("Next live response")).toBeVisible();
        }
        const keys = [...view.container.querySelectorAll<HTMLElement>("[data-row-key]")].map(
          (row) => row.dataset.rowKey,
        );
        expect(new Set(keys).size).toBe(keys.length);
        emitSupervisorChildEvent({
          toolCallId: "sub-reconnect",
          childSessionId: "child-reconnect",
          event: {
            type: "message_end",
            message: { role: "assistant", timestamp: 21, content: "Next complete body" },
          } as never,
        });
        expect(await screen.findByText("Next complete body")).toBeVisible();
        expect(screen.getByText("Complete body with suffix")).toBeVisible();
        expect(screen.queryByText("Post-snapshot delta and more")).toBeNull();
        expect(screen.queryByText("Next live response")).toBeNull();
      }
      expect(api.sendPrompt).not.toHaveBeenCalled();
    },
  );

  it("refreshes every open child snapshot when the parent SSE snapshot reconnects", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getSnapshot).mockResolvedValue({
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready" },
      subagents: [subagentSummary("sub-refresh", "child-refresh")],
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "sub-refresh", name: "subagent", arguments: '{"agent":"search"}' }],
        },
      ],
    } as never);
    vi.mocked(api.getChildSnapshot)
      .mockResolvedValueOnce(
        normalizeTimelineSnapshot({
          session: { id: "child-refresh", cwd: "/p", sessionName: "easyresearch:search" },
          messages: [{ id: "child-message", role: "assistant", content: [{ type: "text", text: "before reconnect" }] }],
          subagents: [],
        } as never),
      )
      .mockResolvedValueOnce(
        normalizeTimelineSnapshot({
          session: { id: "child-refresh", cwd: "/p", sessionName: "easyresearch:search" },
          messages: [
            { id: "child-message", role: "assistant", content: [{ type: "text", text: "recovered from JSONL" }] },
          ],
          subagents: [],
        } as never),
      );
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "View details" }));
    expect(await screen.findByText("before reconnect")).toBeVisible();

    emitInAct({
      type: "snapshot",
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready" },
      subagents: [subagentSummary("sub-refresh", "child-refresh")],
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

  it.each(["event", "reconnect"])(
    "keeps the current child tool live across history refresh and settles it at child termination (%s)",
    async (terminal) => {
      const user = userEvent.setup();
      const parent = {
        session: { id: "s1", cwd: "/p", isStreaming: false, status: "running" },
        subagents: [subagentSummary("sub-tool", "child-tool", "search", { status: "working" })],
        messages: [
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "sub-tool", name: "subagent", arguments: { agent: "search" } }],
          },
        ],
      };
      vi.mocked(api.getSnapshot).mockResolvedValue(parent as never);
      vi.mocked(api.getChildSnapshot).mockResolvedValue({
        session: { id: "child-tool", cwd: "/p", sessionName: "easyresearch:search" },
        subagents: [],
        messages: [
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "child-bash", name: "bash", arguments: { command: "sleep 60" } }],
          },
        ],
      } as never);
      render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
      await user.click(await screen.findByRole("button", { name: "View details" }));
      expect(await screen.findByRole("button", { name: /Running tool: bash/ })).toBeVisible();
      emitInAct({ type: "snapshot", ...parent });
      await waitFor(() => expect(api.getChildSnapshot).toHaveBeenCalledTimes(2));
      expect(screen.getByRole("button", { name: /Running tool: bash/ })).toBeVisible();
      if (terminal === "event") {
        emitSupervisor({ toolCallId: "sub-tool", childSessionId: "child-tool", status: "error" });
      } else {
        emitInAct({
          type: "snapshot",
          ...parent,
          session: { ...parent.session, status: "ready" },
          subagents: [subagentSummary("sub-tool", "child-tool", "search", { status: "error" })],
        });
      }
      expect(await screen.findByRole("button", { name: /Interrupted: bash/ })).toBeVisible();
      expect(screen.queryByRole("button", { name: /Running tool: bash/ })).toBeNull();
    },
  );

  it("queues one reconnect refresh when the child snapshot is already in flight", async () => {
    const user = userEvent.setup();
    let resolveInitial!: (value: Awaited<ReturnType<typeof api.getChildSnapshot>>) => void;
    vi.mocked(api.getSnapshot).mockResolvedValue({
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready" },
      subagents: [subagentSummary("sub-overlap", "child-overlap")],
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
      .mockResolvedValueOnce(
        normalizeTimelineSnapshot({
          session: { id: "child-overlap", cwd: "/p", sessionName: "easyresearch:search" },
          messages: [
            { id: "child-message", role: "assistant", content: [{ type: "text", text: "recovered after overlap" }] },
          ],
          subagents: [],
        } as never),
      );
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "View details" }));
    expect(api.getChildSnapshot).toHaveBeenCalledTimes(1);

    emitInAct({
      type: "snapshot",
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready" },
      subagents: [subagentSummary("sub-overlap", "child-overlap")],
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "sub-overlap", name: "subagent", arguments: '{"agent":"search"}' }],
        },
      ],
    });
    act(() =>
      resolveInitial(
        normalizeTimelineSnapshot({
          session: { id: "child-overlap", cwd: "/p", sessionName: "easyresearch:search" },
          messages: [
            { id: "child-message", role: "assistant", content: [{ type: "text", text: "stale in-flight response" }] },
          ],
          subagents: [],
        } as never),
      ),
    );

    expect(await screen.findByText("recovered after overlap")).toBeVisible();
    expect(api.getChildSnapshot).toHaveBeenCalledTimes(2);
  });

  it("does not let an older completed child link interrupt a working continuation on reconnect", async () => {
    const user = userEvent.setup();
    const parent = {
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "running" },
      subagents: [
        subagentSummary("current", "continued-child", "search", { status: "working" }),
        subagentSummary("old", "continued-child", "search", {
          status: "complete",
          launchId: undefined,
          agentId: undefined,
        }),
      ],
      messages: [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "old", name: "subagent", arguments: { agent: "search" } },
            { type: "toolCall", id: "current", name: "subagent", arguments: { agent: "search_current" } },
          ],
        },
      ],
    };
    vi.mocked(api.getSnapshot).mockResolvedValue(parent as never);
    vi.mocked(api.getChildSnapshot).mockResolvedValue({
      session: { id: "continued-child", cwd: "/p", sessionName: "easyresearch:search" },
      subagents: [],
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "continued-bash", name: "bash", arguments: { command: "sleep 60" } }],
        },
      ],
    } as never);
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    const details = await screen.findAllByRole("button", { name: "View details" });
    await user.click(details[details.length - 1]!);
    expect(await screen.findByRole("button", { name: /Running tool: bash/ })).toBeVisible();
    emitInAct({ type: "snapshot", ...parent });
    await waitFor(() => expect(api.getChildSnapshot).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: /Running tool: bash/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Interrupted: bash/ })).toBeNull();
  });

  it.each([false, true])(
    "does not revive a child tool when termination races history resolution (refresh=%s)",
    async (refresh) => {
      const user = userEvent.setup();
      const parent = {
        session: { id: "s1", cwd: "/p", isStreaming: false, status: "running" },
        subagents: [subagentSummary("sub-race-tool", "child-race-tool", "search", { status: "working" })],
        messages: [
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "sub-race-tool", name: "subagent", arguments: { agent: "search" } }],
          },
        ],
      };
      const child = normalizeTimelineSnapshot({
        session: { id: "child-race-tool", cwd: "/p", sessionName: "easyresearch:search" },
        subagents: [],
        messages: [
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "racing-bash", name: "bash", arguments: { command: "sleep 60" } }],
          },
        ],
      });
      const pending = deferred<Awaited<ReturnType<typeof api.getChildSnapshot>>>();
      vi.mocked(api.getSnapshot).mockResolvedValue(parent as never);
      if (refresh) vi.mocked(api.getChildSnapshot).mockResolvedValueOnce(child as never);
      vi.mocked(api.getChildSnapshot).mockReturnValueOnce(pending.promise);
      render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
      await user.click(await screen.findByRole("button", { name: "View details" }));
      if (refresh) {
        expect(await screen.findByRole("button", { name: /Running tool: bash/ })).toBeVisible();
        emitInAct({ type: "snapshot", ...parent });
      }
      await waitFor(() => expect(api.getChildSnapshot).toHaveBeenCalledTimes(refresh ? 2 : 1));
      await act(async () => {
        emit(supervisorEvent({ toolCallId: "sub-race-tool", childSessionId: "child-race-tool", status: "error" }));
        pending.resolve(child as never);
      });
      expect(await screen.findByRole("button", { name: /Interrupted: bash/ })).toBeVisible();
      expect(screen.queryByRole("button", { name: /Running tool: bash/ })).toBeNull();
    },
  );

  it("preserves nested child output that arrives after a refresh request begins", async () => {
    const user = userEvent.setup();
    let resolveRefresh!: (value: Awaited<ReturnType<typeof api.getChildSnapshot>>) => void;
    vi.mocked(api.getSnapshot).mockResolvedValue({
      session: { id: "s1", cwd: "/p", isStreaming: true, status: "running" },
      subagents: [subagentSummary("sub-race", "child-race", "search", { status: "working" })],
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "sub-race", name: "subagent", arguments: '{"agent":"search"}' }],
        },
      ],
    } as never);
    vi.mocked(api.getChildSnapshot)
      .mockResolvedValueOnce({
        session: { id: "child-race", cwd: "/p", sessionName: "easyresearch:search" },
        messages: [],
        subagents: [],
      } as never)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          }),
      );
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "View details" }));
    await waitFor(() => expect(api.getChildSnapshot).toHaveBeenCalledTimes(1));

    emitInAct({
      type: "snapshot",
      session: { id: "s1", cwd: "/p", isStreaming: true, status: "running" },
      subagents: [subagentSummary("sub-race", "child-race", "search", { status: "working" })],
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "sub-race", name: "subagent", arguments: '{"agent":"search"}' }],
        },
      ],
    });
    await waitFor(() => expect(api.getChildSnapshot).toHaveBeenCalledTimes(2));
    emitSupervisorChildEvent({
      toolCallId: "sub-race",
      agent: "search",
      agentId: "search_0",
      childSessionId: "child-race",
      event: {
        type: "message_start",
        message: { role: "assistant", content: [], timestamp: 200 },
      } as never,
    });
    emitSupervisorChildEvent({
      toolCallId: "sub-race",
      agent: "search",
      agentId: "search_0",
      childSessionId: "child-race",
      event: {
        type: "message_update",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "new nested output" },
      },
    });
    expect(await screen.findByText("new nested output")).toBeVisible();
    emitSupervisorChildEvent({
      toolCallId: "sub-race",
      agent: "search",
      agentId: "search_0",
      childSessionId: "child-race",
      event: {
        type: "entry_appended",
        entry: {
          type: "message",
          id: "persisted-200",
          parentId: null,
          timestamp: "2026-09-01T00:00:00.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "new nested output" }], timestamp: 200 },
        },
      } as never,
    });

    act(() =>
      resolveRefresh({
        session: { id: "child-race", cwd: "/p", sessionName: "easyresearch:search" },
        timeline: [
          {
            kind: "message",
            entryId: "persisted-200",
            message: {
              role: "assistant",
              timestamp: 200,
              content: [{ type: "text", text: "stale refresh output" }],
            },
          },
        ],
        subagents: [],
      } as never),
    );

    await waitFor(() => expect(screen.getByText("new nested output")).toBeVisible());
    expect(screen.queryByText("stale refresh output")).toBeNull();
  });

  it("ignores a delayed child response from an old parent session", async () => {
    const user = userEvent.setup();
    let resolveOld!: (value: Awaited<ReturnType<typeof api.getChildSnapshot>>) => void;
    vi.mocked(api.getSnapshot)
      .mockResolvedValueOnce(
        normalizeTimelineSnapshot({
          session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready" },
          subagents: [subagentSummary("old-tool", "shared-child")],
          messages: [
            {
              role: "assistant",
              content: [{ type: "toolCall", id: "old-tool", name: "subagent", arguments: '{"agent":"search"}' }],
            },
          ],
        } as never),
      )
      .mockResolvedValueOnce(
        normalizeTimelineSnapshot({
          session: { id: "s2", cwd: "/p", isStreaming: false, status: "ready" },
          subagents: [
            subagentSummary("new-tool", "shared-child", "writing", {
              ownerSessionId: "s2",
              agentId: "writing_0",
            }),
          ],
          messages: [
            {
              role: "assistant",
              content: [{ type: "toolCall", id: "new-tool", name: "subagent", arguments: '{"agent":"writing"}' }],
            },
          ],
        } as never),
      );
    vi.mocked(api.getChildSnapshot)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce(
        normalizeTimelineSnapshot({
          session: { id: "shared-child", cwd: "/p", sessionName: "easyresearch:writing" },
          messages: [{ role: "assistant", content: [{ type: "text", text: "new parent child" }] }],
          subagents: [],
        } as never),
      );
    const { rerender, container } = render(
      <WorkPage key="s1" id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />,
    );
    await user.click(await screen.findByRole("button", { name: "View details" }));

    rerender(<WorkPage key="s2" id="s2" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    hydrateTranscript(container);
    await user.click(await screen.findByRole("button", { name: "View details" }));
    expect(await screen.findByText("new parent child")).toBeVisible();
    act(() =>
      resolveOld(
        normalizeTimelineSnapshot({
          session: { id: "shared-child", cwd: "/p", sessionName: "easyresearch:search" },
          messages: [{ role: "assistant", content: [{ type: "text", text: "old parent child" }] }],
          subagents: [],
        } as never),
      ),
    );

    await Promise.resolve();
    expect(screen.getByText("new parent child")).toBeVisible();
    expect(screen.queryByText("old parent child")).toBeNull();
  });

  it("retries a failed child load after close and reopen without duplicate concurrent requests", async () => {
    const user = userEvent.setup();
    let rejectFirst!: (error: unknown) => void;
    vi.mocked(api.getSnapshot).mockResolvedValue({
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready" },
      subagents: [subagentSummary("sub-retry", "child-retry")],
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
      .mockResolvedValueOnce(
        normalizeTimelineSnapshot({
          session: { id: "child-retry", cwd: "/p", sessionName: "easyresearch:search" },
          messages: [{ role: "assistant", content: [{ type: "text", text: "retry recovered" }] }],
          subagents: [],
        } as never),
      );
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    const conversation = within(screen.getByLabelText("Conversation"));
    const tabs = within(screen.getByTestId("agent-tab-group"));
    const details = await conversation.findByRole("button", { name: "View details" });
    act(() => {
      details.click();
      details.click();
    });
    expect(api.getChildSnapshot).toHaveBeenCalledTimes(1);
    act(() => rejectFirst(new api.ApiError(404, { error: "temporarily missing" })));
    expect(await screen.findByText("Child session unavailable.")).toBeVisible();

    await user.click(tabs.getByRole("button", { name: /Close agent tab:/ }));
    await user.click(await conversation.findByRole("button", { name: "View details" }));
    expect(await screen.findByText("retry recovered")).toBeVisible();
    expect(api.getChildSnapshot).toHaveBeenCalledTimes(2);
  });

  it("keeps cards and tabs Working after Stop until an Error supervisor frame arrives", async () => {
    const user = userEvent.setup();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");
    emitInAct({
      type: "tool_execution_start",
      toolCallId: "sub-2",
      toolName: "subagent",
      args: { agent: "search", task: "find papers" },
    });
    emitSupervisor({
      toolCallId: "sub-2",
      agent: "search",
      agentId: "search_0",
      childSessionId: "child-2",
      latestMessage: "still collecting",
    });
    const select = await screen.findByRole("button", { name: "Agent search_0" });
    const stop = await screen.findByRole("button", { name: "Stop agent: search_0" });
    const assistant = screen.getByRole("button", { name: /agent research assistant/i });
    expect(select.contains(stop)).toBe(false);
    expect(select.parentElement).toBe(stop.parentElement);
    expect(select.parentElement).toHaveClass("rounded-full", "border");

    await user.click(stop);
    await waitFor(() => expect(api.abortSession).toHaveBeenCalledWith("s1"));
    expect(assistant).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Agent search_0" })).toBeVisible();
    expect(
      within(screen.getByText("still collecting").closest("article") as HTMLElement).getByText("Running…"),
    ).toBeVisible();

    emitSupervisor({
      toolCallId: "sub-2",
      agent: "search",
      agentId: "search_0",
      childSessionId: "child-2",
      status: "error",
      latestMessage: "Stopped",
    });

    await waitFor(() => expect(screen.queryByRole("button", { name: "Agent search_0" })).toBeNull());
    expect(within(screen.getByText("Stopped").closest("article") as HTMLElement).getByText("Failed")).toBeVisible();
  });

  it("keeps concurrent same-role jobs distinct and accepts out-of-order terminal frames", async () => {
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");
    emitInAct({
      type: "tool_execution_start",
      toolCallId: "search-a",
      toolName: "subagent",
      args: { agent: "search", task: "first corpus" },
    });
    emitInAct({
      type: "tool_execution_start",
      toolCallId: "search-b",
      toolName: "subagent",
      args: { agent: "search", task: "second corpus" },
    });
    emitSupervisor({
      toolCallId: "search-a",
      agent: "search",
      agentId: "search_0",
      childSessionId: "child-search-a",
      latestMessage: "first running",
    });
    emitSupervisor({
      toolCallId: "search-b",
      agent: "search",
      agentId: "search_1",
      childSessionId: "child-search-b",
      latestMessage: "second running",
    });

    expect(screen.getByRole("button", { name: "Agent search_0" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Agent search_1" })).toBeVisible();
    expect(screen.getByText("first running").closest("article")).not.toBe(
      screen.getByText("second running").closest("article"),
    );

    emitSupervisor({
      toolCallId: "search-b",
      agent: "search",
      agentId: "search_1",
      childSessionId: "child-search-b",
      status: "complete",
      latestMessage: "second finished first",
    });

    await waitFor(() => expect(screen.queryByRole("button", { name: "Agent search_1" })).toBeNull());
    expect(screen.getByRole("button", { name: "Agent search_0" })).toBeVisible();
    expect(
      within(screen.getByText("first running").closest("article") as HTMLElement).getByText("Running…"),
    ).toBeVisible();
    expect(
      within(screen.getByText("second finished first").closest("article") as HTMLElement).getByText("Completed"),
    ).toBeVisible();
  });

  it("opens every historical chain UUID through compact per-step details actions", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getSnapshot).mockResolvedValue({
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready" },
      subagents: [
        subagentSummary("chain-history", "child-history-search", "search", { agentId: "search_0", step: 1 }),
        subagentSummary("chain-history", "child-history-writing", "writing", {
          agentId: "writing_0",
          step: 2,
        }),
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
          subagents: [],
        }) as never,
    );
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    const conversation = within(screen.getByLabelText("Conversation"));
    const tabs = within(screen.getByTestId("agent-tab-group"));

    await user.click(await conversation.findByRole("button", { name: "View details: Step 1" }));
    expect(await screen.findByText("history for child-history-search")).toBeVisible();
    await user.click(tabs.getByRole("button", { name: /agent research assistant/i }));
    await user.click(conversation.getByRole("button", { name: "View details: Step 2" }));

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
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);

    expect(await screen.findByText("No progress was saved before this run ended.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "View details" })).toBeNull();
    expect(screen.queryByRole("button", { name: /agent search/i })).toBeNull();
  });

  it("aggregates same-role status with Working above Error above Idle", async () => {
    const user = userEvent.setup();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");
    emitInAct({
      type: "tool_execution_start",
      toolCallId: "search-error",
      toolName: "subagent",
      args: { agent: "search", task: "first" },
    });
    emitInAct({
      type: "tool_execution_start",
      toolCallId: "search-working",
      toolName: "subagent",
      args: { agent: "search", task: "second" },
    });
    emitSupervisor({
      toolCallId: "search-error",
      agent: "search",
      agentId: "search_0",
      childSessionId: "child-error",
      status: "error",
      latestMessage: "failed search",
    });
    emitSupervisor({
      toolCallId: "search-working",
      agent: "search",
      agentId: "search_1",
      childSessionId: "child-working",
      status: "working",
      latestMessage: "active search",
    });
    await user.click(screen.getByRole("button", { name: /agent list/i }));
    const region = screen.getByRole("region", { name: /agent list/i });
    const searchCard = within(region)
      .getByText(/^Web research agent\./)
      .closest(".rounded-md");
    expect(searchCard).not.toBeNull();
    expect(within(searchCard as HTMLElement).getByText(/working/i)).toBeTruthy();

    emitSupervisor({
      toolCallId: "search-working",
      agent: "search",
      agentId: "search_1",
      childSessionId: "child-working",
      status: "complete",
      latestMessage: "finished search",
    });

    await waitFor(() => expect(within(searchCard as HTMLElement).getByText(/^error$/i)).toBeTruthy());
  });

  it("disables the composer on a subagent session line (history browse only)", async () => {
    vi.mocked(api.getSnapshot).mockResolvedValue({
      session: { id: "s3", cwd: "/p", isStreaming: false, status: "ready", sessionName: "easyresearch:search" },
      messages: [{ role: "user", content: [{ type: "text", text: "Task: search" }] }],
      subagents: [],
    } as never);
    render(<WorkPage id="s3" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("Task: search");
    expect(screen.getByText(/history only/i)).toBeTruthy();
    expect(screen.getByRole("textbox", { name: /message/i })).toBeDisabled();
  });

  it("preserves chat state when toggling side panels and back", async () => {
    const user = userEvent.setup();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
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
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");
    const files = within(screen.getByRole("region", { name: /file browser/i }));
    expect(await screen.findByText("folder")).toBeVisible();
    expect(screen.queryByLabelText("Loading folder")).toBeNull();
    expect(files.getByRole("button", { name: "Expand folder" })).toBeVisible();
    await user.click(files.getByRole("button", { name: "Expand folder" }));
    expect(screen.getByLabelText("Loading folder")).toBeVisible();
  });

  it("files panel shows a loading message instead of empty content while the root is pending", async () => {
    const pending: Promise<FileEntryDto[]> = new Promise(() => {});
    vi.mocked(api.listEntries).mockImplementation(async () => pending);
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");
    expect(await screen.findByText("Loading…")).toBeTruthy();
    expect(screen.queryByText("No files.")).toBeNull();
  });

  it("routes valid file watcher events to the file browser and ignores out-of-root events", async () => {
    let entries: FileEntryDto[] = [{ kind: "file", name: "notes.md", path: "/p/notes.md" }];
    vi.mocked(api.listEntries).mockImplementation(async () => entries);
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
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

  it("delivers file-event bursts to pending nested listings and every open preview exactly once", async () => {
    const user = userEvent.setup();
    let revision = 0;
    let holdParent = false;
    const parent = deferred<FileEntryDto[]>();
    vi.mocked(api.listEntries).mockImplementation(async (path) => {
      if (path === "/p")
        return [
          { kind: "directory", name: "results", path: "/p/results" },
          { kind: "file", name: "a.txt", path: "/p/a.txt" },
          { kind: "file", name: "b.txt", path: "/p/b.txt" },
        ];
      if (path === "/p/results")
        return holdParent ? parent.promise : [{ kind: "directory", name: "nested", path: "/p/results/nested" }];
      return [{ kind: "file", name: `result-${revision}.txt`, path: `/p/results/nested/result-${revision}.txt` }];
    });
    vi.mocked(api.readFileContent).mockImplementation(async (path) => ({
      path,
      content: `${path} version ${revision}`,
      byteCount: 20,
      truncated: false,
      binary: false,
    }));
    const view = render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await user.click(await screen.findByText("results"));
    await user.click(await screen.findByText("nested"));
    await screen.findByText("result-0.txt");
    await user.click(screen.getByText("a.txt"));
    await screen.findByText("/p/a.txt version 0");
    await user.click(screen.getByText("b.txt"));
    await screen.findByText("/p/b.txt version 0");
    vi.mocked(api.listEntries).mockClear();
    vi.mocked(api.readFileContent).mockClear();
    const burst = () => {
      for (const file of ["/p/results", "/p/results/nested", "/p", "/p/a.txt", "/p/b.txt", "/p/b.txt"]) {
        emit({ type: "file.watcher.updated", properties: { file, event: "change" } });
      }
    };
    revision = 1;
    holdParent = true;
    await act(async () => burst());
    expect(api.listEntries).toHaveBeenCalledWith("/p/results/nested");
    expect(await screen.findByText("result-1.txt")).toBeVisible();
    await act(async () => parent.resolve([{ kind: "directory", name: "nested", path: "/p/results/nested" }]));
    expect(await screen.findByText("/p/b.txt version 1")).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "a.txt" }));
    expect(await screen.findByText("/p/a.txt version 1")).toBeVisible();
    expect(
      vi
        .mocked(api.readFileContent)
        .mock.calls.map(([path]) => path)
        .sort(),
    ).toEqual(["/p/a.txt", "/p/b.txt"]);
    expect(
      vi
        .mocked(api.listEntries)
        .mock.calls.map(([path]) => path)
        .sort(),
    ).toEqual(["/p", "/p/results", "/p/results/nested"]);

    holdParent = false;
    revision = 2;
    await act(async () => burst());
    expect(await screen.findByText("/p/a.txt version 2")).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "b.txt" }));
    expect(await screen.findByText("/p/b.txt version 2")).toBeVisible();
    expect(await screen.findByText("result-2.txt")).toBeVisible();
    const reads = vi.mocked(api.readFileContent).mock.calls.length;
    const listings = vi.mocked(api.listEntries).mock.calls.length;
    view.rerender(
      <WorkPage id="s1" cwd="/p" configurationGeneration={2} onBack={() => {}} onOpenSettings={() => {}} />,
    );
    await user.click(screen.getByRole("tab", { name: "a.txt" }));
    expect(api.readFileContent).toHaveBeenCalledTimes(reads);
    expect(api.listEntries).toHaveBeenCalledTimes(listings);
    expect(reads).toBe(4);
    expect(listings).toBe(6);
    expect(fileQueueProbe.pending).toBe(0);
  });

  it("discards queued pre-snapshot file events but keeps the following burst", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listEntries).mockResolvedValue(
      ["a", "b"].map((name) => ({ kind: "file", name: `${name}.txt`, path: `/p/${name}.txt` })),
    );
    let revision = 0;
    vi.mocked(api.readFileContent).mockImplementation(async (path) => ({
      path,
      content: `${path} version ${revision}`,
      byteCount: 20,
      truncated: false,
      binary: false,
    }));
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await user.click(await screen.findByText("a.txt"));
    await screen.findByText("/p/a.txt version 0");
    await user.click(screen.getByText("b.txt"));
    await screen.findByText("/p/b.txt version 0");
    vi.mocked(api.readFileContent).mockClear();
    revision = 1;
    await act(async () => {
      emit({ type: "file.watcher.updated", properties: { file: "/p/a.txt", event: "change" } });
      emit({ type: "snapshot", ...snapshotValue, subagents: [] });
      emit({ type: "file.watcher.updated", properties: { file: "/p/b.txt", event: "change" } });
    });
    await screen.findByText("/p/b.txt version 1");
    await user.click(screen.getByRole("tab", { name: "a.txt" }));
    expect(await screen.findByText("/p/a.txt version 0")).toBeVisible();
    expect(vi.mocked(api.readFileContent).mock.calls.map(([path]) => path)).toEqual(["/p/b.txt"]);
    await act(async () => {
      emit({ type: "file.watcher.updated", properties: { file: "/p/a.txt", event: "change" } });
      emit({ type: "snapshot", ...snapshotValue, subagents: [] });
    });
    expect(api.readFileContent).toHaveBeenCalledTimes(1);
    expect(screen.getByText("/p/a.txt version 0")).toBeVisible();
  });

  it("does not replay file events admitted before parent hydration", async () => {
    const pending = deferred<typeof snapshot>();
    vi.mocked(api.getSnapshot).mockReturnValue(pending.promise);
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    expect(api.listEntries).not.toHaveBeenCalled();
    await act(async () => {
      emit({ type: "file.watcher.updated", properties: { file: "/p", event: "change" } });
      emit({ type: "snapshot", ...snapshotValue, subagents: [] });
    });
    await screen.findByText("notes.md");
    expect(api.listEntries).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(snapshot));
    expect(api.listEntries).toHaveBeenCalledTimes(1);
  });

  it("fences queued file events and old stream callbacks when the Work session changes", async () => {
    const user = userEvent.setup();
    vi.mocked(api.readFileContent).mockResolvedValue({
      path: "/p/notes.md",
      content: "plan",
      byteCount: 4,
      truncated: false,
      binary: false,
    });
    const view = render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("notes.md");
    const oldHandlers = latestHandlers!;
    vi.mocked(api.getSnapshot).mockResolvedValue({
      ...snapshotValue,
      session: { ...snapshotValue.session, id: "s2" },
    } as never);
    await act(async () => {
      emit({ type: "file.watcher.updated", properties: { file: "/p", event: "change" } });
      view.rerender(<WorkPage id="s2" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    });
    expect(api.connectSessionEvents).toHaveBeenLastCalledWith("s2", expect.any(Object));
    await screen.findByText("notes.md");
    await user.click(screen.getByText("notes.md"));
    await screen.findByText("plan");
    vi.mocked(api.readFileContent).mockClear();
    await act(async () =>
      oldHandlers.onEvent({ type: "file.watcher.updated", properties: { file: "/p/notes.md", event: "change" } }),
    );
    expect(api.readFileContent).not.toHaveBeenCalled();
    await act(async () => emit({ type: "file.watcher.updated", properties: { file: "/p/notes.md", event: "change" } }));
    expect(api.readFileContent).toHaveBeenCalledOnce();
  });

  it("opens a file from the files panel into a tab and previews its content", async () => {
    const user = userEvent.setup();
    vi.mocked(api.readFileContent).mockResolvedValue({
      path: "/p/notes.md",
      content: "# Notes\n\nplan",
      byteCount: 15,
      truncated: false,
    } as never);
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
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
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");
    await user.click(await screen.findByText("notes.md"));
    expect(await screen.findByText("body")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /close notes.md/i }));
    expect(await screen.findByText("starting research")).toBeTruthy();
    expect(screen.queryByRole("tab", { name: /notes.md/i })).toBeNull();
  });

  it("rehydrates from a snapshot event on reconnect", async () => {
    stubEvents();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");
    emitInAct({
      type: "snapshot",
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready" },
      messages: [{ role: "assistant", content: [{ type: "text", text: "after reconnect" }] }],
    });
    expect(await screen.findByText("after reconnect")).toBeTruthy();
    expect(screen.queryByText("starting research")).toBeNull();
  });

  it("rehydrates nested running tabs from the root reconnect snapshot before child loading", async () => {
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");

    emitInAct({
      type: "snapshot",
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready" },
      subagents: [
        subagentSummary("root-writing", "child-writing", "writing", {
          agentId: "writing_0",
          status: "working",
        }),
        subagentSummary("nested-search", "grandchild-search", "search", {
          ownerSessionId: "child-writing",
          agentId: "search_nested",
          status: "working",
          latestMessage: "nested reconnect work",
        }),
      ],
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "root-writing", name: "subagent", arguments: '{"agent":"writing"}' }],
        },
      ],
    });

    expect(await screen.findByRole("button", { name: "Agent writing_0" })).toBeVisible();
    expect(await screen.findByRole("button", { name: "Agent search_nested" })).toBeVisible();
    expect(api.getChildSnapshot).not.toHaveBeenCalled();
  });

  it("rehydrates a Working card from a ready reconnect summary, then updates it in place", async () => {
    const latestMessage = "verifying metadata for the selected papers";
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");
    emitInAct({
      type: "snapshot",
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready" },
      subagents: [
        subagentSummary("sub-reconnect", "child-reconnect", "search", {
          agentId: "search_0",
          status: "working",
          latestMessage: "restored background work",
        }),
      ],
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

    const select = await screen.findByRole("button", { name: "Agent search_0" });
    const conversation = screen.getByLabelText(/conversation/i);
    const card = within(conversation).getByText("restored background work").closest("article");
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getByText(/running/i)).toBeTruthy();

    emitSupervisor({
      toolCallId: "sub-reconnect",
      agent: "search",
      agentId: "search_0",
      childSessionId: "child-reconnect",
      latestMessage,
    });

    expect(screen.getByRole("button", { name: "Agent search_0" })).toBe(select);
    expect(within(select).queryByTitle(latestMessage)).toBeNull();
    const cardMessage = within(conversation).getByText(latestMessage);
    expect(cardMessage.closest("article")).toBe(card);
  });

  it("does not treat a reconnect tool result as terminal without a supervisor status", async () => {
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");
    emitInAct({
      type: "tool_execution_start",
      toolCallId: "sub-failed-reconnect",
      toolName: "subagent",
      args: { agent: "writing", task: "draft" },
    });
    emitSupervisor({
      toolCallId: "sub-failed-reconnect",
      agent: "writing",
      agentId: "writing_0",
      childSessionId: "child-writing",
      latestMessage: "usable live progress",
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
              arguments: '{"agent":"writing","task":"draft"}',
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
      subagents: [],
    });

    const conversation = screen.getByLabelText(/conversation/i);
    const retained = await within(conversation).findByText("usable live progress");
    expect(retained.closest("article")).toBe(liveCard);
    expect(within(liveCard as HTMLElement).getByText("Writing")).toBeTruthy();
    expect(within(liveCard as HTMLElement).getByText("Running…")).toBeTruthy();

    emitSupervisor({
      toolCallId: "sub-failed-reconnect",
      agent: "writing",
      agentId: "writing_0",
      childSessionId: "child-writing",
      status: "error",
      latestMessage: "full terminal error",
    });
    expect(within(liveCard as HTMLElement).getByText("Failed")).toBeTruthy();
    expect(within(liveCard as HTMLElement).getByText("full terminal error")).toBeTruthy();
  });

  it("shows tool blocks from live events with running and done states", async () => {
    stubEvents();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");
    emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} });
    expect(await screen.findByText(/Running tool: bash/)).toBeTruthy();
    emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: {}, isError: false });
    expect(await screen.findByText("bash")).toBeTruthy();
  });

  it("does not render a live toolResult message_start as a system bubble", async () => {
    stubEvents();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
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
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
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
    const toggle = await screen.findByRole("button", { name: /thinking process/i });
    expect(screen.queryByText("secret chain of thought")).toBeNull();
    expect(screen.getByText("visible answer")).toBeTruthy();
    await userEvent.setup().click(toggle);
    expect(await screen.findByText("secret chain of thought")).toBeTruthy();
    expect(screen.getByRole("button", { name: /thinking process/i })).toHaveAttribute("aria-expanded", "true");
  });

  it("shows tool arguments and expands tool output on demand", async () => {
    stubEvents();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
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
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");
    const chat = screen.getByText("starting research").closest("section");
    const panel = screen.getByRole("region", { name: /file browser/i });
    expect(chat).toBeTruthy();
    expect(chat?.parentElement?.className).toContain("flex-1");
    expect(panel.className).toContain("min-[820px]:shrink-0");
    expect(panel.getAttribute("style")).toMatch(/--panel-w:\s*320px/);
  });

  it("removes the inter-panel gap when the desktop side panel closes", async () => {
    const user = userEvent.setup();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");
    const chat = screen.getByRole("tabpanel", { name: /chat/i });
    const row = chat?.parentElement;
    expect(row).toBeTruthy();
    expect(row).toHaveClass("gap-2", "px-2");

    await user.click(screen.getByRole("button", { name: /files browser/i }));

    expect(row).toHaveClass("gap-0", "px-2");
    expect(row).not.toHaveClass("gap-2");
  });

  it("resizes the panel within min/max while dragging", async () => {
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");
    const panel = screen.getByRole("region", { name: /file browser/i });
    const observer = panelObserver(panel);
    expect(observer).toBeTruthy();
    act(() => observer.__fire(1200));
    await waitFor(() => expect(panel.getAttribute("style")).toMatch(/--panel-w:\s*600px/));
    const handle = within(panel).getByRole("separator", { name: /resize panel/i });
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
    fireEvent.pointerDown(handle, { clientX: 880, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(document, { clientX: 820, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(document, { clientX: 820, clientY: 100, pointerId: 1 });
    expect(panel.getAttribute("style")).toMatch(/--panel-w:\s*660px/);
  });

  it("coalesces pointer moves into one direct width write per animation frame", async () => {
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");
    panelObserver().__fire(1200);
    const panel = screen.getByRole("region", { name: /file browser/i });
    await waitFor(() => expect(panel.getAttribute("style")).toMatch(/--panel-w:\s*600px/));
    const handle = screen.getByRole("separator", { name: /resize panel/i });
    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    try {
      fireEvent.pointerDown(handle, { clientX: 880, clientY: 100, pointerId: 1 });
      fireEvent.pointerMove(document, { clientX: 840, clientY: 100, pointerId: 1 });
      fireEvent.pointerMove(document, { clientX: 820, clientY: 100, pointerId: 1 });

      expect(requestFrame).toHaveBeenCalledOnce();
      expect(panel.getAttribute("style")).toMatch(/--panel-w:\s*600px/);
      act(() => frames[0]?.(performance.now()));
      expect(panel.getAttribute("style")).toMatch(/--panel-w:\s*660px/);
      expect(handle).toHaveAttribute("aria-valuenow", "660");
      fireEvent.pointerUp(document, { clientX: 820, clientY: 100, pointerId: 1 });
      act(() => frames[1]?.(performance.now()));
      act(() => frames[2]?.(performance.now()));
    } finally {
      requestFrame.mockRestore();
    }
  });

  it("does not expose a pending drag width through unrelated React renders", async () => {
    const view = render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");
    panelObserver().__fire(1200);
    const panel = screen.getByRole("region", { name: /file browser/i });
    await waitFor(() => expect(panel.getAttribute("style")).toMatch(/--panel-w:\s*600px/));
    const handle = screen.getByRole("separator", { name: /resize panel/i });
    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    let dragging = false;
    try {
      fireEvent.pointerDown(handle, { clientX: 880, clientY: 100, pointerId: 1 });
      dragging = true;
      fireEvent.pointerMove(document, { clientX: 840, clientY: 100, pointerId: 1 });
      act(() => frames[0]?.(performance.now()));
      expect(panel.getAttribute("style")).toMatch(/--panel-w:\s*640px/);

      fireEvent.pointerMove(document, { clientX: 820, clientY: 100, pointerId: 1 });
      view.rerender(
        <WorkPage id="s1" cwd="/p" configurationGeneration={1} onBack={() => {}} onOpenSettings={() => {}} />,
      );
      expect(panel.getAttribute("style")).toMatch(/--panel-w:\s*640px/);
      act(() => frames[1]?.(performance.now()));
      expect(panel.getAttribute("style")).toMatch(/--panel-w:\s*660px/);

      fireEvent.pointerUp(document, { clientX: 820, clientY: 100, pointerId: 1 });
      dragging = false;
      act(() => frames[2]?.(performance.now()));
      act(() => frames[3]?.(performance.now()));
    } finally {
      if (dragging) fireEvent.pointerUp(document, { clientX: 820, clientY: 100, pointerId: 1 });
      requestFrame.mockRestore();
    }
  });

  it("keeps width transitions disabled until the frame after a rapid release", async () => {
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");
    panelObserver().__fire(1200);
    const panel = screen.getByRole("region", { name: /file browser/i });
    await waitFor(() => expect(panel.getAttribute("style")).toMatch(/--panel-w:\s*600px/));
    const handle = screen.getByRole("separator", { name: /resize panel/i });
    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    try {
      fireEvent.pointerDown(handle, { clientX: 880, clientY: 100, pointerId: 1 });
      fireEvent.pointerMove(document, { clientX: 820, clientY: 100, pointerId: 1 });
      fireEvent.pointerUp(document, { clientX: 820, clientY: 100, pointerId: 1 });

      expect(cancelFrame).toHaveBeenCalledWith(1);
      expect(panel.getAttribute("style")).toMatch(/--panel-w:\s*660px/);
      expect(panel.className).not.toContain("transition-[width,opacity]");
      expect(requestFrame).toHaveBeenCalledTimes(2);
      act(() => frames[1]?.(performance.now()));
      expect(panel.className).not.toContain("transition-[width,opacity]");
      expect(requestFrame).toHaveBeenCalledTimes(3);
      act(() => frames[2]?.(performance.now()));
      expect(panel.className).toContain("transition-[width,opacity]");
    } finally {
      cancelFrame.mockRestore();
      requestFrame.mockRestore();
    }
  });

  it("releases drag globals and document listeners on pointer cancellation", async () => {
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");
    panelObserver().__fire(1200);
    const panel = screen.getByRole("region", { name: /file browser/i });
    await waitFor(() => expect(panel.getAttribute("style")).toMatch(/--panel-w:\s*600px/));
    const handle = screen.getByRole("separator", { name: /resize panel/i });
    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    try {
      fireEvent.pointerDown(handle, { clientX: 880, clientY: 100, pointerId: 1 });
      expect(document.body.style.userSelect).toBe("none");
      expect(document.body.style.overflow).toBe("hidden");
      fireEvent.pointerMove(document, { clientX: 820, clientY: 100, pointerId: 1 });
      act(() => frames[0]?.(performance.now()));
      expect(panel.getAttribute("style")).toMatch(/--panel-w:\s*660px/);

      fireEvent.pointerCancel(document, { clientX: 880, clientY: 100, pointerId: 1 });
      expect(panel.getAttribute("style")).toMatch(/--panel-w:\s*600px/);
      expect(handle).toHaveAttribute("aria-valuenow", "600");
      expect(document.body.style.userSelect).toBe("");
      expect(document.body.style.overflow).toBe("");
      act(() => frames[1]?.(performance.now()));
      act(() => frames[2]?.(performance.now()));
      requestFrame.mockClear();
      fireEvent.pointerMove(document, { clientX: 820, clientY: 100, pointerId: 1 });
      expect(requestFrame).not.toHaveBeenCalled();
    } finally {
      requestFrame.mockRestore();
    }
  });

  it("releases drag globals and document listeners when Work unmounts mid-drag", async () => {
    const view = render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");
    panelObserver().__fire(1200);
    const handle = screen.getByRole("separator", { name: /resize panel/i });
    const requestFrame = vi.spyOn(window, "requestAnimationFrame");
    try {
      fireEvent.pointerDown(handle, { clientX: 880, clientY: 100, pointerId: 1 });
      expect(document.body.style.userSelect).toBe("none");
      view.unmount();

      expect(document.body.style.userSelect).toBe("");
      expect(document.body.style.overflow).toBe("");
      requestFrame.mockClear();
      fireEvent.pointerMove(document, { clientX: 820, clientY: 100, pointerId: 1 });
      expect(requestFrame).not.toHaveBeenCalled();
    } finally {
      requestFrame.mockRestore();
    }
  });

  it("freezes only transcript message content while chat controls follow pointer dragging", async () => {
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");
    panelObserver().__fire(1200);
    const panel = screen.getByRole("region", { name: /file browser/i });
    await waitFor(() => expect(panel.getAttribute("style")).toMatch(/--panel-w:\s*600px/));
    const chat = screen.getByRole("tabpanel", { name: /^chat$/i });
    const transcriptContent = chat.querySelector<HTMLElement>(".relative.mx-auto.w-full");
    expect(transcriptContent).toBeTruthy();
    vi.spyOn(transcriptContent!, "getBoundingClientRect").mockReturnValue({
      right: 568,
      left: 0,
      top: 0,
      bottom: 600,
      width: 568,
      height: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    const handle = screen.getByRole("separator", { name: /resize panel/i });
    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    let dragging = false;
    try {
      fireEvent.pointerDown(handle, { clientX: 880, clientY: 100, pointerId: 1 });
      dragging = true;
      expect(chat).not.toHaveClass("er-chat-resize-snapshot");
      expect(chat.getAttribute("style") ?? "").not.toContain("--chat-snapshot-w");
      expect(transcriptContent).toHaveAttribute("data-resize-snapshot", "true");
      expect(transcriptContent?.getAttribute("style")).toMatch(/--transcript-snapshot-w:\s*568px/);

      fireEvent.pointerMove(document, { clientX: 820, clientY: 100, pointerId: 1 });
      act(() => frames[0]?.(performance.now()));
      expect(panel.getAttribute("style")).toMatch(/--panel-w:\s*660px/);
      expect(transcriptContent?.getAttribute("style")).toMatch(/--transcript-snapshot-w:\s*568px/);

      fireEvent.pointerUp(document, { clientX: 820, clientY: 100, pointerId: 1 });
      dragging = false;
      expect(transcriptContent).not.toHaveAttribute("data-resize-snapshot");
      expect(transcriptContent?.getAttribute("style")).not.toContain("--transcript-snapshot-w");
      act(() => frames[1]?.(performance.now()));
      act(() => frames[2]?.(performance.now()));
    } finally {
      if (dragging) fireEvent.pointerUp(document, { clientX: 820, clientY: 100, pointerId: 1 });
      requestFrame.mockRestore();
    }
  });

  it("exposes the panel divider as a keyboard-adjustable separator", async () => {
    const user = userEvent.setup();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");
    act(() => panelObserver().__fire(1200));
    const handle = await screen.findByRole("separator", { name: /resize panel/i });
    const value = () => Number(handle.getAttribute("aria-valuenow"));
    const initial = value();

    handle.focus();
    await user.keyboard("{ArrowLeft}");
    expect(value()).toBeGreaterThan(initial);
    await user.keyboard("{ArrowRight}");
    expect(value()).toBe(initial);
    await user.keyboard("{Home}");
    expect(value()).toBe(Number(handle.getAttribute("aria-valuemin")));
    await user.keyboard("{End}");
    expect(value()).toBe(Number(handle.getAttribute("aria-valuemax")));
  });

  it("does not let the panel divider collapse under the hr preflight height", async () => {
    const style = document.createElement("style");
    style.textContent = "hr { height: 0 } .h-auto { height: auto }";
    document.head.append(style);
    try {
      render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
      const handle = await screen.findByRole("separator", { name: /resize panel/i });

      expect(getComputedStyle(handle).height).not.toBe("0px");
    } finally {
      style.remove();
    }
  });

  it("remembers the dragged width for the session after the first drag", async () => {
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");
    const panel = screen.getByRole("region", { name: /file browser/i });
    const observer = panelObserver(panel);
    act(() => observer.__fire(1200));
    await waitFor(() => expect(panel.getAttribute("style")).toMatch(/--panel-w:\s*600px/));
    const handle = within(panel).getByRole("separator", { name: /resize panel/i });
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
    fireEvent.pointerDown(handle, { clientX: 880, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(document, { clientX: 820, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(document, { clientX: 820, clientY: 100, pointerId: 1 });
    expect(panel.getAttribute("style")).toMatch(/--panel-w:\s*660px/);
    act(() => observer.__fire(1600));
    await waitFor(() => expect(panel.getAttribute("style")).toMatch(/--panel-w:\s*660px/));
  });

  it("never lets the drag shrink the panel below one third of the screen", async () => {
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");
    const panel = screen.getByRole("region", { name: /file browser/i });
    const observer = panelObserver(panel);
    act(() => observer.__fire(1200));
    await waitFor(() => expect(panel.getAttribute("style")).toMatch(/--panel-w:\s*600px/));
    const handle = within(panel).getByRole("separator", { name: /resize panel/i });
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
    fireEvent.pointerDown(handle, { clientX: 880, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(document, { clientX: 1880, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(document, { clientX: 1880, clientY: 100, pointerId: 1 });
    expect(panel.getAttribute("style")).toMatch(/--panel-w:\s*341px/);
  });

  it("shows Chat by default below 820px and exposes persistent view tabs", async () => {
    vi.stubGlobal("innerWidth", 390);
    render(<WorkPage id="s1" cwd="/papers/fault-diagnosis" onBack={() => {}} onOpenSettings={() => {}} />);
    expect(await screen.findByRole("tab", { name: /chat/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: /chat/i })).toBeVisible();
    expect(screen.getByTitle("/papers/fault-diagnosis")).toHaveTextContent("fault-diagnosis");
  });

  it("preserves file browser state while switching mobile views", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("innerWidth", 390);
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await user.click(await screen.findByRole("tab", { name: /files/i }));
    const filter = screen.getByRole("textbox", { name: /filter files/i });
    expect(filter).toBeVisible();
    expect(filter).toBeEnabled();
    fireEvent.change(filter, { target: { value: "notes" } });
    await user.click(screen.getByRole("tab", { name: /chat/i }));
    await user.click(screen.getByRole("tab", { name: /files/i }));
    expect(screen.getByRole("textbox", { name: /filter files/i })).toHaveValue("notes");
  });

  it("resets to Chat and closes the desktop panel when the viewport narrows below 820px", async () => {
    vi.stubGlobal("innerWidth", 900);
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
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
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
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
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");
    await user.click(screen.getByRole("tab", { name: /files/i }));
    await user.click(screen.getByRole("tab", { name: /agents/i }));
    await user.click(screen.getByRole("tab", { name: /chat/i }));
    expect(api.listEntries).toHaveBeenCalledTimes(1);
    expect(api.listAgents).toHaveBeenCalledTimes(1);
    expect(api.listModels).toHaveBeenCalledTimes(1);
  });

  it("marks the panel invisible after the close transition ends", async () => {
    const user = userEvent.setup();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
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
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");
    panelObserver().__fire(1000);
    const handle = screen.getByRole("separator", { name: /resize panel/i });
    fireEvent.pointerDown(handle, { clientX: 880, clientY: 100, pointerId: 1 });
    const region = screen.getByRole("region", { name: /file browser/i });
    expect(region.className).not.toContain("transition-");
    fireEvent.pointerUp(document, { clientX: 880, clientY: 100, pointerId: 1 });
    await waitFor(() => expect(region.className).toContain("transition-[width,opacity]"));
  });

  it("keeps the resize handle reachable while clipping panel content internally", async () => {
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");
    const region = screen.getByRole("region", { name: /file browser/i });
    expect(region.className).not.toContain("overflow-hidden");
    const wrapper = region.querySelector("#work-panel-files");
    expect(wrapper?.className).toContain("overflow-hidden");
    const handle = screen.getByRole("separator", { name: /resize panel/i });
    expect(region.contains(handle)).toBe(true);
    expect(handle.className).toContain("min-[820px]:block");
  });

  it("keeps entry static, arms panel transitions after layout, and fades later view switches", async () => {
    const user = userEvent.setup();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");
    const filesRegion = screen.getByRole("region", { name: /file browser/i });
    const filesWrapper = filesRegion.querySelector("#work-panel-files");
    expect(filesWrapper).toBeTruthy();
    expect(filesWrapper).not.toHaveClass("animate-v2-fade-in");
    expect(filesRegion.className).not.toContain("transition-[width,opacity]");
    panelObserver().__fire(1000);
    await waitFor(() => expect(filesRegion.className).toContain("transition-[width,opacity]"));
    await user.click(screen.getByRole("button", { name: /agent list/i }));
    const agentsRegion = screen.getByRole("region", { name: /agent list/i });
    const agentsWrapper = agentsRegion.querySelector(".animate-v2-fade-in");
    expect(agentsWrapper).toBeTruthy();
    expect(agentsWrapper).not.toBe(filesWrapper);
    const agentsToggle = screen.getByRole("button", { name: /agent list/i });
    await user.click(agentsToggle);
    expect(agentsRegion.className).toContain("transition-[width,opacity]");
    expect(agentsRegion.className).toContain("min-[820px]:w-0");
    await user.click(agentsToggle);
    expect(agentsRegion.className).toContain("transition-[width,opacity]");
    expect(agentsRegion.className).toContain("min-[820px]:opacity-100");
  });

  it("renders the full six-agent roster in the agents view", async () => {
    const user = userEvent.setup();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");
    await user.click(screen.getByRole("button", { name: /agent list/i }));
    const region = screen.getByRole("region", { name: /agent list/i });
    await waitFor(() => {
      for (const display of ["Research Assistant", "Search", "Experiment", "Writing", "Figures", "Review"]) {
        expect(within(region).getAllByText(display).length).toBeGreaterThan(0);
      }
    });
  });

  it("agent cards show localized descriptions and no Subagents rows", async () => {
    const user = userEvent.setup();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");
    await user.click(screen.getByRole("button", { name: /agent list/i }));
    const region = screen.getByRole("region", { name: /agent list/i });
    expect(await within(region).findByText(/Research Assistant for the paper pipeline/)).toBeTruthy();
    expect(within(region).getByText(/Experiment agent/)).toBeTruthy();
    expect(within(region).queryByText("Subagents")).toBeNull();
    expect(within(region).queryByText("search, figures")).toBeNull();
  });

  it("applying a model to an agent writes it immediately, with no Set button", async () => {
    const user = userEvent.setup();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");
    await user.click(screen.getByRole("button", { name: /agent list/i }));
    const region = screen.getByRole("region", { name: /agent list/i });
    const search = (await within(region).findByText("Search")).closest<HTMLElement>("div.mt-3")!;
    const searchCombo = within(search).getByRole("combobox", { name: "Select model" });
    await user.click(searchCombo);
    await user.click(screen.getByRole("option", { name: "openai/gpt-4o" }));
    await waitFor(() => expect(api.patchAgent).toHaveBeenCalledWith("search", { model: "openai/gpt-4o" }));
    expect(within(region).queryByRole("button", { name: /^set$/i })).toBeNull();
  });

  it("keeps the transcript without a session-ended notice on session_deactivated", async () => {
    stubEvents();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
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
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");
    const input = screen.getByRole("textbox", { name: /message/i });
    expect(input).toBeVisible();
    expect(input).toBeEnabled();
    fireEvent.change(input, { target: { value: "continue please" } });
    await user.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(api.openSession).toHaveBeenCalledWith("/agent/sessions/--p--/a.jsonl"));
    await waitFor(() => expect(api.connectSessionEvents).toHaveBeenCalledTimes(2));
    expect(api.connectSessionEvents).toHaveBeenNthCalledWith(1, "s1", expect.anything());
    expect(api.connectSessionEvents).toHaveBeenNthCalledWith(2, "s2", expect.anything());
    expect(unsubscribeFn).toHaveBeenCalledTimes(1);
    expect(api.sendPrompt).toHaveBeenCalledTimes(1);
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

  it("preserves retained child tabs when the same persisted session reopens under a new runtime id", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getSnapshot)
      .mockResolvedValueOnce(
        normalizeTimelineSnapshot({
          session: {
            id: "s1",
            cwd: "/p",
            isStreaming: false,
            status: "ready",
            sessionFile: "/agent/sessions/--p--/a.jsonl",
          },
          subagents: [subagentSummary("retained-child", "child-retained", "search", { agentId: "search_0" })],
          messages: [
            {
              role: "assistant",
              content: [{ type: "toolCall", id: "retained-child", name: "subagent", arguments: '{"agent":"search"}' }],
            },
          ],
        } as never),
      )
      .mockResolvedValue({
        session: { id: "s2", cwd: "/p", isStreaming: false, status: "ready" },
        messages: [{ role: "user", content: [{ type: "text", text: "continue please" }] }],
        subagents: [],
      } as never);
    vi.mocked(api.getChildSnapshot).mockResolvedValue({
      session: { id: "child-retained", cwd: "/p", sessionName: "easyresearch:search" },
      messages: [{ role: "assistant", content: [{ type: "text", text: "retained child history" }] }],
      subagents: [],
    } as never);
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
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    const tabs = within(screen.getByTestId("agent-tab-group"));
    await user.click(
      await within(screen.getByLabelText("Conversation")).findByRole("button", { name: "View details" }),
    );
    expect(await screen.findByText("retained child history")).toBeVisible();
    expect(screen.getByRole("button", { name: "Agent search_0" })).toBeVisible();
    await user.click(tabs.getByRole("button", { name: /agent research assistant/i }));

    emitInAct({ type: "session_deactivated", sessionId: "s1" });
    const input = screen.getByRole("textbox", { name: /message/i });
    expect(input).toBeVisible();
    expect(input).toBeEnabled();
    fireEvent.change(input, { target: { value: "continue please" } });
    await user.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(api.connectSessionEvents).toHaveBeenCalledTimes(2));
    emitInAct({
      type: "snapshot",
      session: { id: "s2", cwd: "/p", isStreaming: false, status: "ready" },
      messages: [{ role: "user", content: [{ type: "text", text: "continue please" }] }],
      subagents: [],
    });
    await waitFor(() => expect(api.sendPrompt).toHaveBeenCalledTimes(2));

    expect(screen.getByRole("button", { name: "Agent search_0" })).toBeVisible();
    expect(screen.getByRole("button", { name: /Close agent tab:/ })).toBeVisible();
  });

  it("uses one retained-running X to stop the tree and close the child tab", async () => {
    const user = userEvent.setup();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");
    emitInAct({
      type: "tool_execution_start",
      toolCallId: "sub-combined",
      toolName: "subagent",
      args: { agent: "experiment", task: "run benchmark" },
    });
    emitSupervisor({
      toolCallId: "sub-combined",
      agent: "experiment",
      agentId: "experiment_0",
      childSessionId: "child-combined",
      latestMessage: "benchmark running",
    });
    await user.click(await screen.findByRole("button", { name: "Agent experiment_0" }));

    const action = screen.getByRole("button", { name: "Stop and close agent: experiment_0" });
    expect(screen.queryByRole("button", { name: "Stop agent: experiment_0" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close agent tab: experiment_0" })).toBeNull();
    await user.click(action);

    await waitFor(() => expect(api.abortSession).toHaveBeenCalledWith("s1"));
    expect(screen.queryByRole("button", { name: "Agent experiment_0" })).toBeNull();
    expect(screen.getByRole("button", { name: /agent research assistant/i })).toHaveAttribute("aria-pressed", "true");
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
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");
    const input = screen.getByRole("textbox", { name: /message/i });
    expect(input).toBeVisible();
    expect(input).toBeEnabled();
    fireEvent.change(input, { target: { value: "continue please" } });
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
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");
    const input = screen.getByRole("textbox", { name: /message/i });
    expect(input).toBeVisible();
    expect(input).toBeEnabled();
    fireEvent.change(input, { target: { value: "continue please" } });
    await user.click(screen.getByRole("button", { name: /send/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("server exploded");
    expect(api.openSession).not.toHaveBeenCalled();
    expect(api.sendPrompt).toHaveBeenCalledTimes(1);
  });

  it("shows the actionable reopen failure instead of the original unknown-session error", async () => {
    const user = userEvent.setup();
    stubEvents();
    vi.mocked(api.sendPrompt).mockRejectedValueOnce(new api.ApiError(404, { error: "Unknown session: s1" }));
    vi.mocked(api.openSession).mockRejectedValueOnce(new Error("Session file can no longer be reopened"));
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("starting research");

    const input = screen.getByRole("textbox", { name: /message/i });
    expect(input).toBeVisible();
    expect(input).toBeEnabled();
    fireEvent.change(input, { target: { value: "continue please" } });
    await user.click(screen.getByRole("button", { name: /send/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Session file can no longer be reopened");
    expect(screen.queryByText("Unknown session: s1")).toBeNull();
  });

  it("shows the retry banner while an API call is being retried and hides it on completion", async () => {
    stubEvents();
    render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
    emitInAct({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 5000,
      errorMessage: "429 rate limited",
    });
    expect(await screen.findByText(/Retrying API call 1\/3/)).toBeTruthy();
    emitInAct({ type: "auto_retry_end", success: true, attempt: 1 });
    await waitFor(() => expect(screen.queryByText(/Retrying API call 1\/3/)).toBeNull());
  });

  describe("skill slash commands and message branching (ADR-066)", () => {
    it("rebuilds message metadata when a replacement snapshot has the same structure counter", async () => {
      vi.mocked(api.getSnapshot).mockResolvedValue({
        ...snapshotValue,
        timeline: [{ kind: "message", entryId: "old", message: { role: "user", content: "Old question" } }],
      } as never);
      vi.mocked(api.getSessionTree).mockResolvedValue({
        tree: [
          { id: "old", parentId: null, role: "user", kind: "user", text: "Old question" },
          { id: "new", parentId: null, role: "user", kind: "user", text: "Replacement question" },
        ],
        leafId: "new",
        filterMode: "default",
        skipBranchSummaryPrompt: false,
      });
      render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
      await screen.findByText("Old question");
      emitInAct({ type: "message_start", message: { role: "user", timestamp: 42, content: "Live question" } });
      await screen.findByText("Live question");
      emitInAct({
        type: "snapshot",
        session: snapshotValue.session,
        subagents: [],
        timeline: [{ kind: "message", entryId: "new", message: { role: "user", content: "Replacement question" } }],
      });
      await screen.findByText("Replacement question");
      expect(await screen.findByRole("button", { name: /previous version/i })).toBeEnabled();
      expect(screen.getByText("2/2")).toBeTruthy();
    });

    const branchingTree = {
      leafId: "a2",
      tree: [
        { id: "m1", parentId: null, role: "user", text: "write a paper" },
        { id: "a1", parentId: "m1", role: "assistant", text: "starting research" },
        { id: "m2", parentId: null, role: "user", text: "write a paper (edited)" },
        { id: "a2", parentId: "m2", role: "assistant", text: "research restarted" },
      ],
    };

    beforeEach(() => {
      vi.mocked(api.getSnapshot).mockResolvedValue({
        ...snapshotValue,
        timeline: snapshotMessages.map((message, index) => ({
          kind: "message",
          entryId: index === 0 ? "m2" : "a2",
          message,
        })),
      } as never);
    });

    it("opens the skill popover and sends the inserted friendly command", async () => {
      const user = userEvent.setup();
      vi.mocked(api.getSessionCommands).mockResolvedValue([
        { name: "arxiv", description: "arXiv metadata", source: "skill" },
      ]);
      render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
      await screen.findByText("starting research");

      const input = screen.getByRole("textbox", { name: /message/i });
      await user.click(input);
      await user.keyboard("/ar");
      await user.click(await screen.findByRole("option", { name: /\/arxiv/ }));
      expect((input as HTMLTextAreaElement).value).toBe("/arxiv ");
      await user.click(screen.getByRole("button", { name: /send/i }));
      await waitFor(() => expect(api.sendPrompt).toHaveBeenCalledWith("s1", "/arxiv"));
    });

    it("loads session tree metadata and offers the version switcher", async () => {
      vi.mocked(api.getSessionTree).mockResolvedValue(branchingTree as never);
      render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
      await screen.findByText("starting research");
      expect(await screen.findByText("2/2")).toBeTruthy();
    });

    it("edits a historical message: navigate in place, then send the new text", async () => {
      const user = userEvent.setup();
      vi.mocked(api.getSessionTree).mockResolvedValue(branchingTree as never);
      render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
      await screen.findByText("starting research");
      await screen.findByText("2/2");

      await user.click(screen.getByRole("button", { name: /edit/i }));
      const textarea = screen.getByRole("textbox", { name: /edit/i });
      expect(textarea).toBeVisible();
      expect(textarea).toBeEnabled();
      fireEvent.change(textarea, { target: { value: "rewrite the paper" } });
      const sendButtons = within(screen.getByLabelText("Conversation")).getAllByRole("button", { name: /send/i });
      await user.click(sendButtons.find((button) => button.textContent === "Send")!);

      await waitFor(() => expect(api.navigateSessionTree).toHaveBeenCalledWith("s1", "m2", {}));
      expect(api.sendPrompt).toHaveBeenCalledWith("s1", "rewrite the paper");
    });

    it("switches versions by navigating to the neighbor's subtree leaf", async () => {
      const user = userEvent.setup();
      vi.mocked(api.getSessionTree).mockResolvedValue(branchingTree as never);
      render(<WorkPage id="s1" cwd="/p" onBack={() => {}} onOpenSettings={() => {}} />);
      await screen.findByText("starting research");
      await screen.findByText("2/2");

      await user.click(screen.getByRole("button", { name: /previous version/i }));
      await waitFor(() => expect(api.navigateSessionTree).toHaveBeenCalledWith("s1", "a1", {}));
    });
  });
});
