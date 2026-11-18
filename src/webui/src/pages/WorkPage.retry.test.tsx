import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  AutomaticRetryDto,
  ChildSessionSnapshotDto,
  LlmRecoveryDto,
  SessionSnapshotDto,
  SubagentSessionSummaryDto,
} from "../../../web/contracts";
import * as api from "../api";
import { I18nProvider } from "../i18n/I18nProvider";
import { PreferencesProvider } from "../preferences/PreferencesProvider";
import { hydrateTranscript } from "../testing/transcriptTest";
import { ViewActivityProvider } from "../view-activity";
import { WorkPage } from "./WorkPage";

vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  getSnapshot: vi.fn(),
  getChildSnapshot: vi.fn(),
  connectSessionEvents: vi.fn(),
  retryModelRequest: vi.fn(),
  sendPrompt: vi.fn(),
  openSession: vi.fn(),
  abortSession: vi.fn(),
  stopSession: vi.fn(),
  getApiUsageSettings: vi.fn(),
  getSessionCommands: vi.fn(),
  getSessionTree: vi.fn(),
  listAgents: vi.fn(),
  listModels: vi.fn(),
  listEntries: vi.fn(),
  replaceFileWatchDirectories: vi.fn(),
}));

const failure = (targetSessionId: string, failureId = "f1"): LlmRecoveryDto => ({
  targetSessionId,
  failureId,
  failedEntryId: "partial",
  status: "available",
});
const backoff = (errorMessage: string): AutomaticRetryDto => ({
  source: "agent",
  attempt: 2,
  maxAttempts: 10,
  delayMs: 10_000,
  remainingMs: 8000,
  errorMessage,
});
const child = (id: string, ownerSessionId = "root"): SubagentSessionSummaryDto => ({
  ownerSessionId,
  toolCallId: `launch-${id}`,
  launchId: `job-${id}`,
  childSessionId: id,
  agent: id,
  agentId: `${id}_0`,
  status: "working",
});
const rootSnapshot = (patch: Partial<SessionSnapshotDto> = {}): SessionSnapshotDto => ({
  session: { id: "root", cwd: "/fixture", isStreaming: false, status: "ready" },
  runtimeConfigurationGeneration: 1,
  compactionPolicy: { enabled: true, triggerPercent: 70 },
  subagents: [],
  timeline: [
    {
      kind: "message",
      entryId: "partial",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Retained partial answer" },
          { type: "thinking", thinking: "Retained reasoning" },
        ],
        stopReason: "error",
        errorMessage: "provider failed",
        timestamp: 1,
      } as never,
    },
  ],
  ...patch,
});
const childSnapshot = (id: string, patch: Partial<ChildSessionSnapshotDto> = {}): ChildSessionSnapshotDto => ({
  session: { id, cwd: "/fixture", sessionName: `easyresearch:${id}` },
  timeline: rootSnapshot().timeline,
  subagents: [],
  ...patch,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
let handlers: api.SessionEventHandlers[];
const emit = (event: unknown) => act(() => handlers.at(-1)?.onEvent(event));
const stateEvent = (
  targetSessionId: string,
  llmRecovery: LlmRecoveryDto | null,
  automaticRetry: AutomaticRetryDto | null = null,
) => ({ type: "llm_retry_state", targetSessionId, automaticRetry, llmRecovery });
const supervisor = (summary: SubagentSessionSummaryDto, event: unknown) => ({
  type: "subagent_supervisor",
  ...summary,
  event,
});

function page(id = "root", visible = true) {
  return (
    <PreferencesProvider>
      <I18nProvider>
        <ViewActivityProvider visible={visible} interactive={visible}>
          <WorkPage id={id} cwd="/fixture" onBack={() => {}} onOpenSettings={() => {}} />
        </ViewActivityProvider>
      </I18nProvider>
    </PreferencesProvider>
  );
}
async function mount(snapshot = rootSnapshot()) {
  vi.mocked(api.getSnapshot).mockResolvedValue(snapshot);
  const result = render(page());
  await waitFor(() => expect(api.getSessionCommands).toHaveBeenCalled());
  hydrateTranscript(result.container);
  return result;
}
const retryButton = () => screen.getByRole("button", { name: "Retry model request" });
const tabs = () => within(screen.getByTestId("agent-tab-group"));

beforeEach(() => {
  vi.clearAllMocks();
  handlers = [];
  vi.mocked(api.connectSessionEvents).mockImplementation((_id, handler) => {
    handlers.push(handler);
    return vi.fn();
  });
  vi.mocked(api.getApiUsageSettings).mockResolvedValue({ showApiUsageDetails: false });
  vi.mocked(api.getSessionCommands).mockResolvedValue([]);
  vi.mocked(api.getSessionTree).mockResolvedValue({
    tree: [],
    leafId: null,
    filterMode: "default",
    skipBranchSummaryPrompt: false,
  });
  vi.mocked(api.listAgents).mockResolvedValue([]);
  vi.mocked(api.listModels).mockResolvedValue([]);
  vi.mocked(api.listEntries).mockResolvedValue([]);
  vi.mocked(api.replaceFileWatchDirectories).mockResolvedValue();
  vi.mocked(api.abortSession).mockResolvedValue();
  vi.mocked(api.getChildSnapshot)
    .mockReset()
    .mockImplementation(async (_root, id) => childSnapshot(id));
  vi.mocked(api.retryModelRequest)
    .mockReset()
    .mockImplementation(async (_root, request) => ({ accepted: true, ...request }));
});
afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

it("uses live root authority without changing partial output, composer draft or completed history", async () => {
  const user = userEvent.setup();
  const pending = deferred<Awaited<ReturnType<typeof api.retryModelRequest>>>();
  vi.mocked(api.retryModelRequest).mockReturnValueOnce(pending.promise);
  await mount();
  expect(screen.queryByRole("button", { name: "Retry model request" })).toBeNull();
  expect(screen.getByText(/Retained partial answer/)).toBeVisible();
  expect(screen.getByText(/provider failed/)).toBeVisible();
  const composer = screen.getByRole("textbox");
  fireEvent.change(composer, { target: { value: "unsent draft" } });
  emit(stateEvent("root", failure("root")));
  retryButton().focus();
  await user.keyboard("{Enter}{Enter}");
  expect(api.retryModelRequest).toHaveBeenCalledOnce();
  expect(retryButton()).toHaveFocus();
  emit(stateEvent("root", failure("root", "f2")));
  expect(retryButton()).toHaveAttribute("aria-disabled", "false");
  await act(async () => pending.resolve({ accepted: true, targetSessionId: "root", failureId: "f1" }));
  expect(retryButton()).toHaveAttribute("aria-disabled", "false");
  await user.click(retryButton());
  expect(api.retryModelRequest).toHaveBeenLastCalledWith(
    "root",
    { targetSessionId: "root", failureId: "f2" },
    expect.any(AbortSignal),
  );
  expect(composer).toHaveValue("unsent draft");
  expect(screen.getByText(/Retained partial answer/)).toBeVisible();
  expect(api.sendPrompt).not.toHaveBeenCalled();
  expect(api.openSession).not.toHaveBeenCalled();
  emit(stateEvent("root", null));
  expect(screen.queryByRole("button", { name: "Retry model request" })).toBeNull();
  expect(tabs().getByRole("button", { name: "Agent Research Assistant" })).toHaveFocus();
});

it("scopes automatic/manual recovery to root, direct and nested custom Agent views and retains paused tabs", async () => {
  const user = userEvent.setup();
  const direct = child("writing");
  const nested = child("custom", "writing");
  vi.mocked(api.getChildSnapshot).mockImplementation(async (_root, id) =>
    childSnapshot(
      id,
      id === "writing"
        ? { automaticRetry: { ...backoff("direct summary error"), source: "compaction" }, subagents: [nested] }
        : { llmRecovery: failure("custom") },
    ),
  );
  await mount(
    rootSnapshot({
      automaticRetry: backoff("root error"),
      subagents: [direct, { ...nested, llmRecovery: failure("custom") }],
    }),
  );
  expect(screen.getByText("root error")).toBeVisible();
  const nestedTab = await tabs().findByRole("button", { name: "Agent custom_0" });
  expect(nestedTab).toHaveTextContent("Awaiting retry");
  expect(nestedTab).toHaveAccessibleDescription("Awaiting retry");
  await user.click(tabs().getByRole("button", { name: "Agent writing_0" }));
  expect(await screen.findByText("direct summary error")).toBeVisible();
  expect(screen.queryByText("root error")).toBeNull();
  expect(screen.getByRole("textbox")).toBeDisabled();
  emit(supervisor(direct, stateEvent("writing", failure("writing"))));
  await user.click(retryButton());
  expect(api.retryModelRequest).toHaveBeenLastCalledWith(
    "root",
    { targetSessionId: "writing", failureId: "f1" },
    expect.any(AbortSignal),
  );
  await user.click(tabs().getByRole("button", { name: "Agent custom_0" }));
  await waitFor(() => expect(retryButton()).toHaveAttribute("aria-disabled", "false"));
  expect(screen.queryByText("direct summary error")).toBeNull();
  await user.click(retryButton());
  expect(api.retryModelRequest).toHaveBeenLastCalledWith(
    "root",
    { targetSessionId: "custom", failureId: "f1" },
    expect.any(AbortSignal),
  );
  emit(supervisor(direct, supervisor(nested, stateEvent("custom", null, backoff("nested error")))));
  expect(await screen.findByText("nested error")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Retry model request" })).toBeNull();
  emit(supervisor(direct, supervisor(nested, stateEvent("custom", failure("custom", "f2")))));
  emit(supervisor(nested, { type: "agent_settled" }));
  expect(tabs().getByRole("button", { name: "Agent custom_0" })).toHaveTextContent("Awaiting retry");
  expect(retryButton()).toHaveAttribute("aria-disabled", "false");
  expect(screen.getByRole("textbox")).toBeDisabled();
  await user.click(tabs().getByRole("button", { name: "Agent Research Assistant" }));
  expect(screen.getByText("root error")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Retry model request" })).toBeNull();
  expect(api.sendPrompt).not.toHaveBeenCalled();
  expect(api.openSession).not.toHaveBeenCalled();
});

it("refreshes a stale child's snapshot once and preserves a newer SSE failure over the pending read", async () => {
  const user = userEvent.setup();
  const direct = child("custom");
  const refresh = deferred<ChildSessionSnapshotDto>();
  vi.mocked(api.getChildSnapshot)
    .mockResolvedValueOnce(childSnapshot("custom", { llmRecovery: failure("custom") }))
    .mockReturnValueOnce(refresh.promise);
  vi.mocked(api.retryModelRequest).mockRejectedValueOnce(
    new api.ApiError(409, { code: "LLM_RETRY_STALE", error: "expired" }),
  );
  await mount(rootSnapshot({ subagents: [direct] }));
  await user.click(tabs().getByRole("button", { name: "Agent custom_0" }));
  await waitFor(() => expect(retryButton()).toBeVisible());
  await user.click(retryButton());
  await waitFor(() => expect(api.getChildSnapshot).toHaveBeenCalledTimes(2));
  emit(supervisor(direct, stateEvent("custom", failure("custom", "new-failure"))));
  await act(async () => refresh.resolve(childSnapshot("custom", { llmRecovery: null })));
  await user.click(retryButton());
  expect(api.retryModelRequest).toHaveBeenLastCalledWith(
    "root",
    { targetSessionId: "custom", failureId: "new-failure" },
    expect.any(AbortSignal),
  );
  expect(api.getChildSnapshot).toHaveBeenCalledTimes(2);
});

it("cancels only pending view admission on child/root switch and on hidden-root disposal", async () => {
  const user = userEvent.setup();
  const pending = deferred<Awaited<ReturnType<typeof api.retryModelRequest>>>();
  vi.mocked(api.retryModelRequest).mockReturnValue(pending.promise);
  const mounted = await mount(rootSnapshot({ llmRecovery: failure("root"), subagents: [child("custom")] }));
  await user.click(retryButton());
  const firstSignal = vi.mocked(api.retryModelRequest).mock.calls[0]?.[2];
  await user.click(tabs().getByRole("button", { name: "Agent custom_0" }));
  expect(firstSignal?.aborted).toBe(true);
  await user.click(tabs().getByRole("button", { name: "Agent Research Assistant" }));
  await user.click(retryButton());
  const secondSignal = vi.mocked(api.retryModelRequest).mock.calls[1]?.[2];
  mounted.rerender(page("root", false));
  expect(secondSignal?.aborted).toBe(true);
  mounted.unmount();
  expect(api.abortSession).not.toHaveBeenCalled();
  expect(api.stopSession).not.toHaveBeenCalled();
  await act(async () => pending.resolve({ accepted: true, targetSessionId: "root", failureId: "f1" }));
});

it("authoritative reconnect replaces remaining time/recovery and malformed or foreign frames add no action", async () => {
  await mount(rootSnapshot({ automaticRetry: backoff("waiting") }));
  emit({ type: "snapshot", ...rootSnapshot({ automaticRetry: { ...backoff("new wait"), remainingMs: 1000 } }) });
  expect(screen.getByText("retrying in 1s")).toBeVisible();
  emit(stateEvent("foreign", failure("foreign")));
  emit(stateEvent("root", { ...failure("root"), failureId: "" }));
  expect(screen.queryByRole("button", { name: "Retry model request" })).toBeNull();
  emit({ type: "snapshot", ...rootSnapshot({ llmRecovery: failure("root") }) });
  expect(retryButton()).toBeVisible();
  emit({ type: "session_deactivated" });
  expect(screen.queryByRole("button", { name: "Retry model request" })).toBeNull();
  expect(api.openSession).not.toHaveBeenCalled();
});

it("keeps Stop available for a paused root and clears pending admission only from authoritative state", async () => {
  const user = userEvent.setup();
  const pending = deferred<Awaited<ReturnType<typeof api.retryModelRequest>>>();
  vi.mocked(api.retryModelRequest).mockReturnValue(pending.promise);
  await mount(rootSnapshot({ llmRecovery: failure("root") }));
  await user.click(retryButton());
  const signal = vi.mocked(api.retryModelRequest).mock.calls[0]?.[2];
  const stop = screen.getByRole("button", { name: "Stop" });
  await user.click(stop);
  expect(api.abortSession).toHaveBeenCalledWith("root");
  expect(retryButton()).toHaveAttribute("aria-disabled", "true");
  emit(stateEvent("root", null));
  expect(signal?.aborted).toBe(true);
  expect(screen.queryByRole("button", { name: "Retry model request" })).toBeNull();
  expect(screen.getByRole("textbox")).toHaveFocus();
  await act(async () => pending.resolve({ accepted: true, targetSessionId: "root", failureId: "f1" }));
  expect(screen.queryByRole("button", { name: "Retry model request" })).toBeNull();
});

it("refreshes root admission conflicts through its existing connection owner and never auto-reopens 404", async () => {
  const user = userEvent.setup();
  await mount(rootSnapshot({ llmRecovery: failure("root") }));
  vi.mocked(api.getSnapshot).mockResolvedValue(rootSnapshot({ llmRecovery: failure("root", "fresh") }));
  vi.mocked(api.retryModelRequest).mockRejectedValueOnce(
    new api.ApiError(409, { code: "LLM_RETRY_STALE", error: "expired" }),
  );
  await user.click(retryButton());
  await waitFor(() => expect(api.getSnapshot).toHaveBeenCalledTimes(2));
  expect(api.connectSessionEvents).toHaveBeenCalledTimes(2);
  await waitFor(() => expect(retryButton()).toHaveAttribute("aria-disabled", "false"));
  vi.mocked(api.retryModelRequest).mockRejectedValueOnce(new api.ApiError(404, { error: "runtime unavailable" }));
  await user.click(retryButton());
  expect(await screen.findByRole("alert")).toHaveTextContent("runtime unavailable");
  expect(api.retryModelRequest).toHaveBeenCalledTimes(2);
  expect(api.openSession).not.toHaveBeenCalled();
  expect(api.sendPrompt).not.toHaveBeenCalled();
  expect(api.getSnapshot).toHaveBeenCalledTimes(2);
});

it.each(["root", "direct", "nested"] as const)(
  "fences pending %s retry admission at parent rehydration before child refresh completes",
  async (scope) => {
    const user = userEvent.setup();
    const target = scope === "root" ? "root" : "custom";
    const recovery = failure(target);
    const summary = { ...child(target, scope === "nested" ? "writing" : "root"), llmRecovery: recovery };
    const snapshot = rootSnapshot({
      llmRecovery: scope === "root" ? recovery : null,
      subagents: scope === "root" ? [] : scope === "nested" ? [child("writing"), summary] : [summary],
    });
    if (scope !== "root")
      vi.mocked(api.getChildSnapshot).mockResolvedValueOnce(childSnapshot(target, { llmRecovery: recovery }));
    await mount(snapshot);
    if (scope !== "root") {
      await user.click(tabs().getByRole("button", { name: "Agent custom_0" }));
      await waitFor(() => expect(api.getChildSnapshot).toHaveBeenCalledOnce());
      await waitFor(() => expect(screen.getByText(/Retained partial answer/)).toBeVisible());
    }

    const receipt = deferred<Awaited<ReturnType<typeof api.retryModelRequest>>>();
    const refresh = deferred<ChildSessionSnapshotDto>();
    vi.mocked(api.retryModelRequest).mockReturnValueOnce(receipt.promise);
    if (scope !== "root") vi.mocked(api.getChildSnapshot).mockReturnValueOnce(refresh.promise);
    await user.click(retryButton());
    const signal = vi.mocked(api.retryModelRequest).mock.calls[0]?.[2];
    expect(signal?.aborted).toBe(false);
    emit({ type: "snapshot", ...snapshot });
    if (scope !== "root") await waitFor(() => expect(api.getChildSnapshot).toHaveBeenCalledTimes(2));

    await act(async () => receipt.reject(new Error("obsolete admission connection lost")));
    expect({ aborted: signal?.aborted, staleError: screen.queryByRole("alert")?.textContent ?? null }).toEqual({
      aborted: true,
      staleError: null,
    });
    expect(retryButton()).toHaveAttribute("aria-disabled", "false");
    expect(api.retryModelRequest).toHaveBeenCalledOnce();
    // This is intentionally after the fence assertions: no child body is needed to invalidate admission.
    if (scope !== "root") await act(async () => refresh.resolve(childSnapshot(target, { llmRecovery: recovery })));
    expect(api.abortSession).not.toHaveBeenCalled();
    expect(api.stopSession).not.toHaveBeenCalled();
    expect(api.openSession).not.toHaveBeenCalled();
    expect(api.sendPrompt).not.toHaveBeenCalled();
  },
);

it.each([
  { scope: "direct", source: "agent" as const },
  { scope: "nested", source: "compaction" as const },
])(
  "keeps late $scope child history but rejects its old $source retry after deactivation",
  async ({ scope, source }) => {
    const user = userEvent.setup();
    const automaticRetry = { ...backoff("obsolete child backoff"), source };
    const summary = { ...child("custom", scope === "nested" ? "writing" : "root"), automaticRetry };
    const snapshot = rootSnapshot({ subagents: scope === "nested" ? [child("writing"), summary] : [summary] });
    const read = deferred<ChildSessionSnapshotDto>();
    vi.mocked(api.getChildSnapshot).mockReturnValueOnce(read.promise);
    await mount(snapshot);
    await user.click(tabs().getByRole("button", { name: "Agent custom_0" }));
    await waitFor(() => expect(api.getChildSnapshot).toHaveBeenCalledOnce());
    expect(screen.getByText("obsolete child backoff")).toBeVisible();
    emit({ type: "session_deactivated" });
    expect(screen.queryByText("obsolete child backoff")).toBeNull();

    await act(async () => read.resolve(childSnapshot("custom", { automaticRetry })));
    expect(await screen.findByText(/Retained partial answer/)).toBeVisible();
    expect(screen.queryByText("obsolete child backoff")).toBeNull();
    expect(screen.queryByText(/Retrying API call/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry model request" })).toBeNull();

    const freshRetry = { ...automaticRetry, errorMessage: "fresh child backoff", remainingMs: 1000 };
    vi.mocked(api.getChildSnapshot).mockResolvedValue(childSnapshot("custom", { automaticRetry: freshRetry }));
    emit({
      type: "snapshot",
      ...rootSnapshot({
        subagents: snapshot.subagents.map((item) =>
          item.childSessionId === "custom" ? { ...item, automaticRetry: freshRetry } : item,
        ),
      }),
    });
    expect(await screen.findByText("fresh child backoff")).toBeVisible();
    expect(screen.queryByText("obsolete child backoff")).toBeNull();
    expect(api.abortSession).not.toHaveBeenCalled();
    expect(api.stopSession).not.toHaveBeenCalled();
  },
);
