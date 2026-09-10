---
name: customize-easyresearch
description: >-
  Use when editing or troubleshooting EasyResearch's own agents, skills,
  settings.json, models.json, auth.json, extensions, prompts, themes, or
  .easyresearch configuration; also for API timeouts, retries, transport,
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
| Extensions, prompts, themes | Respective global/project directories and Pi settings resource entries |

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
   saving changed an in-flight request. For extension authoring, Web APIs, or
   diagnostics, consult the same reference only as needed.

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
tools: [read, write, bash, web-search, webfetch]
skills: [paper-search, arxiv]
subagents: []
---

Verify candidate metadata against source pages. Report verified findings,
source URLs, unresolved gaps, and complete, partial, or blocked status.
```

| Field | Meaning |
| --- | --- |
| `enable` | Defaults true; literal false disables specialist/custom selection |
| `tools` | Missing, YAML-empty, or `[]`: all controlled tools; non-empty: strict allowlist |
| `skills` | Missing, YAML-empty, or `[]`: all controlled Skills; non-empty: resolved-name allowlist |
| `subagents` | Omitted: all eligible enabled Agents; `[]`: leaf; non-empty: allowlist |
| `model`, `thinking` | Ignored in Markdown; do not migrate these fields into settings |

Only one local shell is exposed: `powershell` on Windows, `bash` on Linux/macOS.
Exact `bash`/`powershell` allowlist entries normalize to that native name;
`ssh-bash` is a separate remote tool. Use native shell syntax.
Unresolved Skills are skipped at runtime and diagnosed only in Settings.
For bundled Agents, retain role boundaries, inputs, procedure, dispatch targets,
completion criteria, and the specialist handoff contract.

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

No project/session Agent overrides or Follow global mode exist. With no model,
the Research Assistant uses Pi's native resolution without persisting a default;
other Agents inherit its effective model. With no thinking setting, the
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
- Valid global Agent definitions, `agentDefaults`, `models.json`, and controlled
  mutable Skill descriptor edits refresh Settings/Work automatically. Idle
  runtimes reload; running Agents finish the current response/tool batch and
  apply changes before the next LLM request. Use Settings Refresh for recovery,
  not a routine restart. This covers global, enabled home, and owned exact-cwd
  project Skills, not automatic re-reading of every auxiliary reference file.
- Other settings/resources retain their documented new-session/restart behavior;
  network proxy changes require a daemon restart. Do not promise universal hot
  reload. Check the configuration reference for the affected setting.
- Report changed paths, effective scope, remaining warnings, and any necessary
  next action. Distinguish saved configuration from verified API/tool behavior.
