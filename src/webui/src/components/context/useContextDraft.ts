import { useCallback, useEffect, useRef, useState } from "react";
import type { ContextEditDto, ContextPreviewDto, ContextSnapshotDto } from "../../../../web/context-contracts";
import { applyContextEdits, getSessionContext, previewContextEdits } from "../../api";
import { ApiError } from "../../api/transport";
import { useViewActivity } from "../../view-activity";

export function contextErrorCode(error: unknown): string {
  if (error instanceof ApiError && error.details && typeof error.details === "object") {
    const code = (error.details as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "CONTEXT_UNAVAILABLE";
}

/** View-owned requests and drafts; never takes ownership of Agent execution. */
export function useContextDraft(sessionId: string, refreshSignal: string, busy: boolean) {
  const { interactive } = useViewActivity();
  const [snapshot, setSnapshot] = useState<ContextSnapshotDto | null>(null);
  const [edits, setEdits] = useState<ContextEditDto[]>([]);
  const [preview, setPreview] = useState<ContextPreviewDto | null>(null);
  const [checking, setChecking] = useState(true);
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [verifiedSignal, setVerifiedSignal] = useState<string | null>(null);
  const needsCheck = checking || verifiedSignal !== refreshSignal;
  const current = useRef({ snapshot, edits, stale, applying, interactive, refreshSignal });
  current.current = { snapshot, edits, stale, applying, interactive, refreshSignal };
  const checkAfterApply = useRef(false);
  const read = useRef<AbortController | null>(null);
  const estimate = useRef<AbortController | null>(null);
  const mutation = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const previewGeneration = useRef(0);
  const alive = useRef(true);

  const invalidate = useCallback(() => {
    estimate.current?.abort();
    previewGeneration.current += 1;
    setPreview(null);
    setPreviewing(false);
    setStale(true);
    setError("CONTEXT_STALE");
  }, []);

  const load = useCallback(
    async (reset = false, preserveError = false) => {
      if (!current.current.interactive) return;
      if (current.current.applying) {
        checkAfterApply.current = true;
        return;
      }
      read.current?.abort();
      estimate.current?.abort();
      previewGeneration.current += 1;
      setPreview(null);
      const sourceSignal = current.current.refreshSignal;
      const controller = new AbortController();
      read.current = controller;
      const request = ++generation.current;
      setChecking(true);
      if (!preserveError) setError(current.current.stale ? "CONTEXT_STALE" : null);
      try {
        const next = await getSessionContext(sessionId, controller.signal);
        if (
          !alive.current ||
          controller.signal.aborted ||
          request !== generation.current ||
          sourceSignal !== current.current.refreshSignal ||
          !current.current.interactive
        )
          return;
        if (next.sessionId !== sessionId) throw new Error("Mismatched context session");
        const old = current.current;
        if (!reset && old.snapshot && old.snapshot.revision !== next.revision && old.edits.length) {
          invalidate();
        } else {
          if (reset || old.snapshot?.revision !== next.revision) {
            estimate.current?.abort();
            previewGeneration.current += 1;
            setEdits([]);
            setPreview(null);
            setStale(false);
          }
          setSnapshot(next);
          if (reset) setError(null);
        }
        setVerifiedSignal(sourceSignal);
      } catch (error) {
        if (alive.current && !controller.signal.aborted && request === generation.current)
          setError(contextErrorCode(error));
      } finally {
        if (alive.current && !controller.signal.aborted && request === generation.current) setChecking(false);
      }
    },
    [sessionId, invalidate],
  );

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current += 1;
      previewGeneration.current += 1;
      read.current?.abort();
      estimate.current?.abort();
      // Cancels HTTP observation only; the admitted server operation remains owned there.
      mutation.current?.abort();
    };
  }, []);

  // Existing session/configuration notifications are hints; the opaque server
  // revision decides whether a retained draft is still valid.
  useEffect(() => {
    if (!interactive) {
      read.current?.abort();
      estimate.current?.abort();
      generation.current += 1;
      previewGeneration.current += 1;
      return;
    }
    void refreshSignal;
    void load();
    return () => {
      read.current?.abort();
    };
  }, [refreshSignal, interactive, load]);

  useEffect(() => {
    void attempt;
    estimate.current?.abort();
    const request = ++previewGeneration.current;
    setPreview(null);
    setPreviewing(false);
    if (!snapshot || !edits.length || stale || !interactive || needsCheck || applying) return;
    const sourceSignal = refreshSignal;
    const controller = new AbortController();
    estimate.current = controller;
    setPreviewing(true);
    const timer = window.setTimeout(() => {
      void previewContextEdits(sessionId, { revision: snapshot.revision, edits }, controller.signal)
        .then((next) => {
          if (
            !alive.current ||
            controller.signal.aborted ||
            request !== previewGeneration.current ||
            sourceSignal !== current.current.refreshSignal ||
            !current.current.interactive
          )
            return;
          if (next.revision !== snapshot.revision) {
            invalidate();
            return;
          }
          setPreview(next);
          setPreviewing(false);
        })
        .catch((error: unknown) => {
          if (
            !alive.current ||
            controller.signal.aborted ||
            request !== previewGeneration.current ||
            sourceSignal !== current.current.refreshSignal ||
            !current.current.interactive
          )
            return;
          if (contextErrorCode(error) === "CONTEXT_STALE") invalidate();
          else setError(contextErrorCode(error));
          setPreviewing(false);
        });
    }, 200);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [sessionId, snapshot, edits, stale, interactive, needsCheck, applying, attempt, invalidate, refreshSignal]);

  const stage = (edit: ContextEditDto) => {
    if (stale || applying || !interactive || needsCheck) return;
    estimate.current?.abort();
    previewGeneration.current += 1;
    setPreview(null);
    setError(null);
    setEdits((edits) => [...edits, edit]);
  };
  const reset = () => {
    if (applying) return;
    estimate.current?.abort();
    previewGeneration.current += 1;
    setEdits([]);
    setPreview(null);
    setError(stale ? "CONTEXT_STALE" : null);
  };
  const apply = async () => {
    if (
      !snapshot ||
      !preview?.changes.length ||
      needsCheck ||
      stale ||
      busy ||
      snapshot.busy ||
      current.current.applying ||
      !interactive
    )
      return;
    current.current.applying = true;
    setApplying(true);
    setError(null);
    read.current?.abort();
    generation.current += 1;
    const controller = new AbortController();
    mutation.current = controller;
    try {
      const next = await applyContextEdits(sessionId, { revision: snapshot.revision, edits }, controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      if (next.sessionId !== sessionId) throw new Error("Mismatched context session");
      setSnapshot(next);
      setEdits([]);
      setPreview(null);
      setStale(false);
      current.current = { ...current.current, snapshot: next, edits: [], stale: false };
    } catch (error) {
      if (!alive.current || controller.signal.aborted) return;
      const code = contextErrorCode(error);
      setError(code);
      if (code === "CONTEXT_STALE") invalidate();
      // A native append may have partly succeeded. Reconcile actual context,
      // retaining the draft if its revision is still valid, otherwise fence it.
      current.current.applying = false;
      void load(false, true);
    } finally {
      if (alive.current && !controller.signal.aborted) {
        current.current.applying = false;
        setApplying(false);
        if (checkAfterApply.current) {
          checkAfterApply.current = false;
          void load(false, true);
        }
      }
    }
  };
  return {
    snapshot,
    edits,
    preview,
    checking: needsCheck,
    previewing,
    applying,
    stale,
    error,
    stage,
    reset,
    apply,
    invalidate,
    refresh: () => load(current.current.stale),
    retryPreview: () => {
      setError(null);
      setAttempt((n) => n + 1);
    },
  };
}
