# OpenCode-Style Web UI Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite every LazyResearch Web page in the current opencode visual language and add reliable mobile navigation, lazy-tree state, academic Markdown preview, and full PDF.js preview.

**Architecture:** Keep the React/Pi session data boundaries and replace the frontend component tree around a shared opencode-style shell. Add one focused raw-file backend contract, one reusable lazy-tree hook, and content-specific preview components; integrate them into persistent desktop/mobile Work views.

**Tech Stack:** Bun, TypeScript 5.9, React 19, Vite 6, Tailwind CSS v4, lucide-react, react-markdown, PDF.js, Vitest, Testing Library, Playwright CLI.

## Global Constraints

- Work only in `/home/cyy/MyProject/LazyResearch/.worktrees/webui-opencode-rewrite` on `feat/webui-opencode-rewrite`.
- Read `/home/cyy/MyProject/LazyResearch/.docs/webui.md`, `.docs/pi-backend-parity.md`, `.docs/architecture.md`, and `.docs/decisions.md` before editing.
- Use `/tmp/opencode/opencode-src` and `http://localhost:4096` as the visual and interaction references.
- Preserve React 19, Tailwind CSS v4, Pi RPC/SSE, `session-reducer`, exact-cwd semantics, and the global-only config UI.
- Direct dependencies remain pinned exactly: `pdfjs-dist@6.2.108`, `remark-gfm@4.0.1`, `remark-math@6.0.0`, `rehype-katex@7.0.1`, and `katex@0.18.1`.
- Use opencode v2 light tokens, 41px titlebars, 8px outer insets, 10px raised surfaces, and 28px dense controls.
- Mobile Work uses persistent full-width `Chat`, `Files`, and `Agents` top tabs below 820px.
- Do not render raw Markdown HTML, import opencode private packages, add Git UI, or expose project config editing.
- Follow TDD for each behavior and commit each completed task separately.

---

### Task 0: Frontend Gate And Detached HMR Environment

**Files:**
- No source files are modified.

**Interfaces:**
- Produces: authoritative frontend skill guidance loaded into the implementation session.
- Produces: backend API at `http://127.0.0.1:3000` and the Vite HMR URL printed by `npm run dev:web`.

- [ ] **Step 1: Complete the mandatory frontend skill gate**

Invoke the `find-skills` skill, then load and follow the project `frontend-design` skill before any frontend source edit. Re-read the four authoritative `.docs/` files listed in Global Constraints if implementation occurs in a fresh subagent context.

- [ ] **Step 2: Free port 3000 exactly as requested**

```bash
PID=$(lsof -tiTCP:3000 -sTCP:LISTEN || true)
if [ -n "$PID" ]; then kill $PID; fi
while lsof -tiTCP:3000 -sTCP:LISTEN >/dev/null 2>&1; do sleep 0.2; done
```

- [ ] **Step 3: Start backend and Vite HMR as detached npm processes**

```bash
nohup npm run dev -- web > /tmp/lazyresearch-web-backend.log 2>&1 &
echo $! > /tmp/lazyresearch-web-backend.pid
nohup npm run dev:web -- --host 127.0.0.1 > /tmp/lazyresearch-web-vite.log 2>&1 &
echo $! > /tmp/lazyresearch-web-vite.pid
```

Poll `http://127.0.0.1:3000/api/status` and the Vite URL printed in `/tmp/lazyresearch-web-vite.log` until both return HTTP success. Do not use a fixed sleep. Leave both processes running throughout implementation so frontend edits hot reload.

### Task 1: MIME-Correct Ranged Raw Files

**Files:**
- Create: `src/web/raw-file.ts`
- Create: `src/web/raw-file.test.ts`
- Modify: `src/web/contracts.ts`
- Modify: `src/web/directories.ts`
- Modify: `src/web/directories.test.ts`
- Modify: `src/web/routes.ts`
- Modify: `src/web/server.test.ts`

**Interfaces:**
- Produces: `RawFileDescriptor { path: string; size: number; mimeType: string }`.
- Produces: `ByteRange { start: number; end: number }` with inclusive offsets.
- Produces: `parseByteRange(value: string | null, size: number): ByteRange | null`.
- Produces: `DirectoryService.describeFile(path): RawFileDescriptor` and `DirectoryService.readFileBytes(path, range): Uint8Array`.
- Produces: `FileContentDto.binary: boolean` so non-UTF-8 text fallback is explicit rather than inferred in React.
- Produces: `GET /api/file/raw?path=` for Tasks 3 and 5.

