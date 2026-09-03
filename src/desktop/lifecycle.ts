import type {
  DesktopReadyEvent,
  DesktopRestartRequestedEvent,
} from "./contracts";
import type { DesktopSidecarExit, DesktopSidecarProcessHandle } from "./sidecar";

export interface DesktopLifecycleState {
  readonly exiting: boolean;
}

export function createDesktopLifecycleState(): DesktopLifecycleState {
  return { exiting: false };
}

export function beginDesktopExit(state: DesktopLifecycleState): DesktopLifecycleState {
  return state.exiting ? state : { exiting: true };
}

export function handleWindowClose(state: DesktopLifecycleState): {
  action: "hide" | "close";
  state: DesktopLifecycleState;
} {
  return { action: state.exiting ? "close" : "hide", state };
}

export interface DesktopSidecarLifecycleHandle {
  readonly ready: Pick<DesktopReadyEvent, "bootId" | "logPath">;
  readonly restartRequested: Promise<DesktopRestartRequestedEvent>;
  readonly exited: Promise<DesktopSidecarExit>;
  forceTerminate(): void;
}

export interface DesktopLifecycleDeadline {
  readonly expired: Promise<void>;
  cancel(): void;
}

export interface DesktopSidecarLifecycleOptions {
  isCurrent(): boolean;
  isExiting(): boolean;
  captureRoute(): string;
  showRestarting(hash: string): void;
  clearCurrent(): void;
  startSuccessor(hash: string): Promise<boolean>;
  showStartupFailure(hash: string): Promise<void>;
  showUnexpectedExit(logPath: string): Promise<void>;
  onCleanupError?(error: unknown): void;
  expectedRestartExitTimeoutMs?: number;
  forcedRestartExitTimeoutMs?: number;
  createDeadline?: (timeoutMs: number) => DesktopLifecycleDeadline;
}

export type DesktopSidecarDisposition =
  | "ignored"
  | "restarted"
  | "restart-failed"
  | "unexpected";

export const EXPECTED_RESTART_EXIT_TIMEOUT_MS = 15_000;
export const FORCED_RESTART_EXIT_TIMEOUT_MS = 5_000;

export async function monitorDesktopSidecarLifecycle(
  handle: DesktopSidecarLifecycleHandle,
  options: DesktopSidecarLifecycleOptions,
): Promise<DesktopSidecarDisposition> {
  let retainedHash: string | undefined;
  const prepareExpectedRestart = (): boolean => {
    if (retainedHash !== undefined) return true;
    if (!options.isCurrent() || options.isExiting()) return false;
    retainedHash = options.captureRoute();
    options.showRestarting(retainedHash);
    return true;
  };
  let resolveExpectedRestart!: () => void;
  const expectedRestart = new Promise<void>((resolve) => {
    resolveExpectedRestart = resolve;
  });
  void handle.restartRequested.then((event) => {
    if (event.bootId === handle.ready.bootId && prepareExpectedRestart()) {
      resolveExpectedRestart();
    }
  });

  const first = await Promise.race([
    handle.exited.then((exit) => ({ kind: "exit" as const, exit })),
    expectedRestart.then(() => ({ kind: "restart" as const })),
  ]);
  let exit: DesktopSidecarExit;
  if (first.kind === "restart") {
    const createDeadline = options.createDeadline ?? createDesktopLifecycleDeadline;
    const graceful = await settleBeforeDeadline(
      handle.exited,
      options.expectedRestartExitTimeoutMs ?? EXPECTED_RESTART_EXIT_TIMEOUT_MS,
      createDeadline,
    );
    if (!graceful.settled) {
      if (!options.isCurrent() || options.isExiting()) return "ignored";
      try {
        handle.forceTerminate();
      } catch (error) {
        options.onCleanupError?.(error);
      }
      const forced = await settleBeforeDeadline(
        handle.exited,
        options.forcedRestartExitTimeoutMs ?? FORCED_RESTART_EXIT_TIMEOUT_MS,
        createDeadline,
      );
      if (!options.isCurrent() || options.isExiting()) return "ignored";
      if (forced.settled) options.clearCurrent();
      await options.showStartupFailure(retainedHash!);
      return "restart-failed";
    }
    exit = graceful.value;
  } else {
    exit = first.exit;
  }
  if (!options.isCurrent() || options.isExiting()) return "ignored";

  if (
    exit.code === 0
    && exit.signal === null
    && !exit.protocolError
    && exit.expectedRestart?.bootId === handle.ready.bootId
  ) {
    if (!prepareExpectedRestart()) return "ignored";
    const hash = retainedHash!;
    options.clearCurrent();
    let started = false;
    try {
      started = await options.startSuccessor(hash);
    } catch {
      // The existing startup recovery surface owns safe diagnostics and Retry.
    }
    if (started) return "restarted";
    if (!options.isExiting()) await options.showStartupFailure(hash);
    return "restart-failed";
  }

  options.clearCurrent();
  await options.showUnexpectedExit(handle.ready.logPath);
  return "unexpected";
}

export interface DesktopSidecarOwnership {
  readonly size: number;
  readonly acceptingLaunches: boolean;
  closeLaunchAdmission(): void;
  retain(handle: DesktopSidecarProcessHandle): void;
  shutdownAll(): Promise<void>;
}

export function createDesktopSidecarOwnership(): DesktopSidecarOwnership {
  const owned = new Set<DesktopSidecarProcessHandle>();
  let acceptingLaunches = true;
  let shutdownAttempt: Promise<void> | undefined;
  const drainOwned = async (): Promise<void> => {
    while (owned.size > 0) {
      const handles = [...owned];
      const results = await Promise.allSettled(handles.map(async (handle) => {
        await handle.shutdown();
        await handle.exited;
      }));
      const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      for (const [index, result] of results.entries()) {
        if (result.status === "fulfilled") owned.delete(handles[index]!);
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, "EasyResearch could not stop every owned Desktop sidecar.");
      }
    }
  };
  return {
    get size() {
      return owned.size;
    },
    get acceptingLaunches() {
      return acceptingLaunches;
    },
    closeLaunchAdmission() {
      acceptingLaunches = false;
    },
    retain(handle) {
      if (owned.has(handle)) return;
      owned.add(handle);
      void handle.exited.then(() => {
        owned.delete(handle);
      });
    },
    shutdownAll() {
      if (shutdownAttempt) return shutdownAttempt;
      const current = Promise.resolve().then(drainOwned);
      shutdownAttempt = current;
      void current.then(
        () => {
          if (shutdownAttempt === current) shutdownAttempt = undefined;
        },
        () => {
          if (shutdownAttempt === current) shutdownAttempt = undefined;
        },
      );
      return current;
    },
  };
}

export async function prepareDesktopSidecarLaunch(
  ownership: DesktopSidecarOwnership,
): Promise<boolean> {
  if (!ownership.acceptingLaunches) return false;
  if (ownership.size > 0) {
    await ownership.shutdownAll();
    if (!ownership.acceptingLaunches) return false;
  }
  return ownership.acceptingLaunches;
}

function createDesktopLifecycleDeadline(timeoutMs: number): DesktopLifecycleDeadline {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    expired: new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

async function settleBeforeDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  createDeadline: (timeoutMs: number) => DesktopLifecycleDeadline,
): Promise<{ settled: true; value: T } | { settled: false }> {
  const deadline = createDeadline(timeoutMs);
  try {
    return await Promise.race([
      operation.then((value) => ({ settled: true as const, value })),
      deadline.expired.then(() => ({ settled: false as const })),
    ]);
  } finally {
    deadline.cancel();
  }
}
