# OpenCode-Style Web UI Rewrite Design

## Goal

Rewrite LazyResearch's full Web component tree so Home, directory selection, Work, file browsing, and global configuration match the current opencode Web visual language and responsive behavior. Preserve the existing React 19, Tailwind CSS v4, Pi RPC/SSE, session reducer, and process lifecycle boundaries.

The opencode source under `/tmp/opencode/opencode-src` and the live UI at `http://localhost:4096` are the implementation references. The rewrite does not port SolidJS or depend on opencode's private UI packages.

## Required Outcomes

- All Web pages use opencode v2 light tokens, 41px titlebar geometry, 8px page inset, 10px raised surfaces, and dense 28px controls.
- Desktop Work uses coupled chat and resizable Files/Agents panes.
- Mobile Work uses full-width `Chat`, `Files`, and `Agents` top tabs. View state remains mounted while switching.
- Untouched tree directories show chevrons. Spinners appear only during active listing requests.
- Markdown preview supports GFM, math, fenced code, tables, task lists, and local relative images/file links.
- PDF preview uses PDF.js and supports continuous pages, page navigation, page input/count, zoom, fit width, rotation, text search, match navigation/count, and download.
- Home does not present named `lazyresearch:<agent>` session lines as top-level orchestrator sessions.
- The Agents view uses the five-agent ADR-022 roster and reflects strictly serial subagent activity; no `parallel` mode remains.
- Desktop and mobile layouts have no incoherent overlap, clipped controls, or horizontal page overflow.

## Architecture

The frontend is reorganized around a shared application shell and focused feature boundaries:

- `AppShell`: titlebar, page surface, desktop/mobile breakpoints, and global navigation.
- `HomeWorkspace`: project groups derived from exact session cwd, session search/history, running status, New session, and utility actions.
- `WorkWorkspace`: persistent session connection, chat transcript/composer, agent focus, desktop coupled panes, and mobile work tabs.
- `FileWorkspace`: open tabs, preview/pinned tab behavior, file tree, filtering, content cache, and preview dispatch.
- `ConfigWorkspace`: global-only tree/editor split with mobile tree-to-editor navigation.
- `DirectoryDialog`: server-backed path completion and directory tree in a full-height mobile dialog and bounded desktop dialog.

Existing backend session contracts and `session-reducer` behavior remain unchanged. Backend work is limited to the raw file capability needed by document previews.

## Page Design

### Home

Home is one raised surface at `m-2`. Its inner layout is capped at 1080px. At `lg`, a 280px project/utility sidebar sits beside a session column capped near 720px. Orchestrator sessions are grouped by exact cwd. Named stage-agent lines whose session name starts with `lazyresearch:` are filtered from the top-level reopen list because opening one through the orchestrator Work page would mount the wrong runtime role. Project rows expose New session; the main column includes search, live status, and orchestrator history. Mobile stacks these controls in one column without removing New session or Settings.

### Work

Desktop retains a flexible chat panel and a pixel-width, resizable right panel separated by an 8px gap. The chat panel owns agent chips, transcript, and composer. The right panel switches between Files and Agents without unmounting their state.

Below 820px, a top tablist switches between `Chat`, `Files`, and `Agents`. Each view fills the available Work surface. Chat position, composer draft, opened files, tree expansion, active preview, and agent focus survive tab switches.

The Agents view uses the fixed ADR-022 roster: `orchestrator`, `search`, `experiment`, `writing`, and `figures`. It labels allowed nested dispatch where available (`experiment` to `search`; `writing` to `search`/`figures`; `figures` to `search`) and never describes agents as parallel. At most one stage agent is running. Dynamic activity/history tabs remain serial and can later bind to each agent's persistent `lazyresearch:<agent>` line without changing the Work navigation model. Any consumed `SubagentDetails.mode` is `"single" | "chain"` only.

### Config And Directory Selection

Config is global-only. Desktop uses tree/editor split panes; mobile navigates from tree to editor with a Back control. Directory selection uses the same titlebar, row density, focus rings, path completion, and explicit tree loading states. It fills the mobile viewport and is a bounded overlay on desktop.

