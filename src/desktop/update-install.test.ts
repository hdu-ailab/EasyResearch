import { expect, it, vi } from "vitest";
import { createDesktopSidecarOwnership } from "./lifecycle";
import { DesktopUpdateCleanupError, installDesktopUpdate } from "./update-install";

function fixture() {
  const ownership = createDesktopSidecarOwnership();
  const helper = { commit: vi.fn(async () => {}), abort: vi.fn(async () => {}) };
  const prepare = vi.fn(async () => helper);
  const shutdown = vi.fn(async () => {});
  const admit = vi.fn(async () => ({ ok: true as const }));
  const committed = vi.fn(); const quit = vi.fn();
  return { ownership, helper, prepare, admit, force: false, shutdown, committed, quit, signal: new AbortController().signal };
}

it("synchronously fences launches, stops owned work, then commits custody before host quit", async () => {
  const f = fixture(); const order: string[] = [];
  f.prepare.mockImplementation(async () => { expect(f.ownership.acceptingLaunches).toBe(false); order.push("prepare"); return f.helper; });
  f.shutdown.mockImplementation(async () => { order.push("stop"); });
  f.helper.commit.mockImplementation(async () => { order.push("commit"); });
  f.quit.mockImplementation(() => { order.push("quit"); });
  const installing = installDesktopUpdate(f);
  expect(f.ownership.acceptingLaunches).toBe(false);
  await installing;
  expect(order).toEqual(["prepare", "stop", "commit", "quit"]);
  expect(f.ownership.acceptingLaunches).toBe(false);
  expect(f.helper.abort).not.toHaveBeenCalled();
});

it.each([false, true])("performs the final admission gate after preparation even with force=%s", async (force) => {
  const f = fixture(); let prepared = false;
  f.prepare.mockImplementation(async () => { prepared = true; return f.helper; });
  f.admit.mockImplementation(async () => { expect(prepared).toBe(true); return { ok: true }; });
  await installDesktopUpdate({ ...f, force });
  expect(f.admit).toHaveBeenCalledWith(force, f.signal);
});

it("a newly busy daemon aborts the prepared helper and restores admission without stopping Agents", async () => {
  const f = fixture();
  const busy = { code: "RUNTIME_BUSY" as const, activeSessions: 2, authFlowActive: true };
  const admit = vi.fn(async () => busy);
  expect(await installDesktopUpdate({ ...f, admit })).toEqual(busy);
  expect(f.helper.abort).toHaveBeenCalledOnce(); expect(f.ownership.acceptingLaunches).toBe(true);
  expect(f.shutdown).not.toHaveBeenCalled(); expect(f.helper.commit).not.toHaveBeenCalled(); expect(f.quit).not.toHaveBeenCalled();
});

it("never commits an installer after failed cleanup and reopens only precommit admission", async () => {
  const f = fixture(); f.shutdown.mockRejectedValue(new Error("still owned"));
  await expect(installDesktopUpdate(f)).rejects.toThrow("still owned");
  expect(f.helper.abort).toHaveBeenCalledOnce();
  expect(f.helper.commit).not.toHaveBeenCalled(); expect(f.quit).not.toHaveBeenCalled();
  expect(f.ownership.acceptingLaunches).toBe(true);
});

it("Exit during preparation aborts the owned helper and never reopens terminal admission", async () => {
  const f = fixture(); const abort = new AbortController();
  f.prepare.mockImplementation(async () => { f.ownership.closeLaunchAdmission(); abort.abort(); return f.helper; });
  await expect(installDesktopUpdate({ ...f, signal: abort.signal })).rejects.toThrow();
  expect(f.helper.abort).toHaveBeenCalledOnce();
  expect(f.helper.commit).not.toHaveBeenCalled(); expect(f.quit).not.toHaveBeenCalled();
  expect(f.ownership.acceptingLaunches).toBe(false);
});

it("failed helper cleanup retains closed admission and is reported instead of quitting", async () => {
  const f = fixture(); f.shutdown.mockRejectedValue(new Error("stop failed"));
  f.helper.abort.mockRejectedValue(new Error("helper remains live"));
  await expect(installDesktopUpdate(f)).rejects.toThrow(/cleanup/i);
  expect(f.ownership.acceptingLaunches).toBe(false); expect(f.quit).not.toHaveBeenCalled();
});

it("does not reopen admission when preparation failed with an owned surviving helper", async () => {
  const f = fixture(); f.prepare.mockRejectedValue(new DesktopUpdateCleanupError([new Error("helper still alive")]));
  await expect(installDesktopUpdate(f)).rejects.toThrow(/cleanup/i);
  expect(f.ownership.acceptingLaunches).toBe(false); expect(f.quit).not.toHaveBeenCalled();
});
