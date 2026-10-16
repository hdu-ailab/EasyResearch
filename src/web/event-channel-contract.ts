/** Browser transport only. Logical ids are view-owned, even for identical paths. */
export interface EventSubscription {
  id: string;
  path: string;
}
export interface EventSubscriptionReplacement {
  revision: number;
  subscriptions: EventSubscription[];
}
export type EventChannelFrame =
  | { type: "connected"; id: string; bootId: string }
  | { type: "heartbeat"; id: string; bootId: string }
  | { type: "event"; id: string; bootId: string; event: unknown }
  | { type: "end" | "stream-error"; id: string; bootId: string };

export function isEventSubscriptionPath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.length <= 1024 &&
    (path === "/api/config/events" ||
      /^\/api\/sessions\/[^/?#]+\/events$/.test(path) ||
      /^\/api\/auth\/flows\/[^/?#]+\/events$/.test(path))
  );
}

export function parseEventSubscriptions(value: unknown): EventSubscriptionReplacement {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid event subscriptions");
  const data = value as EventSubscriptionReplacement;
  if (
    !Number.isSafeInteger(data.revision) ||
    data.revision < 0 ||
    !Array.isArray(data.subscriptions) ||
    data.subscriptions.length > 256
  ) {
    throw new Error("Invalid event subscriptions");
  }
  const seen = new Set<string>();
  const subscriptions = data.subscriptions.map((item) => {
    if (
      !item ||
      typeof item.id !== "string" ||
      !/^[\w-]{1,100}$/.test(item.id) ||
      seen.has(item.id) ||
      !isEventSubscriptionPath(item.path)
    )
      throw new Error("Invalid event subscription");
    seen.add(item.id);
    return { id: item.id, path: item.path };
  });
  return { revision: data.revision, subscriptions };
}