## File Tree State

Each listed directory has one explicit state: `unloaded`, `loading`, `loaded`, or `error`.

- `unloaded`: show a chevron; no request has started.
- `loading`: show a spinner only while the request is pending.
- `loaded`: show the chevron and render children when expanded, including a stable empty state.
- `error`: show the chevron/error affordance and expose Retry.

Expanding an unloaded or failed node starts one request. Collapsing does not discard loaded children. Refresh invalidates the selected directory and every cached descendant before reloading, preventing stale or permanently empty trees.

## Document Preview

Preview dispatch uses the file extension and server content metadata.

### Markdown

Use `react-markdown` with exact-version GFM, math, and KaTeX plugins. Raw HTML is not rendered. Relative image URLs resolve through the raw file endpoint against the Markdown file's parent directory. Relative file links open inside the File workspace; external HTTP(S) links open in a new protected tab. Markdown content follows the restrained opencode typography and remains readable on narrow screens; tables and code blocks scroll inside their own containers.

### PDF

Use exact-version `pdfjs-dist`. Build a LazyResearch toolbar and viewer around PDF.js primitives rather than a browser-native iframe. The raw route supports byte ranges so PDF.js can load large documents incrementally. Toolbar controls are icons with accessible labels/tooltips and collapse to a compact mobile layout. Invalid PDFs, worker failures, password requirements, and network failures render inline error states with Retry where meaningful.

### Other Files

UTF-8 files use the current bounded read-only text preview. Truncated content shows byte count and the 1 MiB notice. Binary/non-UTF-8 files show a concise unsupported preview state. Loading and error states reserve stable geometry.

## Raw File Contract

Add `GET /api/file/raw?path=`. The Directory service canonicalizes the path, verifies it is a readable file, determines a conservative MIME type, and returns bytes with `Content-Length` and `Accept-Ranges: bytes`.

A valid single `Range: bytes=start-end` request returns `206`, `Content-Range`, and the selected bytes. Suffix and open-ended ranges are supported. Unsatisfiable or malformed ranges return `416` with `Content-Range: bytes */<size>`. The endpoint uses the same typed 404/400/403 behavior as the text route. Multi-range responses are not required.

## Error Handling

Errors appear inline near the failed operation, never as overlapping toasts. Retry is offered for directory loads, preview loads, PDF loads, and dropped session streams. User-entered composer/config content remains intact after recoverable errors. Unsupported files are distinct from failed requests.

## Testing And Verification

- Backend unit/integration tests cover MIME selection, full raw responses, standard/open-ended/suffix ranges, invalid ranges, and unreadable/non-file paths.
- Frontend component tests cover every tree state, Retry/refresh invalidation, mobile Work tabs and retained state, Markdown GFM/math/relative resources, PDF toolbar behavior, and preview errors.
- Existing session streaming, reconnect, stop, config validation, and directory selection behavior remains covered.
- Run `bun run test`, `bun run typecheck`, and `bun run build:web`.
- Before implementation, terminate the process listening on port 3000. Start the backend with `npm run dev -- web` in the background and Vite HMR with `npm run dev:web` in the background.
- Use Playwright CLI to compare LazyResearch against `localhost:4096` at desktop and mobile viewports. Check screenshots, bounding boxes, page overflow, console errors, tree loading icons, Markdown content, PDF rendering, and all required controls.

## Delegation And Review

Implementation tasks are delegated to isolated subagents using `deepseekv4flashfree` as requested. Backend raw-file work, tree state, document preview, and page-shell rewrite are split where file ownership permits; shared frontend integration is sequenced to avoid conflicting edits. After every delegation, the primary agent reviews diffs and tests against this design and sends unmet requirements back for rework. The user performs final visual acceptance after the primary agent's verification pass.

## Out Of Scope

- Porting opencode's SolidJS runtime or private UI packages.
- Git review/tree features, terminal panes, provider login UI, model picker, compaction controls, or session branching controls.
- Editing project-level `.lazyresearch` config from the Web.
- Multi-range HTTP responses or editing project files from the preview.
