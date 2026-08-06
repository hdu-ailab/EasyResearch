# Mobile Full-Screen Work Panel Design

Date: 2026-08-06
Scope: `src/webui/src/pages/WorkPage.tsx` (+ tests + `.docs/webui.md` sync)
Branch: `feat/webui-opencode-rewrite` (worktree)

## Problem

On mobile (<768px, the `md:` breakpoint) the right-side panel (Files / Agent list) is a
bottom sheet: `absolute inset-x-0 bottom-0 top-9`, which leaves the top 36px of the chat
column visible and applies the desktop `width: 320px` inline style. The user wants the
mobile side panel to fully cover the chat area (only one of the two regions is visible at a
time) without covering the topbar.

## Behavior

- Mobile (<768px): pressing the topbar Files or Agent button switches the work area to the
  panel, which covers the **entire** row region below the topbar (`absolute inset-0`), full
  width and full height. Pressing the same button again collapses it back to the chat
  column.
- The topbar stays visible and clickable at all sizes — the panel lives inside the content
  row, below the topbar.
- Desktop (>=768px): unchanged — side-by-side layout with the resizable panel
  (min ~240px / max ~480px, drag handle on the left edge).
- Chat area always stays mounted (React state preserved) while the panel is open; the panel
  is a positioned overlay, `hidden` toggling only affects the panel itself.

## Implementation (WorkPage.tsx)

1. Replace the panel's mobile classes. Current (WorkPage.tsx:278):
   `absolute inset-x-0 bottom-0 top-9 z-30 flex-col rounded-t-[10px] ...'
   New:
   `absolute inset-0 z-30 flex-col ...`
   Keep the `md:`-prefixed desktop classes identical, and keep `flex`/`hidden`
   toggling driven by `panel`.

2. Panel width becomes a CSS variable so mobile can ignore it while desktop drag resizing
   still works. In place of the inline `style={{ width: clampedPanelWidth }}`, render:

   ```
   style={panel ? { "--panel-w": `${clampedPanelWidth}px` } : undefined}
   ```

   and set the width class `w-full md:w-(--panel-w)`. Tailwind v4 resolves the `md:` width
   from the `--panel-w` CSS variable; mobile stays full width.

3. Preserve the existing resize logic (`startResize`, `panelMax`, `PANEL_MIN/CHAT_MIN`
   clamping) exactly — only the style/class plumbing changes.

## Tests (WorkPage.test.tsx)

- Update the width assertions (currently `style` must match `/width:\s*320px/` and
  `/width:\s*380px/`) to assert the `--panel-w` custom property instead.
- Add a mobile contract test: open the panel, assert the region has the `inset-0` covering
  class and width is not a fixed desktop inline width (panel class list should not contain a
  `bottom-0 top-9` pair; the region element is positioned absolute and covers the row).
  This is a class/geometry contract, not a changed-behavior snapshot.

## Docs

- `.docs/webui.md`: the Files panel paragraph already says "On mobile it is the full-width
  `Files` Work tab." Extend it with one sentence: opening the panel on mobile covers the
  chat area below the topbar (full width/height); the topbar stays visible and toggling
  returns to the chat.