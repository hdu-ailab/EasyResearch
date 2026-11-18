import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { LlmRecoveryDto } from "../../../web/contracts";
import { llmRetryConflict, retryModelRequest } from "../api";
import { useViewActivityRef } from "../view-activity";

interface RecoveryOptions {
  rootId: string;
  targetSessionId: string;
  parentHydrationRevision: number;
  hydrationRevision: number;
  recovery: LlmRecoveryDto | null | undefined;
  enabled: boolean;
  refresh(): void;
}

/** Own only the HTTP view request. Runtime retry state is always server-owned. */
export function useLlmRecovery(options: RecoveryOptions) {
  const activity = useViewActivityRef();
  const current = useRef(options);
  current.current = options;
  const operation = useRef<AbortController | null>(null);
  const [local, setLocal] = useState<{
    failureId: string;
    phase: "pending" | "accepted" | "error";
    error?: string;
  } | null>(null);
  const { rootId, targetSessionId, parentHydrationRevision, hydrationRevision, recovery, enabled } = options;
  const failureId = recovery?.failureId;
  const interactive = activity.current.interactive;

  // View/target/failure replacement cancels only the fetch, never Agent execution.
  // biome-ignore lint/correctness/useExhaustiveDependencies: These values delimit admission ownership.
  useLayoutEffect(() => {
    setLocal(null);
    return () => {
      operation.current?.abort();
      operation.current = null;
    };
  }, [rootId, targetSessionId, parentHydrationRevision, hydrationRevision, failureId, enabled, interactive]);

  const retry = useCallback(async () => {
    const latest = current.current;
    if (
      !enabled ||
      !latest.enabled ||
      !interactive ||
      !activity.current.interactive ||
      operation.current ||
      latest.rootId !== rootId ||
      latest.targetSessionId !== targetSessionId ||
      latest.parentHydrationRevision !== parentHydrationRevision ||
      latest.hydrationRevision !== hydrationRevision ||
      latest.recovery?.failureId !== failureId ||
      latest.recovery?.targetSessionId !== targetSessionId ||
      latest.recovery.status !== "available" ||
      !failureId ||
      (local?.failureId === failureId && local.phase !== "error")
    )
      return;
    const controller = new AbortController();
    operation.current = controller; // Claim before React commits, including repeated Enter.
    const owns = () =>
      !controller.signal.aborted &&
      operation.current === controller &&
      activity.current.interactive &&
      current.current.enabled &&
      current.current.rootId === rootId &&
      current.current.targetSessionId === targetSessionId &&
      current.current.parentHydrationRevision === parentHydrationRevision &&
      current.current.hydrationRevision === hydrationRevision &&
      current.current.recovery?.failureId === failureId;
    setLocal({ failureId, phase: "pending" });
    let accepted = false;
    try {
      await retryModelRequest(rootId, { targetSessionId, failureId }, controller.signal);
      if (owns()) {
        accepted = true;
        setLocal({ failureId, phase: "accepted" });
      }
    } catch (error) {
      if (!owns()) return;
      setLocal({ failureId, phase: "error", error: error instanceof Error ? error.message : String(error) });
      if (llmRetryConflict(error)) current.current.refresh();
    } finally {
      if (!accepted && operation.current === controller) operation.current = null;
    }
  }, [
    activity,
    enabled,
    failureId,
    hydrationRevision,
    interactive,
    local,
    parentHydrationRevision,
    rootId,
    targetSessionId,
  ]);

  const ownedLocal = local?.failureId === failureId ? local : null;
  return {
    retry,
    busy: recovery?.status === "starting" || ownedLocal?.phase === "pending" || ownedLocal?.phase === "accepted",
    error: ownedLocal?.error ?? null,
  };
}
