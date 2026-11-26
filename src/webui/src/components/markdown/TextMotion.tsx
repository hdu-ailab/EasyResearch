import type { Element } from "hast";
import {
  type ComponentProps,
  createContext,
  memo,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import "./text-motion.css";

interface MotionSource {
  source: string;
  generation: number;
  enabled: boolean;
  streaming: boolean;
  replacing?: boolean;
}

const staticSource: MotionSource = { source: "", generation: 0, enabled: false, streaming: false };
export const MarkdownMotionSource = createContext<MotionSource>(staticSource);
export const MarkdownTextOffset = createContext(0);
const TextMotionContext = createContext({ enabled: false, from: Number.POSITIVE_INFINITY, disabled: true });
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function useReducedMotion(active: boolean) {
  const query = useMemo(() => (active ? window.matchMedia?.(REDUCED_MOTION) : undefined), [active]);
  const [reduced, setReduced] = useState(query?.matches ?? false);
  useLayoutEffect(() => {
    setReduced(query?.matches ?? false);
    if (!query) return;
    const changed = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener("change", changed);
    return () => query.removeEventListener("change", changed);
  }, [query]);
  return query?.matches || reduced;
}

/** Only append-compatible *displayed prose* earns new-word motion. A markup
 * reinterpretation can change leaf paths without introducing any new words. */
export function MarkdownTextMotion({ prose, children }: { prose: string; children: ReactNode }) {
  const source = useContext(MarkdownMotionSource);
  const [wasStreaming, setWasStreaming] = useState(source.streaming);
  if (source.streaming && !wasStreaming) setWasStreaming(true);
  const reduced = useReducedMotion(source.enabled && source.streaming);
  const previous = useRef<{ source: string; prose: string; generation: number } | null>(null);
  const before = previous.current;
  const disabled =
    reduced ||
    !source.streaming ||
    Boolean(source.replacing) ||
    (before !== null && before.generation !== source.generation);
  const from =
    source.enabled &&
    !disabled &&
    before !== null &&
    source.source.startsWith(before.source) &&
    prose.startsWith(before.prose)
      ? before.prose.length
      : Number.POSITIVE_INFINITY;
  // Ordinary history keeps its compact text DOM. A live body's word nodes stay
  // mounted through finalization; a later cache remount is static history again.
  const enabled = source.enabled && (source.streaming || wasStreaming);
  const value = useMemo(() => ({ enabled, from, disabled }), [enabled, from, disabled]);
  useLayoutEffect(() => {
    if (!source.replacing) previous.current = { source: source.source, prose, generation: source.generation };
  }, [source.source, source.generation, source.replacing, prose]);
  return <TextMotionContext value={value}>{children}</TextMotionContext>;
}

const Word = memo(function Word({ text, animate, disabled }: { text: string; animate: boolean; disabled: boolean }) {
  const [entering, setEntering] = useState(animate);
  // Reduced motion and terminal/replacement transitions snap to the visible state;
  // they need not emit an animationend event. Later preference changes cannot replay.
  if (disabled && entering) setEntering(false);
  return (
    <span
      data-markdown-word=""
      data-entering={entering && !disabled ? true : undefined}
      className={entering && !disabled ? "er-markdown-word-enter" : undefined}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) setEntering(false);
      }}
    >
      {text}
    </span>
  );
});

function ProseText({ text, start }: { text: string; start: number }) {
  const motion = useContext(TextMotionContext);
  const offset = useContext(MarkdownTextOffset) + start;
  if (!motion.enabled) return text;
  let word = 0;
  return [...text.matchAll(/\s+|\S+/gu)].map((match) =>
    /^\s/u.test(match[0]) ? (
      match[0]
    ) : (
      <Word key={word++} text={match[0]} animate={offset + match.index >= motion.from} disabled={motion.disabled} />
    ),
  );
}

export function MarkdownSpan({
  "data-markdown-text": start,
  "data-markdown-prose": prose,
  children,
  node: _node,
  ...props
}: ComponentProps<"span"> & {
  node?: Element;
  "data-markdown-text"?: number;
  "data-markdown-prose"?: string;
}) {
  if (prose !== undefined) return <MarkdownTextMotion prose={prose}>{children}</MarkdownTextMotion>;
  if (start !== undefined) return <ProseText text={String(children ?? "")} start={start} />;
  return <span {...props}>{children}</span>;
}
