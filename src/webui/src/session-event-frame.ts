import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

interface CompatibleDelta {
  event: AgentSessionEvent;
  type: "text_delta" | "thinking_delta";
  contentIndex: number;
  delta: string;
}

function compatibleDelta(event: unknown): CompatibleDelta | undefined {
  if (!event || typeof event !== "object" || (event as { type?: unknown }).type !== "message_update") return;
  const update = (event as { assistantMessageEvent?: unknown }).assistantMessageEvent;
  if (!update || typeof update !== "object") return;
  const value = update as { type?: unknown; contentIndex?: unknown; delta?: unknown };
  if (value.type !== "text_delta" && value.type !== "thinking_delta") return;
  if (!Number.isSafeInteger(value.contentIndex) || typeof value.delta !== "string") return;
  return {
    event: event as AgentSessionEvent,
    type: value.type,
    contentIndex: value.contentIndex as number,
    delta: value.delta,
  };
}

function merge(left: AgentSessionEvent, right: CompatibleDelta): AgentSessionEvent | undefined {
  const prior = compatibleDelta(left);
  if (!prior || prior.type !== right.type || prior.contentIndex !== right.contentIndex) return;
  return {
    ...(right.event as unknown as Record<string, unknown>),
    assistantMessageEvent: {
      type: right.type,
      contentIndex: right.contentIndex,
      delta: prior.delta + right.delta,
    },
  } as unknown as AgentSessionEvent;
}

export function createSessionEventFrame(input: {
  schedule(callback: FrameRequestCallback): number;
  cancel(id: number): void;
  apply(events: AgentSessionEvent[]): void;
}) {
  let events: AgentSessionEvent[] = [];
  let scheduled: number | undefined;

  const apply = () => {
    scheduled = undefined;
    if (events.length === 0) return;
    const current = events;
    events = [];
    input.apply(current);
  };

  return {
    enqueue(event: unknown): boolean {
      const delta = compatibleDelta(event);
      if (!delta) return false;
      const last = events.at(-1);
      const combined = last ? merge(last, delta) : undefined;
      if (combined) events[events.length - 1] = combined;
      else events.push(delta.event);
      scheduled ??= input.schedule(apply);
      return true;
    },
    flush(): void {
      if (scheduled !== undefined) input.cancel(scheduled);
      apply();
    },
    discard(): void {
      if (scheduled !== undefined) input.cancel(scheduled);
      scheduled = undefined;
      events = [];
    },
  };
}
