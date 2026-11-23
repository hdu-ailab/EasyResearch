import type { DesktopSidecarOwnership } from "./lifecycle";
import type { UpdateActionResult } from "../runtime/update-contract";
export type DesktopUpdateBusy = Extract<UpdateActionResult, { code: "RUNTIME_BUSY" }>;

export interface DesktopUpdateCustodian {
  readonly exited?: Promise<unknown>;
  commit(): Promise<void>;
  abort(): Promise<void>;
}

/** Cleanup did not prove helper exit; callers must keep launch admission fenced. */
export class DesktopUpdateCleanupError extends AggregateError {
  constructor(errors: unknown[]) { super(errors, "Update helper cleanup failed."); }
}

/** Result-bearing cleanup. Ordinary terminal Exit is deliberately not an installer. */
export async function installDesktopUpdate(options: {
  ownership: DesktopSidecarOwnership;
  signal: AbortSignal;
  force: boolean;
  prepare(): Promise<DesktopUpdateCustodian>;
  admit(force: boolean, signal: AbortSignal): Promise<DesktopUpdateBusy | { ok: true }>;
  shutdown(): Promise<void>;
  committed(): void;
  quit(): void;
}): Promise<void | DesktopUpdateBusy> {
  const resume = options.ownership.pauseLaunchAdmission();
  let helper: DesktopUpdateCustodian | undefined;
  let committed = false;
  try {
    options.signal.throwIfAborted();
    helper = await options.prepare();
    options.signal.throwIfAborted();
    const admission = await options.admit(options.force, options.signal);
    options.signal.throwIfAborted();
    if ("code" in admission) {
      await helper.abort();
      resume();
      return admission;
    }
    await options.shutdown();
    options.signal.throwIfAborted();
    await helper.commit();
    committed = true;
    options.ownership.closeLaunchAdmission();
    options.committed();
    options.quit();
  } catch (error) {
    if (!committed) {
      if (error instanceof DesktopUpdateCleanupError) throw error;
      try { await helper?.abort(); }
      catch (cleanup) { throw new DesktopUpdateCleanupError([error, cleanup]); }
      resume();
    }
    throw error;
  }
}
