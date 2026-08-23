import { type RefObject, useLayoutEffect, useRef, useState } from "react";

interface ModalEntry {
  z: number;
  onClose: () => void;
  root: () => HTMLElement | null;
  restoreFocus: HTMLElement | null;
}

const openModals = new Set<ModalEntry>();
let nextZ = 50;

function topModal(): ModalEntry | null {
  let top: ModalEntry | null = null;
  for (const entry of openModals) {
    if (!top || entry.z > top.z) top = entry;
  }
  return top;
}

function onKeyDown(event: KeyboardEvent): void {
  const modal = topModal();
  if (!modal) return;
  if (event.key === "Escape") {
    event.preventDefault();
    modal.onClose();
    return;
  }
  if (event.key !== "Tab") return;

  const root = modal.root();
  if (!root) return;
  const focusable = focusableElements(root);
  if (focusable.length === 0) {
    event.preventDefault();
    root.tabIndex = -1;
    root.focus({ preventScroll: true });
    return;
  }
  const first = focusable.at(0);
  const last = focusable.at(-1);
  if (!first || !last) return;
  const active = document.activeElement;
  if (!root.contains(active)) {
    event.preventDefault();
    first.focus({ preventScroll: true });
  } else if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus({ preventScroll: true });
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus({ preventScroll: true });
  }
}

function onFocusIn(event: FocusEvent): void {
  const root = topModal()?.root();
  if (!root || (event.target instanceof Node && root.contains(event.target))) return;
  focusFirst(root);
}

function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
}

function focusFirst(root: HTMLElement): void {
  const first = focusableElements(root)[0];
  if (first) {
    first.focus({ preventScroll: true });
    return;
  }
  root.tabIndex = -1;
  root.focus({ preventScroll: true });
}

/**
 * Register a modal in the global stacking order.
 *
 * Each mounted modal claims an incrementing z-index (replacing a hardcoded
 * `z-50`), so a later-opened modal always paints above earlier ones regardless
 * of DOM order — nested dialogs (config → details → markdown editor) stack
 * correctly. A single document-level `keydown` listener closes only the
 * top-most modal on Escape, so pressing Esc unwinds one layer at a time.
 *
 * When a dialog ref is supplied, the top layer also owns initial focus, focus
 * containment, Tab wrapping, and restoration to its still-connected opener.
 * Returns the z-index to apply to the modal's fixed overlay.
 */
export function useModalLayer<T extends HTMLElement = HTMLElement>(
  onClose: () => void,
  rootRef?: RefObject<T | null>,
): number {
  const [z] = useState(() => ++nextZ);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    const active = document.activeElement;
    const entry: ModalEntry = {
      z,
      onClose: () => onCloseRef.current(),
      root: () => rootRef?.current ?? null,
      restoreFocus: active instanceof HTMLElement && active !== document.body ? active : null,
    };
    openModals.add(entry);
    if (openModals.size === 1) {
      document.addEventListener("keydown", onKeyDown);
      document.addEventListener("focusin", onFocusIn);
    }
    const root = entry.root();
    if (root && !root.contains(document.activeElement)) focusFirst(root);
    return () => {
      const wasTop = topModal() === entry;
      openModals.delete(entry);
      if (openModals.size === 0) {
        document.removeEventListener("keydown", onKeyDown);
        document.removeEventListener("focusin", onFocusIn);
      }
      if (!wasTop) return;
      const remaining = topModal();
      const remainingRoot = remaining?.root() ?? null;
      if (entry.restoreFocus?.isConnected && (!remainingRoot || remainingRoot.contains(entry.restoreFocus))) {
        entry.restoreFocus.focus({ preventScroll: true });
      } else if (remainingRoot) {
        focusFirst(remainingRoot);
      }
    };
  }, [rootRef, z]);

  return z;
}
