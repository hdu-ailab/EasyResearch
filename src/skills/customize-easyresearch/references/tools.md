# User Tools

A Tool is a callable operation registered by a Pi TypeScript extension. Its
registered `name`, parameter schema and `execute` function define the callable
interface. A filename, Agent allowlist entry, shell script or Skill alone does
not register a Tool.

## Choose the scope and matching API

Prefer an existing tool or Skill procedure when it meets the request. For a new
Tool, use a user-owned extension:

| Need | Location |
| --- | --- |
| Available across projects; default choice | `~/.easyresearch/agent/extensions/<name>.ts` |
| Cross-project extension with helpers | `~/.easyresearch/agent/extensions/<name>/index.ts` |
| Only the selected project | `<exact-session-cwd>/.easyresearch/extensions/<name>/index.ts` |

Use the actual user's home and exact session cwd. Do not search project
ancestors. Keep helpers inside the extension's directory, imported relatively
from `index.ts`; loose files at the `extensions/` root may themselves be
discovered as entries. Check existing files and tool names before publishing.
Keep backups outside discovery roots so a second `.ts` entry cannot register
the same name accidentally. One extension can register several tools; tool
names are not derived from filenames.

Read the matching Pi `extensions.md` sections on available imports, custom
tools and lifecycle before authoring. Installed copies normally live at
`<agentDir>/bundled/pi/docs/extensions.md`, with examples in the sibling
`examples/extensions/`. Obtain Pi's exact version from the
`@earendil-works/pi-coding-agent` dependency in the materialized
`pi/package.json`, not that manifest's EasyResearch version. Source checkouts
can use the exact installed dependency's docs. If missing, obtain that version's
documentation rather than upstream latest. The example below targets Pi 1.6.

Use EasyResearch's paths and automatic idle resource application rather than
copying standalone Pi launch/reload commands. No edit to the installation
directory, npm package, bundled tree or application `src/` is required. Existing
native `settings.extensions` entries can select explicit paths; preserve them
and their scope. Do not introduce `tools.json` or enable a `packages` array.

## Complete dependency-free example

