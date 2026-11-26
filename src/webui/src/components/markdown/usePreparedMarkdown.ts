import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { cancelMarkdown, canUseMarkdownWorker, requestMarkdown } from "./client";
import { DisposedError, SupersededError } from "./latest-worker-queue";
import {
  type CachedMarkdown,
  getCompletedMarkdown,
  type PreparedMarkdownBlock,
  prepareMarkdownBlocks,
  setCompletedMarkdown,
} from "./render";

interface Owner {
  scope: string | undefined;
  key: string | undefined;
  active: boolean;
  source: string | undefined;
  streaming: boolean;
  generation: number;
  revision: number;
  acceptedLength: number;
  blocks: readonly PreparedMarkdownBlock[];
}

interface Rendered extends CachedMarkdown {
  owner: Owner;
  generation: number;
}

/** A request belongs to a content owner/generation, not to one render's text prop.
 * The active parse can therefore publish useful progress while its newest successor
 * waits, without admitting a result from a replaced source or an unmounted owner. */
export function usePreparedMarkdown(
  scope: string | undefined,
  key: string | undefined,
  text: string,
  streaming: boolean,
) {
  const owner = useMemo<Owner>(
    () => ({
      scope,
      key,
      active: false,
      source: undefined,
      streaming: false,
      generation: 0,
      revision: -1,
      acceptedLength: 0,
      blocks: [],
    }),
    [scope, key],
  );
  const [rendered, setRendered] = useState<Rendered | null>(null);
  const [failed, setFailed] = useState<{ owner: Owner; source: string; generation: number } | null>(null);
  const cached = useMemo(() => (scope && key ? getCompletedMarkdown(scope, key, text) : undefined), [scope, key, text]);
  const generation =
    owner.source !== undefined && !text.startsWith(owner.source) ? owner.generation + 1 : owner.generation;

  useLayoutEffect(() => {
    owner.active = true;
    return () => {
      owner.active = false;
      if (owner.scope && owner.key) cancelMarkdown(owner.scope, owner.key);
    };
  }, [owner]);

  useLayoutEffect(() => {
    if (owner.source !== undefined && !text.startsWith(owner.source)) {
      owner.generation += 1;
      owner.acceptedLength = 0;
    }
    owner.source = text;
    owner.streaming = streaming;
  }, [owner, text, streaming]);

  useEffect(() => {
    if (!scope || !key || !canUseMarkdownWorker()) return;
    const admittedGeneration = owner.generation;
    if (cached) {
      owner.blocks = cached.blocks;
      owner.acceptedLength = text.length;
      setRendered({ ...cached, owner, generation: admittedGeneration });
      return;
    }
    const request = requestMarkdown({ scope, key, source: text });
    void request.promise.then(
      (result) => {
        if (
          !owner.active ||
          owner.generation !== admittedGeneration ||
          result.scope !== scope ||
          result.key !== key ||
          result.revision !== request.revision ||
          result.revision <= owner.revision ||
          result.source !== text ||
          result.source.length < owner.acceptedLength ||
          !owner.source?.startsWith(result.source)
        )
          return;
        const blocks = prepareMarkdownBlocks(result.blocks, owner.blocks);
        owner.blocks = blocks;
        owner.revision = result.revision;
        owner.acceptedLength = result.source.length;
        if (!owner.streaming && result.source === owner.source) setCompletedMarkdown(scope, key, result.source, blocks);
        setRendered({ owner, generation: admittedGeneration, source: result.source, blocks });
      },
      (error: unknown) => {
        if (error instanceof SupersededError || error instanceof DisposedError) return;
        if (owner.active && owner.generation === admittedGeneration && owner.source === text)
          setFailed({ owner, source: text, generation: admittedGeneration });
      },
    );
  }, [owner, scope, key, text, cached]);

  // Finishing an already prepared source needs no duplicate parse. A pending parse
  // reads the current streaming flag above and caches only the exact final source.
  useEffect(() => {
    if (
      !streaming &&
      scope &&
      key &&
      rendered?.owner === owner &&
      rendered.generation === owner.generation &&
      rendered.source === text
    )
      setCompletedMarkdown(scope, key, text, rendered.blocks);
  }, [scope, key, text, streaming, owner, rendered]);

  return {
    rendered: cached ? { ...cached, generation } : rendered?.owner === owner ? rendered : null,
    generation,
    failed: failed?.owner === owner && failed.generation === generation && failed.source === text,
  };
}