- [ ] **Step 1: Write failing range and MIME tests**

```ts
it.each([
  ["bytes=1-3", { start: 1, end: 3 }],
  ["bytes=4-", { start: 4, end: 9 }],
  ["bytes=-3", { start: 7, end: 9 }],
])("parses %s", (header, expected) => {
  expect(parseByteRange(header, 10)).toEqual(expected);
});

it("rejects malformed, multiple, and unsatisfiable ranges", () => {
  expect(() => parseByteRange("bytes=20-30", 10)).toThrow(RawFileRangeError);
  expect(() => parseByteRange("bytes=0-1,4-5", 10)).toThrow(RawFileRangeError);
  expect(() => parseByteRange("items=0-1", 10)).toThrow(RawFileRangeError);
});

it("maps document extensions to conservative MIME types", () => {
  expect(mimeTypeFor("paper.pdf")).toBe("application/pdf");
  expect(mimeTypeFor("notes.md")).toBe("text/markdown; charset=utf-8");
  expect(mimeTypeFor("figure.png")).toBe("image/png");
  expect(mimeTypeFor("archive.bin")).toBe("application/octet-stream");
});
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `bunx vitest run src/web/raw-file.test.ts src/web/directories.test.ts src/web/server.test.ts`

Expected: FAIL because `raw-file.ts`, descriptor methods, and the route do not exist.

- [ ] **Step 3: Implement pure range/MIME logic and reuse file validation**

```ts
export interface ByteRange { start: number; end: number }
export class RawFileRangeError extends Error {}

