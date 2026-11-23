import type { UpdateController } from "../runtime/update-contract";
import { DESKTOP_UPDATE_ACTION_CHANNEL, DESKTOP_UPDATE_SNAPSHOT_CHANNEL } from "./contracts";
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
