import { describe, expect, it, vi } from "vitest";
import {
  RuntimeRestartCoordinator,
  type RuntimeRestartCoordinatorOptions,
  type RuntimeRestartReservation,
} from "./runtime-restart";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fixture(overrides: Partial<RuntimeRestartCoordinatorOptions> = {}) {
  const reservation: RuntimeRestartReservation = {
    commit: vi.fn(),
    release: vi.fn(() => true),
  };
  const options: RuntimeRestartCoordinatorOptions = {
    bootId: "boot-old",
    activeWorkCount: vi.fn(() => 0),
    beginSessionShutdown: vi.fn(),
    activeAuthFlow: vi.fn(() => false),
    beginAuthShutdown: vi.fn(async () => {}),
    reserveOwnerTransition: vi.fn(async () => reservation),
    ...overrides,
  };
  return { coordinator: new RuntimeRestartCoordinator(options), options, reservation };
}

describe("RuntimeRestartCoordinator", () => {
  it("returns the first busy sample without reserving the owner transition", async () => {
    const { coordinator, options } = fixture({
      activeWorkCount: vi.fn(() => 2),
      activeAuthFlow: vi.fn(() => true),
    });

    await expect(coordinator.request({ force: false })).resolves.toEqual({
      code: "RUNTIME_BUSY",
      activeSessions: 2,
      authFlowActive: true,
    });
    expect(options.reserveOwnerTransition).not.toHaveBeenCalled();
    expect(options.beginSessionShutdown).not.toHaveBeenCalled();
    expect(options.beginAuthShutdown).not.toHaveBeenCalled();
  });

  it("releases a reservation when the final busy sample changes", async () => {
    const counts = [0, 1];
    const { coordinator, options, reservation } = fixture({
      activeWorkCount: vi.fn(() => counts.shift() ?? 1),
    });

    await expect(coordinator.request({ force: false })).resolves.toEqual({
      code: "RUNTIME_BUSY",
      activeSessions: 1,
      authFlowActive: false,
    });
    expect(reservation.release).toHaveBeenCalledOnce();
    expect(reservation.commit).not.toHaveBeenCalled();
    expect(options.beginSessionShutdown).not.toHaveBeenCalled();

    await expect(coordinator.request({ force: false })).resolves.toMatchObject({ code: "RUNTIME_BUSY" });
    expect(options.reserveOwnerTransition).toHaveBeenCalledTimes(1);
    expect(reservation.release).toHaveBeenCalledOnce();
  });

  it("force accepts active session and auth work", async () => {
    const { coordinator, options, reservation } = fixture({
      activeWorkCount: vi.fn(() => 3),
      activeAuthFlow: vi.fn(() => true),
    });

    await expect(coordinator.request({ force: true })).resolves.toEqual({
      accepted: true,
      bootId: "boot-old",
    });
    expect(options.beginSessionShutdown).toHaveBeenCalledOnce();
    expect(options.beginAuthShutdown).toHaveBeenCalledOnce();
    expect(reservation.commit).toHaveBeenCalledOnce();
    expect(reservation.release).not.toHaveBeenCalled();
  });

  it("closes both admissions and commits without yielding after the final sample", async () => {
    const order: string[] = [];
    let microtaskRan = false;
    let samples = 0;
    const reservation: RuntimeRestartReservation = {
      commit: () => order.push("commit"),
      release: () => {
        order.push("release");
      },
    };
    const { coordinator } = fixture({
      activeWorkCount: () => {
        samples += 1;
        order.push(`sessions:${samples}`);
        if (samples === 2) void Promise.resolve().then(() => {
          microtaskRan = true;
        });
        return 0;
      },
      activeAuthFlow: () => {
        order.push("auth-sample");
        return false;
      },
      beginSessionShutdown: () => {
        expect(microtaskRan).toBe(false);
        order.push("sessions-close");
      },
      beginAuthShutdown: () => {
        expect(microtaskRan).toBe(false);
        order.push("auth-close");
        return Promise.resolve();
      },
      reserveOwnerTransition: async () => {
        order.push("reserve");
        return reservation;
      },
    });

    await expect(coordinator.request({ force: false })).resolves.toEqual({
      accepted: true,
      bootId: "boot-old",
    });
    expect(order).toEqual([
      "sessions:1",
      "auth-sample",
      "reserve",
      "sessions:2",
      "auth-sample",
      "sessions-close",
      "auth-close",
      "commit",
    ]);
    expect(microtaskRan).toBe(true);
  });

  it("redacts owner transition reservation failures", async () => {
    const { coordinator } = fixture({
      reserveOwnerTransition: vi.fn(async () => {
        throw new Error("lease pid=321 at /private/runtime.lock");
      }),
    });

    const result = await coordinator.request({ force: false });

    expect(result).toEqual({ code: "RUNTIME_RESTARTING" });
    expect(JSON.stringify(result)).not.toMatch(/321|private|lock|lease/i);
  });

  it("rejects concurrent and post-acceptance calls as restarting", async () => {
    const pending = deferred<RuntimeRestartReservation>();
    const { coordinator, reservation } = fixture({
      reserveOwnerTransition: () => pending.promise,
    });

    const first = coordinator.request({ force: false });
    await expect(coordinator.request({ force: true })).resolves.toEqual({ code: "RUNTIME_RESTARTING" });
    pending.resolve(reservation);
    await expect(first).resolves.toEqual({ accepted: true, bootId: "boot-old" });
    await expect(coordinator.request({ force: true })).resolves.toEqual({ code: "RUNTIME_RESTARTING" });
    expect(reservation.commit).toHaveBeenCalledOnce();
  });

  it("releases an uncommitted reservation exactly once when commit fails", async () => {
    const reservation: RuntimeRestartReservation = {
      commit: vi.fn(() => {
        throw new Error("commit leaked /private/transition path");
      }),
      release: vi.fn(() => true),
    };
    const { coordinator } = fixture({
      reserveOwnerTransition: vi.fn(async () => reservation),
    });

    const result = await coordinator.request({ force: true });

    expect(result).toEqual({ code: "RUNTIME_RESTARTING" });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(reservation.commit).toHaveBeenCalledOnce();
    expect(reservation.release).toHaveBeenCalledOnce();
    await expect(coordinator.request({ force: true })).resolves.toEqual({ code: "RUNTIME_RESTARTING" });
    expect(reservation.release).toHaveBeenCalledOnce();
  });

  it("fails closed when reservation release cannot prove ownership release", async () => {
    const counts = [0, 1];
    const reservation: RuntimeRestartReservation = {
      commit: vi.fn(),
      release: vi.fn(() => false),
    };
    const { coordinator } = fixture({
      activeWorkCount: vi.fn(() => counts.shift() ?? 0),
      reserveOwnerTransition: vi.fn(async () => reservation),
    });

    await expect(coordinator.request({ force: false })).resolves.toEqual({ code: "RUNTIME_RESTARTING" });
    await expect(coordinator.request({ force: true })).resolves.toEqual({ code: "RUNTIME_RESTARTING" });
    expect(reservation.release).toHaveBeenCalledOnce();
  });

  it("suppresses asynchronous auth shutdown rejection after acceptance", async () => {
    const { coordinator, reservation } = fixture({
      beginAuthShutdown: vi.fn(() => Promise.reject(new Error("auth cleanup failed"))),
    });

    await expect(coordinator.request({ force: true })).resolves.toEqual({
      accepted: true,
      bootId: "boot-old",
    });
    expect(reservation.commit).toHaveBeenCalledOnce();
    await Promise.resolve();
  });
});