export function parseByteRange(value: string | null, size: number): ByteRange | null {
  if (value === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || size === 0) throw new RawFileRangeError("Invalid byte range");
  const [, first, last] = match;
  if (!first && !last) throw new RawFileRangeError("Invalid byte range");
  const start = first ? Number(first) : Math.max(0, size - Number(last));
  const end = last && first ? Math.min(Number(last), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) {
    throw new RawFileRangeError("Unsatisfiable byte range");
  }
  return { start, end };
}
```

Refactor `DirectoryService.readFile` to call one private readable-file resolver also used by `describeFile` and `readFileBytes`; do not duplicate `realpathSync`, `statSync`, or access checks.

Mark text content binary when its bounded byte sample contains NUL bytes or UTF-8 decoding with `TextDecoder("utf-8", { fatal: true })` fails. Return an empty `content` string when `binary` is true, while preserving `byteCount` and `truncated`.

- [ ] **Step 4: Implement the raw response route**

For no Range header, return `200`, full bytes, `Content-Type`, `Content-Length`, and `Accept-Ranges: bytes`. For a valid range, return `206` plus `Content-Range: bytes <start>-<end>/<size>`. Convert `RawFileRangeError` to `416` plus `Content-Range: bytes */<size>` without changing existing typed directory errors.

- [ ] **Step 5: Add route-level behavior tests and run them**

```ts
const response = await handler(new Request(`${base}/api/file/raw?path=${encodeURIComponent(pdf)}`, {
  headers: { Range: "bytes=1-3" },
}));
expect(response.status).toBe(206);
expect(response.headers.get("content-range")).toBe("bytes 1-3/5");
expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
```

Run: `bunx vitest run src/web/raw-file.test.ts src/web/directories.test.ts src/web/server.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/web/raw-file.ts src/web/raw-file.test.ts src/web/contracts.ts src/web/directories.ts src/web/directories.test.ts src/web/routes.ts src/web/server.test.ts
git commit -m "Add ranged raw file previews"
```

### Task 2: Shared Explicit Lazy-Tree State

**Files:**
- Create: `src/webui/src/hooks/useLazyTree.ts`
- Create: `src/webui/src/hooks/useLazyTree.test.tsx`
- Modify: `src/webui/src/components/FilesPanel.tsx`
- Modify: `src/webui/src/components/DirectoryDialog.tsx`
- Modify: `src/webui/src/components/DirectoryDialog.test.tsx`
- Modify: `src/webui/src/pages/WorkPage.test.tsx`

**Interfaces:**
- Consumes: async directory/file listing functions already exported by `src/webui/src/api.ts`.
- Produces: `NodeLoadState<T> = { status: "unloaded" | "loading" | "loaded" | "error"; children: T[]; error?: string }`.
- Produces: `useLazyTree<T>({ root, loadChildren })` returning `children`, `status`, `error`, `expanded`, `toggle`, `retry`, and `refresh`.

- [ ] **Step 1: Write failing hook tests for all four states**

```tsx
const pending = deferred<Entry[]>();
const { result } = renderHook(() => useLazyTree({ root: "/p", loadChildren: vi.fn(() => pending.promise) }));
expect(result.current.status("/p")).toBe("loading");
expect(result.current.status("/p/folder")).toBe("unloaded");
await act(() => pending.resolve([{ path: "/p/folder", name: "folder" }]));
expect(result.current.status("/p")).toBe("loaded");
```

Also test one request per expansion, retry after rejection, and `refresh("/p/a")` removing `/p/a` plus `/p/a/b` while retaining `/p/c`.

- [ ] **Step 2: Run the hook test and verify failure**

Run: `bunx vitest run src/webui/src/hooks/useLazyTree.test.tsx`

Expected: FAIL because the hook does not exist.

- [ ] **Step 3: Implement the hook with request identity protection**

Use functional state updates and an `inFlight` ref keyed by path. Ignore stale resolutions after `root` changes or refresh invalidates a path. Root loading begins in an effect; child loading begins only from `toggle` or `retry`.

- [ ] **Step 4: Replace sentinel empty arrays in both trees**

Render rules:

```tsx
const state = tree.status(entry.path);
const icon = state === "loading" ? <Spinner /> : <ChevronRight className={expanded ? "rotate-90" : ""} />;
```

An untouched child must have `state === "unloaded"` and show the chevron. An error row shows Retry adjacent to the folder label. Refresh calls the hook's `refresh`, never `setChildrenByPath(...[])` followed by a stale closure.

- [ ] **Step 5: Add regression tests for the reported spinner bug**

```tsx
expect(await screen.findByText("folder")).toBeVisible();
expect(screen.queryByLabelText("Loading folder")).toBeNull();
expect(screen.getByRole("button", { name: "Expand folder" })).toBeVisible();
await user.click(screen.getByRole("button", { name: "Expand folder" }));
expect(screen.getByLabelText("Loading folder")).toBeVisible();
```

Run: `bunx vitest run src/webui/src/hooks/useLazyTree.test.tsx src/webui/src/components/DirectoryDialog.test.tsx src/webui/src/pages/WorkPage.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/webui/src/hooks src/webui/src/components/FilesPanel.tsx src/webui/src/components/DirectoryDialog.tsx src/webui/src/components/DirectoryDialog.test.tsx src/webui/src/pages/WorkPage.test.tsx
git commit -m "Fix lazy tree loading states"
```

### Task 3: Academic Markdown And Full PDF.js Preview

**Files:**
- Modify: `package.json`
- Modify: `bun.lock`
- Modify: `src/webui/src/api.ts`
- Create: `src/webui/src/components/previews/preview-paths.ts`
- Create: `src/webui/src/components/previews/MarkdownPreview.tsx`
- Create: `src/webui/src/components/previews/PdfPreview.tsx`
- Create: `src/webui/src/components/previews/pdf-runtime.ts`
- Create: `src/webui/src/components/previews/FilePreview.tsx`
- Create: `src/webui/src/components/previews/FilePreview.test.tsx`
- Modify: `src/webui/src/index.css`

**Interfaces:**
- Consumes: `GET /api/file/raw?path=` from Task 1 and `FileContentDto` from the existing text route.
- Produces: `rawFileUrl(path: string): string`.
- Produces: `resolveLocalPreviewPath(documentPath: string, href: string): string | null`.
- Produces: `FilePreview({ path, textFile, onOpenFile })` dispatching Markdown, PDF, or text.
- Produces: `PdfLoader` abstraction in `pdf-runtime.ts` for deterministic component tests.

- [ ] **Step 1: Install exact dependencies**

Run:

```bash
bun add --exact pdfjs-dist@6.2.108 remark-gfm@4.0.1 remark-math@6.0.0 rehype-katex@7.0.1 katex@0.18.1
```

Verify `package.json` contains exact versions without `^` or `~`.

- [ ] **Step 2: Write failing path and Markdown dispatch tests**

```tsx
expect(resolveLocalPreviewPath("/p/docs/paper.md", "../figures/a.png")).toBe("/p/figures/a.png");
expect(resolveLocalPreviewPath("/p/docs/paper.md", "https://example.com/a.png")).toBeNull();

