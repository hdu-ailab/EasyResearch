import { type CSSProperties, type RefObject, useLayoutEffect, useRef, useState } from "react";
import { useViewActivityRef } from "../view-activity";

interface ModalEntry {
  z: number;
  onClose: () => void;
  root: () => HTMLElement | null;
  active: () => boolean;
  restoreFocus: HTMLElement | null;
  isTop: boolean;
  setIsTop: (isTop: boolean) => void;
}

export interface ModalLayerResult {
  zIndex: number;
  isTop: boolean;
  layerProps: {
    style: CSSProperties;
    "aria-hidden": true | undefined;
    inert: true | undefined;
  };
  dialogProps: {
    "aria-modal": true | undefined;
    "aria-hidden": true | undefined;
    inert: true | undefined;
  };
}

const openModals = new Set<ModalEntry>();
let nextZ = 50;

function topModal(): ModalEntry | null {
  let top: ModalEntry | null = null;
  for (const entry of openModals) {
    if (!entry.active()) continue;
    if (!top || entry.z > top.z) top = entry;
  }
  return top;
}

function synchronizeTopState(): void {
  const top = topModal();
  for (const entry of openModals) {
    const isTop = entry === top;
    if (entry.isTop === isTop) continue;
    entry.isTop = isTop;
    const root = entry.root();
    if (root) {
      if (isTop) {
        root.removeAttribute("aria-hidden");
        root.removeAttribute("inert");
        root.setAttribute("aria-modal", "true");
      } else {
        root.removeAttribute("aria-modal");
        root.setAttribute("aria-hidden", "true");
        root.setAttribute("inert", "");
      }
    }
    entry.setIsTop(isTop);
  }
}

function registeredModal(root: HTMLElement | null): ModalEntry | null {
  if (!root) return null;
  for (const entry of openModals) {
    if (entry.root() === root) return entry;
  }
  return null;
}

export function hasModalAbove(root: HTMLElement | null): boolean {
  const entry = registeredModal(root);
  const top = topModal();
  return entry !== null && top !== null && top.z > entry.z;
}

/** Focus from asynchronous Work completions cannot escape the active modal or enter an inert view. */
export function canFocusElement(element: HTMLElement | null): element is HTMLElement {
  if (!element?.isConnected || element.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
  const root = topModal()?.root();
  return !root || root.contains(element);
}

export function requestModalCloseAbove(root: HTMLElement | null): boolean {
  const entry = registeredModal(root);
  const top = topModal();
  if (!entry || !top || top.z <= entry.z) return false;
  top.onClose();
  return true;
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
  ).filter(
    (element) =>
      !element.matches(':disabled, input[type="hidden"]') &&
      element.closest('[hidden], [aria-hidden="true"], [inert]') === null,
  );
}

function focusFirst(root: HTMLElement): void {
  if (!root.isConnected || root.closest('[hidden], [aria-hidden="true"], [inert]')) return;
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
 * Returns the overlay z-index and top-only dialog accessibility state.
 */
export function useModalLayer<T extends HTMLElement = HTMLElement>(
  onClose: () => void,
  rootRef?: RefObject<T | null>,
): ModalLayerResult {
  const activity = useViewActivityRef();
  const active = activity.current.interactive;
  const [z] = useState(() => ++nextZ);
  const [isTop, setIsTop] = useState(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    if (!active) {
      setIsTop(false);
      return;
    }
    const opener = document.activeElement;
    const entry: ModalEntry = {
      z,
      onClose: () => onCloseRef.current(),
      root: () => rootRef?.current ?? null,
      active: () => activity.current.interactive,
      restoreFocus: opener instanceof HTMLElement && opener !== document.body ? opener : null,
      isTop: false,
      setIsTop,
    };
    openModals.add(entry);
    synchronizeTopState();
    if (openModals.size === 1) {
      document.addEventListener("keydown", onKeyDown);
      document.addEventListener("focusin", onFocusIn);
    }
    const root = entry.root();
    if (root && entry.isTop && !root.contains(document.activeElement)) focusFirst(root);
    return () => {
      const wasTop = topModal() === entry;
      openModals.delete(entry);
      synchronizeTopState();
      if (openModals.size === 0) {
        document.removeEventListener("keydown", onKeyDown);
        document.removeEventListener("focusin", onFocusIn);
      }
      if (!wasTop || !activity.current.interactive) return;
      const remaining = topModal();
      const remainingRoot = remaining?.root() ?? null;
      if (canFocusElement(entry.restoreFocus) && (!remainingRoot || remainingRoot.contains(entry.restoreFocus))) {
        entry.restoreFocus.focus({ preventScroll: true });
      } else if (remainingRoot) {
        focusFirst(remainingRoot);
      }
    };
  }, [rootRef, z, active, activity]);

  return {
    zIndex: z,
    isTop: active && isTop,
    layerProps: {
      style: { zIndex: z, visibility: active ? undefined : "hidden" },
      "aria-hidden": active ? undefined : true,
      inert: active ? undefined : true,
    },
    dialogProps:
      active && isTop
        ? { "aria-modal": true, "aria-hidden": undefined, inert: undefined }
        : { "aria-modal": undefined, "aria-hidden": true, inert: true },
  };
}
