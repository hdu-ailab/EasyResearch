import { useEffect, useRef, useState } from "react";

interface ModalEntry {
  z: number;
  onClose: () => void;
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
  if (event.key !== "Escape") return;
  topModal()?.onClose();
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
 * Returns the z-index to apply to the modal's fixed overlay.
 */
export function useModalLayer(onClose: () => void): number {
  const [z] = useState(() => ++nextZ);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const entry: ModalEntry = { z, onClose: () => onCloseRef.current() };
    openModals.add(entry);
    if (openModals.size === 1) document.addEventListener("keydown", onKeyDown);
    return () => {
      openModals.delete(entry);
      if (openModals.size === 0) document.removeEventListener("keydown", onKeyDown);
    };
  }, [z]);

  return z;
}