render(<FilePreview path="/p/paper.md" textFile={markdownDto} onOpenFile={onOpenFile} />);
expect(screen.getByRole("heading", { name: "Method" })).toBeVisible();
expect(screen.getByRole("table")).toBeVisible();
expect(screen.getByRole("img")).toHaveAttribute("src", rawFileUrl("/p/figures/model.png"));
```

Include a math assertion against `.katex`, an internal link click assertion for `onOpenFile`, and an external link assertion for `target="_blank"` and `rel="noreferrer noopener"`.

- [ ] **Step 3: Implement safe Markdown rendering**

Use `remarkGfm`, `remarkMath`, and `rehypeKatex`; import `katex/dist/katex.min.css` and do not add `rehype-raw`. Override `a` and `img` renderers to resolve relative resources. Add scoped `.v2-document` CSS for headings, paragraphs, blockquotes, tables, task lists, KaTeX overflow, and code/table local scrolling.

- [ ] **Step 4: Write failing PDF control tests with a fake loader**

```tsx
render(<PdfPreview path="/p/paper.pdf" loader={fakePdfLoader({ pages: 3, text: ["alpha", "beta alpha", "gamma"] })} />);
expect(await screen.findByText("1 / 3")).toBeVisible();
await user.click(screen.getByRole("button", { name: "Next page" }));
expect(screen.getByLabelText("Current page")).toHaveValue(2);
await user.type(screen.getByRole("searchbox", { name: "Find in PDF" }), "alpha");
expect(await screen.findByText("1 / 2 matches")).toBeVisible();
expect(screen.getByRole("link", { name: "Download PDF" })).toHaveAttribute("href", rawFileUrl("/p/paper.pdf"));
```

Also test zoom, fit width, rotation, next/previous match, malformed PDF error, and Retry.

- [ ] **Step 5: Implement PDF runtime and viewer**

Set `GlobalWorkerOptions.workerSrc` using `new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url)`. Load with `getDocument({ url: rawFileUrl(path) })`. Render continuous canvas pages at the selected scale/rotation. Extract each page's text once for case-insensitive match counts and page navigation. Use `ResizeObserver` for fit width and cancel PDF loading/render tasks during cleanup.

- [ ] **Step 6: Run preview tests and build**

Run: `bunx vitest run src/webui/src/components/previews/FilePreview.test.tsx && bun run typecheck && bun run build:web`

Expected: PASS, then successful typecheck and Vite build with the PDF worker emitted.

- [ ] **Step 7: Commit**

```bash
git add package.json bun.lock src/webui/src/api.ts src/webui/src/components/previews src/webui/src/index.css
git commit -m "Add Markdown and PDF previews"
```

### Task 4: Shared Shell, Home, Directory, And Config Rewrite

**Files:**
- Create: `src/webui/src/components/AppShell.tsx`
- Create: `src/webui/src/components/AppShell.test.tsx`
- Modify: `src/webui/src/App.tsx`
- Modify: `src/webui/src/components/Topbar.tsx`
- Modify: `src/webui/src/pages/HomePage.tsx`
- Modify: `src/webui/src/pages/HomePage.test.tsx`
- Modify: `src/webui/src/components/SessionList.tsx`
- Modify: `src/webui/src/components/DirectoryDialog.tsx`
- Modify: `src/webui/src/components/DirectoryDialog.test.tsx`
- Modify: `src/webui/src/components/ConfigBrowser.tsx`
- Modify: `src/webui/src/components/ConfigBrowser.test.tsx`
- Modify: `src/webui/src/index.css`

**Interfaces:**
- Consumes: current status, session creation/opening, directory, and global config APIs.
- Produces: `AppShell({ titlebar, children })` with one raised `m-2` page surface.
- Produces: `groupSessionsByCwd(history, active)` for Home project/session presentation.
- Preserves: global-only Config Browser and DirectoryDialog keyboard behavior.

- [ ] **Step 1: Write failing shell geometry and Home grouping tests**

```tsx
render(<AppShell titlebar={<span>Title</span>}><div>Body</div></AppShell>);
expect(screen.getByRole("banner")).toHaveClass("h-[41px]");
expect(screen.getByText("Body").parentElement).toHaveClass("m-2", "rounded-[10px]");

