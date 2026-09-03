import { describe, expect, it, vi } from "vitest";
import {
  beginDesktopExit,
  createDesktopSidecarOwnership,
  createDesktopLifecycleState,
  handleWindowClose,
  monitorDesktopSidecarLifecycle,
} from "./lifecycle";
import * as lifecycleModule from "./lifecycle";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function manualDeadline() {
  const elapsed = deferred<void>();
  return {
    elapsed,
    deadline: { expired: elapsed.promise, cancel: vi.fn() },
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

describe("desktop window lifecycle", () => {
  it("hides an ordinary window close while Agents remain owned", () => {
    const state = createDesktopLifecycleState();
    expect(handleWindowClose(state)).toEqual({ action: "hide", state });
  });

  it("allows the window to close after terminal Exit begins", () => {
    const exiting = beginDesktopExit(createDesktopLifecycleState());
    expect(handleWindowClose(exiting)).toEqual({ action: "close", state: exiting });
  });

  it("makes terminal Exit one-way and idempotent", () => {
    const exiting = beginDesktopExit(createDesktopLifecycleState());
    expect(beginDesktopExit(exiting)).toBe(exiting);
    expect(exiting.exiting).toBe(true);
  });
});

describe("desktop sidecar lifecycle", () => {
  function fixture() {
    const restartSignal = deferred<{ type: "desktop.restart-requested"; bootId: string }>();
    let transitionAvailable = false;
    const restartRequested = {
      promise: restartSignal.promise,
      resolve(event: { type: "desktop.restart-requested"; bootId: string }) {
        transitionAvailable = true;
        restartSignal.resolve(event);
      },
    };
    const exited = deferred<{
      code: number | null;
      signal: NodeJS.Signals | null;
      expectedRestart?: { type: "desktop.restart-requested"; bootId: string };
      protocolError?: string;
    }>();
    let current = true;
    let exiting = false;
    const order: string[] = [];
    let transitionHeld = true;
    const restartTransition = {
      path: "/tmp/server.transition.lease",
      token: "electron-transition-token",
      get held() {
        return transitionHeld;
      },
      reserveHandoff: vi.fn(),
      release: vi.fn(() => {
        if (!transitionHeld) return false;
        transitionHeld = false;
        return true;
      }),
    };
    const options = {
      isCurrent: () => current,
      isExiting: () => exiting,
      captureRoute: () => {
        order.push("capture-route");
        return "#/work/session%20one?cwd=%2Fpaper%20one";
      },
      showRestarting: () => order.push("show-restarting"),
      clearCurrent: () => {
        current = false;
        order.push("clear-current");
      },
      startSuccessor: vi.fn(async (hash: string, transition: typeof restartTransition) => {
        expect(transition).toBe(restartTransition);
        order.push(`start:${hash}`);
        transition.release();
        return true;
      }),
      showStartupFailure: vi.fn(async (hash: string) => {
        order.push(`startup-failure:${hash}`);
      }),
      showUnexpectedExit: vi.fn(async (logPath: string) => {
        order.push(`unexpected:${logPath}`);
      }),
    };
    const handle = {
      ready: { bootId: "boot-old", logPath: "/tmp/sidecar.log" },
      restartRequested: restartRequested.promise,
      exited: exited.promise,
      forceTerminate: vi.fn(),
      takeRestartTransition: vi.fn(() => {
        if (!transitionAvailable) throw new Error("no transferred transition");
        transitionAvailable = false;
        return restartTransition;
      }),
    };
    return {
      handle,
      restartRequested,
      exited,
      options,
      order,
      restartTransition,
      makeTransitionAvailable() {
        transitionAvailable = true;
      },
      setCurrent(value: boolean) {
        current = value;
      },
      setExiting(value: boolean) {
        exiting = value;
      },
    };
  }

  it("replaces a matching clean sidecar once without showing the unexpected-exit dialog", async () => {
    const f = fixture();
    const monitored = monitorDesktopSidecarLifecycle(f.handle, f.options);

    f.restartRequested.resolve({ type: "desktop.restart-requested", bootId: "boot-old" });
    await Promise.resolve();
    expect(f.order).toEqual(["capture-route", "show-restarting"]);

    f.exited.resolve({
      code: 0,
      signal: null,
      expectedRestart: { type: "desktop.restart-requested", bootId: "boot-old" },
    });
    await expect(monitored).resolves.toBe("restarted");

    expect(f.order).toEqual([
      "capture-route",
      "show-restarting",
      "clear-current",
      "start:#/work/session%20one?cwd=%2Fpaper%20one",
    ]);
    expect(f.options.startSuccessor).toHaveBeenCalledOnce();
    expect(f.options.startSuccessor).toHaveBeenCalledWith(
      "#/work/session%20one?cwd=%2Fpaper%20one",
      f.restartTransition,
    );
    expect(f.restartTransition.held).toBe(false);
    expect(f.options.showUnexpectedExit).not.toHaveBeenCalled();
    expect(f.restartTransition.release).toHaveBeenCalledOnce();
    expect(f.options.showStartupFailure).not.toHaveBeenCalled();
  });

  it("uses startup recovery once without automatically looping a failed successor", async () => {
    const f = fixture();
    f.options.startSuccessor.mockResolvedValue(false);
    const monitored = monitorDesktopSidecarLifecycle(f.handle, f.options);

    f.restartRequested.resolve({ type: "desktop.restart-requested", bootId: "boot-old" });
    f.exited.resolve({
      code: 0,
      signal: null,
      expectedRestart: { type: "desktop.restart-requested", bootId: "boot-old" },
    });
    await expect(monitored).resolves.toBe("restart-failed");

    expect(f.options.startSuccessor).toHaveBeenCalledOnce();
    expect(f.options.showStartupFailure).toHaveBeenCalledOnce();
    expect(f.options.showStartupFailure).toHaveBeenCalledWith(
      "#/work/session%20one?cwd=%2Fpaper%20one",
    );
    expect(f.options.showUnexpectedExit).not.toHaveBeenCalled();
    expect(f.restartTransition.held).toBe(false);
    expect(f.restartTransition.release).toHaveBeenCalledOnce();
  });

  it("force-terminates a stalled expected restart and reaches recovery after a second bounded wait", async () => {
    const f = fixture();
    const graceful = manualDeadline();
    const forced = manualDeadline();
    const deadlines = [graceful.deadline, forced.deadline];
    const createDeadline = vi.fn(() => deadlines.shift()!);
    const options = {
      ...f.options,
      expectedRestartExitTimeoutMs: 41,
      forcedRestartExitTimeoutMs: 17,
      createDeadline,
    };
    let settled = false;
    const monitored = monitorDesktopSidecarLifecycle(f.handle, options).finally(() => {
      settled = true;
    });

    f.restartRequested.resolve({ type: "desktop.restart-requested", bootId: "boot-old" });
    await flushMicrotasks();
    graceful.elapsed.resolve();
    await flushMicrotasks();
    forced.elapsed.resolve();
    await flushMicrotasks();
    if (!settled) {
      f.exited.resolve({ code: null, signal: "SIGKILL" });
    }

    await expect(monitored).resolves.toBe("restart-failed");
    expect(createDeadline).toHaveBeenNthCalledWith(1, 41);
    expect(createDeadline).toHaveBeenNthCalledWith(2, 17);
    expect(f.handle.forceTerminate).toHaveBeenCalledOnce();
    expect(f.options.startSuccessor).not.toHaveBeenCalled();
    expect(f.options.showStartupFailure).toHaveBeenCalledOnce();
    expect(f.options.showUnexpectedExit).not.toHaveBeenCalled();
    expect(graceful.deadline.cancel).toHaveBeenCalledOnce();
    expect(forced.deadline.cancel).toHaveBeenCalledOnce();
  });

  it("reports a failed force termination without clearing the unsettled sidecar owner", async () => {
    const f = fixture();
    const forceError = new Error("taskkill exited with status 1");
    f.handle.forceTerminate.mockImplementation(() => {
      throw forceError;
    });
    const graceful = manualDeadline();
    const forced = manualDeadline();
    const deadlines = [graceful.deadline, forced.deadline];
    const onCleanupError = vi.fn();
    const monitored = monitorDesktopSidecarLifecycle(f.handle, {
      ...f.options,
      createDeadline: () => deadlines.shift()!,
      onCleanupError,
    } as never);

    f.restartRequested.resolve({ type: "desktop.restart-requested", bootId: "boot-old" });
    await flushMicrotasks();
    graceful.elapsed.resolve();
    await flushMicrotasks();
    forced.elapsed.resolve();

    await expect(monitored).resolves.toBe("restart-failed");
    expect(onCleanupError).toHaveBeenCalledWith(forceError);
    expect(f.order).not.toContain("clear-current");
    expect(f.options.startSuccessor).not.toHaveBeenCalled();
  });

  it("leaves a stalled expected restart to terminal Exit without forcing or showing recovery", async () => {
    const f = fixture();
    const graceful = manualDeadline();
    const createDeadline = vi.fn(() => graceful.deadline);
    const options = {
      ...f.options,
      expectedRestartExitTimeoutMs: 41,
      createDeadline,
    };
    let settled = false;
    const monitored = monitorDesktopSidecarLifecycle(f.handle, options).finally(() => {
      settled = true;
    });

    f.restartRequested.resolve({ type: "desktop.restart-requested", bootId: "boot-old" });
    await flushMicrotasks();
    f.setExiting(true);
    graceful.elapsed.resolve();
    await flushMicrotasks();
    if (!settled) f.exited.resolve({ code: 0, signal: null });

    await expect(monitored).resolves.toBe("ignored");
    expect(f.handle.forceTerminate).not.toHaveBeenCalled();
    expect(f.options.startSuccessor).not.toHaveBeenCalled();
    expect(f.options.showStartupFailure).not.toHaveBeenCalled();
    expect(f.options.showUnexpectedExit).not.toHaveBeenCalled();
    expect(f.restartTransition.held).toBe(true);
  });

  it("suppresses replacement and dialogs once terminal Exit begins", async () => {
    const f = fixture();
    f.setExiting(true);
    const monitored = monitorDesktopSidecarLifecycle(f.handle, f.options);

    f.restartRequested.resolve({ type: "desktop.restart-requested", bootId: "boot-old" });
    f.exited.resolve({
      code: 0,
      signal: null,
      expectedRestart: { type: "desktop.restart-requested", bootId: "boot-old" },
    });
    await expect(monitored).resolves.toBe("ignored");

    expect(f.order).toEqual([]);
    expect(f.options.startSuccessor).not.toHaveBeenCalled();
    expect(f.options.showStartupFailure).not.toHaveBeenCalled();
    expect(f.options.showUnexpectedExit).not.toHaveBeenCalled();
  });

  it.each([
    ["exit without an expected event", { code: 0, signal: null }],
    [
      "matching event with a nonzero exit",
      {
        code: 1,
        signal: null,
        expectedRestart: { type: "desktop.restart-requested" as const, bootId: "boot-old" },
      },
    ],
    [
      "mismatched event",
      {
        code: 1,
        signal: null,
        protocolError: "Desktop sidecar restart identity did not match readiness.",
      },
    ],
  ])("keeps $0 on the existing unexpected-exit path", async (_name, exit) => {
    const f = fixture();
    const monitored = monitorDesktopSidecarLifecycle(f.handle, f.options);

    f.exited.resolve(exit);
    await expect(monitored).resolves.toBe("unexpected");

    expect(f.options.startSuccessor).not.toHaveBeenCalled();
    expect(f.options.showStartupFailure).not.toHaveBeenCalled();
    expect(f.options.showUnexpectedExit).toHaveBeenCalledWith("/tmp/sidecar.log");
  });

  it("releases lazily recovered transition custody after an exit whose restart event was lost", async () => {
    const f = fixture();
    f.makeTransitionAvailable();
    const monitored = monitorDesktopSidecarLifecycle(f.handle, f.options);

    f.exited.resolve({ code: 1, signal: null });
    await expect(monitored).resolves.toBe("unexpected");

    expect(f.handle.takeRestartTransition).toHaveBeenCalledOnce();
    expect(f.restartTransition.release).toHaveBeenCalledOnce();
    expect(f.restartTransition.held).toBe(false);
  });

  it("ignores an old sidecar exit after ownership has moved", async () => {
    const f = fixture();
    f.setCurrent(false);
    const monitored = monitorDesktopSidecarLifecycle(f.handle, f.options);

    f.exited.resolve({ code: 0, signal: null });
    await expect(monitored).resolves.toBe("ignored");

    expect(f.order).toEqual([]);
  });
});

describe("desktop spawned-child ownership", () => {
  it("retains every old and launching child until exit and retries a failed force cleanup", async () => {
    const survivorExited = deferred<{ code: number | null; signal: NodeJS.Signals | null }>();
    const settledExited = deferred<{ code: number | null; signal: NodeJS.Signals | null }>();
    const survivor = {
      pid: 111,
      exited: survivorExited.promise,
      shutdown: vi.fn()
        .mockRejectedValueOnce(new Error("taskkill exited with status 1"))
        .mockImplementationOnce(async () => {
          survivorExited.resolve({ code: null, signal: "SIGKILL" });
        }),
      forceTerminate: vi.fn(),
    };
    const settled = {
      pid: 222,
      exited: settledExited.promise,
      shutdown: vi.fn(async () => {
        settledExited.resolve({ code: 0, signal: null });
      }),
      forceTerminate: vi.fn(),
    };
    expect(typeof createDesktopSidecarOwnership).toBe("function");
    if (typeof createDesktopSidecarOwnership !== "function") return;
    const ownership = createDesktopSidecarOwnership();
    ownership.retain(survivor);
    ownership.retain(settled);

    await expect(ownership.shutdownAll()).rejects.toThrow(/taskkill|status 1/i);
    expect(survivor.shutdown).toHaveBeenCalledOnce();
    expect(settled.shutdown).toHaveBeenCalledOnce();
    expect(ownership.size).toBe(1);

    await expect(ownership.shutdownAll()).resolves.toBeUndefined();
    expect(survivor.shutdown).toHaveBeenCalledTimes(2);
    expect(ownership.size).toBe(0);
  });

  it("closes child-launch admission synchronously for terminal shutdown", () => {
    const ownership = createDesktopSidecarOwnership() as ReturnType<typeof createDesktopSidecarOwnership> & {
      readonly acceptingLaunches: boolean;
      closeLaunchAdmission(): void;
    };

    expect(typeof ownership.closeLaunchAdmission).toBe("function");
    if (typeof ownership.closeLaunchAdmission !== "function") return;
    expect(ownership.acceptingLaunches).toBe(true);

    ownership.closeLaunchAdmission();

    expect(ownership.acceptingLaunches).toBe(false);
  });

  it("drains a child retained while an earlier shutdown snapshot is settling", async () => {
    const firstExited = deferred<{ code: number | null; signal: NodeJS.Signals | null }>();
    const lateExited = deferred<{ code: number | null; signal: NodeJS.Signals | null }>();
    const first = {
      pid: 111,
      exited: firstExited.promise,
      shutdown: vi.fn(async () => {}),
      forceTerminate: vi.fn(),
    };
    const late = {
      pid: 222,
      exited: lateExited.promise,
      shutdown: vi.fn(async () => {}),
      forceTerminate: vi.fn(),
    };
    const ownership = createDesktopSidecarOwnership();
    ownership.retain(first);
    const shutdownOutcome = ownership.shutdownAll().then(
      () => undefined,
      (error: unknown) => error,
    );
    await flushMicrotasks();
    ownership.retain(late);

    firstExited.resolve({ code: 0, signal: null });
    await flushMicrotasks();

    expect(late.shutdown).toHaveBeenCalledOnce();
    lateExited.resolve({ code: 0, signal: null });
    expect(await shutdownOutcome).toBeUndefined();
    expect(ownership.size).toBe(0);
  });

  it("shares one in-flight shutdown drain between Retry and terminal cleanup", async () => {
    const exited = deferred<{ code: number | null; signal: NodeJS.Signals | null }>();
    const handle = {
      pid: 111,
      exited: exited.promise,
      shutdown: vi.fn(async () => {}),
      forceTerminate: vi.fn(),
    };
    const ownership = createDesktopSidecarOwnership();
    ownership.retain(handle);

    const first = ownership.shutdownAll();
    const second = ownership.shutdownAll();
    await flushMicrotasks();

    expect(handle.shutdown).toHaveBeenCalledOnce();
    exited.resolve({ code: 0, signal: null });
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
  });

  it("rechecks launch admission after awaited cleanup before Retry can spawn", async () => {
    const prepareDesktopSidecarLaunch = (lifecycleModule as typeof lifecycleModule & {
      prepareDesktopSidecarLaunch(
        ownership: ReturnType<typeof createDesktopSidecarOwnership>,
      ): Promise<boolean>;
    }).prepareDesktopSidecarLaunch;
    expect(typeof prepareDesktopSidecarLaunch).toBe("function");
    if (typeof prepareDesktopSidecarLaunch !== "function") return;
    const exited = deferred<{ code: number | null; signal: NodeJS.Signals | null }>();
    const handle = {
      pid: 111,
      exited: exited.promise,
      shutdown: vi.fn(async () => {}),
      forceTerminate: vi.fn(),
    };
    const ownership = createDesktopSidecarOwnership() as ReturnType<typeof createDesktopSidecarOwnership> & {
      closeLaunchAdmission(): void;
    };
    ownership.retain(handle);

    const preparing = prepareDesktopSidecarLaunch(ownership);
    await flushMicrotasks();
    ownership.closeLaunchAdmission();
    exited.resolve({ code: 0, signal: null });

    await expect(preparing).resolves.toBe(false);
  });
});
