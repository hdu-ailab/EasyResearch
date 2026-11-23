import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ShellOutputDto } from "../../../background/contracts";
import { ApiError, getShellOutput, replaceBackgroundOutputWatches } from "../api";
import { ShellOutputText, shellOutputTail } from "../shell-output-text";

export type BackgroundOutputSubscription = (listener: (taskId: string) => void) => () => void;
interface OutputView {
  text: string;
  metadata?: Omit<ShellOutputDto, "output">;
  error?: "unavailable" | "failed";
  loading: boolean;
}

export function useShellOutput(input: {
  rootId: string;
  taskId?: string;
  taskStatus?: string;
  leaseId: string | null;
  enabled: boolean;
  revision: RefObject<number>;
  subscribe: BackgroundOutputSubscription;
}) {
  const { rootId, taskId, taskStatus, leaseId, enabled, revision, subscribe } = input;
  const owner = useMemo(
    () => ({ rootId, taskId, decoder: new ShellOutputText(), view: { text: "", loading: true } as OutputView }),
    [rootId, taskId],
  );
  const current = useRef(owner);
  current.current = owner;
  const [published, publish] = useState({ owner, view: owner.view });
  const [attempt, setAttempt] = useState(0);
  const invalidate = useRef<() => void>(() => {});
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    void attempt;
    if (!enabled || !taskId || !leaseId) return;
    let active = true,
      ready = false,
      busy = false,
      dirty = true;
    let request: AbortController | undefined;
    const owns = () => active && current.current === owner;
    const update = (view: OutputView) => {
      if (!owns()) return;
      owner.view = view;
      publish({ owner, view });
    };
    const read = async () => {
      if (!owns() || !ready || busy || !dirty) return;
      busy = true;
      dirty = false;
      request = new AbortController();
      const cursor = owner.view.metadata?.cursor;
      update({ ...owner.view, loading: owner.view.metadata === undefined, error: undefined });
      try {
        const page = await getShellOutput(rootId, taskId, cursor, request.signal);
        if (!owns()) return;
        if (page.id !== taskId) throw new Error("Shell identity changed");
        const replace = page.reset || page.truncated || cursor === undefined;
        if (!replace && page.cursor < cursor) throw new Error("Shell cursor regressed");
        if (replace) owner.decoder = new ShellOutputText();
        const append = replace || page.cursor > cursor ? owner.decoder.append(page.output) : "";
        const { output: _output, ...metadata } = page;
        update({ text: shellOutputTail((replace ? "" : owner.view.text) + append), metadata, loading: false });
        // Drain stopped output immediately, but a partial byte with no cursor
        // progress waits for the next invalidation rather than spinning.
        if (page.status !== "running" && page.cursor < page.size && page.cursor > (cursor ?? 0)) dirty = true;
      } catch (error) {
        if (owns())
          update({
            ...owner.view,
            loading: false,
            error: error instanceof ApiError && error.status === 404 ? "unavailable" : "failed",
          });
      } finally {
        busy = false;
        if (owns() && dirty) void read();
      }
    };
    const markDirty = () => {
      dirty = true;
      void read();
    };
    invalidate.current = markDirty;
    const unsubscribe = subscribe((id) => {
      if (id === taskId) markDirty();
    });
    const registration = ++revision.current;
    void replaceBackgroundOutputWatches(rootId, leaseId, registration, [taskId])
      .then((result) => {
        if (!owns()) return;
        if (!result.applied && result.revision !== registration) throw new Error("Output watch superseded");
        ready = true;
        void read();
      })
      .catch(() => {
        if (owns()) update({ ...owner.view, loading: false, error: "failed" });
      });
    return () => {
      active = false;
      if (invalidate.current === markDirty) invalidate.current = () => {};
      unsubscribe();
      request?.abort();
      void replaceBackgroundOutputWatches(rootId, leaseId, ++revision.current, []).catch(() => {});
    };
  }, [owner, rootId, taskId, leaseId, enabled, revision, subscribe, attempt]);

  useEffect(() => {
    void taskStatus;
    invalidate.current();
  }, [taskStatus]);
  return { ...(published.owner === owner ? published.view : owner.view), retry };
}
