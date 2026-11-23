import { useCallback, useEffect, useRef, useState } from "react";
import { getSkillMarketSummary } from "../../api/skill-marketplace";

/** One view-owned queue: repeated popular/list cards share reads, never a catalog-wide prefetch. */
export function useMarketSummaries(active: boolean) {
  const cache = useRef(new Map<string, { text: string; expires: number }>());
  const queue = useRef(new Set<string>());
  const drain = useRef<() => void>(() => {});
  const activeRef = useRef(active);
  activeRef.current = active;
  const [summaries, setSummaries] = useState<Record<string, string>>({});
  const requestSummary = useCallback((id: string) => {
    if (!activeRef.current || (cache.current.get(id)?.expires ?? 0) > Date.now()) return;
    queue.current.add(id);
    drain.current();
  }, []);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const pending = new Set<string>();
    const save = (id: string, text: string, ttl: number) => {
      if (controller.signal.aborted) return;
      cache.current.delete(id);
      cache.current.set(id, { text, expires: Date.now() + ttl });
      const oldest = cache.current.keys().next().value;
      if (cache.current.size > 128 && oldest !== undefined) cache.current.delete(oldest);
      setSummaries(Object.fromEntries([...cache.current].map(([key, value]) => [key, value.text])));
    };
    const pump = () => {
      if (controller.signal.aborted) return;
      while (pending.size < 3 && queue.current.size) {
        const id = queue.current.values().next().value;
        if (id === undefined) break;
        queue.current.delete(id);
        if (pending.has(id) || (cache.current.get(id)?.expires ?? 0) > Date.now()) continue;
        pending.add(id);
        void getSkillMarketSummary(id, controller.signal)
          .then((text) => save(id, text, 300_000))
          .catch(() => save(id, "", 60_000))
          .finally(() => {
            pending.delete(id);
            pump();
          });
      }
    };
    drain.current = pump;
    pump();
    return () => {
      controller.abort();
      queue.current.clear();
      drain.current = () => {};
    };
  }, [active]);
  return { summaries, requestSummary };
}
