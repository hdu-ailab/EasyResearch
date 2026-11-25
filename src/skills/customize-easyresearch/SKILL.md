---
name: customize-easyresearch
description: >-
  Use when editing or troubleshooting EasyResearch's own agents, skills,
  settings.json, models.json, auth.json, extensions, prompts, themes, or
  .easyresearch configuration; also when creating, updating, enabling or removing
  custom Tools, or for API timeouts, retries, transport,
  compaction, thinking budgets, image settings, mounting skills, or explaining
  config scope and precedence. Not for paper research, experiments, writing,
  figures, or review themselves.
---

# Customizing EasyResearch

Inspect the effective configuration, change the smallest relevant layer, and
preserve unrelated fields. Prefer Agent/Skill Markdown for behavior changes;
use extensions only when configuration cannot express the requested behavior.

## Configuration location and precedence

Global root: `~/.easyresearch/agent/`. Project root:
`<exact-session-cwd>/.easyresearch/`. Paths below are relative to those roots.

| Configuration | Location and precedence |
| --- | --- |
| Agent definitions | Global `agents/<id>.md` over bundled Agents; project `agents/` is ignored |
| Agent model/thinking | Global `settings.json`: `easyresearch.agentDefaults.<id>` only |
| Skills | Project `skills/` > global `skills/` > optional home `~/.agents/skills/` > bundled Skills |
| General settings | Project `settings.json` deep-merges over global, except global-only policies |
| Models and credentials | Global `models.json` and `auth.json` |
| User Tools | Pi extensions in global `extensions/` or exact-project `extensions/`; see [Tools](references/tools.md) |
| Prompts, themes, explicit extensions | Respective global/project directories and Pi settings resource entries |

Same-name Agent/Skill resources replace lower layers completely; distinct names
append. The optional home Skill layer requires global
`easyresearch.enable_dot_agents_skill: true` (default false).
`Research Assistant.md` aliases `research-assistant.md`; the primary filename
wins if both exist. Other built-ins use their primary filenames.

Never search ancestor directories, read `~/.pi` or `.lazypaper`, migrate legacy
data, or create a separate `config.json`. EasyResearch does not read or write
`trust.json`. Bundled resources are fallbacks, not user edit targets: Web
Settings copies an Agent file or complete Skill directory into the global root
on edit. Preserve existing user copies.

## Common runtime settings

For API request timeouts, retry counts/backoff, SSE/WebSocket transport,
compaction, thinking-token budgets, or image handling, read the
[Configuration reference](references/configuration.md). It provides selective
JSON templates, defaults, provider limitations, and application timing.

1. Inspect the relevant global and exact-project settings. Choose global scope
   for all projects or project scope for a native Pi override; keep global-only
   EasyResearch policies global.
2. Merge only requested fields, preserving unrelated nested values. Native Pi
   settings such as `retry` belong at the settings root, not in `models.json`,
   Agent frontmatter, or `easyresearch.agentDefaults`.
3. Distinguish Agent retries from Provider retries and request timeouts from
   stream/connect timeouts and Web idle retention. State units, whether a value
   is a default or an example, and the affected provider's support. A single
   timeout does not impose a whole-task deadline.
4. State whether the setting requires a new/recreated runtime or has a supported
   live-update path. Do not seed a full template into existing settings or claim
   saving changed an in-flight request. For extension authoring, read the
   [Tool reference](references/tools.md); consult the configuration reference for
   Web APIs or diagnostics as needed.

## Editing Agents and Skills

### Agent definitions

Each Agent is a complete Markdown file: frontmatter configures capabilities;
the body supplies the system prompt. Keep the name aligned with the file stem
and provide a meaningful description. Example custom leaf Agent:

```md
---
name: literature-helper
description: Retrieve and verify paper metadata
enable: true
tools: [read, write, shell, web-search, webfetch]
skills: [paper-search, arxiv]
subagents: []
---

Verify candidate metadata against source pages. Report verified findings,
source URLs, unresolved gaps, and complete, partial, or blocked status.
```

