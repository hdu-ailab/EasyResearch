import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TranscriptPageDto } from "../../../web/contracts";
import { ApiError, getTranscriptPage } from "../api";

export function useTranscriptHistory(input: {
  sessionId: string;
  childId?: string;
  hydrationRevision: number;
  cursor?: string;
  disabled: boolean;
  publish(page: TranscriptPageDto, cursor: string, hydrationRevision: number): void;
  refresh(): void;
}) {
  const owner = useMemo(
    () => ({
      sessionId: input.sessionId,
      childId: input.childId,
      hydrationRevision: input.hydrationRevision,
      disabled: input.disabled,
    }),
    [input.sessionId, input.childId, input.hydrationRevision, input.disabled],
  );
  const current = useRef({ owner, input });
  current.current = { owner, input };
  const pending = useRef<{ owner: object; controller: AbortController } | null>(null);
  const [state, setState] = useState({ owner, loading: false, error: false });
  useEffect(
    () => () => {
      if (pending.current?.owner !== owner) return;
      pending.current.controller.abort();
      pending.current = null;
    },
    [owner],
  );
  const loadOlder = useCallback(async (beforePublish?: () => void) => {
    const { owner, input } = current.current;
    const cursor = input.cursor;
    if (input.disabled || !cursor || pending.current?.owner === owner) return;
    pending.current?.controller.abort();
    const request = { owner, controller: new AbortController() };
    pending.current = request;
    setState({ owner, loading: true, error: false });
    const ownsRequest = () => current.current.owner === owner && !request.controller.signal.aborted;
    try {
      const page = await getTranscriptPage(input.sessionId, cursor, input.childId, request.controller.signal);
      if (ownsRequest()) {
        beforePublish?.();
        input.publish(page, cursor, input.hydrationRevision);
      }
    } catch (error) {
      if (!ownsRequest()) return;
      if (error instanceof ApiError && error.status === 409) input.refresh();
      else setState({ owner, loading: false, error: true });
    } finally {
      if (pending.current === request) pending.current = null;
      if (ownsRequest()) setState((state) => ({ ...state, loading: false }));
    }
  }, []);
  return {
    loadOlder,
    loading: state.owner === owner && state.loading,
    error: state.owner === owner && state.error,
  };
}
