import type { UpdateController } from "../runtime/update-contract";
import { DESKTOP_UPDATE_ACTION_CHANNEL, DESKTOP_UPDATE_OPEN_READY_CHANNEL, DESKTOP_UPDATE_SNAPSHOT_CHANNEL, type DesktopUpdateOpenIntent } from "./contracts";
import { validateDesktopUpdateAction } from "./update";

interface Frame { readonly url: string }
interface Contents { readonly mainFrame: Frame; getURL(): string; isDestroyed(): boolean }
export interface DesktopUpdateOwner { contents: Contents; origin: string }
interface Sender { sender: object; senderFrame: Frame | null }

export function isDesktopUpdateSender(event: Sender, owner: DesktopUpdateOwner | undefined): boolean {
  if (!owner || owner.contents.isDestroyed() || event.sender !== owner.contents
    || !event.senderFrame || event.senderFrame !== owner.contents.mainFrame) return false;
  const document = (raw: string) => {
    try {
      const url = new URL(raw);
      if (url.origin !== owner.origin || url.username || url.password || url.search
        || (url.pathname !== "/" && url.pathname !== "/index.html")) return undefined;
      url.hash = ""; return url.href;
    } catch { return undefined; }
  };
  const current = document(owner.contents.getURL());
  return current !== undefined && current === document(event.senderFrame.url);
}

export function registerDesktopUpdateIpc(ipc: { handle(channel: string, listener: (event: Sender, raw?: unknown) => Promise<unknown>): unknown }, controller: () => UpdateController, owner: () => DesktopUpdateOwner | undefined): void {
  ipc.handle(DESKTOP_UPDATE_SNAPSHOT_CHANNEL, async (event) => {
    if (!isDesktopUpdateSender(event, owner())) throw new Error("Update request is not from the current app document.");
    return controller().snapshot();
  });
  ipc.handle(DESKTOP_UPDATE_ACTION_CHANNEL, async (event, raw) => {
    if (!isDesktopUpdateSender(event, owner())) throw new Error("Update request is not from the current app document.");
    return controller().action(validateDesktopUpdateAction(raw));
  });
}

export interface DesktopUpdatePresentation {
  request(intent: DesktopUpdateOpenIntent): void;
  /** Reconsider a subscriber after the current main document finishes loading. */
  flush(): void;
  /** Navigation revokes the document capability, but preserves an undelivered intent. */
  revoke(): void;
  close(): void;
}

/** A single pending view intent, independent of the host-owned update operation. */
export function registerDesktopUpdatePresentation(
  ipc: {
    on(channel: string, listener: (event: Sender, raw: unknown) => void): unknown;
    removeListener(channel: string, listener: (event: Sender, raw: unknown) => void): unknown;
  },
  owner: () => DesktopUpdateOwner | undefined,
  view: { loaded(): boolean; send(intent: DesktopUpdateOpenIntent): void },
): DesktopUpdatePresentation {
  let subscriber: Sender | undefined;
  let pending: DesktopUpdateOpenIntent | undefined;
  let closed = false;
  const flush = (): void => {
    if (closed || !pending || !subscriber || !view.loaded()) return;
    if (!isDesktopUpdateSender(subscriber, owner())) {
      subscriber = undefined;
      return;
    }
    const intent = pending;
    try {
      view.send(intent);
      pending = undefined;
    } catch {
      // A renderer can disappear between validation and delivery. Its replacement
      // must subscribe again before it can consume the still-pending intent.
      subscriber = undefined;
    }
  };
  const ready = (event: Sender, raw: unknown): void => {
    if (closed || typeof raw !== "boolean" || !isDesktopUpdateSender(event, owner())) return;
    if (raw) {
      subscriber = { sender: event.sender, senderFrame: event.senderFrame };
      flush();
    } else if (subscriber?.sender === event.sender && subscriber.senderFrame === event.senderFrame) {
      subscriber = undefined;
    }
  };
  ipc.on(DESKTOP_UPDATE_OPEN_READY_CHANNEL, ready);
  return {
    request(intent) {
      if (closed) return;
      // A check must never consume an undelivered installation-recovery notice.
      pending = pending === "recovery" ? pending : intent;
      flush();
    },
    flush,
    revoke() { subscriber = undefined; },
    close() {
      closed = true;
      subscriber = undefined;
      pending = undefined;
      ipc.removeListener(DESKTOP_UPDATE_OPEN_READY_CHANNEL, ready);
    },
  };
}