| Field | Meaning |
| --- | --- |
| `enable` | Defaults true; literal false disables specialist/custom selection |
| `tools` | Missing, YAML-empty, or `[]`: Research Assistant loads controlled bundled and registered user tools; other Agents load controlled bundled tools only. Non-empty: strict allowlist of registered names |
| `skills` | Missing, YAML-empty, or `[]`: all controlled Skills; non-empty: resolved-name allowlist |
| `subagents` | Omitted: all eligible enabled Agents; `[]`: leaf; non-empty: allowlist |
| `model`, `thinking` | Ignored in Markdown; do not migrate these fields into settings |

The sole local command tool is `shell`. Existing exact `bash`/`powershell`
allowlist entries normalize to `shell`; new definitions should name `shell`.
Use the selected platform's native command syntax; `ssh-bash` remains a separate
remote tool with its own API. Local `shell` accepts `command`, optional `workdir`,
`timeout` in milliseconds, and `background`. Foreground omitted/zero timeout waits
two minutes, then backgrounds the original process. Explicit background commands
return early; positive timeout stops them, omitted/zero is unlimited. Completion
is automatically reported; do not teach polling or duplicate launches.
Unresolved Skills are skipped at runtime and diagnosed only in Settings.
For bundled Agents, retain role boundaries, inputs, procedure, dispatch targets,
completion criteria, and the specialist handoff contract.

Dispatch-capable strict definitions need `subagent` and `models` when their
instructions support user-requested model selection. `subagent` takes `agent`,
`description`, `prompt`, optional `sessionID`, and optional `model`; it always
backgrounds work and returns the native child session ID after durable admission.
Only the immediate caller can follow up with that ID, whether the child is running
or idle. Preserve the specialist nesting graph and exact-cwd artifact ownership.
Per-busy-period background reports may include outstanding work; idle is not task
completion. Treat `<background-result>` messages as harness input, not human
speech, and never fabricate or reproduce their XML. Do independent useful work
or finish the response for automatic wakeup rather than sleeping, polling,
checking progress, or duplicating pending work. Composer Stop interrupts the
current run; selected-task cancellation owns its tree, and terminal Exit owns all
work.

### Agent runtime defaults

Settings and Work both edit this sparse global settings object:

```json
{
  "easyresearch": {
    "agentDefaults": {
      "research-assistant": { "model": "provider/model-id", "thinking": "high" },
      "review": { "thinking": "medium" }
    }
  }
}
```

There is no project Agent-default override or Follow global mode. An explicit
user model/variant request may set `subagent.model` for that child session only;
discover its exact chat-model reference with `models` first and never change
global defaults to implement a one-child request. Without that dispatch override,
use global Agent model defaults. When no model is configured, the Research
Assistant uses Pi's native resolution without persisting a default and other
Agents inherit its effective model. With no thinking setting, the
Research Assistant uses its model's highest supported level; other Agents
inherit that level, constrained by their model. Remove a property to restore
fallback; preserve entries for currently absent custom Agent ids.

### Skill resources

Use `<name>/SKILL.md` with `name` and a trigger-oriented `description` in YAML
frontmatter, followed by instructions. Keep optional `scripts/`, `references/`,
and `assets/` relative to the Skill directory; link references with when-to-read
guidance. Optional metadata includes `license`, `compatibility`, `metadata`,
`allowed-tools`, and `disable-model-invocation`.

Create the Skill in the chosen scope and add its resolved name to the Agent's
explicit `skills` list. If the Agent already loads all Skills, no list edit is
needed. A project Skill can override content without creating a project Agent.

## Creating and updating Tools

Read the [Tool reference](references/tools.md) before creating, updating,
authorizing, deleting, or diagnosing a user Tool. It contains a complete Pi 1.6
example, matching-version documentation lookup, lifecycle rules, and verification.

1. Use an existing tool or Skill procedure when it already meets the request.
   A callable new Tool requires a TypeScript extension whose default export
   receives `ExtensionAPI` and calls `api.registerTool` with a parameter schema
   and execution function. A script or Skill does not register itself as a Tool.
