import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StatusDto, WorkspaceMutationResultDto } from "../../../web/contracts";
import * as api from "../api";
import { ViewActivityProvider } from "../view-activity";
import { HomePage, type HomePageProps } from "./HomePage";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  listStatus: vi.fn(),
  checkForUpdate: vi.fn(),
  createSession: vi.fn(),
  openSession: vi.fn(),
  touchSession: vi.fn(),
  stopSession: vi.fn(),
  renameSession: vi.fn(),
  deleteSession: vi.fn(),
  validateWorkspace: vi.fn(),
  renameWorkspace: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const initial: StatusDto = {
  bootId: "test-boot",
  agentDir: "/agent",
  homeDir: "/home/user",
  sessions: [
    {
      id: "history",
      path: "/agent/sessions/test.jsonl",
      cwd: "/project",
      name: "Cached paper",
      created: "2026-11-13T00:00:00.000Z",
      modified: "2026-11-13T00:00:00.000Z",
      messageCount: 4,
      firstMessage: "A research question",
    },
  ],
  activeSessions: [{ id: "active", cwd: "/project", sessionName: "Live work", status: "ready", isStreaming: false }],
};

function renamedStatus(name: string): StatusDto {
  return { ...initial, sessions: initial.sessions.map((session) => ({ ...session, name })) };
}

function home(visible = true, interactive = visible, props: Partial<HomePageProps> = {}) {
  return (
    <ViewActivityProvider visible={visible} interactive={interactive}>
      <HomePage embedded onOpenSession={vi.fn()} onOpenSettings={vi.fn()} settingsButton={null} {...props} />
    </ViewActivityProvider>
  );
}

async function elapse(ms: number) {
  await act(async () => vi.advanceTimersByTimeAsync(ms));
}

async function flush() {
  await act(async () => {});
}

type Mutation = "rename" | "disconnect" | "delete" | "workspace";
type Action = Mutation | "create" | "history" | "active";

