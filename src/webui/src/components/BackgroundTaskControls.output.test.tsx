import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackgroundTask, ShellOutputDto } from "../../../background/contracts";
import * as api from "../api";
import { ViewActivityProvider } from "../view-activity";
import { BackgroundTaskControls } from "./BackgroundTaskControls";

vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  getShellOutput: vi.fn(),
  replaceBackgroundOutputWatches: vi.fn(),
}));
const task: BackgroundTask = {
  id: "shell-a",
  sessionID: "root",
  kind: "shell",
  description: "Train",
  command: "python train.py",
  blocking: false,
  status: "running",
  startedAt: 1000,
};
function page(output: string, patch: Partial<ShellOutputDto> = {}): ShellOutputDto {
  const bytes = new TextEncoder().encode(output).length;
  return {
    id: task.id,
    sessionID: "root",
    command: "python train.py",
    status: "running",
    startedAt: 1000,
    exitCode: null,
    output,
    cursor: bytes,
    size: bytes,
    reset: false,
    truncated: false,
    ...patch,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup() {
  const listeners = new Set<(id: string) => void>();
  const props = {
    rootId: "root",
    tasks: [task],
    leaseId: "lease",
    pending: [],
    error: null,
    disabled: false,
    onCancel: vi.fn().mockResolvedValue(true),
    onPromote: vi.fn().mockResolvedValue(true),
    subscribeOutput: (listener: (id: string) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const emit = (id = task.id) =>
    act(() => {
      for (const listener of listeners) listener(id);
    });
  const rendered = render(<BackgroundTaskControls {...props} />);
  const user = userEvent.setup();
  const open = async () => {
    await user.click(screen.getByRole("button", { name: /Running tasks/ }));
    await user.click(screen.getByRole("button", { name: "View command output: Train" }));
  };
  return { ...rendered, props, user, emit, open };
}
beforeEach(() => {
  vi.mocked(api.getShellOutput).mockReset().mockResolvedValue(page(""));
  vi.mocked(api.replaceBackgroundOutputWatches)
    .mockReset()
    .mockImplementation(async (_root, _lease, revision) => ({ applied: true, revision }));
});
afterEach(() => vi.useRealTimers());

describe("live selected shell output", () => {
  it.each(["output metadata", "task inventory"] as const)(
    "keeps Escape reachable when %s removes the focused Stop control",
    async (transition) => {
      vi.mocked(api.getShellOutput).mockResolvedValueOnce(page("working"));
      const f = setup();
      await f.open();
      await screen.findByText("working");
      screen.getByRole("button", { name: "Cancel command: Train" }).focus();
      vi.mocked(api.getShellOutput).mockResolvedValue(
        page(" done", { cursor: 12, size: 12, status: "completed", exitCode: 0 }),
      );
      if (transition === "output metadata") f.emit();
      else f.rerender(<BackgroundTaskControls {...f.props} tasks={[]} />);
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Exit 0"));
      expect(screen.getByRole("button", { name: "Back to tasks" })).toHaveFocus();
      await f.user.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(f.props.onCancel).not.toHaveBeenCalled();
    },
  );

  it("keeps keyboard focus inside the task list when a focused task finishes before a peer", async () => {
    const f = setup();
    const peer: BackgroundTask = { ...task, id: "peer", description: "Peer" };
    f.rerender(<BackgroundTaskControls {...f.props} tasks={[task, peer]} />);
    await f.user.click(screen.getByRole("button", { name: /Running tasks/ }));
    screen.getByRole("button", { name: "Cancel command: Train" }).focus();
    f.rerender(<BackgroundTaskControls {...f.props} tasks={[peer]} />);
    expect(screen.getByRole("dialog")).toContainElement(document.activeElement as HTMLElement);
    expect(document.activeElement).not.toBe(document.body);
    await f.user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(f.props.onCancel).not.toHaveBeenCalled();
  });

  it("does not turn the visible elapsed clock into output polling", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const user = userEvent.setup();
    const rendered = render(
      <BackgroundTaskControls
        rootId="root"
        tasks={[task]}
        leaseId="lease"
        pending={[]}
        error={null}
        disabled={false}
        onCancel={vi.fn()}
        onPromote={vi.fn()}
      />,
    );
    try {
      await user.click(screen.getByRole("button", { name: /Running tasks/ }));
      await user.click(screen.getByRole("button", { name: "View command output: Train" }));
      await act(async () => {
        await Promise.resolve();
      });
      expect(api.getShellOutput).toHaveBeenCalledTimes(1);
      act(() => vi.advanceTimersByTime(10000));
      expect(api.getShellOutput).toHaveBeenCalledTimes(1);
      expect(api.replaceBackgroundOutputWatches).toHaveBeenCalledTimes(1);
    } finally {
      rendered.unmount();
      vi.useRealTimers();
    }
  });

  it("caps an appended selected cache at 64 KiB even for an unbroken line", async () => {
    vi.mocked(api.getShellOutput)
      .mockResolvedValueOnce(page("a".repeat(60000)))
      .mockResolvedValueOnce(page("b".repeat(60000), { cursor: 120000, size: 120000 }));
    const f = setup();
    await f.open();
    await waitFor(() => expect(screen.getByRole("region", { name: "Command output" }).textContent?.length).toBe(60000));
    f.emit();
    await waitFor(() => expect(screen.getByRole("region", { name: "Command output" }).textContent?.length).toBe(65536));
    expect(screen.getByRole("region", { name: "Command output" }).textContent).toBe(
      "a".repeat(5536) + "b".repeat(60000),
    );
  });

  it("subscribes before reading and coalesces append races into one cursor-following read", async () => {
    const registration = deferred<{ applied: boolean; revision: number }>();
    vi.mocked(api.replaceBackgroundOutputWatches).mockReturnValueOnce(registration.promise);
    const first = deferred<ShellOutputDto>(),
      second = deferred<ShellOutputDto>();
    vi.mocked(api.getShellOutput).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const f = setup();
    expect(api.getShellOutput).not.toHaveBeenCalled();
    await f.open();
    expect(screen.getByRole("button", { name: "Back to tasks" })).toHaveFocus();
    expect(api.getShellOutput).not.toHaveBeenCalled();
    f.emit();
    await act(async () => registration.resolve({ applied: true, revision: 1 }));
    expect(api.getShellOutput).toHaveBeenCalledWith("root", task.id, undefined, expect.any(AbortSignal));
    f.emit();
    f.emit();
    f.emit("different-shell");
    expect(api.getShellOutput).toHaveBeenCalledTimes(1);
    const raw = "\x1b[31m阶段一\r\x1b[";
    const offset = new TextEncoder().encode(raw).length;
    await act(async () => first.resolve(page(raw)));
    expect(api.getShellOutput).toHaveBeenCalledTimes(2);
    expect(api.getShellOutput).toHaveBeenLastCalledWith("root", task.id, offset, expect.any(AbortSignal));
    const extra = "0m阶段二\r\nready";
    const end = offset + new TextEncoder().encode(extra).length;
    await act(async () => second.resolve(page(extra, { cursor: end, size: end })));
    const output = screen.getByRole("region", { name: "Command output" });
    expect(output.textContent).toBe("阶段一\n阶段二\nready");
    expect(output).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("button", { name: "Cancel command: Train" })).toBeEnabled();
    expect(api.getShellOutput).toHaveBeenCalledTimes(2);
    // Advancing the elapsed clock must never read output or send a model prompt.
    await f.user.keyboard("{Escape}");
    await waitFor(() => expect(api.replaceBackgroundOutputWatches).toHaveBeenLastCalledWith("root", "lease", 2, []));
    expect(f.props.onCancel).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("drains final pages, retains selected terminal output after inventory removal, and resets bounded tails", async () => {
    vi.mocked(api.getShellOutput)
      .mockResolvedValueOnce(page("first"))
      .mockResolvedValueOnce(page("reset", { cursor: 100, size: 100, reset: true }))
      .mockResolvedValueOnce(page(" last", { cursor: 105, size: 110, status: "completed", exitCode: 3 }))
      .mockResolvedValueOnce(page(" done", { cursor: 110, size: 110, status: "completed", exitCode: 3 }));
    const f = setup();
    await f.open();
    await screen.findByText("first");
    f.emit();
    await screen.findByText("reset");
    f.rerender(<BackgroundTaskControls {...f.props} tasks={[]} />);
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Command output" })).toHaveTextContent("reset last done"),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Exit 3");
    expect(screen.queryByRole("button", { name: "Cancel command: Train" })).toBeNull();
    expect(api.getShellOutput).toHaveBeenCalledTimes(4);
    await f.user.click(screen.getByRole("button", { name: "Close tasks" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(f.props.onCancel).not.toHaveBeenCalled();
  });

  it("waits for a new invalidation on partial UTF-8 with no cursor progress", async () => {
    vi.mocked(api.getShellOutput).mockResolvedValue(page("", { cursor: 0, size: 2 }));
    const f = setup();
    await f.open();
    await screen.findByText("No output yet");
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.getShellOutput).toHaveBeenCalledTimes(1);
    vi.mocked(api.getShellOutput).mockResolvedValueOnce(page("汉", { cursor: 3, size: 3 }));
    f.emit();
    await screen.findByText("汉");
    expect(api.getShellOutput).toHaveBeenCalledTimes(2);
  });

  it("does not expose stale selection reads and distinguishes unavailable output from an empty stream", async () => {
    const first = deferred<ShellOutputDto>();
    vi.mocked(api.getShellOutput)
      .mockReturnValueOnce(first.promise)
      .mockRejectedValueOnce(new api.ApiError(404, { error: "Gone" }));
    const f = setup();
    await f.open();
    const signal = vi.mocked(api.getShellOutput).mock.calls[0]![3]!;
    await f.user.click(screen.getByRole("button", { name: "Back to tasks" }));
    expect(signal.aborted).toBe(true);
    await f.user.click(screen.getByRole("button", { name: "View command output: Train" }));
    await screen.findByText("Command output is unavailable.");
    await act(async () => first.resolve(page("obsolete")));
    expect(screen.queryByText("obsolete")).toBeNull();
    expect(screen.queryByText("No output yet")).toBeNull();
    vi.mocked(api.getShellOutput).mockResolvedValueOnce(page("recovered"));
    await f.user.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("recovered");
  });

  it("releases hidden/inactive watches and aborts reads without cancelling work", async () => {
    const listeners = new Set<(id: string) => void>();
    const subscribeOutput = (listener: (id: string) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    };
    const onCancel = vi.fn();
    const props = {
      rootId: "root",
      tasks: [task],
      leaseId: "lease",
      subscribeOutput,
      pending: [],
      error: null,
      disabled: false,
      onCancel,
      onPromote: vi.fn(),
    };
    const view = (visible: boolean) => (
      <>
        <button type="button">Other view action</button>
        <ViewActivityProvider visible={visible} interactive={visible}>
          <BackgroundTaskControls {...props} />
        </ViewActivityProvider>
      </>
    );
    vi.mocked(api.getShellOutput).mockResolvedValueOnce(page("live"));
    const f = render(view(true));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Running tasks/ }));
    await user.click(screen.getByRole("button", { name: "View command output: Train" }));
    await screen.findByText("live");
    const blocked = deferred<ShellOutputDto>();
    vi.mocked(api.getShellOutput).mockReturnValueOnce(blocked.promise);
    act(() => {
      for (const listener of listeners) listener(task.id);
    });
    const signal = vi.mocked(api.getShellOutput).mock.calls.at(-1)![3]!;
    screen.getByRole("button", { name: "Cancel command: Train" }).focus();
    f.rerender(view(false));
    await user.click(screen.getByRole("button", { name: "Other view action" }));
    expect(signal.aborted).toBe(true);
    expect(listeners.size).toBe(0);
    expect(api.replaceBackgroundOutputWatches).toHaveBeenLastCalledWith("root", "lease", 2, []);
    await act(async () => blocked.resolve(page("stale", { cursor: 9, size: 9 })));
    vi.mocked(api.getShellOutput).mockResolvedValueOnce(page(" more", { cursor: 9, size: 9 }));
    f.rerender(view(true));
    await waitFor(() => expect(screen.getByRole("region", { name: "Command output" })).toHaveTextContent("live more"));
    expect(screen.getByRole("button", { name: "Other view action" })).toHaveFocus();
    expect(api.getShellOutput).toHaveBeenLastCalledWith("root", task.id, 4, expect.any(AbortSignal));
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
    expect(listeners.size).toBe(0);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onCancel).not.toHaveBeenCalled();
    visibility.mockRestore();
    f.unmount();
  });
});