2. Default to `~/.easyresearch/agent/extensions/<name>.ts` for cross-project use
   and normal upgrade preservation. Honor project scope with
   `<exact-session-cwd>/.easyresearch/extensions/<name>/index.ts`; keep local
   helpers beside that entry. Preserve existing files and use a unique registered
   name. No installation, bundled-tree, package, or application-source edit is needed.
3. Default activation belongs to `research-assistant`. Leave other Agents alone
   unless the user explicitly names them. Preserve a strict main-Agent list.
   When granting another Agent a Tool, append to its existing non-empty list;
   for a missing/empty list, first identify and show its effective bundled names,
   then retain them in the new explicit list together with the new Tool.
4. Publish the source, then distinguish **saved**, **runtime-applied**, and
   **actually invoked**. Standard extension entries and local helpers refresh
   automatically while idle. The creating run retains its old tools through all
   turns, retries and summaries; a later turn in that same run is not a new run.
   Finish naturally and verify in a subsequent run after application.
5. Use Settings' actual registration-backed tools and safe load diagnostics, then
   perform a small real Agent/tool call. Do not claim success from a filename,
   allowlist entry or saved file, invent a verification API, or sleep/poll/restart
   to force the new tool into the creating run.

## Model configuration

1. Inspect the existing provider entry, then probe its model catalog and consult
   provider documentation for context size, input modalities, and reasoning.
   Ask the user only for facts still missing, not questions already answered.
2. Set `contextWindow` from verified context metadata and
   **`maxTokens = floor(contextWindow / 2)`**, recomputing when the window changes.
   For example, `131072` gives `65536`. Resolve an unknown window before saving.
   Provider output limits are diagnostic, not replacement values: if the half
   window exceeds a declared limit, disclose possible rejection without silently
   clamping the budget or using a fixed fallback.
3. Set `input` to verified text/image support. For reasoning, distinguish no
   support, fixed strength, and configurable strength. Set `reasoning: true`
   only for supported models; add `thinkingLevelMap` for configurable levels.
   Map verified strengths onto Pi's ordered levels
   `off < minimal < low < medium < high < xhigh < max`, preserving stated names
   where possible and using a contiguous run for unnamed levels. Set unsupported
   levels to `null`; mandatory reasoning also requires `"off": null`.
4. Read [Model reference](references/models.md) when probing a catalog, writing
   a provider entry, or configuring thinking/compatibility fields. Show the
   proposed entry with secrets redacted and confirm before saving.

Credentials belong in `auth.json`, a provider `apiKey` field, or a supported
environment reference, never Agent/Skill Markdown or `settings.json`. Do not
echo secrets in diagnostics or proposed diffs. Catalog metadata is a provider
claim, not proof that a real request honors it.

## Saving and verifying

- Recheck scope, preserve unknown Pi fields, validate JSON/frontmatter, and avoid
  overwriting concurrent changes. Web Config validates JSON and writes atomically
  within its selected root; do not bypass its path boundary.
- Valid global Agent definitions, `agentDefaults`, `models.json`, controlled
  mutable Skill descriptors, and standard user extension sources/local helpers
  participate in live configuration. Idle
  runtimes reload; running Agents retain their accepted configuration through the
  whole run, including tool turns, retries and summaries, then apply pending changes
  after native settlement while idle or before the next run. A child model
  override follows the same idle-safe application boundary. Settings/Work refresh
  accepted configuration automatically; callable Tool inventory additionally needs
  an actual successful runtime registration. Use Settings Refresh for recovery,
  not a routine restart. Skill descriptor monitoring covers global, enabled home,
  and owned exact-cwd project Skills, not automatic re-reading of every auxiliary
  reference file. Tool monitoring scope is described in the Tool reference.
- Other settings/resources retain their documented new-session/restart behavior;
  network proxy changes require a daemon restart. Do not promise universal hot
  reload. Check the configuration reference for the affected setting.
- Report changed paths, effective scope, remaining warnings, and any necessary
  next action. Distinguish saved configuration from verified API/tool behavior.