Save as global `extensions/text-metrics.ts`, or as project
`extensions/text-metrics/index.ts` when project scope was requested.
`typebox` and the Pi API are supplied by the host; no dependency installation
is needed.

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (api: ExtensionAPI) {
  api.registerTool({
    name: "text_metrics",
    label: "Text metrics",
    description:
      "Count Unicode code points (including line endings) and lines in at most 4096 code points. Empty text has zero lines. No file or network access.",
    parameters: Type.Object({
      text: Type.String({ maxLength: 4096, description: "Text to measure" }),
    }),
    async execute(_toolCallId, { text }, signal) {
      signal?.throwIfAborted();
      const metrics = {
        codePoints: Array.from(text).length,
        lines: text === "" ? 0 : text.split(/\r\n|\r|\n/u).length,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(metrics) }],
        details: metrics,
      };
    },
  });
}
```

After actual registration and activation, call `text_metrics` with
`{"text":"A😀\r\nB"}`. Its tool result is `{"codePoints":5,"lines":2}`:
CR and LF each count as a code point but together delimit one line. Empty
text returns `{"codePoints":0,"lines":0}`. This measures code points, not model
tokens or visual graphemes.

Keep new tools similarly bounded and explicit about effects. Return model-facing
`content` plus `details`, including in progress updates. Throw a concise error
or return `isError: true` on failure; do not turn cancellation into success or
echo credentials/raw sensitive exceptions.

The factory should register capabilities, not start background processes,
watchers, sockets or timers. Start needed resources from `execute` or
`session_start`, and close session-owned resources in an idempotent
`session_shutdown` handler, including reload/replacement. Keep state per runtime.
Honor `execute`'s `AbortSignal`, pass it to blocking I/O or `api.exec`, and clean
up operation-owned resources in `finally`. This example creates no resources
requiring cleanup. Tool selection is not an OS sandbox; extension code runs
inside the host even when an Agent's allowlist excludes its tools.

## Select the Agents without losing capabilities

| Effective Agent `tools` | User Tool activation |
| --- | --- |
| `research-assistant`: missing, YAML-empty or `[]` | Successful user registrations join its controlled tools |
| Other specialist/custom Agent: missing, YAML-empty or `[]` | Controlled bundled tools only; user tools need explicit opt-in |
| Any Agent: non-empty list | Only listed, actually registered names; the main Agent stays restrictive too |

Default to the Research Assistant and leave other Agent files alone. If the main
Agent already has a strict list, preserve it unless the user explicitly authorizes
adding the tool to that list. Do not clear the list or override activation from
an extension to bypass the restriction.

When the user names another Agent:

1. Read its effective global-over-bundled definition and current capability
   metadata for the selected cwd. Agent definitions are global even when a Tool
   is project-local; an allowlist name cannot create that Tool in other projects.
2. For an existing non-empty list, retain all entries and append the exact
   registered tool name once.
3. For a missing/empty list, obtain and show the Agent's effective **bundled**
   tool names, then write those names plus the new Tool as an explicit list.
   Do not change `[]` to just `[text_metrics]`: that would drop its former tools.
   Defaults depend on the Agent and its subagent policy; do not guess a universal
   list or copy another Agent's capabilities. If this evidence is unavailable,
   finish the extension and report the grant as pending instead of broadening or
   stripping capabilities.
4. Preserve the Agent body, Skills, subagent policy and unrelated fields. Verify
   the new tool and retained capabilities after idle application. A strict list
   does not automatically gain future bundled additions.

Adding an allowlist name is authorization, not proof of registration. A tool
must be successfully loaded and registered before it can become effective.

## Create, update and remove

**Create:** establish scope and a unique callable name, write the complete
extension, and make only authorized Agent-list edits. Standard locations need
no additional settings entry. Validate with the three stages below.

**Update:** inspect the current entry and imports, preserve the tool name and
unrelated behavior, edit the entry or local helper, and publish complete bytes.
Use an atomic same-directory replacement when available and avoid overwriting
concurrent user edits. Repeat a small actual call whose expected result
distinguishes the new behavior from the old; a saved timestamp cannot prove
dependency cache invalidation.

**Remove:** remove only that tool's registration and unused owned imports/helpers.
If its extension contains only that tool, remove its entry or dedicated directory.
Preserve shared code and other registrations. Remove only corresponding explicit
`settings.extensions` entries and obsolete Agent allowlist names, if present.
Do not silently turn a deliberately strict list into `[]`: that changes it to
the Agent's defaults. After idle application confirm the tool is absent from the
target Agent's effective list; preserve historical calls in the transcript.

## Apply and verify in three stages

1. **Saved:** inspect the correct scoped entry, imports, schema and authorized
   Agent definition. File publication alone proves neither registration nor use.
2. **Runtime-applied:** regular files/directories in standard global/exact-cwd
   `extensions/` roots, including in-scope TS/JS/JSON helpers, participate in
   bounded monitoring of additions, changes, removals and file/directory atomic
   replacement. Idle runtimes apply accepted changes
   automatically through the native extension lifecycle. A busy Agent retains
   its old tools and implementations through the entire run, retries and
   summaries. Pending changes apply only after complete native settlement while
   idle, or at the next idle run preflight.
3. **Actually invoked:** after application, use a real session in the selected
   cwd and ask the intended Agent to call the registered name with small known
   inputs. Inspect the actual tool-call/result record, not a model-written answer
   or a direct shell reimplementation. Check normal and invalid inputs and,
   when applicable, cancellation, authorized side effects and retained tools.

If the Agent writes its own new Tool during a run, finish that run naturally.
The next tool turn in the same run still uses the old tool set. Verify in a
subsequent run; do not sleep, poll, force reload while busy, or restart to make
it callable immediately. `turn_end` and `agent_end` are not whole-run settlement.

Use Settings Tools and Agent details to inspect successful runtime registrations,
source scope and safe path-bearing load diagnostics. The existing
`GET /api/agents` supplies `effectiveTools` and optional `toolDiagnostics` for
integrations; it is not a Tool execution endpoint. No separate Tool verification
API exists. Settings does not evaluate extensions merely to render its list.
Before a real session loads an extension, it should not appear as callable merely
because its file exists. Open/resume the relevant exact-cwd session to load it
normally. Busy runtimes may still expose their previous generation until settlement.
Use Settings Refresh to recover stale views after synchronization, not as proof
that an active runtime already changed.

Prefer those standard regular-file/directory locations for automatic monitoring.
Explicit local `settings.extensions` paths and symlink targets are checked by
Settings Refresh and idle preflight, without a promise of automatic file watching.
An explicitly selected single file covers that file only; a selected directory
covers its in-scope code/JSON files. This does not traverse imports outside the
selected scope or `node_modules`. Verify the particular scope and actual updated
behavior instead of promising arbitrary external dependency-tree hot reload.
Keep ordinary authored helpers in the documented extension directory.

## Troubleshooting and upgrades

| Symptom | Check or action |
| --- | --- |
| File exists but no Tool appears | Has a real runtime loaded this scope? Check default export, actual `registerTool` name, imports and safe load diagnostics |
| Settings lists a name but target Agent cannot call it | Check its actual active tools, strict list, selected cwd and runtime application; a different busy runtime may still have an older registration |
| Other Agents need the Tool | Obtain explicit user scope and preserve their bundled/strict capabilities when adding the registered name |
| Helper edit seems ignored | Confirm the relative import and monitored location, let the run settle, then verify new behavior through an actual call; use Settings Refresh for stale-view recovery |
| Tool remains after removal | Check busy old runtimes and another entry/explicit path registering the same name; confirm a newly applied target runtime rather than deleting history |
| Extension fails to load | Check matching Pi API/imports, missing helpers/dependencies and name conflicts; preserve working tools and report the failing path without exposing secrets |

Normal application upgrades preserve global/project user extensions; the replaced
bundled tree and per-version same-name Agent/Skill `.bak` retirement do not include
`extensions/`. A specialist grant stored in a same-name bundled-Agent override may
need reconfirmation after that Agent override is retired. File preservation does
not guarantee indefinite API compatibility: after a Pi API change, consult the
matching docs, adapt only affected code and verify a real call again.

Report the changed paths, scope, authorized Agents, observed verification stage
and any concrete next action. When no runtime is available, deliver the saved
extension and clearly identify registration/invocation as still unverified.
