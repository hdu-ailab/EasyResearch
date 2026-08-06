# File Tree Toggle Button — Design

Date: 2026-08-06
Status: Approved by user
Scope: Small interleaved feature in the ongoing opencode Web UI rewrite (plan: `docs/superpowers/plans/2026-08-06-opencode-webui-rewrite.md`).

## Problem

The right-side file browser (`FileBrowser`) always shows the file tree sidebar
alongside the preview. Users want to hide the tree to give the preview full
width, mirroring opencode web's "Toggle file tree" control in the side panel.

## Reference (opencode web)

- Button: `SessionReviewV2SidebarToggle` (`packages/session-ui/src/v2/components/session-review-v2.tsx`) — ghost icon button, aria-label "Toggle file tree" (`ui.sessionReviewV2.toggleSidebar`), `aria-expanded` + `data-expanded`.
- Placement: far left of the tab bar in a sticky slot (`session-review-v2-sidebar-toggle-slot sticky left-0 z-10`, panel background) so it stays visible while tabs scroll horizontally (`packages/app/src/pages/session/session-side-panel.tsx:556-562`).
- Icon: custom `filetree` (16px stroke tree) — lucide equivalent: `FolderTree`.
- State: `sidebarOpened` default true, toggled by the button (`review-panel-v2-state.ts`); opencode persists it globally, we do not.

## Design

- **Location**: far-left, sticky slot inside `FileTabs` tab bar (`overflow-x-auto`); button does not scroll away with the tabs. Slot carries `bg-v2-background-bg-base` so scrolled tabs pass underneath.
- **Button**: lucide `FolderTree` (size 14), 28px ghost icon button (existing `iconButton`-style tokens: `text-v2-icon-icon-muted hover:bg-v2-grey-100`), `title="Toggle file tree"`, `aria-label="Toggle file tree"`, `aria-expanded={treeVisible}`, `data-expanded` mirroring opencode.
- **State**: `treeVisible` `useState(true)` inside `FileBrowser`; not persisted (YAGNI). Passed to `FileTabs` via an optional `toggle: { opened, onToggle }` prop — `FileTabs` remains backward compatible (other callers unaffected).
- **Hide semantics**: the tree column is hidden with CSS (`hidden` on the column container; component stays mounted) so `useLazyTree` expansion, filter text, and in-flight loading state are preserved. When hidden, the preview `flex-1` column takes the full browser width.
- **Mobile**: the toggle works identically in the mobile Files view; Task 5's stacked layout must preserve this behavior.
- **Accessibility**: `aria-expanded` reflects state; button remains focusable; tooltip via `title`.

## Testing

`FileBrowser.test.tsx` additions:
- Toggle button renders as the first element of the tab bar with `aria-expanded=true`.
- Click collapses: `aria-expanded=false`, tree content not visible, preview still visible.
- Click again expands: tree content visible again.
- Existing FileBrowser tests (PDF dispatch without text fetch, text fetch for `.md`) keep passing; `FileTabs` tests unaffected (prop optional).

## Documentation sync

- `.docs/webui.md` Files browser paragraph: add the file-tree toggle button.
- Plan `2026-08-06-opencode-webui-rewrite.md`: add interleaved task section; Task 5 must not regress the toggle.
