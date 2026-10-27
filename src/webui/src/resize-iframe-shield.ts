import "./resize-iframe-shield.css";

// Identity only: retain no panes or gestures, and work on forwarded non-secure HTTP origins.
let nextOwner = 0;

interface SelectionLease {
  owners: number;
  value: string;
  priority: string;
}

const selectionLeases = new WeakMap<CSSStyleDeclaration, SelectionLease>();

/** Body selection is shared even when mouse/touch gestures own different panes. */
export function suppressResizeSelection(style: CSSStyleDeclaration): () => void {
  let lease = selectionLeases.get(style);
  if (!lease) {
    lease = {
      owners: 0,
      value: style.getPropertyValue("user-select"),
      priority: style.getPropertyPriority("user-select"),
    };
    selectionLeases.set(style, lease);
    style.setProperty("user-select", "none");
  }
  lease.owners += 1;
  const owned = lease;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (selectionLeases.get(style) !== owned || --owned.owners !== 0) return;
    selectionLeases.delete(style);
    style.setProperty("user-select", owned.value, owned.priority);
  };
}

/** One admitted gesture per pane. Nested panes keep independent shield owners. */
export function shieldResizeIframes(pane: HTMLElement): () => void {
  const attribute = "data-resize-iframe-shield";
  const previous = pane.getAttribute(attribute);
  const token = String(++nextOwner);
  pane.setAttribute(attribute, token);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (pane.getAttribute(attribute) !== token) return;
    if (previous === null) pane.removeAttribute(attribute);
    else pane.setAttribute(attribute, previous);
  };
}