async function perform(action: Action) {
  if (action === "rename") {
    fireEvent.click(screen.getByRole("button", { name: "Rename session: Cached paper" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Session name" }), { target: { value: "Renamed paper" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
  } else if (action === "delete") {
    fireEvent.click(screen.getByRole("button", { name: "Delete session: Cached paper" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
  } else if (action === "workspace") {
    fireEvent.click(screen.getByLabelText("Workspace actions: /project"));
    fireEvent.click(screen.getByRole("button", { name: "Edit workspace name" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Folder name"), { target: { value: "renamed" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Edit workspace name" }));
  } else if (action === "disconnect") {
    fireEvent.click(screen.getByRole("button", { name: /disconnect/i }));
  } else if (action === "create") {
    fireEvent.click(screen.getByRole("button", { name: "New session /project" }));
  } else {
    fireEvent.click(screen.getByText(action === "history" ? "Cached paper" : "Live work"));
  }
  await flush();
}

describe("Home status refresh ownership", () => {
  let documentVisibility: DocumentVisibilityState;

  function visibility(state: DocumentVisibilityState) {
    documentVisibility = state;
    fireEvent(document, new Event("visibilitychange"));
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    documentVisibility = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => documentVisibility);
    vi.mocked(api.listStatus).mockResolvedValue(initial);
    vi.mocked(api.checkForUpdate).mockResolvedValue({ latestVersion: null });
    vi.mocked(api.validateWorkspace).mockResolvedValue(undefined);
    vi.mocked(api.createSession).mockResolvedValue({ id: "new", cwd: "/project", status: "ready", isStreaming: false });
    vi.mocked(api.openSession).mockResolvedValue({
      id: "history",
      cwd: "/project",
      status: "ready",
      isStreaming: false,
    });
    vi.mocked(api.renameSession).mockResolvedValue(undefined);
    vi.mocked(api.deleteSession).mockResolvedValue(undefined);
    vi.mocked(api.stopSession).mockResolvedValue(undefined);
    vi.mocked(api.touchSession).mockResolvedValue(undefined);
    vi.mocked(api.renameWorkspace).mockResolvedValue({ cwd: "/renamed", sessionIds: ["history", "active"] });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("accepts slow reads without overlap and waits five seconds after each completion", async () => {
    const reads: ReturnType<typeof deferred<StatusDto>>[] = [];
    let inFlight = 0;
    let peakInFlight = 0;
    vi.mocked(api.listStatus).mockImplementation(() => {
      const read = deferred<StatusDto>();
      reads.push(read);
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      return read.promise.finally(() => {
        inFlight -= 1;
      });
    });
    const publish = vi.fn();
    const onStatusRequest = vi.fn(() => publish);
    render(home(true, true, { onStatusRequest }));

    await elapse(16_000);
    expect(inFlight).toBe(1);
    expect(api.listStatus).toHaveBeenCalledOnce();
    expect(onStatusRequest).toHaveBeenCalledOnce();
    await act(async () => reads[0]!.resolve(initial));
    expect(screen.getByText("Cached paper")).toBeVisible();
    expect(publish).toHaveBeenCalledExactlyOnceWith(initial);
    await elapse(4999);
    expect(api.listStatus).toHaveBeenCalledOnce();
    await elapse(1);
    expect(api.listStatus).toHaveBeenCalledTimes(2);
    await elapse(11_000);
    expect(inFlight).toBe(1);
    await act(async () => reads[1]!.resolve(renamedStatus("Slow fresh paper")));
    expect(screen.getByText("Slow fresh paper")).toBeVisible();
    expect(peakInFlight).toBe(1);
  });

  it.each(["view", "document"] as const)("defers the first read until the %s is visible", async (hidden) => {
    if (hidden === "document") documentVisibility = "hidden";
    const view = render(home(hidden !== "view"));
    await elapse(20_000);
    expect(api.listStatus).not.toHaveBeenCalled();
    if (hidden === "view") view.rerender(home());
    else visibility("visible");
    await flush();
    expect(api.listStatus).toHaveBeenCalledOnce();
    expect(screen.getByText("Cached paper")).toBeVisible();
  });

  it("keeps refreshing the visible Home behind Settings without restarting the read", async () => {
    const pending = deferred<StatusDto>();
    vi.mocked(api.listStatus).mockReturnValueOnce(pending.promise);
    const view = render(home());
    view.rerender(home(true, false));
    expect(api.listStatus).toHaveBeenCalledOnce();
    expect(vi.mocked(api.listStatus).mock.calls[0]?.[0]?.signal?.aborted).toBe(false);
    await act(async () => pending.resolve(initial));
    await elapse(5000);
    expect(api.listStatus).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["view", "resolve"],
    ["view", "reject"],
    ["document", "resolve"],
    ["document", "reject"],
  ] as const)("pauses a hidden %s and fences an old %s across immediate return", async (hidden, completion) => {
    const old = deferred<StatusDto>();
    const fresh = deferred<StatusDto>();
    const publish = vi.fn();
    const onStatusRequest = vi.fn(() => publish);
    const content = (visible: boolean) => home(visible, visible, { onStatusRequest });
    vi.mocked(api.listStatus)
      .mockResolvedValueOnce(initial)
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(fresh.promise);
    const view = render(content(true));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "/project" }));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Cached" } });
    await elapse(5000);
    const oldSignal = vi.mocked(api.listStatus).mock.calls[1]?.[0]?.signal;

    if (hidden === "view") view.rerender(content(false));
    else visibility("hidden");
    expect(oldSignal?.aborted).toBe(true);
    await elapse(20_000);
    expect(api.listStatus).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("searchbox")).toHaveValue("Cached");
    expect(screen.getByRole("button", { name: "/project" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByText("Cached paper")).toBeInTheDocument();

    if (hidden === "view") view.rerender(content(true));
    else visibility("visible");
    expect(api.listStatus).toHaveBeenCalledTimes(3);
    await act(async () => {
      if (completion === "resolve") old.resolve(renamedStatus("Obsolete paper"));
      else old.reject(new Error("Obsolete read failure"));
    });
    expect(publish).toHaveBeenCalledExactlyOnceWith(initial);
    expect(screen.getByText("Cached paper")).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
    await elapse(12_000);
    expect(api.listStatus).toHaveBeenCalledTimes(3);
    const next = renamedStatus("Cached fresh paper");
    await act(async () => fresh.resolve(next));
    expect(publish).toHaveBeenLastCalledWith(next);
    expect(screen.getByText("Cached fresh paper")).toBeVisible();
    await elapse(4999);
    expect(api.listStatus).toHaveBeenCalledTimes(3);
    await elapse(1);
    expect(api.listStatus).toHaveBeenCalledTimes(4);
    expect(api.stopSession).not.toHaveBeenCalled();
    expect(api.deleteSession).not.toHaveBeenCalled();

    // Suspending an idle owner also removes its already-scheduled refresh.
    if (hidden === "view") view.rerender(content(false));
    else visibility("hidden");
    await elapse(20_000);
    expect(api.listStatus).toHaveBeenCalledTimes(4);
  });

  it("owns StrictMode cleanup and unmount independently of late non-cooperative promises", async () => {
    const reads: ReturnType<typeof deferred<StatusDto>>[] = [];
    vi.mocked(api.listStatus).mockImplementation(() => {
      const read = deferred<StatusDto>();
      reads.push(read);
      return read.promise;
    });
    const publish = vi.fn();
    const onStatusRequest = vi.fn(() => publish);
    const view = render(<StrictMode>{home(true, true, { onStatusRequest })}</StrictMode>);
    expect(reads).toHaveLength(2);
    expect(vi.mocked(api.listStatus).mock.calls[0]?.[0]?.signal?.aborted).toBe(true);
    expect(vi.mocked(api.listStatus).mock.calls[1]?.[0]?.signal?.aborted).toBe(false);
    await act(async () => reads[0]!.resolve(renamedStatus("Obsolete StrictMode result")));
    expect(publish).not.toHaveBeenCalled();
    await act(async () => reads[1]!.resolve(initial));
    await elapse(5000);
    view.unmount();
    expect(vi.mocked(api.listStatus).mock.calls[2]?.[0]?.signal?.aborted).toBe(true);
    render(home(true, true, { onStatusRequest }));
    await act(async () => reads[2]!.reject(new Error("Disposed read failure")));
    await elapse(15_000);
    expect(reads).toHaveLength(4);
    await act(async () => reads[3]!.resolve(renamedStatus("Remounted paper")));
    expect(screen.getByText("Remounted paper")).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it.each(["rename", "disconnect", "delete", "workspace"] as const)(
    "replaces a pending status read after %s and captures publication at admission",
    async (mutation) => {
      const old = deferred<StatusDto>();
      const fresh = deferred<StatusDto>();
      const initialPublish = vi.fn();
      const oldPublish = vi.fn();
      const freshPublish = vi.fn();
      const onStatusRequest = vi
        .fn()
        .mockReturnValueOnce(initialPublish)
        .mockReturnValueOnce(oldPublish)
        .mockReturnValue(freshPublish);
      vi.mocked(api.listStatus)
        .mockResolvedValueOnce(initial)
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(fresh.promise);
      render(home(true, true, { onStatusRequest }));
      await flush();
      await elapse(5000);
      const oldSignal = vi.mocked(api.listStatus).mock.calls[1]?.[0]?.signal;
      await perform(mutation);
      expect(oldSignal?.aborted).toBe(true);
      expect(api.listStatus).toHaveBeenCalledTimes(3);
      expect(onStatusRequest).toHaveBeenCalledTimes(3);
      await act(async () => old.resolve(initial));
      expect(oldPublish).not.toHaveBeenCalled();
      await elapse(11_000);
      expect(api.listStatus).toHaveBeenCalledTimes(3);
      const next: StatusDto = { ...initial, sessions: [], activeSessions: [] };
      await act(async () => fresh.resolve(next));
      expect(freshPublish).toHaveBeenCalledExactlyOnceWith(next);
      expect(initialPublish).toHaveBeenCalledExactlyOnceWith(initial);
      await elapse(5000);
      expect(api.listStatus).toHaveBeenCalledTimes(4);
    },
  );

  it.each(["rename", "delete", "workspace"] as const)(
    "publishes an admitted hidden %s mutation but defers its status read until return",
    async (action) => {
      const pending = deferred<void>();
      const workspace = deferred<WorkspaceMutationResultDto>();
      vi.mocked(api.renameSession).mockReturnValue(pending.promise);
      vi.mocked(api.deleteSession).mockReturnValue(pending.promise);
      vi.mocked(api.renameWorkspace).mockReturnValue(workspace.promise);
      const mutation = { renamed: vi.fn(), deleted: vi.fn(), workspace: vi.fn() };
      const onCatalogMutationStart = vi.fn(() => mutation);
      const onStatusRequest = vi.fn(() => vi.fn());
      const content = (visible: boolean) => home(visible, visible, { onCatalogMutationStart, onStatusRequest });
      const view = render(content(true));
      await flush();
      await perform(action);
      view.rerender(content(false));
      await act(async () => {
        if (action === "workspace") workspace.resolve({ cwd: "/renamed", sessionIds: ["history", "active"] });
        else pending.resolve();
      });
      if (action === "rename") expect(mutation.renamed).toHaveBeenCalledExactlyOnceWith("history", "Renamed paper");
      else if (action === "delete") expect(mutation.deleted).toHaveBeenCalledExactlyOnceWith("history");
      else
        expect(mutation.workspace).toHaveBeenCalledExactlyOnceWith(
          "/project",
          { cwd: "/renamed", sessionIds: ["history", "active"] },
          false,
        );
      await elapse(20_000);
      expect(api.listStatus).toHaveBeenCalledOnce();
      expect(onStatusRequest).toHaveBeenCalledOnce();
      view.rerender(content(true));
      expect(api.listStatus).toHaveBeenCalledTimes(2);
      expect(onStatusRequest).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["create", "history", "active", "rename", "disconnect"] as const)(
    "keeps a newer %s failure through automatic reads and clears it on explicit retry",
    async (action) => {
      const pending = deferred<StatusDto>();
      vi.mocked(api.listStatus).mockResolvedValueOnce(initial).mockReturnValueOnce(pending.promise);
      const actionApi = {
        create: api.createSession,
        history: api.openSession,
        active: api.touchSession,
        rename: api.renameSession,
        disconnect: api.stopSession,
      }[action];
      vi.mocked(actionApi).mockRejectedValueOnce(new Error("Action could not finish"));
      render(home());
      await flush();
      await elapse(5000);
      await perform(action);
      expect(screen.getByText("Action could not finish")).toBeVisible();
      await act(async () => pending.resolve(initial));
      expect(screen.getByText("Action could not finish")).toBeVisible();
      await elapse(5000);
      expect(screen.getByText("Action could not finish")).toBeVisible();
      await perform(action);
      expect(screen.queryByText("Action could not finish")).toBeNull();
    },
  );

  it("recovers a status failure only when its next read succeeds", async () => {
    const recovery = deferred<StatusDto>();
    vi.mocked(api.listStatus)
      .mockRejectedValueOnce(new Error("Status unavailable"))
      .mockReturnValueOnce(recovery.promise);
    render(home());
    await flush();
    expect(screen.getByRole("alert")).toHaveTextContent("Status unavailable");
    await elapse(5000);
    expect(screen.getByRole("alert")).toHaveTextContent("Status unavailable");
    await act(async () => recovery.resolve(initial));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Cached paper")).toBeVisible();
  });
});
