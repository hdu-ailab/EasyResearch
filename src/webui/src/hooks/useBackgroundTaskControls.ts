import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BackgroundTask } from "../../../background/contracts";
import { cancelBackgroundTask, promoteBackgroundTasks } from "../api";
import { useI18n } from "../i18n/useI18n";
import { useViewActivityRef } from "../view-activity";

export function useBackgroundTaskControls(rootId: string, tasks: readonly BackgroundTask[], enabled: boolean) {
  const { t } = useI18n();
  const activity = useViewActivityRef();
  const owner = useMemo(() => ({ rootId, active: true, pending: new Set<string>() }), [rootId]);
  const current = useRef({ owner, tasks, enabled });
  current.current = { owner, tasks, enabled };
  const [state, setState] = useState({ owner, pending: [] as string[], error: null as string | null });
  useEffect(() => {
    owner.active = true;
    return () => {
      owner.active = false;
    };
  }, [owner]);

  const run = useCallback(
    async (taskId?: string) => {
      if (!owner.active || current.current.owner !== owner || !current.current.enabled || !activity.current.interactive)
        return false;
      const key = taskId ?? "promote";
      if (owner.pending.has(key)) return false;
      if (
        taskId !== undefined &&
        !current.current.tasks.some((task) => task.id === taskId && task.status === "running")
      ) {
        setState({ owner, pending: [...owner.pending], error: t("background.unavailable") });
        return false;
      }
      owner.pending.add(key);
      setState({ owner, pending: [...owner.pending], error: null });
      try {
        if (taskId === undefined) await promoteBackgroundTasks(owner.rootId);
        else await cancelBackgroundTask(owner.rootId, taskId);
        return owner.active && current.current.owner === owner && current.current.enabled;
      } catch {
        if (owner.active && current.current.owner === owner && current.current.enabled) {
          setState({ owner, pending: [...owner.pending], error: t("background.failed") });
        }
        return false;
      } finally {
        owner.pending.delete(key);
        if (owner.active && current.current.owner === owner) {
          setState((state) => ({ ...state, owner, pending: [...owner.pending] }));
        }
      }
    },
    [owner, activity, t],
  );

  return {
    pending: state.owner === owner ? state.pending : [],
    error: enabled && state.owner === owner ? state.error : null,
    cancel: run,
    promote: () => run(),
  };
}
