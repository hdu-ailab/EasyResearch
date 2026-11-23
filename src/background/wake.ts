import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

export const BACKGROUND_WAKE_TYPE = "easyresearch:background-wake";

export function isBackgroundWake(message: unknown): boolean {
  return message !== null && typeof message === "object"
    && "role" in message && message.role === "custom"
    && "customType" in message && message.customType === BACKGROUND_WAKE_TYPE;
}

export function withoutBackgroundWake<T>(messages: readonly T[]): T[] {
  return messages.filter((message) => !isBackgroundWake(message));
}

export const createBackgroundWakeExtension = (): ExtensionFactory => (pi) => {
  pi.on("context", ({ messages }) => {
    const filtered = withoutBackgroundWake(messages);
    return filtered.length === messages.length ? undefined : { messages: filtered };
  });
};