expect(groupSessionsByCwd(history, active).map((group) => group.cwd)).toEqual(["/a", "/b"]);
```

Home tests must assert project rows, search filtering, New session from a project row, live status, history opening, and mobile utility actions remaining in the DOM.

- [ ] **Step 2: Run shell/Home tests and verify failure**

Run: `bunx vitest run src/webui/src/components/AppShell.test.tsx src/webui/src/pages/HomePage.test.tsx`

Expected: FAIL because the shell and grouping function do not exist.

- [ ] **Step 3: Implement the current opencode Home structure**

Use the live reference geometry: `m-2`, `max-w-[1080px]`, desktop `grid-cols-[280px_minmax(0,720px)]`, mobile single column, dense project/session rows, 28px icon controls, and no nested cards. Keep polling and session API behavior unchanged.

- [ ] **Step 4: Rewrite DirectoryDialog and ConfigBrowser on the shell primitives**

DirectoryDialog is full viewport below `sm` and bounded above it. Config is a desktop split and a mobile tree/editor route. Keep path completion keys, JSON validation, unsaved content, atomic-save error display, and global-only scope. Replace visible arrow text with Lucide icons and accessible labels.

- [ ] **Step 5: Run affected component tests**

Run: `bunx vitest run src/webui/src/components/AppShell.test.tsx src/webui/src/pages/HomePage.test.tsx src/webui/src/components/DirectoryDialog.test.tsx src/webui/src/components/ConfigBrowser.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/webui/src/App.tsx src/webui/src/index.css src/webui/src/components/AppShell.tsx src/webui/src/components/AppShell.test.tsx src/webui/src/components/Topbar.tsx src/webui/src/components/SessionList.tsx src/webui/src/components/DirectoryDialog.tsx src/webui/src/components/DirectoryDialog.test.tsx src/webui/src/components/ConfigBrowser.tsx src/webui/src/components/ConfigBrowser.test.tsx src/webui/src/pages/HomePage.tsx src/webui/src/pages/HomePage.test.tsx
git commit -m "Rewrite the Web application shell"
```

### Task 5: Persistent Desktop/Mobile Work And File Workspace

**Files:**
- Create: `src/webui/src/components/MobileWorkTabs.tsx`
- Create: `src/webui/src/components/MobileWorkTabs.test.tsx`
- Modify: `src/webui/src/pages/WorkPage.tsx`
- Modify: `src/webui/src/pages/WorkPage.test.tsx`
- Modify: `src/webui/src/components/FileBrowser.tsx`
- Modify: `src/webui/src/components/FilesPanel.tsx`
- Modify: `src/webui/src/components/FileTabs.tsx`
- Modify: `src/webui/src/components/ChatTranscript.tsx`
- Modify: `src/webui/src/components/ChatComposer.tsx`
- Modify: `src/webui/src/index.css`

**Interfaces:**
- Consumes: `FilePreview` from Task 3 and `useLazyTree` from Task 2.
- Produces: `WorkView = "chat" | "files" | "agents"` and `MobileWorkTabs`.
- Produces: file tab state with one replaceable preview tab and pinned tabs.
- Preserves: SSE connection, snapshot hydration, composer Send/Stop, agent focus, and panel width clamping.

- [ ] **Step 1: Write failing mobile persistence tests**

```tsx
render(<WorkPage id="s1" cwd="/p" onBack={vi.fn()} />);
await user.type(screen.getByRole("textbox", { name: /message/i }), "draft");
await user.click(screen.getByRole("tab", { name: "Files" }));
await user.click(await screen.findByText("paper.md"));
await user.click(screen.getByRole("tab", { name: "Chat" }));
expect(screen.getByRole("textbox", { name: /message/i })).toHaveValue("draft");
await user.click(screen.getByRole("tab", { name: "Files" }));
expect(screen.getByRole("tab", { name: "paper.md" })).toHaveAttribute("aria-selected", "true");
```

Assert all three view roots remain mounted, inactive roots are hidden/inert, and the desktop panel still owns explicit width plus the invisible resize handle.

- [ ] **Step 2: Write failing file preview/pin tests**

Single-click `a.md`, then single-click `b.md`: the temporary preview tab is replaced. Double-click `b.md`, then single-click `c.pdf`: both pinned `b.md` and temporary `c.pdf` remain. Closing active tabs selects the nearest remaining tab and never destroys the chat transcript.

- [ ] **Step 3: Implement persistent Work views**

Keep one EventSource lifecycle in `WorkPage`. Mount chat, files, and agents once. CSS shows coupled chat/right panes at `min-width: 820px`; below it, `MobileWorkTabs` controls one full-width visible root. Do not duplicate transcript/composer components between desktop and mobile.

- [ ] **Step 4: Integrate content-aware File workspace**

Use `FilePreview` for the active path. Cache text requests per path; PDF.js performs raw range requests. Preserve file tree/filter scroll separately from preview scroll. Make the file sidebar resizable on desktop and full width above the preview on narrow mobile Files view.

- [ ] **Step 5: Align transcript, agent, and composer details**

Match opencode's current message width, title/header spacing, tool rows, reasoning disclosure, 60px composer body, 50px control row, and Send-to-Stop transition. Use stable min/max dimensions so streaming text and status labels cannot move surrounding controls.

- [ ] **Step 6: Run Work tests and responsive component tests**

Run: `bunx vitest run src/webui/src/components/MobileWorkTabs.test.tsx src/webui/src/pages/WorkPage.test.tsx src/webui/src/components/previews/FilePreview.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/webui/src/components/MobileWorkTabs.tsx src/webui/src/components/MobileWorkTabs.test.tsx src/webui/src/components/FileBrowser.tsx src/webui/src/components/FilesPanel.tsx src/webui/src/components/FileTabs.tsx src/webui/src/components/ChatTranscript.tsx src/webui/src/components/ChatComposer.tsx src/webui/src/pages/WorkPage.tsx src/webui/src/pages/WorkPage.test.tsx src/webui/src/index.css
git commit -m "Rewrite the responsive Work workspace"
```

### Task 6: Full Verification, Live HMR, And Visual Rework

**Files:**
- Modify only files implicated by failures or visual mismatches from Tasks 1-5.
- Do not commit generated screenshots, Playwright snapshots, logs, PIDs, or temp fixtures.

**Interfaces:**
- Consumes: the complete application from Tasks 1-5.
- Produces: passing automated checks and a live HMR URL for user visual acceptance.

- [ ] **Step 1: Run all automated gates**

Run:

```bash
bun run test
bun run typecheck
bun run build:web
```

Expected: 0 failed tests, 0 TypeScript errors, and a successful Vite production build.

- [ ] **Step 2: Confirm detached development services are still healthy**

Check the PID files and request the backend/Vite URLs. If either process exited, inspect its `/tmp/lazyresearch-web-*.log`, fix the root cause, and restart only that process with the Task 0 command.

- [ ] **Step 3: Inspect opencode and LazyResearch at desktop**

Use Playwright CLI at 1440x900. Compare titlebar height, 8px outer inset, 10px surfaces, Home columns, Work coupled pane widths, resize behavior, row/control density, typography, and empty/error states. Record bounding boxes with `snapshot --boxes`; take screenshots only for visual comparison.

- [ ] **Step 4: Verify tree, Markdown, and PDF behavior**

Open a project containing nested folders, Markdown with a table/formula/local image, and a PDF. Confirm untouched folders never spin, expansion spins only while pending, refresh/retry work, Markdown local resources resolve, PDF canvases contain nonblank pixels, search counts update, zoom/fit/rotate work, and download points to `/api/file/raw`.

- [ ] **Step 5: Inspect mobile and overflow**

Use Playwright CLI at 390x844 and 412x915. Verify Home, DirectoryDialog, Work tabs, Files, Markdown, PDF toolbar, Agents, and Config tree/editor. Evaluate:

```js
({
  viewport: document.documentElement.clientWidth,
  scrollWidth: document.documentElement.scrollWidth,
  overflowing: [...document.querySelectorAll("*")].filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.getAttribute("aria-label") || el.className).slice(0, 30),
})
```

The page-level `scrollWidth` must equal the viewport; local code/table/tab/PDF toolbar scrollers are allowed.

- [ ] **Step 6: Inspect browser diagnostics and rework failures**

Run `playwright-cli console` and `playwright-cli requests`. Fix React warnings, failed assets, PDF worker errors, inaccessible controls, overlap, and deviations from the reference. Repeat Steps 1 and 3-6 after every rework cycle until all checks pass.

- [ ] **Step 7: Commit verified corrections**

```bash
git status --short
git diff --check
git add <only source and test files changed during verification>
git commit -m "Polish opencode Web UI parity"
```

If verification required no source changes, do not create an empty commit.
